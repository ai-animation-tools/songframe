package sourceedit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
)

// readInput разбирает input.json случая, подставляя папку входных файлов вместо <inputs>.
func readInput(t *testing.T, item golden.Case) (Input, string) {
	t.Helper()
	inputs := filepath.Join(item.Dir, "inputs")
	quoted, _ := json.Marshal(inputs)
	text := strings.ReplaceAll(string(item.Read(t, "input.json")), "<inputs>", strings.Trim(string(quoted), `"`))
	var input Input
	if err := json.Unmarshal([]byte(text), &input); err != nil {
		t.Fatal(err)
	}
	return input, inputs
}

// markInputs заменяет папку входных файлов маркером <inputs> в строках результата.
func markInputs(values []string, inputs string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, strings.ReplaceAll(value, inputs, "<inputs>"))
	}
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

// digest — sha256 всех файлов дерева: проверка, что чтение ничего не записало.
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

// TestViewGolden — viewSources на эталонах оригинала; просмотр не меняет дерево.
func TestViewGolden(t *testing.T) {
	for _, item := range golden.Load(t, "sources-view") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			before := digest(t, project)
			view, err := ViewProject(project)
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, item.Expected(t), view, project)
			if after := digest(t, project); string(mustJSON(t, before)) != string(mustJSON(t, after)) {
				t.Fatal("просмотр изменил файлы проекта")
			}
		})
	}
}

// TestValidateGolden — validateSources: те же проблемы в том же порядке.
func TestValidateGolden(t *testing.T) {
	for _, item := range golden.Load(t, "sources-validate") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			input, inputs := readInput(t, item)
			before := digest(t, project)
			problems, err := Validate(project, input)
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, item.Expected(t), markInputs(problems, inputs), project)
			if after := digest(t, project); string(mustJSON(t, before)) != string(mustJSON(t, after)) {
				t.Fatal("проверка изменила файлы проекта")
			}
		})
	}
}

var updatedAt = regexp.MustCompile(`"updated_at": "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"`)

// TestSaveGolden — saveSources без кастинга: опись (байты файла и результат), дерево source/ и
// тексты ошибок совпадают с оригиналом; время updated_at заменяется маркером.
func TestSaveGolden(t *testing.T) {
	for _, item := range golden.Load(t, "sources-save") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			input, inputs := readInput(t, item)
			before := digest(t, project)
			result, err := Save(context.Background(), project, input, "")
			var expected struct {
				Error         *string         `json:"error"`
				Result        json.RawMessage `json:"result"`
				TreeUnchanged bool            `json:"treeUnchanged"`
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
					t.Fatal("дерево изменилось при отказе")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				manifest, _ := os.ReadFile(filepath.Join(source, "manifest.json"))
				if !updatedAt.Match(manifest) {
					t.Fatalf("updated_at не в формате toISOString:\n%s", manifest)
				}
				text := updatedAt.ReplaceAllString(string(manifest), `"updated_at": "<updated_at>"`)
				if want := string(item.Read(t, "expected-manifest.json")); text != want {
					t.Fatalf("source/manifest.json:\n%s\nожидалось:\n%s", text, want)
				}
				got := updatedAt.ReplaceAllString(string(result), `"updated_at":"<updated_at>"`)
				got = regexp.MustCompile(`"updated_at":"[^"]*"`).ReplaceAllString(got, `"updated_at":"<updated_at>"`)
				golden.AssertJSON(t, expected.Result, []byte(got))
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
			dirs := []string{}
			_ = filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
				if err == nil && entry.IsDir() && path != source {
					rel, _ := filepath.Rel(source, path)
					dirs = append(dirs, filepath.ToSlash(rel))
				}
				return nil
			})
			sort.Strings(dirs)
			golden.AssertValue(t, mustJSON(t, tree.Dirs), dirs, "")
		})
	}
}

// TestSaveProbesDuration — длительность нового трека берётся у ffprobe с точностью до миллисекунды.
func TestSaveProbesDuration(t *testing.T) {
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe не найден")
	}
	track, err := filepath.Abs(filepath.Join("..", "components", "fixtures", "tiny.mp3"))
	if err != nil {
		t.Fatal(err)
	}
	project := t.TempDir()
	text := "[Куплет]\nСтрока\n"
	idea := "Идея"
	_, err = Save(context.Background(), project, Input{Track: &PathInput{Path: track}, Lyrics: &TextInput{Text: &text}, Idea: &TextInput{Text: &idea}, References: []ReferenceInput{}}, DurationProbe(ffprobe))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(project, "source", "manifest.json"))
	if !regexp.MustCompile(`"duration_seconds": \d+(\.\d{1,3})?\n`).Match(data) {
		t.Fatalf("нет длительности трека:\n%s", data)
	}
}

func TestParseFloatAndNormalize(t *testing.T) {
	for text, want := range map[string]float64{"30.000000": 30, "12.3456\n": 12.3456, ".5": 0.5, "1e2x": 100} {
		if got, ok := parseFloat(strings.TrimSpace(text)); !ok || got != want {
			t.Errorf("%q: %v", text, got)
		}
	}
	if _, ok := parseFloat("N/A"); ok {
		t.Error("N/A не число")
	}
	if got := normalizeText("a\r\nb  \n\n"); got != "a\nb\n" {
		t.Errorf("%q", got)
	}
}
