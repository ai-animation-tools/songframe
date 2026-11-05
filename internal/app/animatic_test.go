package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestAnimaticServiceRoutes — маршруты группы без сценарного прохода: пустой проект даёт вид с
// [] вместо null, сборка без сценария и принятие без сборки отклоняются текстами оригинала.
func TestAnimaticServiceRoutes(t *testing.T) {
	project := t.TempDir()
	service := NewAnimaticService(nil, nil)
	view, err := service.View(project)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(view)
	if string(data) != `{"built":null,"shots":[],"approval":{"status":"none","approvedSha256":null,"current":false},"cardsFresh":false,"problems":["Сначала нужен сценарий. Создайте его на странице «Сценарий»."]}` {
		t.Fatalf("вид %s", data)
	}
	if _, err := service.Build(project, true); err == nil || err.Error() != "Сначала нужен сценарий. Создайте его на странице «Сценарий»." {
		t.Fatalf("сборка без сценария: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "scenes.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Build(project, false); err == nil {
		t.Fatal("задание создано без менеджера")
	}
	if _, err := service.SetStatus(project, "approved"); err == nil || err.Error() != "Нет собранного аниматика: сначала соберите его." {
		t.Fatalf("принятие без сборки: %v", err)
	}
}
