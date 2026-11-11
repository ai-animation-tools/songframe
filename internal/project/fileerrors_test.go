package project

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// TestFileProblem — путь от папки проекта и подсказка по причине; вне проекта текста нет.
func TestFileProblem(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "клип")
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "project.json"), []byte(`{"name":"Клип"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		errno syscall.Errno
		path  string
		want  string
	}{
		{"план", syscall.ENOENT, filepath.Join(project, "plan", "scenes.json"),
			"в папке проекта нет «plan/scenes.json». Если файл удалили или переместили вне приложения, верните его на место или повторите шаг, который его создаёт."},
		{"исходник в отсутствующей папке", syscall.ENOENT, filepath.Join(project, "source", "heroes", "lev.png"),
			"в папке проекта нет «source/heroes/lev.png». Если файл удалили или переместили, верните его на место или выберите заново."},
		{"доступ", syscall.EACCES, filepath.Join(project, "assets", "shots"),
			"нет доступа к «assets/shots» в папке проекта. Проверьте права на папку проекта и её файлы."},
		{"папка вместо файла", syscall.EISDIR, filepath.Join(project, "source", "track.mp3"),
			"«source/track.mp3» в папке проекта — папка, а нужен файл. Переименуйте или уберите эту папку."},
	}
	for _, c := range cases {
		got, ok := FileProblem(c.errno, c.path)
		if !ok || got != c.want {
			t.Errorf("%s: %q, %v", c.name, got, ok)
		}
	}

	bare := filepath.Join(root, "папка")
	got, ok := FileProblem(syscall.ENOENT, filepath.Join(bare, "plan", "project.json"))
	if !ok || !strings.HasPrefix(got, "в выбранной папке нет «plan/project.json»: ") {
		t.Errorf("нет маркера: %q, %v", got, ok)
	}
	for name, path := range map[string]string{
		"вне проекта": filepath.Join(bare, "export", "bundle"),
		"корень":      project,
		"без пути":    "",
	} {
		if got, ok := FileProblem(syscall.ENOENT, path); ok {
			t.Errorf("%s: ждали технический текст, получено %q", name, got)
		}
	}
	if got, ok := FileProblem(syscall.EBADF, filepath.Join(project, "plan", "scenes.json")); ok {
		t.Errorf("служебный errno: %q", got)
	}
	if got := ShownPath(filepath.Join(project, "plan", "cast.json")); got != "«plan/cast.json» в папке проекта" {
		t.Errorf("ShownPath в проекте: %q", got)
	}
	if outside := filepath.Join(bare, "x.json"); ShownPath(outside) != outside {
		t.Errorf("ShownPath вне проекта: %q", ShownPath(outside))
	}
}
