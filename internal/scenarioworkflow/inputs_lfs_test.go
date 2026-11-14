package scenarioworkflow

import (
	"os"
	"path/filepath"
	"testing"
)

// TestSourceChangedLFSPointer — несовпадение SHA исходника: указатель Git LFS получает текст с
// командой загрузки, обычная правка и отсутствие файла — прежний текст проверки исходников.
func TestSourceChangedLFSPointer(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "source"), 0o755); err != nil {
		t.Fatal(err)
	}
	track := filepath.Join(project, "source", "track.mp3")
	if err := os.WriteFile(track, []byte("version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := sourceChanged(project, "source/track.mp3", textSourceFileChanged)
	if want := "Файл source/track.mp3 — указатель Git LFS, а не само содержимое. Выполните в папке проекта git lfs pull."; err == nil || err.Error() != want {
		t.Fatalf("указатель: %v", err)
	}
	if err := os.WriteFile(track, []byte("ID3"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := sourceChanged(project, "source/track.mp3", textSourceFileChanged); err == nil || err.Error() != textSourceFileChanged("source/track.mp3") {
		t.Fatalf("правка: %v", err)
	}
	if err := sourceChanged(project, "source/heroes/a.png", textSourceImageChanged); err == nil || err.Error() != textSourceImageChanged("source/heroes/a.png") {
		t.Fatalf("нет файла: %v", err)
	}
}
