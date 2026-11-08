package cast

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
)

// fixedNow — фиксированное время updated_at, записанное в эталонах.
var fixedNow = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

// TestViewMatchesGolden сверяет viewCast с эталонами cast-view и проверяет, что чтение не пишет.
func TestViewMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "cast-view") {
		t.Run(item.Name, func(t *testing.T) {
			path := item.ProjectPath()
			before := treeFiles(t, path)
			view, err := ViewProject(path)
			var want struct {
				Throws *string `json:"throws"`
			}
			_ = json.Unmarshal(item.Expected(t), &want)
			if want.Throws != nil {
				if err == nil {
					t.Fatalf("эталон завершился исключением %q, Go вернул результат", *want.Throws)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, item.Expected(t), view, path)
			assertSameTree(t, before, treeFiles(t, path))
		})
	}
}

// writeExpectation — expected.json записывающих доменов: ошибка, результат, изменённые файлы и
// повторный вызов на результате.
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

// TestWriteMatchesGolden сверяет initCast/writeCast: текст ошибки, результат, состав и байты
// изменённых файлов, стабильность повторного сохранения. Запись — на копии входа.
func TestWriteMatchesGolden(t *testing.T) {
	previous := now
	now = func() time.Time { return fixedNow }
	defer func() { now = previous }()
	for _, item := range golden.Load(t, "cast-write") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			var want writeExpectation
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			var input any
			if item.Call == "writeCast" {
				parsed, err := jscompat.Parse(item.Read(t, "cast-input.json"))
				if err != nil {
					t.Fatal(err)
				}
				input = parsed
			}
			run := func(value any) (*jscompat.Object, error) {
				if item.Call == "initCast" {
					return Init(project)
				}
				return Save(project, value)
			}
			before := treeFiles(t, project)
			result, err := run(input)
			after := treeFiles(t, project)
			assertWrite(t, item, want.Error, want.Result, want.Files, err, result, before, after, project)
			if want.Resave == nil {
				return
			}
			again, err := run(jscompat.DeepClone(result))
			if want.Resave.Error != nil || err != nil {
				t.Fatalf("повторное сохранение: эталон %v, Go %v", want.Resave.Error, err)
			}
			if same := jscompat.Stringify(again) == jscompat.Stringify(result); same != want.Resave.SameResult {
				t.Fatalf("повторный результат совпадает: %v, ожидалось %v", same, want.Resave.SameResult)
			}
			assertFiles(t, want.Resave.Files, changes(after, treeFiles(t, project)))
		})
	}
}

// assertWrite — общая сверка записывающего вызова с эталоном.
func assertWrite(t *testing.T, item golden.Case, wantError *string, wantResult json.RawMessage, wantFiles map[string]string, err error, result any, before, after map[string][]byte, project string) {
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
		golden.AssertJSON(t, wantResult, []byte(jscompat.Stringify(result)))
	}
	got := changes(before, after)
	assertFiles(t, wantFiles, got)
	for path, state := range got {
		if state == "removed" {
			continue
		}
		expected, readErr := os.ReadFile(filepath.Join(item.Dir, "files", filepath.FromSlash(path)))
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

// treeFiles — содержимое дерева по относительному пути через «/».
func treeFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	if _, err := os.Stat(root); err != nil {
		return result
	}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		result[filepath.ToSlash(rel)] = data
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// changes — created/changed/removed по пути, в формате изменений дерева эталона.
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

func assertSameTree(t *testing.T, before, after map[string][]byte) {
	t.Helper()
	if diff := changes(before, after); len(diff) > 0 {
		keys := make([]string, 0, len(diff))
		for key := range diff {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		t.Fatalf("чтение изменило файлы: %v", keys)
	}
}
