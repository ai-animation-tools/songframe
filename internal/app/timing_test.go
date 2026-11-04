package app

import (
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/timing"
)

// TestTimingServiceSave — сохранение через Wails-метод: тот же документ JSON на входе
// (json.RawMessage), побайтно тот же timing.json, что у saveTiming оригинала, и ответ —
// сохранённый документ без потери неизвестных полей.
func TestTimingServiceSave(t *testing.T) {
	service := NewTimingService(nil, nil, nil, t.TempDir())
	for _, item := range golden.Load(t, "timing-save") {
		if item.Name == "validation-error" {
			continue
		}
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			result, err := service.Save(project, item.Read(t, "timing-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			written, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(timing.TimingPath)))
			if err != nil {
				t.Fatal(err)
			}
			if string(written) != string(item.Read(t, "expected-timing.json")) || string(result) != string(written) {
				t.Fatalf("сохранение отличается от оригинала:\n%s", written)
			}
		})
	}
	if _, err := service.Save(t.TempDir(), []byte("{")); err == nil {
		t.Fatal("битый JSON должен отклоняться")
	}
}
