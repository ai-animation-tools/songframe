package applymontage

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/assetpackage"
	"songframe-go/internal/golden"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/pycompat"
)

// goldenFile — testdata/golden/apply-montage/cases.json: случаи CLI оригинала на копии общего
// образца checks-base с настоящим FFmpeg (скрипт съёмки — capture-apply.py вне репозитория).
type goldenFile struct {
	FFmpegVersion string       `json:"ffmpegVersion"`
	Base          string       `json:"base"`
	Cases         []goldenCase `json:"cases"`
}

// goldenCase — операции подготовки, шаги CLI и ожидаемое состояние проекта после всех шагов.
type goldenCase struct {
	Name string `json:"name"`
	// Covers — ветки оригинала, которые проходит случай; «prepare available» читает длину видео ffprobe.
	Covers   []string   `json:"covers"`
	Setup    []setupOp  `json:"setup"`
	Steps    []stepSpec `json:"steps"`
	Expected struct {
		Steps []struct {
			Code   int    `json:"code"`
			Stdout string `json:"stdout"`
			Stderr string `json:"stderr"`
		} `json:"steps"`
		Changed   map[string]json.RawMessage `json:"changed"`
		Removed   []string                   `json:"removed"`
		Revisions []string                   `json:"revisions"`
	} `json:"expected"`
}

// setupOp — литеральная операция над копией образца (write/append/copy/remove/mkdir).
type setupOp struct {
	Op   string `json:"op"`
	Path string `json:"path"`
	Text string `json:"text"`
	Hex  string `json:"hex"`
	From string `json:"from"`
	To   string `json:"to"`
}

// stepSpec — аргументы после --project и операции перед шагом.
type stepSpec struct {
	Args  []string  `json:"args"`
	Setup []setupOp `json:"setup"`
}

// treeEntry — запись снимка дерева, как tree() скрипта съёмки.
type treeEntry struct {
	Dir    bool
	Text   *string
	SHA256 string
	Bytes  int64
	Media  any
	IsNew  bool
}

// real — маркеры <project>/<inputs> в путь случая.
func real(text, project, inputs string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "<project>", project), "<inputs>", inputs)
}

// applyOps — apply_ops скрипта съёмки.
func applyOps(t *testing.T, project, inputs string, ops []setupOp) {
	t.Helper()
	for _, op := range ops {
		name := op.Path
		if op.Op == "copy" {
			name = op.To
		}
		target := real(name, project, inputs)
		if !filepath.IsAbs(target) {
			target = filepath.Join(project, filepath.FromSlash(target))
		}
		var err error
		switch op.Op {
		case "write":
			if err = os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
				err = os.WriteFile(target, []byte(op.Text), 0o644)
			}
		case "append":
			var data []byte
			if data, err = hex.DecodeString(op.Hex); err == nil {
				var file *os.File
				if file, err = os.OpenFile(target, os.O_APPEND|os.O_WRONLY, 0); err == nil {
					_, err = file.Write(data)
					file.Close()
				}
			}
		case "copy":
			var data []byte
			if data, err = os.ReadFile(filepath.Join(project, filepath.FromSlash(op.From))); err == nil {
				if err = os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
					err = os.WriteFile(target, data, 0o644)
				}
			}
		case "remove":
			err = os.Remove(target)
		case "mkdir":
			err = os.MkdirAll(target, 0o755)
		default:
			t.Fatalf("неизвестная операция %q", op.Op)
		}
		if err != nil {
			t.Fatalf("операция %+v: %v", op, err)
		}
	}
}

// mediaSummary — media() скрипта съёмки: сводка ffprobe видео и звука.
func mediaSummary(t *testing.T, path string) any {
	t.Helper()
	result, err := mediacmd.Run(context.Background(), mediacmd.FFprobe(), "-v", "error", "-show_streams", "-of", "json", path)
	if err != nil || result.Code != 0 {
		return nil
	}
	var probe struct {
		Streams []map[string]any `json:"streams"`
	}
	if err := json.Unmarshal(result.Stdout, &probe); err != nil {
		t.Fatal(err)
	}
	summary := map[string]any{}
	pick := func(stream map[string]any, keys ...string) map[string]any {
		values := map[string]any{}
		for _, key := range keys {
			values[key] = stream[key]
		}
		return values
	}
	for _, stream := range probe.Streams {
		switch stream["codec_type"] {
		case "video":
			summary["video"] = pick(stream, "codec_name", "width", "height", "r_frame_rate", "nb_frames", "pix_fmt")
		case "audio":
			summary["audio"] = pick(stream, "codec_name", "sample_rate", "channels", "duration")
		}
	}
	return summary
}

// snapshot — tree(folder, base) скрипта съёмки: каталоги, текст JSON/Markdown, SHA остального;
// MP4, которого нет в образце, — ещё размер и сводка ffprobe.
func snapshot(t *testing.T, folder, base string, media bool) map[string]treeEntry {
	t.Helper()
	result := map[string]treeEntry{}
	err := filepath.Walk(folder, func(path string, info os.FileInfo, err error) error {
		if err != nil || path == folder {
			return err
		}
		relative, _ := filepath.Rel(folder, path)
		name := filepath.ToSlash(relative)
		if info.IsDir() {
			result[name] = treeEntry{Dir: true}
			return nil
		}
		extension := filepath.Ext(name)
		if extension == ".json" || extension == ".md" {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			text := string(data)
			result[name] = treeEntry{Text: &text}
			return nil
		}
		digest, err := assetpackage.FileSHA256(path)
		if err != nil {
			return err
		}
		entry := treeEntry{SHA256: digest}
		if _, err := os.Stat(filepath.Join(base, relative)); extension == ".mp4" && err != nil {
			entry.IsNew, entry.Bytes = true, info.Size()
			if media {
				entry.Media = mediaSummary(t, path)
			}
		}
		result[name] = entry
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// expectedEntry — запись changed эталона в виде treeEntry.
func expectedEntry(t *testing.T, raw json.RawMessage) treeEntry {
	t.Helper()
	var dir string
	if json.Unmarshal(raw, &dir) == nil {
		return treeEntry{Dir: dir == "dir"}
	}
	var value struct {
		Text   *string `json:"text"`
		SHA256 string  `json:"sha256"`
		Bytes  *int64  `json:"bytes"`
		Media  any     `json:"media"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	entry := treeEntry{Text: value.Text, SHA256: value.SHA256, Media: value.Media}
	if value.Bytes != nil {
		entry.IsNew, entry.Bytes = true, *value.Bytes
	}
	return entry
}

// sameEntry сравнивает записи; сводку ffprobe — через JSON (числа и строки как у Python).
func sameEntry(want, got treeEntry) bool {
	if want.Dir != got.Dir || want.SHA256 != got.SHA256 || want.IsNew != got.IsNew || want.Bytes != got.Bytes {
		return false
	}
	if (want.Text == nil) != (got.Text == nil) || (want.Text != nil && *want.Text != *got.Text) {
		return false
	}
	left, _ := json.Marshal(want.Media)
	right, _ := json.Marshal(got.Media)
	return bytes.Equal(left, right)
}

// describe — краткое описание записи для сообщения об ошибке.
func describe(entry treeEntry) string {
	switch {
	case entry.Dir:
		return "dir"
	case entry.Text != nil:
		text := *entry.Text
		if len(text) > 400 {
			text = text[:400] + "…"
		}
		return "text " + text
	}
	data, _ := json.Marshal(entry.Media)
	return "sha " + entry.SHA256 + " " + string(data)
}

// loadGolden читает эталон и сообщает, совпадает ли локальный FFmpeg с версией съёмки.
func loadGolden(t *testing.T) (goldenFile, bool) {
	t.Helper()
	var file goldenFile
	if err := json.Unmarshal(golden.ReadFile(t, "apply-montage", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	same := false
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err == nil {
		if result, err := mediacmd.Run(context.Background(), mediacmd.FFmpeg(), "-version"); err == nil {
			first, _, _ := strings.Cut(string(result.Stdout), "\n")
			same = first == file.FFmpegVersion
		}
	}
	return file, same
}

// baseProject — каталог общего образца checks-base/project.
func baseProject(t *testing.T, base string) string {
	t.Helper()
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(root, base, "project")
}

// copyDir — копия образца в каталог случая (права 0644/0755, как у checkout).
func copyDir(t *testing.T, from, to string) {
	t.Helper()
	err := filepath.Walk(from, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(from, path)
		target := filepath.Join(to, relative)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// injectIDs подменяет NewID идентификаторами транзакций оригинала по порядку создания.
func injectIDs(t *testing.T, ids []string) {
	t.Helper()
	queue := append([]string{}, ids...)
	previous := NewID
	NewID = func() string {
		if len(queue) == 0 {
			t.Fatal("транзакций больше, чем в эталоне")
		}
		id := queue[0]
		queue = queue[1:]
		return id
	}
	t.Cleanup(func() {
		NewID = previous
		if len(queue) != 0 {
			t.Errorf("не созданы транзакции эталона: %v", queue)
		}
	})
}

// TestApplyMontageGolden запускает Run на каждом случае эталона оригинала и сверяет коды, потоки
// и всё изменённое дерево проекта: тексты манифестов, журналов, реестра, статуса и представлений
// побайтно, новые MP4 — SHA-256, размером и сводкой ffprobe. ID транзакций выдаются те же, что у
// оригинала. Карточки аниматика (PNG Pillow) сверяются отдельным правилом: см. cardsDiffer.
// Без FFmpeg пропускаются случаи с медиа и с проверкой длины источника ffprobe; при другой версии
// FFmpeg пропускаются случаи, публикующие новые MP4.
func TestApplyMontageGolden(t *testing.T) {
	file, sameFFmpeg := loadGolden(t)
	_, ffmpegErr := exec.LookPath(mediacmd.FFmpeg())
	base := baseProject(t, file.Base)
	for _, item := range file.Cases {
		t.Run(item.Name, func(t *testing.T) {
			if (len(item.Expected.Revisions) > 0 || slices.Contains(item.Covers, "prepare available")) && ffmpegErr != nil {
				t.Skip("нет FFmpeg")
			}
			if len(item.Expected.Revisions) > 0 && !sameFFmpeg {
				t.Skip("версия FFmpeg отличается от съёмки: байты MP4 и SHA в манифестах не совпадут")
			}
			folder := t.TempDir()
			project, inputs := filepath.Join(folder, "project"), filepath.Join(folder, "inputs")
			copyDir(t, base, project)
			if err := os.MkdirAll(inputs, 0o755); err != nil {
				t.Fatal(err)
			}
			applyOps(t, project, inputs, item.Setup)
			before := snapshot(t, project, base, false)
			injectIDs(t, item.Expected.Revisions)
			for index, step := range item.Steps {
				applyOps(t, project, inputs, step.Setup)
				args := make([]string, len(step.Args))
				for position, arg := range step.Args {
					args[position] = real(arg, project, inputs)
				}
				output := Run(context.Background(), project, args)
				want := item.Expected.Steps[index]
				mark := func(text string) string {
					return strings.ReplaceAll(strings.ReplaceAll(text, project, "<project>"), inputs, "<inputs>")
				}
				if output.Code != want.Code || mark(output.Stdout) != want.Stdout || mark(output.Stderr) != want.Stderr {
					t.Fatalf("шаг %d: код %d stdout %q stderr %q; ожидалось %d %q %q", index, output.Code,
						mark(output.Stdout), mark(output.Stderr), want.Code, want.Stdout, want.Stderr)
				}
			}
			after := snapshot(t, project, base, true)
			pngRoot = project
			compareTrees(t, before, after, item)
		})
	}
}

// compareTrees сверяет changed/removed эталона с фактической разностью снимков.
func compareTrees(t *testing.T, before, after map[string]treeEntry, item goldenCase) {
	t.Helper()
	compareTreesIn(t, before, after, item)
}

// pngRoot — корень проекта случая для checkPNG (задаётся тестом перед сравнением).
var pngRoot string

// cardPNG — карточка аниматика в проекте или её резервная копия в журнале монтажа.
func cardPNG(name string) bool {
	if !strings.HasSuffix(name, ".png") {
		return false
	}
	directory := filepath.ToSlash(filepath.Dir(name))
	return directory == "plan/animatic/cards" || (strings.HasPrefix(directory, History+"/") && strings.HasSuffix(directory, "/before/plan/animatic/cards"))
}

// checkPNG — перерисованная карточка Go остаётся PNG 1280×720.
func checkPNG(t *testing.T, after map[string]treeEntry, name string) {
	t.Helper()
	file, err := os.Open(filepath.Join(pngRoot, filepath.FromSlash(name)))
	if err != nil {
		t.Errorf("%s: %v", name, err)
		return
	}
	defer file.Close()
	config, err := png.DecodeConfig(file)
	if err != nil || config.Width != 1280 || config.Height != 720 {
		t.Errorf("%s: не PNG 1280×720: %v", name, err)
	}
}

// maskCards — текст для сравнения без SHA-256 PNG карточек: в квитанции карточек — маркер вместо
// SHA файла, в журнале монтажа — без строк карточек и с маркером SHA новой квитанции. Байты
// карточек Go не совпадают с Pillow (как в эталоне scene-views); остальное сравнивается побайтно.
func maskCards(t *testing.T, name, text string) string {
	t.Helper()
	switch {
	case name == "plan/animatic/cards/manifest.json":
		value, err := pycompat.LoadsJSON(text)
		if err != nil {
			return text
		}
		if cards, ok := value.(*pycompat.Dict).Value("cards").(*pycompat.Dict); ok {
			for _, sid := range cards.Keys() {
				cards.Value(sid).(*pycompat.Dict).Set("sha256", "<sha256>")
			}
		}
		masked, _ := pycompat.DumpsJSON(value, pycompat.Indented)
		return masked
	case strings.HasPrefix(name, History+"/") && strings.HasSuffix(name, "/journal.json"):
		value, err := pycompat.LoadsJSON(text)
		if err != nil {
			return text
		}
		journal := value.(*pycompat.Dict)
		files := []any{}
		for _, raw := range journal.Value("files").([]any) {
			entry := raw.(*pycompat.Dict)
			path := entry.Value("path").(string)
			if cardPNG(path) {
				continue
			}
			if path == "plan/animatic/cards/manifest.json" {
				entry.Set("after", "<sha256>")
			}
			files = append(files, entry)
		}
		journal.Set("files", files)
		masked, _ := pycompat.DumpsJSON(journal, pycompat.Indented)
		return masked
	}
	return text
}

// compareTreesIn — сравнение снимков с правилом карточек.
func compareTreesIn(t *testing.T, before, after map[string]treeEntry, item goldenCase) {
	t.Helper()
	got := map[string]treeEntry{}
	for name, entry := range after {
		if previous, ok := before[name]; !ok || !sameEntry(previous, entry) {
			got[name] = entry
		}
	}
	removed := []string{}
	for name := range before {
		if _, ok := after[name]; !ok {
			removed = append(removed, name)
		}
	}
	sort.Strings(removed)
	if !reflect.DeepEqual(removed, item.Expected.Removed) && !(len(removed) == 0 && len(item.Expected.Removed) == 0) {
		t.Errorf("удалены %v, ожидалось %v", removed, item.Expected.Removed)
	}
	names := map[string]bool{}
	for name := range got {
		names[name] = true
	}
	for name := range item.Expected.Changed {
		names[name] = true
	}
	sorted := make([]string, 0, len(names))
	for name := range names {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	for _, name := range sorted {
		raw, expected := item.Expected.Changed[name]
		entry, changed := got[name]
		if cardPNG(name) && changed && !expected {
			// Перерисованная карточка Go: другие байты PNG при тех же входах (правило scene-views).
			checkPNG(t, after, name)
			continue
		}
		if expected && changed && entry.Text != nil {
			if want := expectedEntry(t, raw); want.Text != nil && maskCards(t, name, *want.Text) == maskCards(t, name, *entry.Text) {
				continue
			}
		}
		switch {
		case !expected:
			t.Errorf("лишнее изменение %s: %s", name, describe(entry))
		case !changed:
			t.Errorf("нет изменения %s: ожидалось %s", name, describe(expectedEntry(t, raw)))
		case !sameEntry(expectedEntry(t, raw), entry):
			t.Errorf("%s:\n got  %s\n want %s", name, describe(entry), describe(expectedEntry(t, raw)))
		}
	}
}
