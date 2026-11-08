package mediaproviders

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

var providerBlock = regexp.MustCompile(`\n  (\w+): \{\n    title: '([^']*)',\n    kinds: \[([^\]]*)\],\n    executor: (null|'\w+'),\n    paid: (true|false),`)

// TestRegistryMatchesFrontend — поля реестра Go совпадают с MEDIA_PROVIDERS renderer, порядок тоже.
func TestRegistryMatchesFrontend(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "shared", "media-providers.ts"))
	if err != nil {
		t.Fatal(err)
	}
	blocks := providerBlock.FindAllStringSubmatch(string(data), -1)
	if len(blocks) == 0 || len(blocks) != len(IDs()) {
		t.Fatalf("в renderer %d провайдеров, в Go %v", len(blocks), IDs())
	}
	for index, block := range blocks {
		kinds := []string{}
		for _, kind := range strings.Split(block[3], ",") {
			kinds = append(kinds, strings.Trim(strings.TrimSpace(kind), "'"))
		}
		want := Info{Title: block[2], Kinds: kinds, Executor: strings.Trim(strings.ReplaceAll(block[4], "null", ""), "'"), Paid: block[5] == "true"}
		got, _ := Lookup(block[1])
		if IDs()[index] != block[1] || got.Title != want.Title || !slices.Equal(got.Kinds, want.Kinds) || got.Executor != want.Executor || got.Paid != want.Paid {
			t.Fatalf("провайдер %s: Go %+v, renderer %+v", block[1], got, want)
		}
	}
}

func TestSupportsNormalizeRegister(t *testing.T) {
	if !Supports("codex", Image) || Supports("codex", Video) || Supports(5, Image) || Supports("Codex", Image) {
		t.Fatal("Supports")
	}
	if id, ok := Normalize("  KLING "); !ok || id != "kling" {
		t.Fatal("Normalize")
	}
	restore := Register("test", Info{Title: "Тест", Kinds: []string{Video}})
	if !Supports("test", Video) || IDs()[len(IDs())-1] != "test" {
		t.Fatal("Register")
	}
	restore()
	if _, ok := Lookup("test"); ok || slices.Contains(IDs(), "test") {
		t.Fatal("откат Register")
	}
}
