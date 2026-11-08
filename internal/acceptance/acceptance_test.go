package acceptance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
)

// TestComputeMatchesGolden сверяет итог Compute (отпечатки, состояние и причины) с
// expected-acceptance.json эталонов статуса.
func TestComputeMatchesGolden(t *testing.T) {
	checked := 0
	for _, item := range golden.Load(t, "status") {
		want, err := os.ReadFile(filepath.Join(item.Dir, "expected-acceptance.json"))
		if err != nil {
			continue
		}
		checked++
		t.Run(item.Name, func(t *testing.T) {
			path := item.ProjectPath()
			scenes, ok := dynvalue.ReadJSONFile(filepath.Join(path, "plan", "scenes.json"))
			if !ok {
				t.Fatal("эталон есть, а scenes.json не читается")
			}
			result, err := Compute(path, scenes)
			var throws struct {
				Throws *string `json:"throws"`
			}
			if json.Unmarshal(want, &throws) == nil && throws.Throws != nil {
				if err == nil {
					t.Fatalf("эталон бросает %q, Go вернул %+v", *throws.Throws, result)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, want, result, path)
		})
	}
	if checked == 0 {
		t.Fatal("нет ни одного expected-acceptance.json")
	}
}
