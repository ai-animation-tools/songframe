package components

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVerifiedModelsWaitForRuntimeAndReuseSHA заканчивает автоматическую проверку понятным ожиданием зависимости.
// После появления ORT обычная проверка использует прежний SHA и доводит models до native-ready без ручного Force.
func TestVerifiedModelsWaitForRuntimeAndReuseSHA(t *testing.T) {
	m, _, native := testManager(t)
	for _, id := range []string{"ffmpeg", "voc-ft", "ctc-ru", "ctc-vocab"} {
		installSynthetic(t, m, id)
	}
	state, err := m.Check(context.Background(), []string{"known-text-ctc"}, false)
	if err == nil || *native != 0 {
		t.Fatalf("нет ожидаемого ожидания runtime: %v native=%d", err, *native)
	}
	for _, id := range []string{"voc-ft", "ctc-ru"} {
		model := component(t, state, id)
		if model.Status != "blocked" || !strings.Contains(model.Reason, "Файл модели проверен.") || !strings.Contains(model.Reason, "нужен ONNX Runtime CPU") {
			t.Fatalf("непонятное конечное состояние %s: %+v", id, model)
		}
	}
	// Изменяем bytes с сохранёнными metadata, чтобы доказать reuse уже подтверждённого SHA,
	// а не скрытый повтор хеширования при новой автоматической проверке зависимости.
	file := component(t, state, "voc-ft").Paths["model"]
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	data[0] ^= 1
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	installSynthetic(t, m, "ort-cpu")
	state, err = m.Check(context.Background(), []string{"known-text-ctc"}, false)
	if err != nil || *native != 1 {
		t.Fatalf("модель не продолжила проверку: %v native=%d %+v", err, *native, state)
	}
	for _, id := range []string{"ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"} {
		if component(t, state, id).Status != "ready" {
			t.Fatalf("%s не готов после появления runtime: %+v", id, state)
		}
	}
	state, err = m.Check(context.Background(), []string{"prepare-vocals"}, true)
	if err == nil || component(t, state, "voc-ft").Status != "incompatible" {
		t.Fatal("Force потерял проверку реального SHA")
	}
}

// TestMissingRuntimeDoesNotHideBadModelSHA сохраняет собственный отказ модели вместо общего blocked.
func TestMissingRuntimeDoesNotHideBadModelSHA(t *testing.T) {
	m, _, native := testManager(t)
	installSynthetic(t, m, "ffmpeg")
	root := installSynthetic(t, m, "voc-ft")
	if err := os.WriteFile(filepath.Join(root, "vocals.onnx"), []byte("повреждённые веса"), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	model := component(t, state, "voc-ft")
	if err == nil || model.Status != "incompatible" || !strings.Contains(model.Reason, "SHA/размером") || *native != 0 {
		t.Fatalf("собственный SHA отказ скрыт: %v %+v", err, model)
	}
}

// TestRuntimeNativeFailureBlocksOnlyVerifiedModels отделяет ошибку загрузчика от ошибки самих весов.
// Неверный SHA соседней модели остаётся виден, пока пригодная по SHA модель ждёт ORT.
func TestRuntimeNativeFailureBlocksOnlyVerifiedModels(t *testing.T) {
	m, _, _ := testManager(t)
	for _, id := range []string{"ffmpeg", "ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"} {
		installSynthetic(t, m, id)
	}
	ctc := component(t, m.State(), "ctc-ru").Paths["model"]
	if err := os.WriteFile(ctc, []byte("неверный SHA CTC"), 0600); err != nil {
		t.Fatal(err)
	}
	m.options.ort = func(context.Context, string, []ModelFile) (ORTReport, error) {
		return ORTReport{}, errors.New("не найдена библиотека зависимости ORT")
	}
	state, err := m.Check(context.Background(), []string{"known-text-ctc"}, false)
	if err == nil || component(t, state, "ort-cpu").Status != "incompatible" || component(t, state, "voc-ft").Status != "blocked" {
		t.Fatalf("runtime failure не разделён: %v %+v", err, state)
	}
	if c := component(t, state, "ctc-ru"); c.Status != "incompatible" || !strings.Contains(c.Reason, "SHA/размером") {
		t.Fatalf("ORT failure затёр SHA CTC: %+v", c)
	}
}

// TestRuntimeWaitPreservesOwnNativeModelError не заменяет ранее доказанный отказ графа общим ожиданием ORT.
func TestRuntimeWaitPreservesOwnNativeModelError(t *testing.T) {
	m, _, _ := testManager(t)
	for _, id := range []string{"ffmpeg", "ort-cpu", "voc-ft"} {
		installSynthetic(t, m, id)
	}
	m.options.ort = func(context.Context, string, []ModelFile) (ORTReport, error) {
		return ORTReport{API: 27, Models: map[string]ProbeOutcome{"voc-ft": {Status: "incompatible", Reason: "не подходит граф модели"}}}, nil
	}
	state, _ := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if component(t, state, "voc-ft").Reason != "не подходит граф модели" {
		t.Fatal("нет собственного model-native отказа")
	}
	runtime := component(t, state, "ort-cpu").Paths["ort-library"]
	if err := os.Remove(runtime); err != nil {
		t.Fatal(err)
	}
	state, _ = m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if c := component(t, state, "voc-ft"); c.Status != "incompatible" || c.Reason != "не подходит граф модели" {
		t.Fatalf("собственный отказ графа заменён ожиданием: %+v", c)
	}
}
