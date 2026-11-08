package cutspeech_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/cutspeech"
	"songframe/internal/golden"
)

// TestCanceledCutWritesNothing — отменённое задание останавливает декодирование: код 1, текст
// отмены в stderr, папка вывода не создаётся.
func TestCanceledCutWritesNothing(t *testing.T) {
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(t.TempDir(), "project")
	copyDir(t, filepath.Join(base, "cut-speech", "project"), project)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := filepath.Join(project, "audio")
	result := cutspeech.Run(ctx, project, []string{"cut", "M02", "--out", out, "--start", "0.1", "--end", "0.2"})
	if result.Code != 1 || result.Stderr == "" || result.Stdout != "" {
		t.Fatalf("исход отмены: %+v", result)
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatalf("папка вывода создана: %v", err)
	}
}
