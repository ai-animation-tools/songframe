package acceptshot

import (
	"os"
	"path/filepath"
	"testing"
)

// TestKitExists — комплектом считается только непустая папка плана в assets; пустая (след отката клипа)
// удаляется и приёмку не останавливает.
func TestKitExists(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "M01")
	if exists, err := kitExists(missing); exists || err != nil {
		t.Fatalf("нет папки: %v %v", exists, err)
	}
	empty := filepath.Join(root, "M02")
	if err := os.Mkdir(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	if exists, err := kitExists(empty); exists || err != nil {
		t.Fatalf("пустая папка: %v %v", exists, err)
	}
	if _, err := os.Stat(empty); !os.IsNotExist(err) {
		t.Fatalf("пустая папка не удалена: %v", err)
	}
	kit := filepath.Join(root, "M03")
	if err := os.MkdirAll(kit, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(kit, "manifest.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if exists, err := kitExists(kit); !exists || err != nil {
		t.Fatalf("комплект: %v %v", exists, err)
	}
}
