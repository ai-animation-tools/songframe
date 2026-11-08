package trash

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMoveToHomeTrash — папка уходит в files/ корзины с записью info, повторное имя не затирает первое.
func TestMoveToHomeTrash(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	for range 2 {
		folder := filepath.Join(root, "результат")
		if err := os.MkdirAll(folder, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(folder, "vocals.wav"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := Move(folder); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(folder); !os.IsNotExist(err) {
			t.Fatalf("папка осталась на месте: %v", err)
		}
	}
	trash := filepath.Join(root, "data", "Trash")
	for _, name := range []string{"результат", "результат.2"} {
		if _, err := os.Stat(filepath.Join(trash, "files", name, "vocals.wav")); err != nil {
			t.Fatal(err)
		}
		info, err := os.ReadFile(filepath.Join(trash, "info", name+".trashinfo"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(info), "[Trash Info]\nPath=/") || !strings.Contains(string(info), "%D1%80%D0%B5") {
			t.Fatalf("запись корзины: %q", info)
		}
	}
	if err := Move(filepath.Join(root, "нет")); err == nil {
		t.Fatal("отсутствующий путь должен давать ошибку")
	}
}
