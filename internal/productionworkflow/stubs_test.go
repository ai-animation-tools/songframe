package productionworkflow

import (
	"errors"
	"io/fs"
	"os"
	"testing"
)

// Busy и PendingProposals служат списку планов: ошибка чтения проекта не ломает список,
// а даёт «не занят» и пустую сводку (не nil, чтобы Go отдал {}).
func TestFlowToleratesMissingProject(t *testing.T) {
	w := New(Options{LocalDir: t.TempDir()})
	if w.Busy("/нет-такого-проекта", "M01", "") {
		t.Fatal("Busy для отсутствующего проекта")
	}
	pending := w.PendingProposals("/нет-такого-проекта")
	if pending == nil || len(pending) != 0 {
		t.Fatalf("PendingProposals: %#v", pending)
	}
}

// readDirNames — имена в каталоге; отсутствующий каталог — пустой список.
func readDirNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names, err
}
