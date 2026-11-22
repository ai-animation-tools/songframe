package scenarioworkflow

import (
	"os"
	"path/filepath"
	"testing"
)

// fileHash отдаёт SHA-256 байтов через кэш filedigest: повторный вызов без изменений даёт тот же
// хеш, перезапись файла — новый; отсутствующий файл — nil, каталог на месте файла — ошибка.
func TestFileHashFollowsChanges(t *testing.T) {
	project := t.TempDir()
	path := filepath.Join(project, "source", "a.txt")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(text string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	hash := func(relative string) *string {
		t.Helper()
		value, err := fileHash(project, relative)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	write("первый")
	first := hash("source/a.txt")
	if first == nil || *first != digestText([]byte("первый")) {
		t.Fatalf("хеш %v", first)
	}
	if again := hash("source/a.txt"); again == nil || *again != *first {
		t.Fatalf("повторный хеш %v", again)
	}
	write("второй")
	if changed := hash("source/a.txt"); changed == nil || *changed != digestText([]byte("второй")) {
		t.Fatalf("после правки %v", changed)
	}
	if missing := hash("source/b.txt"); missing != nil {
		t.Fatalf("нет файла: %v", *missing)
	}
	if err := os.Mkdir(filepath.Join(project, "source", "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := fileHash(project, "source/dir"); err == nil {
		t.Fatal("каталог на месте файла должен давать ошибку")
	}
}
