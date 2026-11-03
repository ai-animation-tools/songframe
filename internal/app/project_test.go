package app

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// registrySpy проверяет, что сервис регистрирует только выбранный файл и передаёт ошибку пользователю.
type registrySpy struct {
	paths []string
	err   error
}

func (r *registrySpy) Register(path string) (string, error) {
	r.paths = append(r.paths, path)
	return "http://127.0.0.1:1234/media/fixture", r.err
}

func TestProjectServiceMediaValidation(t *testing.T) {
	root := t.TempDir()
	registry := &registrySpy{}
	service := NewProjectService(registry)
	for _, extension := range []string{".wav", ".MP3", ".mp4", ".webm"} {
		path := filepath.Join(root, "Файл с пробелами"+extension)
		if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		value, err := service.Media(path)
		if err != nil || value.URL == "" || value.Path != path {
			t.Fatalf("медиа: %+v %v", value, err)
		}
	}
	if len(registry.paths) != 4 {
		t.Fatal("неверное число регистраций")
	}
	if _, err := service.Media(filepath.Join(root, "нет.mp3")); err == nil {
		t.Fatal("отсутствующее медиа принято")
	}
	if _, err := service.Media(filepath.Join(root, "secret.txt")); err == nil {
		t.Fatal("неподдерживаемый формат принят")
	}
	if len(registry.paths) != 4 {
		t.Fatal("ошибочный путь передан серверу")
	}
	registry.err = errors.New("нет доступа")
	if _, err := service.Media(registry.paths[0]); err == nil {
		t.Fatal("потеря ошибки регистрации")
	}
}

// Незавершённый проект не регистрирует трек; исправный snapshot получает URL только в памяти.
func TestProjectServiceOpenRegistersOnlyReadableProject(t *testing.T) {
	root := t.TempDir()
	for path, content := range map[string]string{
		"plan/project.json": `{"name":"Копия"}`,
		"source/text.md":    "Текст\n",
		"source/track.mp3":  "fixture",
	} {
		target := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	registry := &registrySpy{}
	service := NewProjectService(registry)
	value, err := service.Open(root)
	if err != nil || value.Track == nil || value.Track.URL == "" || len(registry.paths) != 1 {
		t.Fatalf("читаемый проект: %+v %v", value, err)
	}
	journal := filepath.Join(root, "plan", "derived-history", "pending", "journal.json")
	if err := os.MkdirAll(filepath.Dir(journal), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(journal, []byte(`{"state":"publishing"}`), 0600); err != nil {
		t.Fatal(err)
	}
	value, err = service.Open(root)
	if err != nil || !value.Blocked || value.Track != nil || len(registry.paths) != 1 {
		t.Fatalf("заблокированный проект зарегистрировал медиа: %+v %v", value, err)
	}
}
