package drafts

import (
	"os"
	"path/filepath"
	"testing"
)

// TestDraftLifecycle — запись, чтение, замена и удаление черновика; каталог проекта убирается вместе с последним.
func TestDraftLifecycle(t *testing.T) {
	state := t.TempDir()
	project := filepath.Join(t.TempDir(), "клип")
	store := NewStore(state)
	if content, err := store.Read(project, "schemes"); err != nil || content != "" {
		t.Fatalf("пустой черновик: %q, %v", content, err)
	}
	if err := store.Write(project, "schemes", `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	if err := store.Write(project, "scenes", `{"b":2}`); err != nil {
		t.Fatal(err)
	}
	if err := store.Write(project, "schemes", `{"a":2}`); err != nil {
		t.Fatal(err)
	}
	if content, _ := store.Read(project, "schemes"); content != `{"a":2}` {
		t.Fatalf("черновик схем: %q", content)
	}
	// Черновик лежит в каталоге состояния, а не в папке проекта.
	if _, err := os.Stat(project); !os.IsNotExist(err) {
		t.Fatalf("папка проекта не должна появиться: %v", err)
	}
	if err := store.Remove(project, "schemes"); err != nil {
		t.Fatal(err)
	}
	if content, _ := store.Read(project, "scenes"); content != `{"b":2}` {
		t.Fatalf("черновик сцен должен остаться: %q", content)
	}
	if err := store.Remove(project, "scenes"); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(project, "scenes"); err != nil {
		t.Fatalf("повторное удаление: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(state, "drafts"))
	if len(entries) != 0 {
		t.Fatalf("каталог проекта должен быть удалён: %v", entries)
	}
}

// TestDraftRejects — неизвестный вид, пустой проект и не JSON не записываются.
func TestDraftRejects(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := store.Write("p", "timing", `{}`); err == nil {
		t.Fatal("неизвестный вид должен отклоняться")
	}
	if err := store.Write("", "scenes", `{}`); err == nil {
		t.Fatal("пустой проект должен отклоняться")
	}
	if err := store.Write("p", "scenes", `{`); err == nil {
		t.Fatal("не JSON должен отклоняться")
	}
}

// TestDraftsPerProject — у разных проектов разные черновики; относительный и абсолютный путь — один проект.
func TestDraftsPerProject(t *testing.T) {
	store := NewStore(t.TempDir())
	base := t.TempDir()
	first, second := filepath.Join(base, "a"), filepath.Join(base, "b")
	_ = store.Write(first, "scenes", `1`)
	_ = store.Write(second, "scenes", `2`)
	if content, _ := store.Read(first, "scenes"); content != "1" {
		t.Fatalf("первый проект: %q", content)
	}
	wd, _ := os.Getwd()
	relative, err := filepath.Rel(wd, second)
	if err != nil {
		t.Skip("нет относительного пути")
	}
	if content, _ := store.Read(relative, "scenes"); content != "2" {
		t.Fatalf("относительный путь: %q", content)
	}
}
