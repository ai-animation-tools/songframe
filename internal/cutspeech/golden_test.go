package cutspeech_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/mediacmd"
	"songframe/internal/tools"
)

// goldenStep — шаг случая домена cut-speech: запуск CLI с ожидаемым исходом либо правка
// проекта (запись текста или входного файла, порча байта, удаление).
type goldenStep struct {
	Run        []string `json:"run"`
	Code       int      `json:"code"`
	Stdout     string   `json:"stdout"`
	Stderr     string   `json:"stderr"`
	Unhandled  string   `json:"unhandled"`
	NoFFmpeg   bool     `json:"noFFmpeg"`
	FFmpegText bool     `json:"ffmpegText"`
	Write      string   `json:"write"`
	Text       *string  `json:"text"`
	Input      string   `json:"input"`
	Tamper     string   `json:"tamper"`
	Offset     int      `json:"offset"`
	Remove     string   `json:"remove"`
}

// goldenFile — итог файла проекта: текст (JSON) или SHA-256 и размер; "removed" — удалён.
type goldenFile struct {
	Text    *string `json:"text"`
	SHA256  string  `json:"sha256"`
	Bytes   int     `json:"bytes"`
	Removed bool    `json:"-"`
}

func (f *goldenFile) UnmarshalJSON(data []byte) error {
	if string(data) == `"removed"` {
		f.Removed = true
		return nil
	}
	type plain goldenFile
	return json.Unmarshal(data, (*plain)(f))
}

// goldenCase — случай эталона; Refusal — текст ожидаемого отказа (код 1, без записи файлов),
// который заменяет исход шагов случая.
type goldenCase struct {
	Name    string                     `json:"name"`
	Overlay map[string]json.RawMessage `json:"overlay"`
	Remove  []string                   `json:"remove"`
	Steps   []goldenStep               `json:"steps"`
	Files   map[string]goldenFile      `json:"files"`
	Refusal string                     `json:"refusal"`
}

// addresses — адреса структур FFmpeg в stderr, нормализованные в эталоне.
var addresses = regexp.MustCompile(`0x[0-9a-f]+`)

// ffmpegVersion — первая строка `ffmpeg -version` или пусто без FFmpeg.
func ffmpegVersion(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return ""
	}
	out, err := exec.Command("ffmpeg", "-version").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.SplitN(string(out), "\n", 2)[0]
}

func snapshot(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		rel, _ := filepath.Rel(root, path)
		files[filepath.ToSlash(rel)] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func copyDir(t *testing.T, from, to string) {
	t.Helper()
	for rel, data := range snapshot(t, from) {
		target := filepath.Join(to, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestGolden — CLI cut_speech против эталона: коды, stdout, stderr (необработанная ошибка —
// строкой «Ошибка: …» в поле unhandled) и итоговые файлы. Тексты FFmpeg и байты передискретизации сверяются только при той же
// версии FFmpeg, что записана в эталоне; без FFmpeg тест пропускается.
func TestGolden(t *testing.T) {
	version := ffmpegVersion(t)
	if version == "" {
		t.Skip("нет ffmpeg в PATH")
	}
	var document struct {
		FFmpegVersion string       `json:"ffmpegVersion"`
		Cases         []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "cut-speech", "cases.json"), &document); err != nil {
		t.Fatal(err)
	}
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	base = filepath.Join(base, "cut-speech")
	sameFFmpeg := version == document.FFmpegVersion
	for _, item := range document.Cases {
		t.Run(item.Name, func(t *testing.T) {
			project := filepath.Join(t.TempDir(), "project")
			copyDir(t, filepath.Join(base, "project"), project)
			for rel, raw := range item.Overlay {
				var text string
				var data []byte
				if json.Unmarshal(raw, &text) == nil {
					data = []byte(text)
				} else {
					var encoded struct{ Base64 string }
					if err := json.Unmarshal(raw, &encoded); err != nil {
						t.Fatal(err)
					}
					data, _ = base64.StdEncoding.DecodeString(encoded.Base64)
				}
				if err := os.WriteFile(filepath.Join(project, filepath.FromSlash(rel)), data, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			for _, rel := range item.Remove {
				if err := os.Remove(filepath.Join(project, filepath.FromSlash(rel))); err != nil {
					t.Fatal(err)
				}
			}
			resolved, _ := filepath.EvalSymlinks(project)
			normalize := func(text string) string {
				return strings.ReplaceAll(strings.ReplaceAll(text, resolved, "<project>"), project, "<project>")
			}
			versionText := false
			before := snapshot(t, project)
			for number, step := range item.Steps {
				path := func(rel string) string { return filepath.Join(project, filepath.FromSlash(rel)) }
				switch {
				case step.Write != "":
					data := []byte(nil)
					if step.Text != nil {
						data = []byte(*step.Text)
					} else {
						var err error
						if data, err = os.ReadFile(filepath.Join(base, "inputs", step.Input)); err != nil {
							t.Fatal(err)
						}
					}
					if err := os.MkdirAll(filepath.Dir(path(step.Write)), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path(step.Write), data, 0o644); err != nil {
						t.Fatal(err)
					}
					continue
				case step.Tamper != "":
					data, err := os.ReadFile(path(step.Tamper))
					if err != nil {
						t.Fatal(err)
					}
					data[step.Offset] ^= 0xff
					if err := os.WriteFile(path(step.Tamper), data, 0o644); err != nil {
						t.Fatal(err)
					}
					continue
				case step.Remove != "":
					if err := os.Remove(path(step.Remove)); err != nil {
						t.Fatal(err)
					}
					continue
				}
				args := make([]string, len(step.Run))
				for index, arg := range step.Run {
					args[index] = strings.ReplaceAll(arg, "<project>", project)
				}
				previous := mediacmd.Programs
				if step.NoFFmpeg {
					mediacmd.Programs = func() (string, string) { return filepath.Join(project, "нет", "ffmpeg"), "" }
				}
				result, err := tools.RunContext(context.Background(), project, "cut_speech", args)
				mediacmd.Programs = previous
				if err != nil {
					t.Fatal(err)
				}
				wantCode, wantStdout, wantStderr := step.Code, step.Stdout, step.Stderr
				if step.Unhandled != "" {
					wantStderr = step.Unhandled + "\n"
				}
				if item.Refusal != "" {
					wantCode, wantStdout, wantStderr = 1, "", item.Refusal+"\n"
				}
				gotStdout, gotStderr := normalize(result.Stdout), addresses.ReplaceAllString(normalize(result.Stderr), "0x?")
				if *result.Code != wantCode {
					t.Errorf("шаг %d %v: код %d, ожидался %d (stderr %q)", number, step.Run, *result.Code, wantCode, gotStderr)
				}
				if step.FFmpegText && !sameFFmpeg {
					versionText = true
					if !strings.HasPrefix(gotStderr, strings.SplitN(wantStderr, ":", 2)[0]) {
						t.Errorf("шаг %d: stderr %q, ожидалось начало %q", number, gotStderr, wantStderr)
					}
					continue
				}
				if gotStdout != wantStdout {
					t.Errorf("шаг %d %v: stdout\n%s\nожидалось\n%s", number, step.Run, gotStdout, wantStdout)
				}
				if gotStderr != wantStderr {
					t.Errorf("шаг %d %v: stderr\n%q\nожидалось\n%q", number, step.Run, gotStderr, wantStderr)
				}
			}
			if versionText {
				return
			}
			want := item.Files
			if item.Refusal != "" {
				want = map[string]goldenFile{}
			}
			after := snapshot(t, project)
			names := map[string]bool{}
			for name := range before {
				names[name] = true
			}
			for name := range after {
				names[name] = true
			}
			sorted := make([]string, 0, len(names))
			for name := range names {
				sorted = append(sorted, name)
			}
			sort.Strings(sorted)
			for _, name := range sorted {
				expected, listed := want[name]
				data, exists := after[name]
				switch {
				case !exists && !(listed && expected.Removed):
					t.Errorf("файл %s удалён", name)
				case !exists:
				case bytes.Equal(before[name], data) && before[name] != nil:
					if listed {
						t.Errorf("файл %s не изменился", name)
					}
				case !listed:
					t.Errorf("лишний файл %s", name)
				case expected.Text != nil:
					if string(data) != *expected.Text {
						t.Errorf("файл %s:\n%s\nожидалось\n%s", name, data, *expected.Text)
					}
				default:
					sum := sha256.Sum256(data)
					if hex.EncodeToString(sum[:]) != expected.SHA256 || len(data) != expected.Bytes {
						t.Errorf("файл %s: SHA-256 %x (%d байт), ожидалось %s (%d)", name, sum, len(data), expected.SHA256, expected.Bytes)
					}
				}
			}
		})
	}
}
