package scenario

import (
	"os"
	"path/filepath"
	"testing"
)

// TestViewVideoProvider проверяет, что вид сценария отдаёт провайдера видео проекта как есть
// и опускает поле, когда провайдер не выбран: по нему редактор планов берёт предел длины запроса.
func TestViewVideoProvider(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(generation string) {
		text := `{"schema_version":1,"name":"Проба","animatic_video":"proba.mp4","fps":30,"agent_instructions":"","generation":` + generation + `}`
		if err := os.WriteFile(filepath.Join(project, "plan", "project.json"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"video":{"provider":"test"},"image":null}`)
	view, err := ViewProject(project)
	if err != nil {
		t.Fatal(err)
	}
	if string(view.VideoProvider) != `"test"` {
		t.Fatalf("videoProvider = %s, ожидался \"test\"", view.VideoProvider)
	}
	write(`{"video":null,"image":null}`)
	view, err = ViewProject(project)
	if err != nil {
		t.Fatal(err)
	}
	if view.VideoProvider != nil {
		t.Fatalf("videoProvider без выбранного провайдера = %s", view.VideoProvider)
	}
}
