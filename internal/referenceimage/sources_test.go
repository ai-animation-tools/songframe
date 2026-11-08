package referenceimage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/sourceedit"
)

// readInput разбирает input.json случая, подставляя папку входных файлов вместо <inputs>.
func readInput(t *testing.T, item golden.Case) (sourceedit.Input, string) {
	t.Helper()
	inputs := filepath.Join(item.Dir, "inputs")
	quoted, _ := json.Marshal(inputs)
	text := strings.ReplaceAll(string(item.Read(t, "input.json")), "<inputs>", strings.Trim(string(quoted), `"`))
	var input sourceedit.Input
	if err := json.Unmarshal([]byte(text), &input); err != nil {
		t.Fatal(err)
	}
	return input, inputs
}

// digest — sha256 файлов дерева (пути через «/»).
func digest(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		data, _ := os.ReadFile(path)
		sum := sha256.Sum256(data)
		rel, _ := filepath.Rel(root, path)
		result[filepath.ToSlash(rel)] = hex.EncodeToString(sum[:])
		return nil
	})
	return result
}

// dirs — каталоги дерева (через «/»), включая пустые.
func dirs(root string) []string {
	result := []string{}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.IsDir() && path != root {
			rel, _ := filepath.Rel(root, path)
			result = append(result, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(result)
	return result
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

var updatedAt = regexp.MustCompile(`"updated_at": ?"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"`)

// assertCase сверяет результат SaveSources со случаем sources-save-cast: текст ошибки, неизменность
// дерева при отказе и откате, опись (байты и результат), дерево source/ и точные байты кастинга.
func assertCase(t *testing.T, item golden.Case) {
	t.Helper()
	project := item.CopyProject(t)
	input, inputs := readInput(t, item)
	before := digest(t, project)
	castPath := filepath.Join(project, "plan", "cast.json")
	castBefore, castErr := os.ReadFile(castPath)
	result, err := SaveSources(context.Background(), project, input, "")
	var expected struct {
		Error         *string         `json:"error"`
		Result        json.RawMessage `json:"result"`
		TreeUnchanged bool            `json:"treeUnchanged"`
		CastUnchanged bool            `json:"castUnchanged"`
	}
	if err := json.Unmarshal(item.Expected(t), &expected); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(project, "source")
	if expected.Error != nil {
		if err == nil || strings.ReplaceAll(err.Error(), inputs, "<inputs>") != *expected.Error {
			t.Fatalf("ошибка %v, ожидалась %q", err, *expected.Error)
		}
		if expected.TreeUnchanged && string(mustJSON(t, before)) != string(mustJSON(t, digest(t, project))) {
			t.Fatal("дерево проекта изменилось при отказе")
		}
	} else {
		if err != nil {
			t.Fatal(err)
		}
		manifest, _ := os.ReadFile(filepath.Join(source, "manifest.json"))
		text := updatedAt.ReplaceAllString(string(manifest), `"updated_at": "<updated_at>"`)
		if want := string(item.Read(t, "expected-manifest.json")); text != want {
			t.Fatalf("source/manifest.json:\n%s\nожидалось:\n%s", text, want)
		}
		got := updatedAt.ReplaceAllString(string(result), `"updated_at":"<updated_at>"`)
		golden.AssertJSON(t, expected.Result, []byte(got))
	}
	castAfter, castAfterErr := os.ReadFile(castPath)
	if unchanged := (castErr == nil) == (castAfterErr == nil) && string(castBefore) == string(castAfter); unchanged != expected.CastUnchanged {
		t.Fatalf("неизменность plan/cast.json: %v, ожидалась %v", unchanged, expected.CastUnchanged)
	}
	if want, err := os.ReadFile(filepath.Join(item.Dir, "expected-cast.json")); err == nil {
		if string(castAfter) != string(want) {
			t.Fatalf("plan/cast.json:\n%s\nожидалось:\n%s", castAfter, want)
		}
	} else if castAfterErr == nil {
		t.Fatal("plan/cast.json есть, хотя эталон его не содержит")
	}
	var tree struct {
		Dirs  []string          `json:"dirs"`
		Files map[string]string `json:"files"`
	}
	if err := json.Unmarshal(item.Read(t, "expected-source.json"), &tree); err != nil {
		t.Fatal(err)
	}
	files := digest(t, source)
	if expected.Error == nil {
		delete(files, "manifest.json")
	}
	golden.AssertValue(t, mustJSON(t, tree.Files), files, "")
	golden.AssertValue(t, mustJSON(t, tree.Dirs), dirs(source), "")
}

// TestSaveSourcesGolden — SaveSources на эталонах обоих доменов: без
// кастинга (sources-save) и с ним (sources-save-cast: новые виды, отказы, откат).
func TestSaveSourcesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "sources-save-cast") {
		t.Run(item.Name, func(t *testing.T) { assertCase(t, item) })
	}
	// Без plan/cast.json SaveSources — это sourceedit.Save; его эталоны сверяет sourceedit, здесь
	// достаточно убедиться, что путь без кастинга выбран и даёт ту же ошибку/успех.
	for _, item := range golden.Load(t, "sources-save") {
		t.Run("no-cast/"+item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			input, inputs := readInput(t, item)
			_, err := SaveSources(context.Background(), project, input, "")
			var expected struct {
				Error *string `json:"error"`
			}
			if err := json.Unmarshal(item.Expected(t), &expected); err != nil {
				t.Fatal(err)
			}
			if (expected.Error == nil) != (err == nil) || (err != nil && strings.ReplaceAll(err.Error(), inputs, "<inputs>") != *expected.Error) {
				t.Fatalf("ошибка %v, ожидалась %v", err, expected.Error)
			}
			if _, err := os.Stat(filepath.Join(project, "plan", "cast.json")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatal("сохранение без кастинга создало plan/cast.json")
			}
		})
	}
}

// TestRollbackWithCopies — откат при резерве копиями (жёсткие ссылки недоступны: другой том или ФС).
func TestRollbackWithCopies(t *testing.T) {
	link = func(string, string) error { return errors.New("ссылки недоступны") }
	t.Cleanup(func() { link = os.Link })
	for _, item := range golden.Load(t, "sources-save-cast") {
		if item.Name == "rollback" || item.Name == "new-images" {
			t.Run(item.Name, func(t *testing.T) { assertCase(t, item) })
		}
	}
}

// TestSnapshotRemoved — после успешного сохранения и после отката резерв во временной папке удалён.
func TestSnapshotRemoved(t *testing.T) {
	type run struct {
		name    string
		project string
		input   sourceedit.Input
	}
	var runs []run
	for _, item := range golden.Load(t, "sources-save-cast") {
		if item.Name == "rollback" || item.Name == "new-images" {
			input, _ := readInput(t, item)
			runs = append(runs, run{item.Name, item.CopyProject(t), input})
		}
	}
	// Временная папка подменяется после копий проектов: в ней должен появляться только резерв.
	temp := t.TempDir()
	t.Setenv("TMPDIR", temp)
	t.Setenv("TMP", temp)
	t.Setenv("TEMP", temp)
	for _, item := range runs {
		_, _ = SaveSources(context.Background(), item.project, item.input, "")
		if entries, _ := os.ReadDir(temp); len(entries) > 0 {
			t.Fatalf("%s: остался резерв %s", item.name, entries[0].Name())
		}
	}
	if len(runs) != 2 {
		t.Fatalf("случаев %d", len(runs))
	}
}

// TestRestoreFailed — откат не удался: ошибка restoreFailed называет папку резерва, в которой
// остались прежние source/ и plan/cast.json.
func TestRestoreFailed(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("запрет записи правами папки здесь не действует")
	}
	var item golden.Case
	for _, candidate := range golden.Load(t, "sources-save-cast") {
		if candidate.Name == "new-images" {
			item = candidate
		}
	}
	project := item.CopyProject(t)
	input, _ := readInput(t, item)
	heroes := filepath.Join(project, "source", "heroes")
	castBefore, _ := os.ReadFile(filepath.Join(project, "plan", "cast.json"))
	saveCast = func(string, any) error {
		// Новый вид Миры уже скопирован; папка без права записи не даст его удалить при откате.
		if err := os.Chmod(heroes, 0o555); err != nil {
			t.Fatal(err)
		}
		return errors.New("сбой записи кастинга")
	}
	t.Cleanup(func() {
		saveCast = saveCastDefault
		_ = os.Chmod(heroes, 0o755)
	})
	_, err := SaveSources(context.Background(), project, input, "")
	prefix := "Не удалось восстановить исходники после ошибки. Резерв сохранён в "
	if err == nil || !strings.HasPrefix(err.Error(), prefix) {
		t.Fatalf("ошибка %v", err)
	}
	backup := strings.TrimPrefix(err.Error(), prefix)
	backup = backup[:strings.Index(backup, ": Error: ")]
	t.Cleanup(func() { _ = os.RemoveAll(backup) })
	if data, _ := os.ReadFile(filepath.Join(backup, "plan", "cast.json")); string(data) != string(castBefore) {
		t.Fatal("в резерве нет прежнего plan/cast.json")
	}
	if _, err := os.Stat(filepath.Join(backup, "source", "heroes", "mira.png")); err != nil {
		t.Fatalf("в резерве нет прежних исходников: %v", err)
	}
	if _, err := os.Stat(filepath.Join(backup, "source", "heroes", "mira-3.jpg")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("резерв содержит новый файл")
	}
}

// saveCastDefault — исходная запись кастинга для восстановления точки подмены после теста.
var saveCastDefault = saveCast
