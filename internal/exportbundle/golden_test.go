package exportbundle

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"io/fs"
	"math"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/pycompat"
)

// Эталон export-edit-bundle снят с CLI tools/export_edit_bundle оригинала на копиях образца
// checks-base: разность с образцом хранится в случае, сверяются код, stdout, stderr (у трассировки —
// заголовок и последняя строка) и всё, что появилось в рабочей папке: тексты пакета побайтно, копии
// медиа — SHA-256 и размер. Абсолютный путь рабочей папки в текстах заменён на <tmp>.

// bundleFile — файл входа или результата случая.
type bundleFile struct {
	Text   *string `json:"text"`
	Base64 string  `json:"base64"`
	SHA256 string  `json:"sha256"`
	Bytes  int     `json:"bytes"`
	Dir    bool    `json:"dir"`
}

type bundleCase struct {
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Project     string                `json:"project"`
	Args        []string              `json:"args"`
	Cwd         string                `json:"cwd"`
	Overlay     map[string]bundleFile `json:"overlay"`
	Remove      []string              `json:"remove"`
	Links       map[string]string     `json:"links"`
	Dirs        []string              `json:"dirs"`
	Expected    struct {
		Code      int                   `json:"code"`
		Stdout    string                `json:"stdout"`
		Stderr    string                `json:"stderr"`
		Traceback string                `json:"traceback"`
		Created   map[string]bundleFile `json:"created"`
	} `json:"expected"`
}

// fixedReadme — исправленные ошибки README пакета оригинала, эталон остаётся снимком оригинала:
// файлы лежат в папке проекта, а не в репозитории, пример из чужого клипа убран, добавлено
// пояснение о переносимости timeline.fcpxml.
func fixedReadme(text string) string {
	text = strings.ReplaceAll(text, "- `media/` — копии исходников, если пакет собран с `--copy`.", "- `media/` — копии исходников, если пакет собран с `--copy`; `timeline.fcpxml` ссылается на них относительными путями, поэтому папку пакета можно передавать целиком.")
	text = strings.ReplaceAll(text, "относительны к корню репозитория;", "относительны к корню папки проекта;")
	return strings.ReplaceAll(text, "генерации (например, вступление из M13);", "генерации;")
}

var relativeSource = regexp.MustCompile(`src="([^"]*)"`)

// absoluteSources возвращает относительные src переносимого FCPXML к абсолютному URI оригинала:
// эталон хранит абсолютные пути, а сравнение заодно доказывает, что относительный путь от папки
// пакета ведёт в тот же файл.
func absoluteSources(text, bundle string) string {
	return relativeSource.ReplaceAllStringFunc(text, func(attribute string) string {
		value := relativeSource.FindStringSubmatch(attribute)[1]
		if strings.HasPrefix(value, "file:") {
			return attribute
		}
		decoded, err := url.PathUnescape(value)
		if err != nil {
			return attribute
		}
		path := filepath.Join(bundle, filepath.FromSlash(decoded))
		return `src="` + fileURI(filepath.ToSlash(path), filepath.VolumeName(path)) + `"`
	})
}

// TestFCPXMLPortable — пакет с копиями и пакет внутри проекта не содержат абсолютных путей машины;
// пакет вне проекта без копий опирается на абсолютные пути, потому что переносить его не с чем.
func TestFCPXMLPortable(t *testing.T) {
	root := t.TempDir()
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(root, "клип")
	copyProject(t, project)
	cases := []struct {
		out      string
		copyAll  bool
		absolute bool
		song     string
	}{
		{filepath.Join(project, "plan/batches/с-копиями"), true, false, "media/source/"},
		{filepath.Join(project, "plan/batches/без-копий"), false, false, "../../../source/"},
		{filepath.Join(root, "наружу"), true, false, "media/source/"},
		{filepath.Join(root, "наружу-без-копий"), false, true, "file://"},
	}
	for _, c := range cases {
		if _, err := export(context.Background(), project, c.out, c.copyAll); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(c.out, "timeline.fcpxml"))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "file://") != c.absolute {
			t.Errorf("%s: абсолютные пути: ожидалось %v", c.out, c.absolute)
		}
		song := relativeSource.FindStringSubmatch(string(data))[1]
		if !strings.HasPrefix(song, c.song) {
			t.Errorf("%s: песня %s", c.out, song)
		}
	}
}

// copyProject — копия образца checks-base в рабочую папку случая.
func copyProject(t *testing.T, target string) {
	t.Helper()
	source := filepath.Join("..", "..", "testdata", "golden", "checks-base", "project")
	err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(source, path)
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// listTree — все пути рабочей папки: файл — содержимое, папка и ссылка — пометка.
func listTree(t *testing.T, root string) map[string]string {
	t.Helper()
	tree := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == root {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		relative = filepath.ToSlash(relative)
		switch {
		case entry.IsDir():
			tree[relative] = "\x00dir"
		case entry.Type()&os.ModeSymlink != 0:
			tree[relative] = "\x00link"
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			tree[relative] = string(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return tree
}

// prepare — рабочая папка случая: копия образца с разностью из эталона.
func (c bundleCase) prepare(t *testing.T, tmp string) string {
	t.Helper()
	project := filepath.Join(tmp, c.Project)
	copyProject(t, project)
	fill := func(text string) string { return strings.ReplaceAll(text, "<tmp>", tmp) }
	for _, rel := range c.Remove {
		if err := os.RemoveAll(filepath.Join(tmp, filepath.FromSlash(rel))); err != nil {
			t.Fatal(err)
		}
	}
	dirs := append([]string(nil), c.Dirs...)
	sort.Strings(dirs)
	for _, rel := range dirs {
		path := filepath.Join(tmp, filepath.FromSlash(rel))
		// Папка на месте файла образца: файл убирается, вложенные папки создаются поверх родителей.
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for rel, file := range c.Overlay {
		path := filepath.Join(tmp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		var data []byte
		if file.Text != nil {
			data = []byte(fill(*file.Text))
		} else {
			decoded, err := base64.StdEncoding.DecodeString(file.Base64)
			if err != nil {
				t.Fatal(err)
			}
			data = decoded
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for rel, target := range c.Links {
		if err := os.Symlink(fill(target), filepath.Join(tmp, filepath.FromSlash(rel))); err != nil {
			t.Fatal(err)
		}
	}
	return project
}

// TestExportGolden — CLI оригинала: все случаи домена export-edit-bundle побайтно.
func TestExportGolden(t *testing.T) {
	var document struct {
		Cases []bundleCase `json:"cases"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "export-edit-bundle", "cases.json"), &document); err != nil {
		t.Fatal(err)
	}
	for _, c := range document.Cases {
		t.Run(c.Name, func(t *testing.T) {
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			tmp := filepath.Join(base, "w")
			if err := os.MkdirAll(tmp, 0o755); err != nil {
				t.Fatal(err)
			}
			project := c.prepare(t, tmp)
			before := listTree(t, tmp)
			args := make([]string, len(c.Args))
			for index, arg := range c.Args {
				args[index] = strings.ReplaceAll(strings.ReplaceAll(arg, "<tmp>", tmp), "<project>", project)
			}
			if c.Cwd == "project" {
				t.Chdir(project)
			} else {
				t.Chdir(tmp)
			}
			output := Run(context.Background(), project, args)
			norm := func(text string) string {
				return strings.ReplaceAll(strings.ReplaceAll(text, tmp, "<tmp>"), (&url.URL{Path: tmp}).EscapedPath(), "<tmp>")
			}
			if output.Code != c.Expected.Code {
				t.Errorf("код %d, ожидался %d\nstderr: %s", output.Code, c.Expected.Code, output.Stderr)
			}
			if got := norm(output.Stdout); got != c.Expected.Stdout {
				t.Errorf("stdout\n%q\nожидался\n%q", got, c.Expected.Stdout)
			}
			if c.Expected.Traceback != "" {
				want := "Traceback (most recent call last):\n"
				lines := strings.Split(strings.TrimRight(output.Stderr, "\n"), "\n")
				if !strings.HasPrefix(output.Stderr, want) || norm(lines[len(lines)-1]) != c.Expected.Traceback {
					t.Errorf("stderr\n%q\nожидалась трассировка\n%q", output.Stderr, c.Expected.Traceback)
				}
			} else if got := norm(output.Stderr); got != c.Expected.Stderr {
				t.Errorf("stderr\n%q\nожидался\n%q", got, c.Expected.Stderr)
			}
			after := listTree(t, tmp)
			created := map[string]bool{}
			for path, content := range after {
				if previous, found := before[path]; found {
					if previous != content {
						t.Errorf("изменён вход %s", path)
					}
					continue
				}
				created[path] = true
				want, known := c.Expected.Created[path]
				if !known {
					t.Errorf("лишний файл %s", path)
					continue
				}
				switch {
				case want.Dir:
					if content != "\x00dir" {
						t.Errorf("%s: ожидалась папка", path)
					}
				case want.Text != nil:
					expected := fixedReadme(*want.Text)
					if strings.HasSuffix(path, ".fcpxml") {
						content = absoluteSources(content, filepath.Dir(filepath.Join(tmp, filepath.FromSlash(path))))
					}
					if got := norm(content); got != expected {
						t.Errorf("%s\n%s", path, firstDifference(got, expected))
					}
					if strings.HasSuffix(path, ".fcpxml") {
						wellFormed(t, content)
					}
				default:
					sum := sha256.Sum256([]byte(content))
					if hex.EncodeToString(sum[:]) != want.SHA256 || len(content) != want.Bytes {
						t.Errorf("%s: байты копии отличаются", path)
					}
				}
			}
			for path := range c.Expected.Created {
				if !created[path] {
					t.Errorf("нет файла %s", path)
				}
			}
			for path := range before {
				if _, found := after[path]; !found {
					t.Errorf("удалён вход %s", path)
				}
			}
		})
	}
}

// wellFormed — документ FCPXML читается строгим разбором XML до конца.
func wellFormed(t *testing.T, document string) {
	t.Helper()
	decoder := xml.NewDecoder(strings.NewReader(document))
	for {
		if _, err := decoder.Token(); err == io.EOF {
			return
		} else if err != nil {
			t.Errorf("FCPXML: %v", err)
			return
		}
	}
}

// edlEvent — событие EDL: строка с номером, катушкой и четырьмя таймкодами.
var edlEvent = regexp.MustCompile(`(?m)^\d{3,}  (\S+) +V     C        (\S+) (\S+) (\S+) (\S+)$`)

// TestRepeatEventsContinuous — у repeat события идут встык по таймкодам песни и заканчиваются на
// конце плана, а длина источника равна длине записи.
func TestRepeatEventsContinuous(t *testing.T) {
	var document struct {
		Cases []bundleCase `json:"cases"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "export-edit-bundle", "cases.json"), &document); err != nil {
		t.Fatal(err)
	}
	wanted := map[string]string{"repeat-tail": "M05", "repeat-no-tail": "M05", "repeat-fractional-song": "M04"}
	for _, c := range document.Cases {
		shot, ok := wanted[c.Name]
		if !ok {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			tmp, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			project := c.prepare(t, tmp)
			out := filepath.Join(tmp, "out")
			if output := Run(context.Background(), project, []string{"--out", out}); output.Code != 0 {
				t.Fatalf("сборка: %+v", output)
			}
			data, err := os.ReadFile(filepath.Join(out, "timeline.edl"))
			if err != nil {
				t.Fatal(err)
			}
			seconds := func(code string) int {
				var hours, minutes, whole, frames int
				if _, err := fmt.Sscanf(code, "%d:%d:%d:%d", &hours, &minutes, &whole, &frames); err != nil {
					t.Fatalf("таймкод %q", code)
				}
				return ((hours*3600+minutes*60+whole)*30 + frames)
			}
			previous, count := -1, 0
			for _, event := range edlEvent.FindAllStringSubmatch(string(data), -1) {
				if event[1] != shot {
					continue
				}
				count++
				if previous >= 0 && seconds(event[4]) != previous {
					t.Errorf("разрыв шкалы: %v после кадра %d", event, previous)
				}
				if seconds(event[3])-seconds(event[2]) != seconds(event[5])-seconds(event[4]) {
					t.Errorf("длины источника и записи: %v", event)
				}
				previous = seconds(event[5])
			}
			if count < 2 || previous != 900 && previous != 600 {
				t.Errorf("событий %d, конец на кадре %d", count, previous)
			}
		})
	}
}

// firstDifference — окрестность первого расхождения двух текстов для сообщения теста.
func firstDifference(got, want string) string {
	index := 0
	for index < len(got) && index < len(want) && got[index] == want[index] {
		index++
	}
	from := max(index-80, 0)
	return "получено: " + strings.ToValidUTF8(got[from:min(index+120, len(got))], "?") + "\nожидалось: " + strings.ToValidUTF8(want[from:min(index+120, len(want))], "?")
}

// TestNumbersGolden — frames_at, timecode, rational, round и форматы float значений оригинала:
// случайные секунды, половины кадра и дроби на частотах шкалы и генерации.
func TestNumbersGolden(t *testing.T) {
	var document struct {
		Frames []struct {
			Seconds  any    `json:"seconds"`
			Num      string `json:"num"`
			Den      string `json:"den"`
			Frames   string `json:"frames"`
			Timecode string `json:"timecode"`
			Rational string `json:"rational"`
		} `json:"frames"`
		Formats []struct {
			Value  float64 `json:"value"`
			Round6 float64 `json:"round6"`
			G      string  `json:"g"`
			Speed  string  `json:"speed"`
			Fixed4 string  `json:"fixed4"`
		} `json:"formats"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "export-edit-bundle", "numbers.json"), &document); err != nil {
		t.Fatal(err)
	}
	for _, item := range document.Frames {
		rate, ok := new(big.Rat).SetString(item.Num + "/" + item.Den)
		if !ok {
			t.Fatalf("частота %s/%s", item.Num, item.Den)
		}
		frames, err := framesAt(item.Seconds, rate)
		if err != nil || frames.String() != item.Frames {
			t.Errorf("framesAt(%v, %s) = %v, %v; ожидалось %s", item.Seconds, rate, frames, err, item.Frames)
		}
		code, err := timecode(item.Seconds)
		if err != nil || code != item.Timecode {
			t.Errorf("timecode(%v) = %q, %v; ожидалось %q", item.Seconds, code, err, item.Timecode)
		}
		time, err := rational(item.Seconds)
		if err != nil || time != item.Rational {
			t.Errorf("rational(%v) = %q, %v; ожидалось %q", item.Seconds, time, err, item.Rational)
		}
	}
	for _, item := range document.Formats {
		rounded := round6(item.Value)
		if rounded != item.Round6 || math.Signbit(rounded) != math.Signbit(item.Round6) {
			t.Errorf("round6(%v) = %v, ожидалось %v", item.Value, rounded, item.Round6)
		}
		if got := formatG(item.Value); got != item.G {
			t.Errorf(":g %v = %q, ожидалось %q", item.Value, got, item.G)
		}
		if got := speedField(item.Value); got != item.Speed {
			t.Errorf(":05.1f %v = %q, ожидалось %q", item.Value, got, item.Speed)
		}
		if got := pycompat.FormatFixed(item.Value, 4); got != item.Fixed4 {
			t.Errorf(":.4f %v = %q, ожидалось %q", item.Value, got, item.Fixed4)
		}
	}
}

// TestFileURIWindows — Path.as_uri на Windows: диск (двоеточие тома не кодируется) и сетевой путь.
func TestFileURIWindows(t *testing.T) {
	if got, want := fileURI("C:/клип/a b.mp4", "C:"), "file:///C:/%D0%BA%D0%BB%D0%B8%D0%BF/a%20b.mp4"; got != want {
		t.Errorf("диск: %q, ожидалось %q", got, want)
	}
	if got, want := fileURI("//host/share/a#.mp4", "//host/share"), "file://host/share/a%23.mp4"; got != want {
		t.Errorf("сеть: %q, ожидалось %q", got, want)
	}
}

// TestCopyStopsOnCancel — отменённое задание не копирует медиа и завершается без текста; уже
// начатая папка остаётся, как у процесса оригинала, снятого сигналом.
func TestCopyStopsOnCancel(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	copyProject(t, project)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	output := Run(ctx, project, []string{"--out", filepath.Join(root, "out"), "--copy"})
	if output.Code != 1 || output.Stderr != "" || output.Stdout != "" {
		t.Fatalf("остановка: %+v", output)
	}
	if _, err := os.Stat(filepath.Join(root, "out", "bundle.json")); !os.IsNotExist(err) {
		t.Fatalf("bundle.json после отмены: %v", err)
	}
}
