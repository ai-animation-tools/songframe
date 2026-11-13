package checkworkspace

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/sceneregistry"
)

// Папка записей предложений производства лежит среди рабочих пакетов, но пакетом не считается:
// проверка рабочего дерева не сообщает о ней как о папке без плана-владельца.
func TestCollectSkipsProposals(t *testing.T) {
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(project, os.DirFS(filepath.Join(root, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	before, err := Collect(project)
	if err != nil {
		t.Fatal(err)
	}
	proposals := filepath.Join(project, filepath.FromSlash(sceneregistry.ProposalsDir))
	if err := os.MkdirAll(filepath.Join(proposals, "M01"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"M01.json": `{"schemaVersion":1,"discarded":"x"}`, "M01/K01.png": "png"} {
		if err := os.WriteFile(filepath.Join(proposals, filepath.FromSlash(name)), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	after, err := Collect(project)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before.Problems, after.Problems) {
		t.Fatalf("папка предложений дала несоответствия: %v", after.Problems)
	}
}
