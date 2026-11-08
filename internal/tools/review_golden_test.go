package tools_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"songframe-go/internal/buildreview"
	"songframe-go/internal/golden"
	"songframe-go/internal/tools"
)

// Эталоны build-review и production-tools/accept-edit: build_review и приёмка участка
// accept_shot на синтетическом мини-проекте с настоящим FFmpeg. Медиа результатов сверяются
// побайтно только при той же версии FFmpeg, что записана в эталоне; иначе — сводка ffprobe и рецепт без
// SHA видео и строки версии.

// reviewCase — случай: подготовка, шаги инструментов и ожидаемый исход.
type reviewCase struct {
	Name  string `json:"name"`
	Setup []struct {
		Op   string `json:"op"`
		Path string `json:"path"`
		To   string `json:"to"`
		From string `json:"from"`
		Text string `json:"text"`
	} `json:"setup"`
	Steps []struct {
		Tool string   `json:"tool"`
		Args []string `json:"args"`
	} `json:"steps"`
	Expected struct {
		Steps []struct {
			Code   int    `json:"code"`
			Stdout string `json:"stdout"`
			Stderr string `json:"stderr"`
		} `json:"steps"`
		Changed map[string]any `json:"changed"`
		Removed []string       `json:"removed"`
		Tmp     map[string]any `json:"tmp"`
	} `json:"expected"`
}

type reviewDomain struct {
	FFmpegVersion string       `json:"ffmpegVersion"`
	Cases         []reviewCase `json:"cases"`
}

var reviewTime = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`)

func TestBuildReviewGolden(t *testing.T) {
	runReviewDomain(t, filepath.Join("build-review", "cases.json"), "")
}

func TestAcceptEditGolden(t *testing.T) {
	runReviewDomain(t, filepath.Join("production-tools", "accept-edit", "cases.json"), filepath.Join(goldenDir(t), "production-tools", "accept-edit", "overlay"))
}

// goldenDir — testdata/golden модуля.
func goldenDir(t *testing.T) string {
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// runReviewDomain — прогон случаев домена на копиях проекта build-review (и разности overlay).
func runReviewDomain(t *testing.T, name, overlay string) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("нет ffmpeg в PATH")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("нет ffprobe в PATH")
	}
	base := filepath.Join(goldenDir(t), "build-review", "project")
	data, err := os.ReadFile(filepath.Join(goldenDir(t), name))
	if err != nil {
		t.Fatal(err)
	}
	var domain reviewDomain
	if err := json.Unmarshal(data, &domain); err != nil {
		t.Fatal(err)
	}
	version, _ := exec.Command("ffmpeg", "-version").Output()
	exact := strings.SplitN(string(version), "\n", 2)[0] == domain.FFmpegVersion
	saved := tools.LocalDir
	state := t.TempDir()
	tools.LocalDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { tools.LocalDir = saved })
	savedTemp := buildreview.TempDir
	t.Cleanup(func() { buildreview.TempDir = savedTemp })
	for _, c := range domain.Cases {
		t.Run(c.Name, func(t *testing.T) {
			root := t.TempDir()
			project, inputs, tmp := filepath.Join(root, "project"), filepath.Join(root, "inputs"), filepath.Join(root, "tmp")
			copyDir(t, base, project)
			if overlay != "" {
				copyDir(t, overlay, project)
			}
			copyDir(t, filepath.Join(goldenDir(t), "build-review", "inputs"), inputs)
			if err := os.MkdirAll(tmp, 0o755); err != nil {
				t.Fatal(err)
			}
			buildreview.TempDir = func() string { return tmp }
			realize := func(text string) string {
				return strings.NewReplacer("<project>", project, "<inputs>", inputs, "<tmp>", tmp).Replace(text)
			}
			mark := func(text string) string {
				text = strings.NewReplacer(project, "<project>", inputs, "<inputs>", tmp, "<tmp>").Replace(text)
				return reviewTime.ReplaceAllString(text, "<time>")
			}
			for _, op := range c.Setup {
				target := realize(op.Path + op.To)
				if !filepath.IsAbs(target) {
					target = filepath.Join(project, filepath.FromSlash(target))
				}
				var err error
				switch op.Op {
				case "write":
					_ = os.MkdirAll(filepath.Dir(target), 0o755)
					err = os.WriteFile(target, []byte(realize(op.Text)), 0o644)
				case "copy":
					var content []byte
					if content, err = os.ReadFile(realize(op.From)); err == nil {
						err = os.WriteFile(target, content, 0o644)
					}
				case "remove":
					err = os.Remove(target)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			before := reviewTree(t, project, base, mark)
			for index, step := range c.Steps {
				args := make([]string, len(step.Args))
				for position, arg := range step.Args {
					args[position] = realize(arg)
				}
				result, err := tools.Run(project, step.Tool, args)
				if err != nil {
					t.Fatal(err)
				}
				want := c.Expected.Steps[index]
				if result.Code == nil || *result.Code != want.Code {
					t.Fatalf("шаг %d: код %v, ожидался %d; stderr %q", index, result.Code, want.Code, result.Stderr)
				}
				if got, expected := mark(result.Stderr), want.Stderr; strings.HasPrefix(expected, "Traceback") {
					if lastLine(got) != lastLine(expected) {
						t.Fatalf("шаг %d: stderr %q, ожидался %q", index, got, expected)
					}
				} else if got != expected {
					t.Fatalf("шаг %d: stderr %q, ожидался %q", index, got, expected)
				}
				compareText(t, "stdout", mark(result.Stdout), want.Stdout, exact)
			}
			after := reviewTree(t, project, base, mark)
			changed := map[string]any{}
			for path, entry := range after {
				if !reflect.DeepEqual(before[path], entry) {
					changed[path] = entry
				}
			}
			removed := []string{}
			for path := range before {
				if _, ok := after[path]; !ok {
					removed = append(removed, path)
				}
			}
			compareTrees(t, "дерево проекта", changed, c.Expected.Changed, exact)
			if len(removed) != len(c.Expected.Removed) {
				t.Fatalf("удалено %v, ожидалось %v", removed, c.Expected.Removed)
			}
			for _, path := range c.Expected.Removed {
				if _, ok := after[path]; ok {
					t.Fatalf("не удалено %s", path)
				}
			}
			compareTrees(t, "временная папка", reviewTree(t, tmp, base, mark), c.Expected.Tmp, exact)
		})
	}
}

// reviewTree — дерево папки в формате эталона: каталоги — "dir", JSON — текст с маркерами, новые MP4 —
// SHA, байты и сводка ffprobe, остальное — SHA. Значения приводятся к виду encoding/json.
func reviewTree(t *testing.T, folder, base string, mark func(string) string) map[string]any {
	t.Helper()
	result := map[string]any{}
	err := filepath.WalkDir(folder, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == folder {
			return err
		}
		relative, _ := filepath.Rel(folder, path)
		name := filepath.ToSlash(relative)
		if entry.IsDir() {
			result[name] = "dir"
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		digest := hex.EncodeToString(sum[:])
		_, baseErr := os.Stat(filepath.Join(base, relative))
		switch {
		case strings.HasSuffix(name, ".json"):
			result[name] = map[string]any{"text": mark(string(data))}
		case strings.HasSuffix(name, ".mp4") && baseErr != nil:
			result[name] = map[string]any{"sha256": digest, "bytes": float64(len(data)), "media": mediaSummary(path)}
		default:
			result[name] = map[string]any{"sha256": digest}
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return result
}

// mediaSummary — сводка медиа в формате эталона: поля видео- и звукового потока ffprobe; nil — не медиа.
func mediaSummary(path string) any {
	output, err := exec.Command("ffprobe", "-v", "error", "-show_streams", "-of", "json", path).Output()
	if err != nil {
		return nil
	}
	var data struct {
		Streams []map[string]any `json:"streams"`
	}
	if err := json.Unmarshal(output, &data); err != nil {
		return nil
	}
	pick := func(stream map[string]any, keys ...string) map[string]any {
		result := map[string]any{}
		for _, key := range keys {
			result[key] = stream[key]
		}
		return result
	}
	result := map[string]any{}
	for _, stream := range data.Streams {
		switch stream["codec_type"] {
		case "video":
			result["video"] = pick(stream, "codec_name", "width", "height", "r_frame_rate", "nb_frames", "pix_fmt")
		case "audio":
			result["audio"] = pick(stream, "codec_name", "sample_rate", "channels", "duration")
		}
	}
	return result
}

// compareTrees — дерево против эталона; при другой версии FFmpeg у новых MP4 сверяется только
// сводка, а JSON — без полей, зависящих от байтов кодирования.
func compareTrees(t *testing.T, label string, got, want map[string]any, exact bool) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d записей, ожидалось %d\n%v\n%v", label, len(got), len(want), keys(got), keys(want))
	}
	for path, expected := range want {
		actual, ok := got[path]
		if !ok {
			t.Fatalf("%s: нет %s", label, path)
		}
		entry, isMap := expected.(map[string]any)
		if text, ok := entry["text"].(string); isMap && ok {
			compareText(t, label+": "+path, actual.(map[string]any)["text"].(string), text, exact)
			continue
		}
		if isMap && entry["media"] != nil && !exact {
			if !reflect.DeepEqual(actual.(map[string]any)["media"], entry["media"]) {
				t.Fatalf("%s: %s: сводка %v, ожидалась %v", label, path, actual, expected)
			}
			continue
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("%s: %s: %v, ожидалось %v", label, path, actual, expected)
		}
	}
}

func keys(tree map[string]any) []string {
	result := []string{}
	for key := range tree {
		result = append(result, key)
	}
	return result
}

// compareText — точное сравнение; при другой версии FFmpeg JSON сравнивается без video_sha256,
// ffmpeg_version и SHA/размера video.mp4.
func compareText(t *testing.T, label, got, want string, exact bool) {
	t.Helper()
	if got == want {
		return
	}
	if !exact {
		var left, right any
		if json.Unmarshal([]byte(got), &left) == nil && json.Unmarshal([]byte(want), &right) == nil {
			if reflect.DeepEqual(stripEncoded(left), stripEncoded(right)) {
				return
			}
		}
	}
	t.Fatalf("%s:\n%s\nожидалось\n%s", label, got, want)
}

// stripEncoded — копия JSON без значений, зависящих от версии FFmpeg.
func stripEncoded(value any) any {
	switch item := value.(type) {
	case map[string]any:
		result := map[string]any{}
		for key, child := range item {
			if key == "video_sha256" || key == "ffmpeg_version" {
				continue
			}
			result[key] = stripEncoded(child)
		}
		if item["path"] == "video.mp4" {
			delete(result, "sha256")
			delete(result, "bytes")
		}
		return result
	case []any:
		result := make([]any, len(item))
		for index, child := range item {
			result[index] = stripEncoded(child)
		}
		return result
	}
	return value
}
