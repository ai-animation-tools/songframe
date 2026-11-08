package scenesave

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/scenario"
)

// TestSaveMatchesGolden повторяет вызовы страницы сценария на эталонах scenario-scenes: оценку
// сохранения и проверку черновика до записи, затем saveScenesWithMode в режиме случая и повторное
// сохранение результата. Сверяются ответы, тексты ошибок, состав и байты изменённых файлов
// (plan/scenes.json, plan/production-status.json, workflow.json пакетов).
func TestSaveMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "scenario-scenes") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			var spec struct {
				Mode string `json:"mode"`
			}
			if err := json.Unmarshal(item.Read(t, "case.json"), &spec); err != nil {
				t.Fatal(err)
			}
			input, err := dynvalue.Parse(item.Read(t, "scenes-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			before := treeFiles(t, project)

			impact, err := SaveImpact(project, dynvalue.DeepClone(input))
			assertOutcome(t, "оценка", item.Read(t, "expected-impact.json"), impact, err, project)
			problems, err := scenario.ValidateProjectScenes(project, dynvalue.DeepClone(input))
			assertOutcome(t, "проверка", item.Read(t, "expected-validate.json"), problems, err, project)
			if diff := changes(before, treeFiles(t, project)); len(diff) > 0 {
				t.Fatalf("оценка и проверка изменили файлы: %v", diff)
			}

			var want struct {
				Error  *string           `json:"error"`
				Result json.RawMessage   `json:"result"`
				Files  map[string]string `json:"files"`
				Resave *struct {
					Error      *string           `json:"error"`
					SameResult bool              `json:"sameResult"`
					Files      map[string]string `json:"files"`
				} `json:"resave"`
			}
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			saved, err := SaveScenesWithMode(project, dynvalue.DeepClone(input), spec.Mode)
			after := treeFiles(t, project)
			assertWrite(t, item.Dir, want.Error, want.Result, want.Files, err, saved, before, after)
			if want.Resave != nil {
				again, err := SaveScenesWithMode(project, dynvalue.DeepClone(saved), spec.Mode)
				gotError := ""
				if err != nil {
					gotError = err.Error()
				}
				wantError := ""
				if want.Resave.Error != nil {
					wantError = *want.Resave.Error
				}
				if gotError != wantError {
					t.Fatalf("повторное сохранение: Go %q, TS %q", gotError, wantError)
				}
				if err == nil && (dynvalue.Stringify(again) == dynvalue.Stringify(saved)) != want.Resave.SameResult {
					t.Fatal("повторное сохранение вернуло другой реестр")
				}
				assertFiles(t, want.Resave.Files, changes(after, treeFiles(t, project)))
			}
		})
	}
}

// assertOutcome сверяет ответ без записи: значение либо `{throws}` эталона при исключении.
func assertOutcome(t *testing.T, label string, want []byte, got any, err error, root string) {
	t.Helper()
	var thrown struct {
		Throws *string `json:"throws"`
	}
	_ = json.Unmarshal(want, &thrown)
	switch {
	case thrown.Throws != nil && err == nil:
		t.Fatalf("%s: эталон бросил %q, Go вернул значение", label, *thrown.Throws)
	case thrown.Throws == nil && err != nil:
		t.Fatalf("%s: %v", label, err)
	case err == nil:
		golden.AssertValue(t, want, got, root)
	}
}

// assertWrite сверяет записывающий вызов: текст ошибки, результат, состав и байты изменённых файлов.
func assertWrite(t *testing.T, dir string, wantError *string, wantResult json.RawMessage, wantFiles map[string]string, err error, result any, before, after map[string][]byte) {
	t.Helper()
	switch {
	case wantError != nil && err == nil:
		t.Fatalf("эталон отказал %q, Go сохранил", *wantError)
	case wantError == nil && err != nil:
		t.Fatalf("эталон сохранил, Go: %v", err)
	case wantError != nil && err.Error() != *wantError:
		t.Fatalf("ошибка\n  Go:  %s\n  TS:  %s", err, *wantError)
	}
	if wantError == nil {
		golden.AssertJSON(t, wantResult, []byte(dynvalue.Stringify(result)))
	}
	got := changes(before, after)
	assertFiles(t, wantFiles, got)
	for path, state := range got {
		if state == "removed" {
			continue
		}
		expected, readErr := os.ReadFile(filepath.Join(dir, "files", filepath.FromSlash(path)))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if !bytes.Equal(expected, after[path]) {
			t.Fatalf("%s: байты отличаются\n  Go: %q\n  TS: %q", path, after[path], expected)
		}
	}
}

func assertFiles(t *testing.T, want, got map[string]string) {
	t.Helper()
	if want == nil {
		want = map[string]string{}
	}
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if !bytes.Equal(wantJSON, gotJSON) {
		t.Fatalf("изменённые файлы\n  Go: %s\n  TS: %s", gotJSON, wantJSON)
	}
}

func treeFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		rel, _ := filepath.Rel(root, path)
		result[filepath.ToSlash(rel)] = data
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return result
}

func changes(before, after map[string][]byte) map[string]string {
	result := map[string]string{}
	for path, data := range after {
		previous, ok := before[path]
		switch {
		case !ok:
			result[path] = "created"
		case !bytes.Equal(previous, data):
			result[path] = "changed"
		}
	}
	for path := range before {
		if _, ok := after[path]; !ok {
			result[path] = "removed"
		}
	}
	return result
}
