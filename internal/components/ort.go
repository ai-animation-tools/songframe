package components

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"

	ort "github.com/microsoft/onnxruntime/go/onnxruntime"
)

// ModelFile связывает проверенный менеджером артефакт с выбранным внешним файлом.
// Проверка SHA и согласованности CTC/vocab принадлежит менеджеру, а не native adapter.
type ModelFile struct {
	Artifact Artifact
	Path     string
}

// ORTReport описывает реальную проверку runtime и коротких синтетических графов.
// RestartRequired означает попытку сменить уже загруженную библиотеку в одном процессе.
type ORTReport struct {
	Version         string                  `json:"version"`
	API             int                     `json:"api"`
	Models          map[string]ProbeOutcome `json:"models"`
	RestartRequired bool                    `json:"restartRequired"`
}

// ortState сериализует глобальный Init binding и все диагностические sessions.
// Создание канала не загружает native library; Shutdown не вызывается, поскольку он запрещает следующий Init.
var ortState = struct {
	gate    chan struct{}
	library string
	file    os.FileInfo
}{gate: make(chan struct{}, 1)}

// CheckORT загружает ORT только по явному вызову и абсолютному пути; старт окна его не требует.
// Run(ctx) закреплённого binding передаёт отмену через RunOptionsSetTerminate. CreateSession
// не принимает context: отмена загрузки учитывается после возврата native вызова, с закрытием session.
// Ошибка возвращается для runtime или общей отмены; отказы отдельных моделей находятся в Models
// и не делают исправный runtime либо соседнюю модель несовместимыми.
func CheckORT(ctx context.Context, library string, models []ModelFile) (ORTReport, error) {
	report := ORTReport{Models: make(map[string]ProbeOutcome)}
	for _, model := range models {
		report.Models[model.Artifact.ID] = ProbeOutcome{Status: "error", Reason: "Модель ещё не проверена."}
	}
	select {
	case ortState.gate <- struct{}{}:
		defer func() { <-ortState.gate }()
	case <-ctx.Done():
		return ortFailure(report, models, "cancelled", ctx.Err())
	}
	if err := ctx.Err(); err != nil {
		return ortFailure(report, models, "cancelled", err)
	}
	if !filepath.IsAbs(library) || strings.ContainsRune(library, 0) {
		return ortFailure(report, models, "incompatible", fmt.Errorf("ORT: нужен явный абсолютный путь к библиотеке"))
	}
	absolute, err := filepath.EvalSymlinks(filepath.Clean(library))
	if err != nil {
		return ortFailure(report, models, "incompatible", fmt.Errorf("ORT: библиотека недоступна: %w", err))
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = fmt.Errorf("путь не является обычным файлом")
		}
		return ortFailure(report, models, "incompatible", fmt.Errorf("ORT: неверная библиотека: %w", err))
	}
	if ortState.library != "" && (absolute != ortState.library || !os.SameFile(ortState.file, info) || info.Size() != ortState.file.Size() || !info.ModTime().Equal(ortState.file.ModTime())) {
		report.RestartRequired = true
		return ortFailure(report, models, "incompatible", fmt.Errorf("ORT: для смены уже загруженной библиотеки требуется перезапустить приложение"))
	}
	if ortState.library == "" {
		ort.SetSharedLibraryPath(absolute)
		if err = ort.Init(); err != nil {
			return ortFailure(report, models, "incompatible", fmt.Errorf("ORT: загрузка библиотеки или C API не удалась: %w", err))
		}
		// Успешный Init уже закрепил native handle даже при ошибке дальнейшей диагностики.
		ortState.library, ortState.file = absolute, info
	}
	report.API = ort.APIVersion()
	report.Version, err = ort.GetVersion()
	if err != nil {
		return ortFailure(report, models, "error", fmt.Errorf("ORT: не прочитана версия: %w", err))
	}
	if report.API != 27 {
		return ortFailure(report, models, "incompatible", fmt.Errorf("ORT: нужен C API 27 принятого binding, получен %d", report.API))
	}
	if err = ort.DisableTelemetry(); err != nil {
		return ortFailure(report, models, "error", fmt.Errorf("ORT: не удалось отключить telemetry: %w", err))
	}
	providers, err := ort.AvailableProviders()
	if err != nil {
		return ortFailure(report, models, "error", fmt.Errorf("ORT: не прочитан список providers: %w", err))
	}
	if !slices.Contains(providers, "CPUExecutionProvider") {
		return ortFailure(report, models, "incompatible", fmt.Errorf("ORT: отсутствует CPUExecutionProvider"))
	}
	if err = ctx.Err(); err != nil {
		return ortFailure(report, models, "cancelled", err)
	}
	for index, model := range models {
		outcome, _ := checkORTModel(ctx, model)
		report.Models[model.Artifact.ID] = outcome
		if err = ctx.Err(); err != nil {
			return ortFailure(report, models[index:], "cancelled", err)
		}
	}
	return report, nil
}

// ortFailure заполняет одинаковую причину у зависимых моделей, если runtime ещё непригоден.
func ortFailure(report ORTReport, models []ModelFile, status string, err error) (ORTReport, error) {
	for _, model := range models {
		report.Models[model.Artifact.ID] = ProbeOutcome{Status: status, Reason: err.Error()}
	}
	return report, err
}

// ortTensorContract описывает только float32 границу графа; строки формы обозначают dynamic dimensions.
type ortTensorContract struct {
	Name  string `json:"name"`
	DType string `json:"dtype"`
	Shape []any  `json:"shape"`
}

// ortModelContract читает имена и формы из закреплённого manifest, без повторного DSP-рецепта.
type ortModelContract struct {
	Inputs  []ortTensorContract `json:"inputs"`
	Outputs []ortTensorContract `json:"outputs"`
}

// checkORTModel открывает и всегда закрывает отдельную CPU session с одним потоком.
// Без добавленных EP default session выполняет граф на CPU; проверка не запускает обработку песни.
func checkORTModel(ctx context.Context, model ModelFile) (ProbeOutcome, error) {
	fail := func(status string, err error) (ProbeOutcome, error) {
		return ProbeOutcome{Status: status, Reason: err.Error()}, err
	}
	if err := ctx.Err(); err != nil {
		return fail("cancelled", err)
	}
	if model.Artifact.Component != "voc-ft" && model.Artifact.Component != "ctc-ru" {
		return fail("incompatible", fmt.Errorf("ORT: неизвестный граф %s", model.Artifact.ID))
	}
	if !filepath.IsAbs(model.Path) || strings.ContainsRune(model.Path, 0) {
		return fail("incompatible", fmt.Errorf("ORT %s: нужен абсолютный путь модели", model.Artifact.ID))
	}
	var contract ortModelContract
	if err := json.Unmarshal(model.Artifact.Model, &contract); err != nil || len(contract.Inputs) != 1 || len(contract.Outputs) != 1 {
		return fail("incompatible", fmt.Errorf("ORT %s: неполный контракт входа/выхода", model.Artifact.ID))
	}
	options, err := ort.NewSessionOptions()
	if err != nil {
		return fail("error", err)
	}
	defer options.Close()
	if err = options.SetIntraOpNumThreads(1); err != nil {
		return fail("error", err)
	}
	if err = options.SetInterOpNumThreads(1); err != nil {
		return fail("error", err)
	}
	session, err := ort.NewSession(model.Path, options)
	if err != nil {
		if ctx.Err() != nil {
			return fail("cancelled", ctx.Err())
		}
		return fail("incompatible", fmt.Errorf("ORT %s: не создана сессия: %w", model.Artifact.ID, err))
	}
	defer session.Close()
	if err = ctx.Err(); err != nil {
		return fail("cancelled", err)
	}
	if err = matchORTMetadata(session.Inputs(), contract.Inputs); err != nil {
		return fail("incompatible", fmt.Errorf("ORT %s, вход: %w", model.Artifact.ID, err))
	}
	if err = matchORTMetadata(session.Outputs(), contract.Outputs); err != nil {
		return fail("incompatible", fmt.Errorf("ORT %s, выход: %w", model.Artifact.ID, err))
	}
	if err = runORTSynthetic(ctx, session, model.Artifact.Component, contract); err != nil {
		if ctx.Err() != nil {
			return fail("cancelled", ctx.Err())
		}
		return fail("error", fmt.Errorf("ORT %s, короткий inference: %w", model.Artifact.ID, err))
	}
	return ProbeOutcome{Status: "ready", Reason: "CPU session, метаданные и короткий синтетический inference проверены."}, nil
}

// matchORTMetadata требует точных имён, float32 и всех статических/dynamic размеров manifest.
func matchORTMetadata(actual []ort.IOInfo, expected []ortTensorContract) error {
	if len(actual) != len(expected) {
		return fmt.Errorf("число тензоров %d вместо %d", len(actual), len(expected))
	}
	for i, tensor := range actual {
		want := expected[i]
		if tensor.Name != want.Name || tensor.DataType != ort.TensorElementDataTypeFloat32 || want.DType != "float32" || len(tensor.Shape) != len(want.Shape) {
			return fmt.Errorf("не совпадают имя, тип или rank тензора %s", want.Name)
		}
		for d, dimension := range want.Shape {
			switch v := dimension.(type) {
			case float64:
				if v != math.Trunc(v) || v < 1 || float64(tensor.Shape[d]) != v {
					return fmt.Errorf("не совпадает размер %s[%d]", want.Name, d)
				}
			case string:
				if v == "" || tensor.Shape[d] != -1 {
					return fmt.Errorf("не совпадает dynamic размер %s[%d]", want.Name, d)
				}
			default:
				return fmt.Errorf("неверный размер %s[%d]", want.Name, d)
			}
		}
	}
	return nil
}

// runORTSynthetic проверяет один спектральный блок Voc FT либо одну секунду CTC.
// Тензоры освобождаются после завершения native Run и его встроенного watcher отмены.
func runORTSynthetic(ctx context.Context, session *ort.Session, component string, contract ortModelContract) error {
	shape, outputShape := []int64{1, 4, 3072, 256}, []int64{1, 4, 3072, 256}
	if component == "ctc-ru" {
		shape, outputShape = []int64{1, 16000}, []int64{1, 49, 39}
	}
	count := 1
	for _, n := range shape {
		count *= int(n)
	}
	signal := make([]float32, count)
	for i := range signal {
		signal[i] = float32(math.Sin(float64(i)*.017) * .01)
	}
	input, err := ort.CreateTensor(shape, signal)
	if err != nil {
		return err
	}
	defer input.Close()
	outputs, err := session.Run(ctx, map[string]*ort.Tensor{contract.Inputs[0].Name: input}, []string{contract.Outputs[0].Name})
	if err != nil {
		return err
	}
	defer func() {
		for _, tensor := range outputs {
			tensor.Close()
		}
	}()
	if err = ctx.Err(); err != nil {
		return err
	}
	output := outputs[contract.Outputs[0].Name]
	if output == nil || !slices.Equal(output.Shape(), outputShape) {
		return fmt.Errorf("не совпадает форма результата, ожидается %v", outputShape)
	}
	values, err := ort.TensorData[float32](output)
	if err != nil {
		return err
	}
	expectedCount := 1
	for _, n := range outputShape {
		expectedCount *= int(n)
	}
	if len(values) != expectedCount {
		return fmt.Errorf("неверное число выходных значений")
	}
	for _, v := range values {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return fmt.Errorf("модель вернула NaN/Infinity")
		}
	}
	return ctx.Err()
}
