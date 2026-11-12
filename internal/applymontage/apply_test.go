package applymontage

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/mediacmd"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Сбои транзакции через точки подмены: ошибка второго рендера,
// чужая правка во время рендера, сбой публикации после реестра и аварийная остановка публикации с
// восстановлением при следующем запуске. Эталон CLI (golden_test.go) эти ветки не достаёт.

// sampleProject — копия общего образца checks-base в каталоге теста; без FFmpeg тест пропускается.
func sampleProject(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err != nil {
		t.Skip("нет FFmpeg")
	}
	if _, err := exec.LookPath(mediacmd.FFprobe()); err != nil {
		t.Skip("нет ffprobe")
	}
	root := filepath.Join(t.TempDir(), "project")
	copyDir(t, baseProject(t, "checks-base"), root)
	return root
}

// interval — участок черновика: сцена и кадры исходника [start, end).
type interval struct {
	scene      string
	start, end int64
}

// makeDraft — draft() test_apply_montage: original (или принятый клип) выбранных сцен с SHA
// текущих реестра и манифестов.
func makeDraft(t *testing.T, root string, intervals ...interval) *toolrt.Dict {
	t.Helper()
	load := func(name string) *toolrt.Dict {
		value, err := toolrt.LoadJSONFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		return value.(*toolrt.Dict)
	}
	digest := func(name string) string {
		value, err := sha(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	scenes := map[string]*toolrt.Dict{}
	for _, scene := range load("plan/scenes.json").Value("scenes").([]any) {
		scenes[scene.(*toolrt.Dict).Value("id").(string)] = scene.(*toolrt.Dict)
	}
	clips := []any{}
	hashes := toolrt.NewDict()
	for _, item := range intervals {
		name := "assets/shots/" + item.scene + "/manifest.json"
		original := load(name).Value("generation").(*toolrt.Dict).Value("original").(*toolrt.Dict)
		clips = append(clips, toolcli.Record(
			"id", "clip-"+item.scene, "scene", item.scene,
			"path", "assets/shots/"+item.scene+"/"+original.Value("path").(string), "kind", "video",
			"source_start_frame", toolrt.NewInt(item.start), "source_end_frame_exclusive", toolrt.NewInt(item.end),
			"source_frames", nil,
		))
		hashes.Set(item.scene, digest(name))
	}
	first, last := intervals[0].scene, intervals[len(intervals)-1].scene
	return toolcli.Record(
		"schema_version", toolrt.NewInt(1), "name", "Ручной монтаж", "clips", clips,
		"audio", toolcli.Record("path", "source/track.mp3", "start_frame", scenes[first].Value("start_frame"),
			"end_frame_exclusive", scenes[last].Value("end_frame_exclusive")),
		"base_scenes_sha256", digest("plan/scenes.json"), "base_manifest_sha256", hashes,
	)
}

// projectFiles — snapshot() test_apply_montage: байты файлов проекта без журналов и ревизий.
func projectFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		name := filepath.ToSlash(relative)
		for _, part := range strings.Split(name, "/") {
			if part == "montage-history" || part == "revisions" {
				return nil
			}
		}
		data, err := os.ReadFile(path)
		result[name] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// sameFiles сравнивает снимки и называет первое расхождение.
func sameFiles(t *testing.T, want, got map[string][]byte) {
	t.Helper()
	for name, data := range want {
		if other, ok := got[name]; !ok || !bytes.Equal(other, data) {
			t.Errorf("файл %s изменён или удалён", name)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			t.Errorf("новый файл %s", name)
		}
	}
}

// boundary — перенос стыка M01/M02 (два клипа).
var boundary = []interval{{"M01", 0, 255}, {"M02", 5, 110}}

// TestRenderFailureHasNoPartialMutation — ошибка второго рендера не меняет проект.
func TestRenderFailureHasNoPartialMutation(t *testing.T) {
	root := sampleProject(t)
	before := projectFiles(t, root)
	draft := makeDraft(t, root, boundary...)
	calls := 0
	renderEditHook = func(ctx context.Context, original, filter string, frames toolrt.Int, target string, fps int64) error {
		calls++
		if calls == 2 {
			return valueError("Сбой второго рендера")
		}
		return RenderEdit(ctx, original, filter, frames, target, fps)
	}
	t.Cleanup(func() { renderEditHook = RenderEdit })
	if _, err := Apply(context.Background(), draft, root, false); !toolrt.Is(err, toolrt.ValueError) {
		t.Fatalf("ожидался ValueError: %v", err)
	}
	if calls != 2 {
		t.Fatalf("рендеров %d", calls)
	}
	sameFiles(t, before, projectFiles(t, root))
	if Active() {
		t.Fatal("признак применения не снят после ошибки")
	}
}

// TestChangeDuringRenderIsRejectedBeforePublication — чужая правка реестра во время рендера
// останавливает применение до первой записи; правка сохраняется.
func TestChangeDuringRenderIsRejectedBeforePublication(t *testing.T) {
	root := sampleProject(t)
	draft := makeDraft(t, root, interval{"M02", 5, 125})
	before := projectFiles(t, root)
	registry := filepath.Join(root, "plan", "scenes.json")
	renderEditHook = func(ctx context.Context, original, filter string, frames toolrt.Int, target string, fps int64) error {
		if !Active() {
			t.Error("во время рендера применение не отмечено")
		}
		if err := RenderEdit(ctx, original, filter, frames, target, fps); err != nil {
			return err
		}
		data, _ := os.ReadFile(registry)
		return os.WriteFile(registry, append(data, '\n'), 0o644)
	}
	t.Cleanup(func() { renderEditHook = RenderEdit })
	_, err := Apply(context.Background(), draft, root, false)
	if err == nil || err.Error() != textRegistry {
		t.Fatalf("ожидался отказ по реестру: %v", err)
	}
	before["plan/scenes.json"] = append(before["plan/scenes.json"], '\n')
	sameFiles(t, before, projectFiles(t, root))
}

// TestPublicationErrorRollsBack — сбой публикации после реестра откатывает реестр, оба
// манифеста и представления; журнал — rolled_back.
func TestPublicationErrorRollsBack(t *testing.T) {
	root := sampleProject(t)
	before := projectFiles(t, root)
	calls := 0
	registry := filepath.Join(root, "plan", "scenes.json")
	publishFileHook = func(source, target string) error {
		calls++
		if err := PublishFile(source, target); err != nil {
			return err
		}
		if target == registry {
			return toolrt.New(toolrt.OSError, "Сбой после публикации реестра")
		}
		return nil
	}
	t.Cleanup(func() { publishFileHook = PublishFile })
	_, err := Apply(context.Background(), makeDraft(t, root, boundary...), root, true)
	if !toolrt.Is(err, toolrt.OSError) {
		t.Fatalf("ожидался OSError: %v", err)
	}
	if calls <= 2 {
		t.Fatalf("публикаций %d", calls)
	}
	sameFiles(t, before, projectFiles(t, root))
	journals := toolrt.Glob(filepath.Join(root, filepath.FromSlash(History)), "*/journal.json")
	if len(journals) != 1 {
		t.Fatalf("журналы %v", journals)
	}
	journal, err := toolrt.LoadJSONFile(journals[0])
	if err != nil || journal.(*toolrt.Dict).Value("state") != "rolled_back" {
		t.Fatalf("журнал %v: %v", journal, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(journals[0]), "staging")); !os.IsNotExist(err) {
		t.Fatalf("staging не удалён: %v", err)
	}
}

// TestNextLaunchRecoversInterruptedPublication — аварийная остановка посреди публикации
// оставляет журнал publishing; Recover возвращает проект, повторный Recover ничего не меняет.
func TestNextLaunchRecoversInterruptedPublication(t *testing.T) {
	root := sampleProject(t)
	before := projectFiles(t, root)
	crash := errors.New("имитация аварийного завершения")
	publishFileHook = func(source, target string) error {
		if err := PublishFile(source, target); err != nil {
			return err
		}
		return crash
	}
	// Остановка процесса не выполняет откат: подменённый restore оставляет журнал publishing.
	restoreHook = func(string, *toolrt.Dict, string) error { return crash }
	_, err := Apply(context.Background(), makeDraft(t, root, interval{"M02", 5, 125}), root, false)
	publishFileHook, restoreHook = PublishFile, restore
	if !errors.Is(err, crash) {
		t.Fatalf("ожидалась остановка: %v", err)
	}
	if len(toolrt.Glob(filepath.Join(root, filepath.FromSlash(History)), "*/staging")) != 1 {
		t.Fatal("staging прерванной публикации должен остаться для восстановления")
	}
	for range 2 {
		if err := Recover(root); err != nil {
			t.Fatal(err)
		}
		sameFiles(t, before, projectFiles(t, root))
	}
	if len(toolrt.Glob(filepath.Join(root, filepath.FromSlash(History)), "*/staging")) != 0 {
		t.Fatal("staging не удалён восстановлением")
	}
}

// TestInvalidDraftsNeverRender — неверные и устаревшие черновики отклоняются до рендера.
func TestInvalidDraftsNeverRender(t *testing.T) {
	root := sampleProject(t)
	before := projectFiles(t, root)
	renderEditHook = func(context.Context, string, string, toolrt.Int, string, int64) error {
		t.Error("рендер неверного черновика")
		return nil
	}
	t.Cleanup(func() { renderEditHook = RenderEdit })
	stale := makeDraft(t, root, interval{"M02", 5, 125})
	stale.Value("base_manifest_sha256").(*toolrt.Dict).Set("M02", strings.Repeat("0", 64))
	staleRegistry := makeDraft(t, root, interval{"M02", 5, 125})
	staleRegistry.Set("base_scenes_sha256", strings.Repeat("0", 64))
	reversed := makeDraft(t, root, interval{"M02", 0, 120}, interval{"M01", 0, 240})
	for _, draft := range []*toolrt.Dict{stale, staleRegistry, reversed} {
		if _, err := Apply(context.Background(), draft, root, false); !toolrt.Is(err, toolrt.ValueError) {
			t.Errorf("ожидался ValueError: %v", err)
		}
	}
	sameFiles(t, before, projectFiles(t, root))
}
