package tools_test

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"

	"songframe/internal/golden"
	"songframe/internal/mediaadapters"
	"songframe/internal/shotworkflow"
	"songframe/internal/toolrt"
	"songframe/internal/tools"
)

// Маркеры эталонов shot-workflow и verify-asset-replay: временная папка ОС и папка отчёта.
const (
	tmpMarker = "<tmp>"
	outMarker = "<out>"
	// swNow — фиксированное now() эталона shot-workflow.
	swNow = "2026-11-04T12:00:00+00:00"
)

// promptAdapter — поддельный адаптер провайдера test эталона shot-workflow: предупреждение о
// длине промпта начиная с 40 символов.
type promptAdapter struct{}

func (promptAdapter) PromptWarningChars() int { return 40 }

// treeEntry — файл дерева: байты и права (st_mode & 0o777), как в состоянии дерева эталона.
type treeEntry struct {
	data []byte
	mode fs.FileMode
}

// treeState — файлы и каталоги дерева root относительными путями со слешами; нет root — пусто.
func treeState(t *testing.T, root string) (map[string]treeEntry, map[string]bool) {
	t.Helper()
	files, dirs := map[string]treeEntry{}, map[string]bool{}
	if _, err := os.Stat(root); err != nil {
		return files, dirs
	}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == root {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			dirs[relative] = true
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files[relative] = treeEntry{data, info.Mode().Perm()}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files, dirs
}

// copyDir копирует дерево source в target (входы tmp/ случая).
func copyDir(t *testing.T, source, target string) {
	t.Helper()
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

// isDir — путь существует и это каталог.
func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// markers — замена путей случая маркерами, длинный путь первым (временная папка может лежать
// внутри проекта), так же, как маркеры записаны в эталоне.
type markers [][2]string

func newMarkers(pairs ...[2]string) markers {
	result := markers(pairs)
	sort.SliceStable(result, func(i, j int) bool { return len(result[i][0]) > len(result[j][0]) })
	return result
}

func (m markers) text(text string) string {
	for _, pair := range m {
		text = strings.ReplaceAll(text, pair[0], pair[1])
	}
	return text
}

// bytes — нормализация байтов файла: текст UTF-8 проходит m.text, двоичные файлы — как есть.
func (m markers) bytes(data []byte) []byte {
	if !utf8.Valid(data) {
		return data
	}
	return []byte(m.text(string(data)))
}

// substitute — маркеры аргументов случая заменяются путями этого запуска.
func (m markers) substitute(args []any) []string {
	result := []string{}
	for _, arg := range args {
		text := arg.(string)
		for _, pair := range m {
			text = strings.ReplaceAll(text, pair[1], pair[0])
		}
		result = append(result, text)
	}
	return result
}

// toolCase — подготовленный запуск случая: проект, временная папка ОС и папка отчёта.
type toolCase struct {
	spec     *toolrt.Dict
	expected *toolrt.Dict
	root     string
	tmp      string
	inside   bool
	out      string
	markers  markers
}

// prepareCase собирает вход случая: проект из образца и разности, временную папку ОС (TMPDIR,
// отдельная или внутри проекта по case.json.tmpdir) с входом tmp/ и пустую папку отчёта.
func prepareCase(t *testing.T, c golden.Case) toolCase {
	spec := c.ReadValue(t, "case.json")
	root := c.BuildProject(t)
	run := toolCase{spec: spec, expected: c.ReadValue(t, "expected.json"), root: root, out: t.TempDir()}
	if inside, ok := spec.Value("tmpdir").(string); ok {
		run.tmp, run.inside = filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(inside, golden.ProjectMarker+"/"))), true
	} else {
		run.tmp = t.TempDir()
		// Пустой вход временной папки в Git не хранится: каталога tmp/ у случая нет.
		if input := filepath.Join(c.Dir, "tmp"); spec.Value("tmp") == true && isDir(input) {
			copyDir(t, input, run.tmp)
		}
	}
	// Проект лежит в t.TempDir() внутри системной временной папки: без своей TMPDIR пакет
	// проекта считался бы пакетом временной папки ОС.
	t.Setenv("TMPDIR", run.tmp)
	run.markers = newMarkers([2]string{run.tmp, tmpMarker}, [2]string{root, golden.ProjectMarker}, [2]string{run.out, outMarker})
	return run
}

// checkStreams сверяет код, stdout и stderr; необработанная ошибка сверяется целиком.
func (run toolCase) checkStreams(t *testing.T, result tools.Result, sortedStdout bool) {
	t.Helper()
	if want := run.expected.Value("code").(toolrt.Int).String(); result.Code == nil || want != toolrt.NewInt(int64(*result.Code)).String() {
		t.Errorf("код завершения: ожидалось %s, получено %v (stderr %s)", want, result.Code, result.Stderr)
	}
	want, got := golden.ValueString(t, run.expected, "stdout"), run.markers.text(result.Stdout)
	if sortedStdout {
		want, got = sortedLines(want), sortedLines(got)
	}
	if got != want {
		t.Errorf("stdout:\n--- ожидалось\n%s\n--- получено\n%s", want, got)
	}
	wantErr, gotErr := golden.ValueString(t, run.expected, "stderr"), run.markers.text(result.Stderr)
	checkStderr(t, run.expected, wantErr, gotErr, nil)
}

// sortedLines — строки вывода как мультимножество: планы печатаются по мере завершения потоков,
// порядок между ними не определён.
func sortedLines(text string) string {
	lines := strings.Split(text, "\n")
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// snapshot — состояние проекта и (если она отдельно) временной папки до запуска.
type snapshot struct {
	files, tmpFiles map[string]treeEntry
	dirs, tmpDirs   map[string]bool
}

func (run toolCase) snapshot(t *testing.T) snapshot {
	var state snapshot
	state.files, state.dirs = treeState(t, run.root)
	state.tmpFiles, state.tmpDirs = map[string]treeEntry{}, map[string]bool{}
	if !run.inside {
		state.tmpFiles, state.tmpDirs = treeState(t, run.tmp)
	}
	return state
}

// checkTree сверяет разность деревьев до/после с expected.files/dirs/modes и байты созданных и
// изменённых файлов с files/ и tmp-files/ эталона (пути — маркерами).
func (run toolCase) checkTree(t *testing.T, c golden.Case, before snapshot) {
	t.Helper()
	after := run.snapshot(t)
	gotFiles, gotDirs, gotModes := map[string]string{}, map[string]string{}, map[string]string{}
	diff := func(prefix, store string, old, new map[string]treeEntry, oldDirs, newDirs map[string]bool) {
		for relative, entry := range new {
			key := prefix + relative
			previous, existed := old[relative]
			switch {
			case !existed:
				gotFiles[key] = "created"
			case !bytes.Equal(previous.data, entry.data):
				gotFiles[key] = "changed"
			default:
				continue
			}
			want := c.Read(t, store+"/"+relative)
			if got := run.markers.bytes(entry.data); !bytes.Equal(got, want) {
				t.Errorf("байты %s:\n--- ожидалось\n%s\n--- получено\n%s", key, want, got)
			}
			if filepath.Base(relative) == "workflow.json" {
				gotModes[key] = fmt.Sprintf("%04o", entry.mode)
			}
		}
		for relative := range old {
			if _, ok := new[relative]; !ok {
				gotFiles[prefix+relative] = "removed"
			}
		}
		for relative := range newDirs {
			if !oldDirs[relative] {
				gotDirs[prefix+relative] = "created"
			}
		}
		for relative := range oldDirs {
			if !newDirs[relative] {
				gotDirs[prefix+relative] = "removed"
			}
		}
	}
	diff("", "files", before.files, after.files, before.dirs, after.dirs)
	diff(tmpMarker+"/", "tmp-files", before.tmpFiles, after.tmpFiles, before.tmpDirs, after.tmpDirs)
	for label, got := range map[string]map[string]string{"files": gotFiles, "dirs": gotDirs, "modes": gotModes} {
		want := map[string]string{}
		expected := run.expected.Value(label).(*toolrt.Dict)
		for _, key := range expected.Keys() {
			want[key] = expected.Value(key).(string)
		}
		if fmt.Sprint(want) != fmt.Sprint(got) {
			t.Errorf("%s:\n--- ожидалось\n%v\n--- получено\n%v", label, want, got)
		}
	}
}

// TestShotWorkflowGolden запускает tools.run("shot_workflow") на входах эталона shot-workflow и
// сверяет код, stdout, stderr и все изменения файлов проекта и временной папки ОС (байты, права
// workflow.json, созданные и удалённые каталоги) с эталоном. Время now() фиксировано,
// провайдер test проекта-образца получает предел длины промпта 40 символов.
func TestShotWorkflowGolden(t *testing.T) {
	previousNow := shotworkflow.Now
	shotworkflow.Now = func() string { return swNow }
	t.Cleanup(func() { shotworkflow.Now = previousNow })
	t.Cleanup(mediaadapters.Register("test", promptAdapter{}))
	for _, c := range golden.Load(t, "shot-workflow") {
		t.Run(c.Name, func(t *testing.T) {
			run := prepareCase(t, c)
			// Предел конкретного провайдера доказывает его адаптер: пока он не объявляет
			// PromptWarningChars, случай не проверяется.
			if provider, ok := run.spec.Value("provider").(string); ok {
				adapter, known := mediaadapters.Get(provider)
				if _, limited := adapter.(shotworkflow.PromptLimiter); !known || !limited {
					t.Skipf("адаптер %s не объявляет предел промпта", provider)
				}
			}
			before := run.snapshot(t)
			result, err := tools.Run(run.root, c.Call, run.markers.substitute(run.spec.Value("args").([]any)))
			if err != nil {
				t.Fatalf("tools.Run: %v", err)
			}
			run.checkStreams(t, result, false)
			run.checkTree(t, c, before)
		})
	}
}

// TestVerifyAssetReplayGolden запускает tools.run("verify_asset_replay") на входах эталона
// verify-asset-replay: код, stdout (строки планов — без учёта порядка), stderr и байты отчёта;
// проект не должен меняться. Случаям с проверкой воспроизведения нужны ffmpeg и ffprobe в PATH.
func TestVerifyAssetReplayGolden(t *testing.T) {
	_, ffmpegErr := exec.LookPath("ffmpeg")
	_, ffprobeErr := exec.LookPath("ffprobe")
	for _, c := range golden.Load(t, "verify-asset-replay") {
		t.Run(c.Name, func(t *testing.T) {
			run := prepareCase(t, c)
			if (ffmpegErr != nil || ffprobeErr != nil) && strings.Contains(golden.ValueString(t, run.expected, "stdout"), "RMS=") {
				t.Skip("нет ffmpeg/ffprobe")
			}
			before := run.snapshot(t)
			result, err := tools.Run(run.root, c.Call, run.markers.substitute(run.spec.Value("args").([]any)))
			if err != nil {
				t.Fatalf("tools.Run: %v", err)
			}
			run.checkStreams(t, result, true)
			run.checkTree(t, c, before)
			report, err := os.ReadFile(filepath.Join(run.out, "report.json"))
			switch want := run.expected.Value("report").(type) {
			case nil:
				if err == nil {
					t.Errorf("отчёт не должен создаваться")
				}
			case string:
				if err != nil || string(report) != want {
					t.Errorf("отчёт (%v):\n--- ожидалось\n%s\n--- получено\n%s", err, want, report)
				}
			}
		})
	}
}
