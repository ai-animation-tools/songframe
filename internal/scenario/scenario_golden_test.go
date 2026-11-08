package scenario

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
)

// TestViewMatchesGolden сверяет viewScenario, readScenarioRegistry и validateScenes с эталонами
// scenario-view и проверяет, что чтение не пишет.
func TestViewMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "scenario-view") {
		t.Run(item.Name, func(t *testing.T) {
			path := item.ProjectPath()
			before := treeFiles(t, path)
			view, err := ViewProject(path)
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, item.Expected(t), view, path)
			golden.AssertValue(t, item.Read(t, "expected-status.json"), RegistryStatus(path), path)
			if diff := changes(before, treeFiles(t, path)); len(diff) > 0 {
				t.Fatalf("чтение изменило файлы: %v", diff)
			}
		})
	}
}

// TestBriefMatchesGolden сверяет buildBrief для всех пар план/фаза эталонов scenario-brief.
func TestBriefMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "scenario-brief") {
		t.Run(item.Name, func(t *testing.T) {
			path := item.ProjectPath()
			var spec struct {
				Briefs [][2]string `json:"briefs"`
			}
			if err := json.Unmarshal(item.Read(t, "case.json"), &spec); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(item.Dir, "scenes-input.json"))
			if err != nil {
				raw = item.Read(t, "project/plan/scenes.json")
			}
			data, err := dynvalue.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			pairs := spec.Briefs
			if pairs == nil {
				scenes, _ := dynvalue.AsArray(dynvalue.Get(data, "scenes"))
				for _, scene := range scenes {
					id := dynvalue.ToString(dynvalue.Get(scene, "id"))
					pairs = append(pairs, [2]string{id, "before"}, [2]string{id, "after"})
				}
			}
			type entry struct {
				Shot   string  `json:"shot"`
				Phase  string  `json:"phase"`
				Result *Brief  `json:"result,omitempty"`
				Error  *string `json:"error,omitempty"`
			}
			got := []entry{}
			for _, pair := range pairs {
				brief, err := BuildBrief(dynvalue.DeepClone(data), readCastValue(path), pair[0], pair[1])
				if err != nil {
					message := err.Error()
					got = append(got, entry{Shot: pair[0], Phase: pair[1], Error: &message})
				} else {
					got = append(got, entry{Shot: pair[0], Phase: pair[1], Result: &brief})
				}
			}
			golden.AssertValue(t, item.Expected(t), got, path)
		})
	}
}

// writeExpectation — expected.json записывающих доменов (см. README эталонов).
type writeExpectation struct {
	Error  *string           `json:"error"`
	Result json.RawMessage   `json:"result"`
	Files  map[string]string `json:"files"`
	Resave *struct {
		Error      *string           `json:"error"`
		SameResult bool              `json:"sameResult"`
		Files      map[string]string `json:"files"`
	} `json:"resave"`
}

// treatmentExpectation — expected.json scenario-treatment: общий формат записи и originalError —
// текст отказа строгой проверки для случаев, которые сохраняются черновиком (см. README эталонов).
type treatmentExpectation struct {
	writeExpectation
	OriginalError *string `json:"originalError"`
}

// TestSaveTreatmentMatchesGolden сверяет saveTreatment: ошибка, результат, байты файла и повтор,
// а также проблемы ValidateProjectTreatment того же входа. Содержательные проблемы не отклоняют
// сохранение; у таких случаев проблемы через пробел равны тексту строгого отказа (originalError),
// у корректных трактовок — пусты, у неверной структуры — один текст отказа.
func TestSaveTreatmentMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "scenario-treatment") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			input, err := dynvalue.Parse(item.Read(t, "treatment-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			var want treatmentExpectation
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			before := treeFiles(t, project)
			problems, err := ValidateProjectTreatment(project, dynvalue.DeepClone(input))
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case want.Error != nil:
				if len(problems) != 1 || problems[0] != *want.Error {
					t.Fatalf("проблемы неверной структуры: %q", problems)
				}
			case want.OriginalError != nil:
				if got := strings.Join(problems, " "); got != *want.OriginalError {
					t.Fatalf("проблемы черновика\n  Go: %s\n  TS: %s", got, *want.OriginalError)
				}
			case len(problems) != 0:
				t.Fatalf("эталон принял трактовку, Go нашёл проблемы: %q", problems)
			}
			if diff := changes(before, treeFiles(t, project)); len(diff) > 0 {
				t.Fatalf("проверка черновика изменила файлы: %v", diff)
			}
			result, err := SaveTreatment(project, input)
			after := treeFiles(t, project)
			AssertWrite(t, item.Dir, want.Error, want.Result, want.Files, err, result, before, after)
			if want.Resave != nil {
				again, err := SaveTreatment(project, dynvalue.DeepClone(result))
				if err != nil || (dynvalue.Stringify(again) == dynvalue.Stringify(result)) != want.Resave.SameResult {
					t.Fatalf("повторное сохранение: %v", err)
				}
				assertFiles(t, want.Resave.Files, changes(after, treeFiles(t, project)))
			}
		})
	}
}

// TestNormalizeTreatmentRejectsProblems — строгая нормализация (ответ агента) отклоняет
// трактовку с содержательными проблемами текстом originalError эталона.
func TestNormalizeTreatmentRejectsProblems(t *testing.T) {
	for _, item := range golden.Load(t, "scenario-treatment") {
		t.Run(item.Name, func(t *testing.T) {
			var want treatmentExpectation
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			input, err := dynvalue.Parse(item.Read(t, "treatment-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			duration, err := projectDuration(item.ProjectPath())
			if err != nil {
				t.Fatal(err)
			}
			_, err = NormalizeTreatment(input, duration)
			expected := want.Error
			if expected == nil {
				expected = want.OriginalError
			}
			switch {
			case expected == nil && err != nil:
				t.Fatalf("эталон принял, Go: %v", err)
			case expected != nil && (err == nil || err.Error() != *expected):
				t.Fatalf("ошибка\n  Go: %v\n  TS: %s", err, *expected)
			}
		})
	}
}

// AssertWrite — общая сверка записывающего вызова с эталоном: текст ошибки, результат, состав и
// байты изменённых файлов (files/<путь> каталога случая).
func AssertWrite(t *testing.T, dir string, wantError *string, wantResult json.RawMessage, wantFiles map[string]string, err error, result any, before, after map[string][]byte) {
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
	if _, err := os.Stat(root); err != nil {
		return result
	}
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
