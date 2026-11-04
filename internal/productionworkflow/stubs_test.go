package productionworkflow

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"testing"
)

// Неперенесённые действия зарегистрированы и отказывают своим текстом до любых проверок
// входа и без записей: применение — этап 45g.2, создание и импорт опор — этап 45g.3.
func TestNotMigratedActionsRefuse(t *testing.T) {
	local := t.TempDir()
	w := New(Options{LocalDir: local})
	if _, err := w.Apply("/нет", "M01", "", "p"); err == nil || err.Error() != TextApplyNotMigrated {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := w.GenerateFrames(context.Background(), "/нет", "M01", ""); err == nil || err.Error() != TextFramesNotMigrated {
		t.Fatalf("GenerateFrames: %v", err)
	}
	if _, err := w.ImportFrames("/нет", "M01", "", []FrameCandidate{{ID: "K01", Path: "/нет.png"}}); err == nil || err.Error() != TextFramesNotMigrated {
		t.Fatalf("ImportFrames: %v", err)
	}
	if entries, err := readDirNames(local); err != nil || len(entries) != 0 {
		t.Fatalf("каталог состояния изменён: %v %v", entries, err)
	}
}

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
