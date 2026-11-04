package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"testing/fstest"

	"songframe-go/internal/golden"
	"songframe-go/internal/newproject"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/store"
)

// markPaths заменяет корень маркером в JSON-представлении значения (как normalize съёмки).
// HTML-экранирование выключено, чтобы маркер <base> не превращался в \u003cbase\u003e.
func markPaths(t *testing.T, value any, roots map[string]string) []byte {
	t.Helper()
	var buffer strings.Builder
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		t.Fatal(err)
	}
	text := buffer.String()
	for marker, root := range roots {
		quoted, _ := json.Marshal(root)
		text = strings.ReplaceAll(text, strings.Trim(string(quoted), `"`), marker)
	}
	return []byte(strings.TrimSpace(text))
}

// expandMarker подставляет корень вместо маркера во входе эталона.
func expandMarker(data []byte, marker, root string) []byte {
	quoted, _ := json.Marshal(root)
	return []byte(strings.ReplaceAll(string(data), marker, strings.Trim(string(quoted), `"`)))
}

// failingTemplate отдаёт ошибку на чтении одного файла, имитируя сбой посреди копирования.
type failingTemplate struct{ fstest.MapFS }

func (f failingTemplate) Open(name string) (fs.File, error) {
	if name == "plan/project.json" {
		return nil, errors.New("сбой чтения шаблона")
	}
	return f.MapFS.Open(name)
}

func (f failingTemplate) ReadFile(name string) ([]byte, error) {
	if name == "plan/project.json" {
		return nil, errors.New("сбой чтения шаблона")
	}
	return f.MapFS.ReadFile(name)
}

// stateSummary — текущий проект и история (путь, имя) без времени, как stateSummary съёмки.
func stateSummary(t *testing.T, dir string) map[string]any {
	t.Helper()
	state := store.NewLocalState(dir)
	current, err := state.Current()
	if err != nil {
		t.Fatal(err)
	}
	history, err := state.History()
	if err != nil {
		t.Fatal(err)
	}
	entries := []map[string]string{}
	for _, entry := range history {
		entries = append(entries, map[string]string{"path": entry.Path, "name": entry.Name})
	}
	var currentValue any
	if current != "" {
		currentValue = current
	}
	return map[string]any{"current": currentValue, "history": entries}
}

// treeOf — файлы (sha256) и каталоги дерева без .git, пути через «/».
func treeOf(t *testing.T, root string) (map[string]string, []string) {
	t.Helper()
	files, dirs := map[string]string{}, []string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		switch {
		case rel == ".":
		case entry.IsDir() && entry.Name() == ".git":
			return filepath.SkipDir
		case entry.IsDir():
			dirs = append(dirs, rel)
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(data)
			files[rel] = hex.EncodeToString(sum[:])
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	sort.Strings(dirs)
	return files, dirs
}

// TestProjectCreateGolden — projects.create из встроенного шаблона: то же дерево и байты, статус,
// текущий проект и история, что у оригинала (testdata/golden/project-create).
func TestProjectCreateGolden(t *testing.T) {
	_, gitErr := exec.LookPath("git")
	for _, item := range golden.Load(t, "project-create") {
		t.Run(item.Name, func(t *testing.T) {
			base := filepath.Join(t.TempDir(), "base")
			stateDir := t.TempDir()
			var setup struct {
				Dirs []string `json:"dirs"`
			}
			if err := json.Unmarshal(item.Read(t, "setup.json"), &setup); err != nil {
				t.Fatal(err)
			}
			for _, dir := range append([]string{""}, setup.Dirs...) {
				if err := os.MkdirAll(filepath.Join(base, dir), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			var input newproject.Input
			if err := json.Unmarshal(expandMarker(item.Read(t, "input.json"), "<base>", base), &input); err != nil {
				t.Fatal(err)
			}
			var expected struct {
				Error  *string         `json:"error"`
				Status json.RawMessage `json:"status"`
				State  json.RawMessage `json:"state"`
			}
			if err := json.Unmarshal(item.Expected(t), &expected); err != nil {
				t.Fatal(err)
			}
			service := NewProjectService(nil, stateDir)
			got, err := service.Create(input)
			roots := map[string]string{"<base>": base}
			if expected.Error != nil {
				if err == nil || string(markPaths(t, err.Error(), roots)) != string(markPaths(t, *expected.Error, nil)) {
					t.Fatalf("ошибка %v, ожидалась %q", err, *expected.Error)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				golden.AssertJSON(t, expected.Status, markPaths(t, got, roots))
			}
			golden.AssertJSON(t, expected.State, markPaths(t, stateSummary(t, stateDir), roots))

			var tree struct {
				Exists bool              `json:"exists"`
				Git    bool              `json:"git"`
				Dirs   []string          `json:"dirs"`
				Files  map[string]string `json:"files"`
			}
			if err := json.Unmarshal(item.Read(t, "expected-tree.json"), &tree); err != nil {
				t.Fatal(err)
			}
			target := filepath.Clean(input.Path)
			if _, err := os.Stat(target); (err == nil) != tree.Exists {
				t.Fatalf("папка проекта существует: %v, ожидалось %v", err == nil, tree.Exists)
			}
			files, dirs := treeOf(t, target)
			if tree.Exists {
				golden.AssertValue(t, mustJSON(t, tree.Files), files, "")
				golden.AssertValue(t, mustJSON(t, tree.Dirs), dirs, "")
			}
			if _, err := os.Stat(filepath.Join(target, ".git", "HEAD")); tree.Git && gitErr == nil && err != nil {
				t.Fatalf("новый проект не стал репозиторием: %v", err)
			}
			// Временная папка сборки не остаётся рядом с проектом.
			siblings, _ := os.ReadDir(filepath.Dir(target))
			for _, entry := range siblings {
				if strings.Contains(entry.Name(), ".songframe-new-") {
					t.Fatalf("осталась временная папка %s", entry.Name())
				}
			}
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

// TestProjectCreateWithoutGit — git необязателен: без него проект создаётся обычной папкой без
// служебного файла о сбое и открывается.
func TestProjectCreateWithoutGit(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	target := filepath.Join(t.TempDir(), "Клип без git")
	service := NewProjectService(nil, t.TempDir())
	got, err := service.Create(newproject.Input{Name: "Клип", Path: target})
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "empty" || got.Name != "Клип" {
		t.Fatalf("статус %+v", got)
	}
	for _, name := range []string{".git", newproject.GitFailedFile} {
		if _, err := os.Stat(filepath.Join(target, name)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

// TestProjectCreateTemplateFailure — сбой копирования шаблона не оставляет папку на выбранном пути.
func TestProjectCreateTemplateFailure(t *testing.T) {
	target := filepath.Join(t.TempDir(), "new")
	service := NewProjectService(nil, t.TempDir())
	service.template = failingTemplate{fstest.MapFS{"README.md": {Data: []byte("x")}, "plan/project.json": {Data: []byte("{}")}}}
	if _, err := service.Create(newproject.Input{Name: "Клип", Path: target}); err == nil {
		t.Fatal("ожидалась ошибка копирования")
	}
	if _, err := os.Stat(target); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("на месте проекта осталась папка: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(target))
	if len(entries) != 0 {
		t.Fatalf("остались файлы: %v", entries)
	}
}

// TestProjectRenameGolden — projects.rename: байты plan/project.json, история и статус, как у оригинала.
func TestProjectRenameGolden(t *testing.T) {
	for _, item := range golden.Load(t, "project-rename") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			var expected struct {
				Error         *string         `json:"error"`
				ErrorPrefix   *string         `json:"errorPrefix"`
				Status        json.RawMessage `json:"status"`
				History       json.RawMessage `json:"history"`
				FileUnchanged bool            `json:"fileUnchanged"`
			}
			if err := json.Unmarshal(item.Expected(t), &expected); err != nil {
				t.Fatal(err)
			}
			var summary struct {
				History []struct {
					Path string `json:"path"`
				} `json:"history"`
			}
			if err := json.Unmarshal(expected.History, &summary); err != nil {
				t.Fatal(err)
			}
			// Вход истории съёмки: другой проект и (если он в итоговой истории) этот со старым именем.
			stateDir := t.TempDir()
			type record struct {
				Path       string `json:"path"`
				Name       string `json:"name"`
				LastOpened string `json:"last_opened"`
			}
			records := []record{{Path: "/elsewhere/Другой клип", Name: "Другой клип", LastOpened: "2026-10-01T00:00:00.000Z"}}
			for _, entry := range summary.History {
				if entry.Path == "<project>" {
					records = append(records, record{Path: project, Name: "Старое имя", LastOpened: "2026-10-02T00:00:00.000Z"})
				}
			}
			if err := projectfs.WriteJSON(filepath.Join(stateDir, store.HistoryFile), map[string]any{"schema_version": 1, "projects": records}); err != nil {
				t.Fatal(err)
			}
			var input struct {
				Name string `json:"name"`
			}
			if err := json.Unmarshal(item.Read(t, "input.json"), &input); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(project, "plan", "project.json")
			before, _ := os.ReadFile(file)
			got, err := NewProjectService(nil, stateDir).Rename(project, input.Name)
			roots := map[string]string{"<project>": project}
			switch {
			case expected.ErrorPrefix != nil:
				if err == nil || !strings.HasPrefix(string(markPaths(t, err.Error(), roots)), strings.TrimSuffix(string(markPaths(t, *expected.ErrorPrefix, nil)), `"`)) {
					t.Fatalf("ошибка %v, ожидался префикс %q", err, *expected.ErrorPrefix)
				}
			case expected.Error != nil:
				if err == nil || err.Error() != *expected.Error {
					t.Fatalf("ошибка %v, ожидалась %q", err, *expected.Error)
				}
			default:
				if err != nil {
					t.Fatal(err)
				}
				golden.AssertValue(t, expected.Status, got, project)
			}
			golden.AssertJSON(t, expected.History, markPaths(t, stateSummary(t, stateDir), roots))
			after, _ := os.ReadFile(file)
			if expected.FileUnchanged {
				if string(before) != string(after) {
					t.Fatal("plan/project.json изменился")
				}
				return
			}
			if want := item.Read(t, "expected-project.json"); string(want) != string(after) {
				t.Fatalf("plan/project.json:\n%s\nожидалось:\n%s", after, want)
			}
		})
	}
}

// TestProjectRenameRespectsWriteGate — незавершённая многофайловая публикация запрещает правку маркера.
func TestProjectRenameRespectsWriteGate(t *testing.T) {
	project := t.TempDir()
	if err := projectfs.WriteJSON(filepath.Join(project, "plan", "project.json"), map[string]any{"name": "Клип"}); err != nil {
		t.Fatal(err)
	}
	journal := filepath.Join(project, "plan", "montage-history", "0001", "journal.json")
	if err := os.MkdirAll(filepath.Dir(journal), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(journal, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if projectfs.CheckWrite(project) == nil {
		t.Fatal("битый журнал должен блокировать запись")
	}
	_, err := NewProjectService(nil, t.TempDir()).Rename(project, "Новое")
	var blocked *projectfs.BlockedError
	if !errors.As(err, &blocked) {
		t.Fatalf("ожидался отказ шлюза записи, получено %v", err)
	}
}
