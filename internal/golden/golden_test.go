package golden

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCasesAreComplete проверяет целостность снятых эталонов: у каждого случая есть описание,
// функция оригинала, ожидаемый JSON и вход, наличие которого совпадает с case.json.
func TestCasesAreComplete(t *testing.T) {
	calls := map[string]string{"status": "computeStatus", "timing-view": "viewTiming", "timing-save": "saveTiming"}
	for domain, call := range calls {
		for _, item := range Load(t, domain) {
			t.Run(domain+"/"+item.Name, func(t *testing.T) {
				if item.Call != call || item.Description == "" || len(item.Covers) == 0 {
					t.Fatalf("неполный case.json: %+v", item)
				}
				_, err := os.Stat(item.ProjectPath())
				if item.HasProject() != (err == nil) {
					t.Fatalf("наличие входа %v не совпадает с case.json", err == nil)
				}
				var expected map[string]any
				if err := json.Unmarshal(item.Expected(t), &expected); err != nil {
					t.Fatal(err)
				}
				// Абсолютные пути машины не должны попадать в эталон.
				if strings.Contains(string(item.Expected(t)), "/tmp/") || strings.Contains(string(item.Expected(t)), "/home/") {
					t.Fatal("в эталоне остался абсолютный путь")
				}
				if domain == "status" {
					if _, throws := expected["throws"]; !throws && expected["path"] != ProjectMarker {
						t.Fatalf("path статуса %v", expected["path"])
					}
					item.Read(t, "expected-open.json")
				}
				if domain == "timing-save" {
					checkSaveCase(t, item, expected)
				}
			})
		}
	}
}

// checkSaveCase сверяет записанный файл saveTiming с возвращённым результатом того же вызова.
func checkSaveCase(t *testing.T, item Case, expected map[string]any) {
	t.Helper()
	item.Read(t, "timing-input.json")
	if expected["error"] != nil {
		if expected["fileUnchanged"] != true {
			t.Fatal("ошибка сохранения должна оставлять файл без изменений")
		}
		return
	}
	result, err := json.Marshal(expected["result"])
	if err != nil {
		t.Fatal(err)
	}
	written := item.Read(t, "expected-timing.json")
	AssertJSON(t, result, written)
	if !strings.HasSuffix(string(written), "}\n") {
		t.Fatal("оригинал завершает timing.json переводом строки")
	}
}

// TestValidationCases проверяет, что общий для Go и TS файл validateTiming разбирается.
func TestValidationCases(t *testing.T) {
	names := map[string]bool{}
	for _, item := range ValidationCases(t) {
		if names[item.Name] || item.Expected == nil || len(item.Input.Timing) == 0 || len(item.Input.Lyrics) == 0 {
			t.Fatalf("неполный случай %+v", item.Name)
		}
		names[item.Name] = true
	}
	if !names["valid"] || !names["combined"] {
		t.Fatal("нет опорных случаев valid/combined")
	}
}

// TestDiff фиксирует правила сравнения: порядок ключей и запись чисел не важны, null/отсутствие/[] различаются.
func TestDiff(t *testing.T) {
	same := [][2]string{
		{`{"a":1,"b":[1,2]}`, `{"b":[1,2],"a":1}`},
		{`{"start":8.0}`, `{"start":8}`},
		{`{"x":1e1}`, `{"x":10}`},
		{`{"s":"Мир"}`, "{\"s\":\"\\u041c\\u0438\\u0440\"}"},
	}
	for _, pair := range same {
		diffs, err := Diff([]byte(pair[0]), []byte(pair[1]))
		if err != nil || len(diffs) != 0 {
			t.Fatalf("%s vs %s: %v %v", pair[0], pair[1], diffs, err)
		}
	}
	different := [][3]string{
		{`{"a":null}`, `{}`, "$.a"},
		{`{"a":[]}`, `{"a":null}`, "$.a"},
		{`{"a":[1,2]}`, `{"a":[1]}`, "$.a"},
		{`{"a":{"b":0.1}}`, `{"a":{"b":0.10000000000000002}}`, "$.a.b"},
		{`{"a":1}`, `{"a":1,"b":2}`, "$.b"},
		{`{"a":"1"}`, `{"a":1}`, "$.a"},
	}
	for _, item := range different {
		diffs, err := Diff([]byte(item[0]), []byte(item[1]))
		if err != nil || len(diffs) == 0 || !strings.HasPrefix(diffs[0], item[2]) {
			t.Fatalf("%s vs %s: %v %v", item[0], item[1], diffs, err)
		}
	}
	if _, err := Diff([]byte(`{`), []byte(`{}`)); err == nil {
		t.Fatal("битый JSON должен давать ошибку")
	}
}

// TestNormalizePaths проверяет замену корня в строках, включая разделители Windows и текст ошибки.
func TestNormalizePaths(t *testing.T) {
	data := []byte(`{"path":"/tmp/x/project","trackPath":"/tmp/x/project/source/track.mp3","n":1,"other":"/tmp/xy"}`)
	got, err := NormalizePaths(data, "/tmp/x/project")
	if err != nil {
		t.Fatal(err)
	}
	AssertJSON(t, []byte(`{"path":"<project>","trackPath":"<project>/source/track.mp3","n":1,"other":"/tmp/xy"}`), got)

	windows := []byte(`{"p":"C:\\x\\project\\source\\track.mp3","e":"Нет файла: C:\\x\\project\\plan «x»"}`)
	got, err = NormalizePaths(windows, `C:\x\project`)
	if err != nil {
		t.Fatal(err)
	}
	AssertJSON(t, []byte(`{"p":"<project>/source/track.mp3","e":"Нет файла: <project>/plan «x»"}`), got)
}

// TestCopyProject проверяет, что копия сохраняет basename и не связана с эталоном.
func TestCopyProject(t *testing.T) {
	for _, item := range Load(t, "timing-save") {
		copy := item.CopyProject(t)
		if filepath.Base(copy) != projectDir {
			t.Fatalf("basename копии %s", copy)
		}
		target := filepath.Join(copy, "plan", "project.json")
		if err := os.WriteFile(target, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if data, _ := os.ReadFile(filepath.Join(item.ProjectPath(), "plan", "project.json")); string(data) == "{}" {
			t.Fatal("запись в копию изменила эталон")
		}
		return
	}
}

// TestTreeDigest фиксирует формат дайджеста дерева, общий со скриптом съёмки.
func TestTreeDigest(t *testing.T) {
	root := t.TempDir()
	write := func(name, text string) {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("b.txt", "b")
	write("a/c.txt", "c")
	write(".git/HEAD", "ignored")
	hash := func(text string) string {
		sum := sha256.Sum256([]byte(text))
		return hex.EncodeToString(sum[:])
	}
	want := hash(hash("c") + "  a/c.txt\n" + hash("b") + "  b.txt\n")
	got, err := TreeDigest(root)
	if err != nil || got != want {
		t.Fatalf("дайджест %s, ожидался %s (%v)", got, want, err)
	}
	write("b.txt", "B")
	if changed, _ := TreeDigest(root); changed == want {
		t.Fatal("изменение файла не изменило дайджест")
	}
}

// TestRealProjects проверяет подключённые эталоны настоящих клипов: клип не менялся после съёмки,
// значит эталон актуален. Без SONGFRAME_GOLDEN_REAL тест пропускается.
func TestRealProjects(t *testing.T) {
	for _, project := range RealProjects(t) {
		t.Run(project.Name, func(t *testing.T) {
			digest, err := TreeDigest(project.Project)
			if err != nil {
				t.Fatal(err)
			}
			if digest != project.Manifest.TreeSHA256 {
				t.Fatalf("клип изменился после съёмки эталона: %s, в manifest %s", digest, project.Manifest.TreeSHA256)
			}
			for _, name := range []string{"expected-status.json", "expected-open.json", "expected-timing-view.json", "expected-timing-save.json"} {
				var value any
				if err := json.Unmarshal(project.Read(t, name), &value); err != nil {
					t.Fatalf("%s: %v", name, err)
				}
			}
		})
	}
}
