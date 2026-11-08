package buildanimatic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolrt"
)

// domain — каталог эталона CLI build_animatic (см. testdata/golden/README.md).
const domain = "build-animatic"

// goldenCases — cases.json домена.
type goldenCases struct {
	FFmpegVersion string       `json:"ffmpegVersion"`
	Cases         []goldenCase `json:"cases"`
}

type goldenCase struct {
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Base        string       `json:"base"`
	Steps       []goldenStep `json:"steps"`
}

type goldenStep struct {
	Op           string    `json:"op"`
	Path         string    `json:"path"`
	Text         *string   `json:"text"`
	File         string    `json:"file"`
	Args         []string  `json:"args"`
	Expected     *expected `json:"expected"`
	FFmpegStderr bool      `json:"ffmpegStderr"`
}

type expected struct {
	Code    int                        `json:"code"`
	Stdout  string                     `json:"stdout"`
	Stderr  string                     `json:"stderr"`
	Changes map[string]*string         `json:"changes"`
	Texts   map[string]string          `json:"texts"`
	Probe   map[string]json.RawMessage `json:"probe"`
}

// requireMedia пропускает тест без FFmpeg/ffprobe и сообщает, совпадает ли версия FFmpeg со
// снятой: тогда медиа и их хеши сверяются побайтно, иначе — структура и сводка ffprobe.
func requireMedia(t *testing.T, want string) bool {
	t.Helper()
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skipf("нет %s в PATH", name)
		}
	}
	output, err := exec.Command("ffmpeg", "-version").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.SplitN(string(output), "\n", 2)[0] == want
}

// TestGolden воспроизводит сценарии CLI эталона на копиях входного клипа: код, stdout, stderr,
// разность дерева проекта, тексты latest и сводку ffprobe готового MP4.
func TestGolden(t *testing.T) {
	var data goldenCases
	if err := json.Unmarshal(golden.ReadFile(t, domain, "cases.json"), &data); err != nil {
		t.Fatal(err)
	}
	same := requireMedia(t, data.FFmpegVersion)
	if !same {
		t.Logf("FFmpeg отличается от снятого (%s): медиа сверяются по структуре", data.FFmpegVersion)
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, domain)
	for _, c := range data.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if !same && c.Name == "cache-damaged" {
				t.Skip("шаги ссылаются на ключи кэша, зависящие от версии FFmpeg")
			}
			project := copyTree(t, filepath.Join(dir, c.Base))
			for index, step := range c.Steps {
				target := filepath.Join(project, filepath.FromSlash(step.Path))
				switch step.Op {
				case "write":
					data := []byte(nil)
					if step.Text != nil {
						data = []byte(*step.Text)
					} else {
						data, err = os.ReadFile(filepath.Join(dir, filepath.FromSlash(step.File)))
						if err != nil {
							t.Fatal(err)
						}
					}
					if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(target, data, 0o644); err != nil {
						t.Fatal(err)
					}
				case "remove":
					if err := os.RemoveAll(target); err != nil {
						t.Fatal(err)
					}
				case "run":
					checkRun(t, index, project, step, same)
				default:
					t.Fatalf("неизвестный шаг %s", step.Op)
				}
			}
		})
	}
}

var (
	secondsPattern  = regexp.MustCompile(`"seconds": [0-9.e-]+`)
	addressPattern  = regexp.MustCompile(`@ 0x[0-9a-f]+`)
	segmentPattern  = regexp.MustCompile(`^plan/animatic/\.cache/segments/[0-9a-f]{64}\.(mp4|json)$`)
	videoShaPattern = regexp.MustCompile(`"(video_sha256|toolchain_sha256)": "[0-9a-f]{64}"`)
	durationPattern = regexp.MustCompile(`"(video_duration|source_audio_duration)": [0-9.e-]+`)
)

// normalize — нормализация вывода, как в эталоне: путь проекта, время сборки и адреса FFmpeg.
func normalize(text, project string) string {
	text = strings.ReplaceAll(text, project, "<project>")
	text = addressPattern.ReplaceAllString(text, "@ <addr>")
	return secondsPattern.ReplaceAllString(text, `"seconds": "<seconds>"`)
}

// masked — значения, зависящие от сборки FFmpeg, для сверки при другой версии.
func masked(text string) string {
	text = videoShaPattern.ReplaceAllString(text, `"$1": "<media>"`)
	return durationPattern.ReplaceAllString(text, `"$1": "<media>"`)
}

func checkRun(t *testing.T, index int, project string, step goldenStep, same bool) {
	t.Helper()
	want := step.Expected
	before := snapshot(t, project)
	output := Run(context.Background(), project, append([]string(nil), step.Args...))
	after := snapshot(t, project)
	label := "шаг " + strconv.Itoa(index) + " (" + strings.Join(step.Args, " ") + ")"
	if output.Code != want.Code {
		t.Fatalf("%s: код %d, ждали %d\nstdout %s\nstderr %s", label, output.Code, want.Code, output.Stdout, output.Stderr)
	}
	stdout, wantStdout := normalize(output.Stdout, project), want.Stdout
	if !same {
		stdout, wantStdout = masked(stdout), masked(wantStdout)
	}
	if stdout != wantStdout {
		t.Fatalf("%s: stdout\n%s\nждали\n%s", label, stdout, wantStdout)
	}
	stderr := normalize(output.Stderr, project)
	switch {
	case toolrt.IsUnhandled(want.Stderr):
		if stderr != want.Stderr {
			t.Fatalf("%s: необработанная ошибка\n%s\nждали\n%s", label, stderr, want.Stderr)
		}
	case step.FFmpegStderr && !same:
		prefix, _, _ := strings.Cut(want.Stderr, ": ")
		if !strings.HasPrefix(stderr, prefix+": ") {
			t.Fatalf("%s: stderr %q, ждали начало %q", label, stderr, prefix)
		}
	case stderr != want.Stderr:
		t.Fatalf("%s: stderr\n%q\nждали\n%q", label, stderr, want.Stderr)
	}
	got := map[string]*string{}
	for name := range union(before, after) {
		if before[name] != after[name] {
			if value, ok := after[name]; ok {
				got[name] = &value
			} else {
				got[name] = nil
			}
		}
	}
	if gotList, wantList := changeList(got, same), changeList(want.Changes, same); !reflect.DeepEqual(gotList, wantList) {
		t.Fatalf("%s: изменения дерева\n%s\nждали\n%s", label, strings.Join(gotList, "\n"), strings.Join(wantList, "\n"))
	}
	for name, text := range want.Texts {
		data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		gotText, wantText := string(data), text
		if !same {
			gotText, wantText = masked(gotText), masked(wantText)
		}
		if gotText != wantText {
			t.Fatalf("%s: %s\n%s\nждали\n%s", label, name, gotText, wantText)
		}
	}
	for name, summary := range want.Probe {
		gotSummary := probeSummary(t, filepath.Join(project, filepath.FromSlash(name)))
		golden.AssertJSON(t, summary, gotSummary)
	}
	// Временные папки сборки и кэша не остаются после завершения, в том числе после отказа.
	for _, pattern := range []string{"plan/animatic/.cache/build-*", "plan/animatic/.cache/*/.pending-*"} {
		if leftovers, _ := filepath.Glob(filepath.Join(project, filepath.FromSlash(pattern))); len(leftovers) > 0 {
			t.Fatalf("%s: остались временные папки %v", label, leftovers)
		}
	}
}

// changeList — разность дерева строками «путь=SHA»; при другой версии FFmpeg ключи кэша и хеши
// производных медиа заменены маркерами.
func changeList(changes map[string]*string, same bool) []string {
	result := []string{}
	for name, value := range changes {
		text := "<removed>"
		if value != nil {
			text = *value
		}
		if !same {
			if segmentPattern.MatchString(name) {
				name = "plan/animatic/.cache/segments/<key>" + filepath.Ext(name)
				text = "<media>"
			}
			if value != nil && (strings.HasSuffix(name, ".mp4") || name == "plan/animatic/latest/manifest.json") {
				text = "<media>"
			}
		}
		result = append(result, name+"="+text)
	}
	sort.Strings(result)
	return result
}

func union(left, right map[string]string) map[string]bool {
	result := map[string]bool{}
	for name := range left {
		result[name] = true
	}
	for name := range right {
		result[name] = true
	}
	return result
}

// snapshot — SHA-256 всех файлов проекта по путям через «/».
func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		name, _ := filepath.Rel(root, path)
		result[filepath.ToSlash(name)] = hex.EncodeToString(sum[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// copyTree — копия входного клипа во временной папке с разрешённым путём (как его разрешает CLI).
func copyTree(t *testing.T, source string) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, "project")
	err = filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name, _ := filepath.Rel(source, path)
		destination := filepath.Join(target, name)
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
	return target
}

// probeSummary — сводка ffprobe MP4 в формате эталона.
func probeSummary(t *testing.T, path string) []byte {
	t.Helper()
	output, err := exec.Command("ffprobe", "-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		Streams  []map[string]any `json:"streams"`
		Format   map[string]any   `json:"format"`
		Chapters []map[string]any `json:"chapters"`
	}
	if err := json.Unmarshal(output, &info); err != nil {
		t.Fatal(err)
	}
	pick := func(stream map[string]any, keys ...string) map[string]any {
		result := map[string]any{}
		for _, key := range keys {
			result[key] = stream[key]
		}
		return result
	}
	summary := map[string]any{"audio": []any{}, "chapters": []any{}}
	for _, stream := range info.Streams {
		switch stream["codec_type"] {
		case "video":
			if summary["video"] == nil {
				summary["video"] = pick(stream, "codec_name", "width", "height", "r_frame_rate", "nb_frames", "pix_fmt")
			}
		case "audio":
			summary["audio"] = append(summary["audio"].([]any), pick(stream, "codec_name", "channels", "sample_rate"))
		}
	}
	tags, _ := info.Format["tags"].(map[string]any)
	summary["title"] = tags["title"]
	for _, chapter := range info.Chapters {
		chapterTags, _ := chapter["tags"].(map[string]any)
		summary["chapters"] = append(summary["chapters"].([]any), map[string]any{
			"start": chapter["start"], "end": chapter["end"], "time_base": chapter["time_base"], "title": chapterTags["title"],
		})
	}
	data, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
