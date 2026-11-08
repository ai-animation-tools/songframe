package app

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/store"
)

// registrySpy проверяет, что сервис регистрирует только выбранный файл и передаёт ошибку пользователю.
type registrySpy struct {
	paths []string
	roots []string
	err   error
}

func (r *registrySpy) AllowRoot(path string) error {
	r.roots = append(r.roots, path)
	return nil
}

func (r *registrySpy) Register(path string) (string, error) {
	r.paths = append(r.paths, path)
	return "http://127.0.0.1:1234/media/fixture", r.err
}

func TestProjectServiceMediaValidation(t *testing.T) {
	root := t.TempDir()
	registry := &registrySpy{}
	service := NewProjectService(registry, t.TempDir())
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
// TestProjectServiceOpenMatchesGolden проходит все эталоны status: open либо отклоняет папку
// текстом эталона, либо возвращает тот же статус, что status, и делает проект текущим.
func TestProjectServiceOpenMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "status") {
		if !item.HasProject() {
			continue
		}
		t.Run(item.Name, func(t *testing.T) {
			root := item.CopyProject(t)
			var open struct {
				Error        *string `json:"error"`
				SameAsStatus *bool   `json:"sameAsStatus"`
				Throws       any     `json:"throws"`
			}
			if err := json.Unmarshal(item.Read(t, "expected-open.json"), &open); err != nil {
				t.Fatal(err)
			}
			local := t.TempDir()
			roots := &registrySpy{}
			service := NewProjectService(roots, local)
			value, err := service.Open(root)
			if open.Error != nil || open.Throws != nil {
				if err == nil {
					t.Fatal("открыт проект, который эталон отклоняет")
				}
				if open.Error != nil && strings.ReplaceAll(err.Error(), root, "<project>") != *open.Error {
					t.Fatalf("текст ошибки: %q", err.Error())
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, item.Expected(t), value, root)
			if current, _ := store.NewLocalState(local).Current(); current != root || len(roots.roots) != 1 {
				t.Fatalf("текущий проект %q, корни %v", current, roots.roots)
			}
		})
	}
}

func TestProjectServiceHistoryAndClose(t *testing.T) {
	item := golden.Load(t, "status")[0]
	for _, candidate := range golden.Load(t, "status") {
		if candidate.Name == "sample" {
			item = candidate
		}
	}
	root := item.CopyProject(t)
	local := t.TempDir()
	service := NewProjectService(&registrySpy{}, local)
	if _, err := service.Open(root); err != nil {
		t.Fatal(err)
	}
	state := store.NewLocalState(local)
	if history, _ := state.History(); len(history) != 1 || history[0].Path != root {
		t.Fatalf("история: %+v", history)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	if current, _ := state.Current(); current != "" {
		t.Fatalf("после close текущий %q", current)
	}
	if _, err := service.Open(root); err != nil {
		t.Fatal(err)
	}
	if err := service.Forget(root); err != nil {
		t.Fatal(err)
	}
	if history, _ := state.History(); len(history) != 0 {
		t.Fatalf("после forget: %+v", history)
	}
	if current, _ := state.Current(); current != "" {
		t.Fatalf("forget не снял текущий %q", current)
	}
}
