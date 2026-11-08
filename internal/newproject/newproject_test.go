package newproject

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
)

// TestValidateGolden — Validate на эталонах testdata/golden/project-validate-new.
func TestValidateGolden(t *testing.T) {
	var cases []struct {
		Name  string `json:"name"`
		Setup struct {
			Dirs  []string `json:"dirs"`
			Files []string `json:"files"`
		} `json:"setup"`
		Input    json.RawMessage `json:"input"`
		Expected []string        `json:"expected"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "project-validate-new", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			base := filepath.Join(t.TempDir(), "base")
			for _, dir := range append([]string{""}, item.Setup.Dirs...) {
				if err := os.MkdirAll(filepath.Join(base, dir), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for _, file := range item.Setup.Files {
				if err := os.WriteFile(filepath.Join(base, file), []byte("x\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			var input Input
			if err := json.Unmarshal([]byte(strings.ReplaceAll(string(item.Input), "<base>", base)), &input); err != nil {
				t.Fatal(err)
			}
			got := Validate(input)
			for index := range got {
				got[index] = strings.ReplaceAll(got[index], base, "<base>")
			}
			golden.AssertValue(t, mustJSON(t, item.Expected), got, "")
		})
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDefaultAnimaticName(t *testing.T) {
	for name, want := range map[string]string{
		"Night Drive 2":  "night-drive-2-animatic.mp4",
		"Огород":         "animatic.mp4",
		"--Эхо: Live!--": "live-animatic.mp4",
		"İX":             "i-x-animatic.mp4",
		"":               "animatic.mp4",
	} {
		if got := DefaultAnimaticName(name); got != want {
			t.Errorf("%q: %q, ожидалось %q", name, got, want)
		}
	}
}

func TestRenderPlaceholders(t *testing.T) {
	values := Placeholders{"project_name": "Клип {{animatic_video}}", "animatic_video": "a.mp4"}
	got := RenderPlaceholders("{{project_name}} {{ animatic_video }} {{unknown}} {{Project_name}}", values)
	if want := "Клип {{animatic_video}} a.mp4 {{unknown}} {{Project_name}}"; got != want {
		t.Fatalf("%q", got)
	}
	if !isText(".gitignore") || !isText("README.md") || isText("cover.png") || isText("Makefile") {
		t.Fatal("выбор текстовых файлов отличается от эталона")
	}
}
