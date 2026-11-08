package repodocs

import (
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// update перезаписывает docs/code-map.md сгенерированной картой: `wails3 task docs:map`.
var update = flag.Bool("update", false, "перезаписать docs/code-map.md")

// TestCodeMap требует, чтобы карта кода покрывала все пакеты и страницы и совпадала с
// закоммиченной. Падение после добавления пакета или страницы — сигнал внести их в areas.go,
// написать комментарий и выполнить `wails3 task docs:map`.
func TestCodeMap(t *testing.T) {
	got, err := RenderCodeMap(repoRoot)
	if err != nil {
		t.Fatalf("карта кода не собирается:\n%v", err)
	}
	file := filepath.Join(repoRoot, CodeMapFile)
	if *update {
		if err := os.WriteFile(file, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("%v: выполните `wails3 task docs:map`", err)
	}
	if string(want) != got {
		t.Fatalf("%s устарела: выполните `wails3 task docs:map` и закоммитьте результат", CodeMapFile)
	}
}
