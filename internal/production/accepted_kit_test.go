package production

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writeKit — комплект плана M05 с указанными файлами (имя → содержимое).
func writeKit(t *testing.T, files map[string]string) string {
	t.Helper()
	project := t.TempDir()
	dir := filepath.Join(project, "assets", "shots", "M05")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return project
}

// Принятый план показывает, как получено видео, по снимку комплекта: ручная генерация с
// источником и примечанием, опора, промпт и срез речи с границами из рецепта.
func TestAcceptedKitManualSpeech(t *testing.T) {
	project := writeKit(t, map[string]string{
		"manifest.json": `{"generation":{"request":{"path":"generation-request.json"},"prompt":{"path":"generation-prompt.txt"},
			"generation_id":null,"inputs":[{"path":"generation-input-1.png","slot":"image"},{"path":"generation-input-2.wav","slot":"audio"},
			{"path":"missing.png","slot":"image"}],"audio":{"path":"speech.wav"}}}`,
		"generation-request.json": `{"provider":"test","manual_generation":{"source":"Сайт сервиса","cost":{"amount":38,"unit":"credits"},"description":"Попыток: 1."}}`,
		"generation-prompt.txt":   "Средний план, камера приближается.",
		"generation-input-1.png":  "png",
		"generation-input-2.wav":  "wav",
		"speech.wav":              "wav",
		"audio-recipe.json":       `{"source_interval_seconds":[23.25,27.25]}`,
	})
	kit, err := AcceptedKitFor(project, "M05")
	if err != nil || kit == nil {
		t.Fatalf("комплект %v, ошибка %v", kit, err)
	}
	dir := filepath.Join(project, "assets", "shots", "M05")
	if kit.Provider == nil || *kit.Provider != "test" || kit.GenerationID != nil {
		t.Fatalf("провайдер %v, генерация %v", kit.Provider, kit.GenerationID)
	}
	var manual map[string]any
	if err := json.Unmarshal(kit.ManualGeneration, &manual); err != nil || manual["source"] != "Сайт сервиса" || manual["description"] != "Попыток: 1." {
		t.Fatalf("ручная генерация %s", kit.ManualGeneration)
	}
	if kit.Prompt == nil || *kit.Prompt != "Средний план, камера приближается." {
		t.Fatalf("промпт %v", kit.Prompt)
	}
	if len(kit.Images) != 1 || kit.Images[0] != filepath.Join(dir, "generation-input-1.png") {
		t.Fatalf("опоры %v", kit.Images)
	}
	if kit.Speech == nil || kit.Speech.Path != filepath.Join(dir, "speech.wav") || *kit.Speech.Start != 23.25 || *kit.Speech.End != 27.25 {
		t.Fatalf("срез %+v", kit.Speech)
	}
}

// План через провайдера: номер генерации, без ручной генерации и среза; производный план и
// отсутствующий комплект дают nil, чужой путь вместо кода плана отклоняется.
func TestAcceptedKitProviderAndMissing(t *testing.T) {
	project := writeKit(t, map[string]string{
		"manifest.json":           `{"generation":{"request":{"path":"generation-request.json"},"generation_id":"gen-7","inputs":[]}}`,
		"generation-request.json": `{"provider":"test"}`,
	})
	kit, err := AcceptedKitFor(project, "M05")
	if err != nil || kit == nil || kit.GenerationID == nil || *kit.GenerationID != "gen-7" || kit.ManualGeneration != nil || kit.Speech != nil || kit.Prompt != nil {
		t.Fatalf("комплект %+v, ошибка %v", kit, err)
	}
	derived := writeKit(t, map[string]string{"manifest.json": `{"kind":"derived","accepted_edit":{}}`})
	if kit, err := AcceptedKitFor(derived, "M05"); err != nil || kit != nil {
		t.Fatalf("производный план: %+v, %v", kit, err)
	}
	if kit, err := AcceptedKitFor(t.TempDir(), "M05"); err != nil || kit != nil {
		t.Fatalf("без комплекта: %+v, %v", kit, err)
	}
	if _, err := AcceptedKitFor(project, "../M05"); err == nil {
		t.Fatal("путь вместо кода плана принят")
	}
}
