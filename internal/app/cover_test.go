package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"songframe-go/internal/covergen"
)

// newCoverSession создаёт сессию обложки на провайдере-агенте реестра без проверки выбора.
func newCoverSession(t *testing.T) (*covergen.Generator, string) {
	t.Helper()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	document := `{"name": "Клип", "generation": {"image": {"provider": "codex", "provider_selected": true}}}`
	if err := os.WriteFile(filepath.Join(project, "plan", "project.json"), []byte(document), 0o644); err != nil {
		t.Fatal(err)
	}
	temp := t.TempDir()
	generator := covergen.New(covergen.Options{
		AssertSelection: func(string) error { return nil },
		ReadImage:       covergen.ReadImage,
		CropImage:       covergen.CropImage,
		TempDir:         func() string { return temp },
	})
	t.Cleanup(func() { _ = generator.Shutdown() })
	session, err := generator.Create(project, "Обложка", nil)
	if err != nil {
		t.Fatal(err)
	}
	return generator, session.ID
}

// TestCoverWindowCleanup — закрытие или перезагрузка окна (closeOwned) закрывает сессии этого окна
// и удаляет их временные папки; сессии другого окна остаются.
func TestCoverWindowCleanup(t *testing.T) {
	generator, id := newCoverSession(t)
	other, err := generator.Create(func() string { project, _ := generator.Project(id); return project }(), "Другая", nil)
	if err != nil {
		t.Fatal(err)
	}
	routes := newCoverRoutes(generator, nil)
	routes.owners[1] = map[string]bool{id: true}
	routes.owners[2] = map[string]bool{other.ID: true}
	routes.projects[id], routes.projects[other.ID] = "a", "b"
	routes.closeOwned(1)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := generator.View(id); err != nil {
			if err.Error() != "Сессия обложки закрыта. Откройте генерацию заново." {
				t.Fatalf("закрытая сессия: %v", err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("сессия окна не закрыта")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := generator.View(other.ID); err != nil {
		t.Fatalf("сессия другого окна закрыта: %v", err)
	}
	if _, ok := routes.projects[id]; ok || routes.owners[1] != nil || routes.projects[other.ID] != "b" {
		t.Fatalf("владельцы после закрытия окна: %v, %v", routes.owners, routes.projects)
	}
}

// TestReferenceAttachTarget — повтор привязки той же сессии к другой сущности отклоняется до
// любых записей; повтор для той же сущности снова проходит обычную проверку сессии.
func TestReferenceAttachTarget(t *testing.T) {
	generator, id := newCoverSession(t)
	service := NewReferenceImagesService(generator, nil)
	service.attached[id] = "oleg"
	if err := service.Attach(id, "boat"); err == nil || err.Error() != textTargetChanged {
		t.Fatalf("другая сущность: %v", err)
	}
	if err := service.Attach(id, "oleg"); err == nil || err.Error() == textTargetChanged {
		t.Fatalf("та же сущность без готового изображения: %v", err)
	}
}
