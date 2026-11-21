package viewframe

import (
	"encoding/json"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/schemes"
)

// caseFile — общая таблица случаев testdata/golden/viewframe/cases.json. Её же читает тест карты точки съёмки на
// TypeScript (frontend/src/shared/viewframe.test.ts): направление, попадание в кадр и расстояния совпадают.
type caseFile struct {
	Schemes map[string]schemes.Scheme `json:"schemes"`
	Cases   []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Input       struct {
			Viewpoint json.RawMessage    `json:"viewpoint"`
			Scheme    *string            `json:"scheme"`
			Heights   map[string]float64 `json:"heights"`
		} `json:"input"`
		Expected json.RawMessage `json:"expected"`
	} `json:"cases"`
}

func TestGoldenFrames(t *testing.T) {
	var file caseFile
	if err := json.Unmarshal(golden.ReadFile(t, "viewframe", "cases.json"), &file); err != nil {
		t.Fatalf("viewframe/cases.json: %v", err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("viewframe/cases.json пуст")
	}
	for _, item := range file.Cases {
		t.Run(item.Name, func(t *testing.T) {
			viewpoint, err := ParseViewpoint([]byte(item.Input.Viewpoint))
			if err != nil {
				t.Fatal(err)
			}
			var scheme *schemes.Scheme
			if item.Input.Scheme != nil {
				found, ok := file.Schemes[*item.Input.Scheme]
				if !ok {
					t.Fatalf("нет схемы %q", *item.Input.Scheme)
				}
				scheme = &found
			}
			got, err := json.Marshal(Compute(viewpoint, scheme, item.Input.Heights))
			if err != nil {
				t.Fatal(err)
			}
			if len(item.Expected) == 0 {
				t.Fatalf("нет ожидаемого результата; получено:\n%s", got)
			}
			golden.AssertJSON(t, item.Expected, got)
		})
	}
}
