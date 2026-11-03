package components

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ort "github.com/microsoft/onnxruntime/go/onnxruntime"
)

// TestORTBaseline проверяет отсутствие native загрузки при чтении реестра и ошибках входа.
// Обычный прогон не зависит от установленного ORT, моделей или сетевого соединения.
func TestORTBaseline(t *testing.T) {
	if ort.IsInitialized() {
		t.Fatal("ORT загружен без явного запроса")
	}
	if _, err := Load(); err != nil {
		t.Fatal(err)
	}
	if ort.IsInitialized() {
		t.Fatal("чтение manifest загрузило ORT")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	report, err := CheckORT(ctx, "/неиспользуемая-библиотека", []ModelFile{{Artifact: Artifact{ID: "ctc-ru"}}})
	if !errors.Is(err, context.Canceled) || report.Models["ctc-ru"].Status != "cancelled" {
		t.Fatalf("не сохранена отмена: %+v %v", report, err)
	}
	for _, library := range []string{"", "relative.so", filepath.Join(t.TempDir(), "нет библиотеки.so"), t.TempDir()} {
		if _, err := CheckORT(context.Background(), library, nil); err == nil {
			t.Fatalf("принят неверный путь %q", library)
		}
	}
	if ort.IsInitialized() {
		t.Fatal("ошибка пути загрузила ORT")
	}
}

// TestORTWaitCancellation проверяет отмену ожидания сериализованного native вызова.
// Второй запрос не должен зависать до завершения чужого inference.
func TestORTWaitCancellation(t *testing.T) {
	ortState.gate <- struct{}{}
	defer func() { <-ortState.gate }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := CheckORT(ctx, "/неиспользуемая-библиотека", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("не прервано ожидание: %v", err)
	}
}

// TestORTMetadata проверяет точную границу графа, включая запрет лишнего attention_mask.
func TestORTMetadata(t *testing.T) {
	expected := []ortTensorContract{{Name: "input_values", DType: "float32", Shape: []any{"batch_size", "sequence_length"}}}
	good := []ort.IOInfo{{Name: "input_values", DataType: ort.TensorElementDataTypeFloat32, Shape: []int64{-1, -1}}}
	if err := matchORTMetadata(good, expected); err != nil {
		t.Fatal(err)
	}
	cases := [][]ort.IOInfo{
		nil,
		{{Name: "input_values", DataType: ort.TensorElementDataTypeFloat32, Shape: []int64{1, -1}}},
		{{Name: "input_values", DataType: ort.TensorElementDataTypeInt64, Shape: []int64{-1, -1}}},
		{{Name: "иной вход", DataType: ort.TensorElementDataTypeFloat32, Shape: []int64{-1, -1}}},
		{good[0], {Name: "attention_mask", DataType: ort.TensorElementDataTypeInt64, Shape: []int64{-1, -1}}},
	}
	for _, actual := range cases {
		if matchORTMetadata(actual, expected) == nil {
			t.Fatalf("приняты несовместимые метаданные: %+v", actual)
		}
	}
	fixed := []ortTensorContract{{Name: "output", DType: "float32", Shape: []any{"batch_size", float64(4), float64(3072), float64(256)}}}
	if err := matchORTMetadata([]ort.IOInfo{{Name: "output", DataType: ort.TensorElementDataTypeFloat32, Shape: []int64{-1, 4, 3072, 256}}}, fixed); err != nil {
		t.Fatal(err)
	}
	if matchORTMetadata([]ort.IOInfo{{Name: "output", DataType: ort.TensorElementDataTypeFloat32, Shape: []int64{-1, 4, 3072, 255}}}, fixed) == nil {
		t.Fatal("принят неверный frames")
	}
}

// TestORTIntegration запускает независимые процессы ради непереинициализируемого global Init.
// Нужны SONGFRAME_ORT_LIBRARY и SONGFRAME_ORT_MODEL_DIR с уже установленными read-only весами.
func TestORTIntegration(t *testing.T) {
	if os.Getenv("SONGFRAME_ORT_LIBRARY") == "" || os.Getenv("SONGFRAME_ORT_MODEL_DIR") == "" {
		t.Skip("не заданы явные ORT и каталог моделей")
	}
	for _, scenario := range []string{"retry", "switch", "models", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestORTIntegrationChild$", "-test.v")
			command.Env = append(os.Environ(), "SONGFRAME_ORT_TEST_CHILD="+scenario)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("native сценарий %s: %v\n%s", scenario, err, output)
			}
		})
	}
}

// TestORTIntegrationChild исполняет единственный native сценарий и завершается без Shutdown.
// Данные моделей только читаются; входы inference создаются в памяти, проекты не используются.
func TestORTIntegrationChild(t *testing.T) {
	scenario := os.Getenv("SONGFRAME_ORT_TEST_CHILD")
	if scenario == "" {
		t.Skip("дочерний native сценарий не выбран")
	}
	library := os.Getenv("SONGFRAME_ORT_LIBRARY")
	models := ortIntegrationModels(t)
	switch scenario {
	case "retry":
		broken := filepath.Join(t.TempDir(), "повреждённая библиотека.so")
		if err := os.WriteFile(broken, []byte("не ELF и не PE"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := CheckORT(context.Background(), broken, nil); err == nil {
			t.Fatal("принят повреждённый ABI")
		}
		if ort.IsInitialized() {
			t.Fatal("неудачная загрузка оставила initialized")
		}
		report, err := CheckORT(context.Background(), library, nil)
		if err != nil || report.API != 27 || report.Version != "1.31.0" {
			t.Fatalf("повтор Init: %+v %v", report, err)
		}
	case "switch":
		if _, err := CheckORT(context.Background(), library, nil); err != nil {
			t.Fatal(err)
		}
		other := filepath.Join(t.TempDir(), "другая библиотека.so")
		if err := os.WriteFile(other, []byte("другая версия"), 0600); err != nil {
			t.Fatal(err)
		}
		report, err := CheckORT(context.Background(), other, models)
		if err == nil || !report.RestartRequired {
			t.Fatalf("нет требования перезапуска: %+v %v", report, err)
		}
		if _, err := CheckORT(context.Background(), library, nil); err != nil {
			t.Fatalf("предыдущая библиотека перестала работать: %v", err)
		}
	case "models":
		report, err := CheckORT(context.Background(), library, models)
		if err != nil {
			t.Fatalf("native модели: %+v %v", report, err)
		}
		for _, model := range models {
			if report.Models[model.Artifact.ID].Status != "ready" {
				t.Fatalf("нет ready: %+v", report)
			}
		}
		// Чужая модель с корректным ONNX ABI должна быть отвергнута по контракту tensor metadata.
		wrong := models[1]
		wrong.Path = models[0].Path
		report, err = CheckORT(context.Background(), library, []ModelFile{models[0], wrong})
		if err != nil || report.Models[wrong.Artifact.ID].Status != "incompatible" || report.Models[models[0].Artifact.ID].Status != "ready" {
			t.Fatalf("принят неверный граф: %+v %v", report, err)
		}
	case "cancel":
		if _, err := CheckORT(context.Background(), library, nil); err != nil {
			t.Fatal(err)
		}
		options, err := ort.NewSessionOptions()
		if err != nil {
			t.Fatal(err)
		}
		defer options.Close()
		if err = options.SetIntraOpNumThreads(1); err != nil {
			t.Fatal(err)
		}
		session, err := ort.NewSession(models[1].Path, options)
		if err != nil {
			t.Fatal(err)
		}
		defer session.Close()
		var contract ortModelContract
		if err = json.Unmarshal(models[1].Artifact.Model, &contract); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
		defer cancel()
		if err = runORTSynthetic(ctx, session, "ctc-ru", contract); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("короткий inference не отменён: %v", err)
		}
		if err = runORTSynthetic(context.Background(), session, "ctc-ru", contract); err != nil {
			t.Fatalf("terminate повредил следующий Run: %v", err)
		}
	default:
		t.Fatalf("неизвестный native сценарий %q", scenario)
	}
}

// ortIntegrationModels находит только два закреплённых ONNX и канонические имена manifest.
func ortIntegrationModels(t *testing.T) []ModelFile {
	t.Helper()
	manifest, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	var models []ModelFile
	for _, component := range []string{"voc-ft", "ctc-ru"} {
		for _, artifact := range manifest.Artifacts {
			if artifact.Component == component {
				models = append(models, ModelFile{Artifact: artifact, Path: filepath.Join(os.Getenv("SONGFRAME_ORT_MODEL_DIR"), artifact.Entrypoints["model"])})
			}
		}
	}
	if len(models) != 2 || strings.TrimSpace(os.Getenv("SONGFRAME_ORT_LIBRARY")) == "" {
		t.Fatal("не задан закреплённый комплект")
	}
	return models
}
