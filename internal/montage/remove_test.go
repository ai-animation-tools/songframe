package montage

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRemoveDraft: удаляется только файл черновика, повторное удаление не ошибка, а идентификатор
// проверяется так же, как при чтении, поэтому путь за пределы plan/montage недостижим.
func TestRemoveDraft(t *testing.T) {
	project := t.TempDir()
	directory := filepath.Join(project, "plan", "montage")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	const id = "2fe903c0-b6d3-4176-9692-dda994878f85"
	kept := filepath.Join(directory, "3056de6f-b1b4-4df9-8cc5-c710aed5cd98.json")
	for _, path := range []string{filepath.Join(directory, id+".json"), kept} {
		if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := RemoveDraft(project, id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(directory, id+".json")); !os.IsNotExist(err) {
		t.Fatalf("черновик не удалён: %v", err)
	}
	if _, err := os.Stat(kept); err != nil {
		t.Fatalf("соседний черновик затронут: %v", err)
	}
	if err := RemoveDraft(project, id); err != nil {
		t.Fatalf("повторное удаление: %v", err)
	}
	if err := RemoveDraft(project, "../../project"); err == nil {
		t.Fatal("недопустимый идентификатор принят")
	}
}
