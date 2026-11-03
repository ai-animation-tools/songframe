package components

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// testManager подменяет только вызовы процессов, оставляя настоящее обнаружение и профиль.
func testManager(t *testing.T) (*Manager, *int, *int) {
	t.Helper()
	manifest, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	media, native := 0, 0
	options := managerOptions{os: "linux", arch: "amd64", lookPath: func(string) (string, error) { return "", os.ErrNotExist }, media: func(_ context.Context, m Manifest, _ FFmpegPair) (MediaReport, error) {
		media++
		report := MediaReport{Version: "проверена", Operations: map[string]ProbeOutcome{}}
		for _, c := range m.Capabilities {
			for _, probe := range c.Probes {
				if probe == "ffmpeg-recipes" {
					report.Operations[c.ID] = ProbeOutcome{"ready", "проверено"}
				}
			}
		}
		return report, nil
	}, ort: func(_ context.Context, _ string, models []ModelFile) (ORTReport, error) {
		native++
		report := ORTReport{Version: "1.31.0", API: 27, Models: map[string]ProbeOutcome{}}
		for _, model := range models {
			report.Models[model.Artifact.Component] = ProbeOutcome{"ready", "проверено"}
		}
		return report, nil
	}}
	return newManager(t.TempDir(), manifest, options), &media, &native
}

// component/operation находят статус по ID, чтобы тест не зависел от порядка карточек.
func component(t *testing.T, s Snapshot, id string) ComponentState {
	t.Helper()
	for _, c := range s.Components {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("нет компонента %s", id)
	return ComponentState{}
}
func operation(t *testing.T, s Snapshot, id string) OperationState {
	t.Helper()
	for _, c := range s.Operations {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("нет операции %s", id)
	return OperationState{}
}

// externalPair создаёт файлы с пробелами/кириллицей; исполнение в этих тестах подменено границей probe.
func externalPair(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Пара с ё")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("синтетический бинарник"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// installSynthetic меняет только тестовый экземпляр manifest и создаёт маленькие файлы.
// Это проверяет SHA/состав и порядок обнаружения без моделей, настоящего профиля и runtime.
func installSynthetic(t *testing.T, m *Manager, id string) string {
	t.Helper()
	for ai, a := range m.manifest.Artifacts {
		if a.Component != id || (a.OS != "any" && a.OS != "linux") {
			continue
		}
		root := filepath.Join(m.profile, "components", a.ID, a.Version)
		for fi, f := range a.Files {
			name := filepath.Join(root, filepath.FromSlash(f.Path))
			if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
				t.Fatal(err)
			}
			if f.Type == "symlink" {
				if err := os.Symlink(f.Target, name); err != nil {
					t.Fatal(err)
				}
				continue
			}
			data := []byte("fixture:" + id + ":" + f.Path)
			if id == "ctc-vocab" {
				vocab := map[string]int{"<pad>": 0, "|": 4, "ё": 6}
				for n := 0; n < 39; n++ {
					if n != 0 && n != 4 && n != 6 {
						vocab["буква"+strconv.Itoa(n)] = n
					}
				}
				data, _ = json.Marshal(vocab)
			}
			sum := sha256.Sum256(data)
			m.manifest.Artifacts[ai].Files[fi].Bytes = int64(len(data))
			m.manifest.Artifacts[ai].Files[fi].SHA256 = hex.EncodeToString(sum[:])
			if err := os.WriteFile(name, data, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		return root
	}
	t.Fatalf("нет артефакта %s", id)
	return ""
}

// TestManagerMissingDoesNotBlockReading подтверждает отсутствие глобальной производственной блокировки.
func TestManagerMissingDoesNotBlockReading(t *testing.T) {
	m, media, native := testManager(t)
	s := m.State()
	if operation(t, s, "project-view").Status != "ready" || operation(t, s, "timing-view").Status != "ready" {
		t.Fatal(s)
	}
	if component(t, s, "ffmpeg").Status != "missing" {
		t.Fatal(s)
	}
	s, err := m.Check(context.Background(), []string{"project-view", "timing-view"}, false)
	if err != nil || s.Checking || *media != 0 || *native != 0 {
		t.Fatalf("лишняя производственная проверка: %v %+v", err, s)
	}
}

// TestManagerExplicitPathNeverFallsBack сохраняет намерение пользователя при исчезнувшей папке.
func TestManagerExplicitPathNeverFallsBack(t *testing.T) {
	m, _, _ := testManager(t)
	pair := externalPair(t)
	calls := 0
	m.options.lookPath = func(name string) (string, error) { calls++; return filepath.Join(pair, name), nil }
	if _, err := m.Configure(Selection{FFmpegDirectory: filepath.Join(t.TempDir(), "нет")}); err != nil {
		t.Fatal(err)
	}
	s := m.State()
	if calls != 0 || component(t, s, "ffmpeg").Source != "explicit" || component(t, s, "ffmpeg").Status != "missing" {
		t.Fatal(s, calls)
	}
}

// TestManagerManagedFallbackAndVersionMask проверяет неполный/испорченный managed и неподтверждённый OS/arch.
func TestManagerManagedFallbackAndVersionMask(t *testing.T) {
	for _, mode := range []string{"неполный", "неверный SHA", "нет пакета"} {
		t.Run(mode, func(t *testing.T) {
			m, _, _ := testManager(t)
			pair := externalPair(t)
			m.options.lookPath = func(name string) (string, error) { return filepath.Join(pair, name), nil }
			root := installSynthetic(t, m, "ffmpeg")
			switch mode {
			case "неполный":
				os.Remove(filepath.Join(root, "bin/ffprobe"))
			case "неверный SHA":
				os.WriteFile(filepath.Join(root, "bin/ffmpeg"), []byte("другие байты"), 0o700)
			case "нет пакета":
				m.options.os = "darwin"
			}
			s, err := m.Check(context.Background(), []string{"audio-pcm"}, false)
			if err != nil || component(t, s, "ffmpeg").Source != "path" || operation(t, s, "audio-pcm").Status != "ready" {
				t.Fatalf("PATH потерян: %v %+v", err, s)
			}
		})
	}
}

// TestManagerPartialMediaAndCache не позволяет ошибке экспорта блокировать PCM или пережить Force failure.
func TestManagerPartialMediaAndCache(t *testing.T) {
	m, media, _ := testManager(t)
	pair := externalPair(t)
	if _, err := m.Configure(Selection{FFmpegDirectory: pair}); err != nil {
		t.Fatal(err)
	}
	original := m.options.media
	m.options.media = func(ctx context.Context, manifest Manifest, pair FFmpegPair) (MediaReport, error) {
		r, err := original(ctx, manifest, pair)
		r.Operations["montage-export"] = ProbeOutcome{"incompatible", "нет libx264"}
		return r, err
	}
	s, err := m.Check(context.Background(), []string{"audio-pcm", "montage-export"}, false)
	if err != nil || s.Checking || operation(t, s, "audio-pcm").Status != "ready" || operation(t, s, "montage-export").Status != "incompatible" {
		t.Fatal(err, s)
	}
	m.Check(context.Background(), []string{"audio-pcm"}, false)
	if *media != 1 {
		t.Fatal("неизменный медиакомплект проверен повторно")
	}
	m.options.media = func(context.Context, Manifest, FFmpegPair) (MediaReport, error) {
		return MediaReport{}, errors.New("исчезла внешняя библиотека")
	}
	s, err = m.Check(context.Background(), []string{"audio-pcm"}, true)
	if err == nil || operation(t, s, "audio-pcm").Status == "ready" || s.Checking {
		t.Fatal("старый успех перекрыл отказ", s, err)
	}
}

// TestManagerModelsAndPartialNative сохраняет независимость VocFT от CTC и кэш хеширования.
func TestManagerModelsAndPartialNative(t *testing.T) {
	m, _, native := testManager(t)
	for _, id := range []string{"ffmpeg", "ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"} {
		installSynthetic(t, m, id)
	}
	m.options.ort = func(_ context.Context, _ string, models []ModelFile) (ORTReport, error) {
		*native++
		r := ORTReport{API: 27, Version: "1.31.0", Models: map[string]ProbeOutcome{}}
		for _, model := range models {
			r.Models[model.Artifact.Component] = ProbeOutcome{"ready", "проверено"}
		}
		r.Models["ctc-ru"] = ProbeOutcome{"incompatible", "не подходит граф"}
		return r, nil
	}
	s, err := m.Check(context.Background(), []string{"known-text-ctc"}, false)
	if err != nil || operation(t, s, "prepare-vocals").Status != "ready" || operation(t, s, "ctc-existing-vocals").Status != "incompatible" {
		t.Fatal(err, s)
	}
	lib := component(t, s, "ort-cpu").Paths["ort-library"]
	info, _ := os.Stat(lib)
	data, _ := os.ReadFile(lib)
	data[0] ^= 1
	os.WriteFile(lib, data, 0o700)
	os.Chtimes(lib, info.ModTime(), info.ModTime())
	before := *native
	s, err = m.Check(context.Background(), []string{"prepare-vocals"}, true)
	if err == nil || *native != before || component(t, s, "ort-cpu").Status == "ready" {
		t.Fatal("неверный SHA допустил native загрузку", err, s)
	}
}

// TestManagerExistingVocalDoesNotRequireVocFT проверяет отдельную функцию выравнивания готового WAV.
func TestManagerExistingVocalDoesNotRequireVocFT(t *testing.T) {
	m, _, _ := testManager(t)
	for _, id := range []string{"ffmpeg", "ort-cpu", "ctc-ru", "ctc-vocab"} {
		installSynthetic(t, m, id)
	}
	s, err := m.Check(context.Background(), []string{"ctc-existing-vocals"}, false)
	if err != nil || operation(t, s, "ctc-existing-vocals").Status != "ready" || operation(t, s, "prepare-vocals").Status == "ready" {
		t.Fatal(err, s)
	}
	vocab := component(t, s, "ctc-vocab").Paths["vocab"]
	os.Remove(vocab)
	if operation(t, m.State(), "ctc-existing-vocals").Status == "ready" {
		t.Fatal("исчезнувший vocab оставил ready")
	}
}

// TestManagerCancelAndConfiguration проверяет отмену, запрет одновременного выбора и очистку Checking.
func TestManagerCancelAndConfiguration(t *testing.T) {
	m, _, _ := testManager(t)
	m.Configure(Selection{FFmpegDirectory: externalPair(t)})
	started := make(chan struct{})
	m.options.media = func(ctx context.Context, _ Manifest, _ FFmpegPair) (MediaReport, error) {
		close(started)
		<-ctx.Done()
		return MediaReport{}, ctx.Err()
	}
	done := make(chan Snapshot, 1)
	go func() { s, _ := m.Check(context.Background(), []string{"audio-pcm"}, false); done <- s }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("проверка не началась")
	}
	if !m.State().Checking {
		t.Fatal("не показана выполняющаяся проверка")
	}
	if _, err := m.Configure(Selection{}); err == nil {
		t.Fatal("выбор заменён во время проверки")
	}
	m.Cancel()
	select {
	case s := <-done:
		if s.Checking || operation(t, s, "audio-pcm").Status != "cancelled" {
			t.Fatal(s)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("отмена зависла")
	}
}

// TestManagerSettingsRecoveryAndReadOnlyState не меняет повреждённый профиль до явного Configure.
func TestManagerSettingsRecoveryAndReadOnlyState(t *testing.T) {
	m, _, _ := testManager(t)
	name := filepath.Join(m.profile, "components.json")
	os.WriteFile(name, []byte("broken"), 0o600)
	again := newManager(m.profile, m.manifest, m.options)
	s := again.State()
	if s.Problem == "" || operation(t, s, "project-view").Status != "ready" || operation(t, s, "audio-pcm").Status == "ready" {
		t.Fatal(s)
	}
	data, _ := os.ReadFile(name)
	if string(data) != "broken" {
		t.Fatal("чтение переписало настройки")
	}
	pair := externalPair(t)
	if _, err := again.Configure(Selection{FFmpegDirectory: pair}); err != nil {
		t.Fatal(err)
	}
	reopened := newManager(m.profile, m.manifest, m.options)
	if reopened.State().Problem != "" || reopened.State().Selection.FFmpegDirectory != pair {
		t.Fatal("выбор не сохранён")
	}
	if _, err := reopened.Check(context.Background(), []string{"shell.execute"}, false); err == nil || !strings.Contains(err.Error(), "неизвестная") {
		t.Fatal(err)
	}
}

// TestManagerIntegration соединяет настоящее обнаружение, SHA и оба native probe на явных read-only файлах.
// Профиль всегда временный; без env обычный набор остаётся независимым от установленного runtime.
func TestManagerIntegration(t *testing.T) {
	mediaDir, library, modelDir := os.Getenv("SONGFRAME_TEST_MEDIA_BIN"), os.Getenv("SONGFRAME_ORT_LIBRARY"), os.Getenv("SONGFRAME_ORT_MODEL_DIR")
	if mediaDir == "" || library == "" || modelDir == "" {
		t.Skip("не заданы явные каталоги integration компонентов")
	}
	m, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.Configure(Selection{FFmpegDirectory: mediaDir, ORTDirectory: filepath.Dir(filepath.Dir(library)), VocalsFile: filepath.Join(modelDir, "vocals.onnx"), CTCDirectory: modelDir})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	snapshot, err := m.Check(ctx, []string{"known-text-ctc", "montage-export"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Checking {
		t.Fatal("проверка завершилась с активным флагом")
	}
	for _, id := range []string{"known-text-ctc", "ctc-existing-vocals", "prepare-vocals", "montage-export", "project-view", "timing-view"} {
		if got := operation(t, snapshot, id); got.Status != "ready" {
			t.Fatalf("%s: %s: %s", id, got.Status, got.Reason)
		}
	}
	t.Logf("Проверены %d компонента и %d функций без загрузки пакетов", len(snapshot.Components), len(snapshot.Operations))
}

// TestManagerManagedPartialAndForceRetry повторяет transient отказ без изменения stat файлов.
func TestManagerManagedPartialAndForceRetry(t *testing.T) {
	m, _, _ := testManager(t)
	managed := installSynthetic(t, m, "ffmpeg")
	pair := externalPair(t)
	m.options.lookPath = func(name string) (string, error) { return filepath.Join(pair, name), nil }
	original := m.options.media
	broken := true
	m.options.media = func(ctx context.Context, manifest Manifest, pair FFmpegPair) (MediaReport, error) {
		r, err := original(ctx, manifest, pair)
		if broken && strings.HasPrefix(pair.FFmpeg, managed) {
			r.Operations["montage-export"] = ProbeOutcome{"incompatible", "временно недоступен encoder"}
		}
		return r, err
	}
	snapshot, err := m.Check(context.Background(), []string{"montage-export"}, false)
	if err != nil || component(t, snapshot, "ffmpeg").Source != "path" || operation(t, snapshot, "montage-export").Status != "ready" {
		t.Fatal(err, snapshot)
	}
	broken = false
	snapshot, err = m.Check(context.Background(), []string{"montage-export"}, true)
	if err != nil || component(t, snapshot, "ffmpeg").Source != "managed" || operation(t, snapshot, "montage-export").Status != "ready" {
		t.Fatal("force не повторил managed", err, snapshot)
	}
}

// TestManagerNativeConfirmationIsCached не загружает sessions заново при просмотре прежнего результата.
func TestManagerNativeConfirmationIsCached(t *testing.T) {
	m, _, native := testManager(t)
	for _, id := range []string{"ffmpeg", "ort-cpu", "ctc-ru", "ctc-vocab"} {
		installSynthetic(t, m, id)
	}
	for n := 0; n < 2; n++ {
		if _, err := m.Check(context.Background(), []string{"ctc-existing-vocals"}, false); err != nil {
			t.Fatal(err)
		}
	}
	if *native != 1 {
		t.Fatalf("неизменные sessions проверены %d раз", *native)
	}
	if _, err := m.Check(context.Background(), []string{"ctc-existing-vocals"}, true); err != nil {
		t.Fatal(err)
	}
	if *native != 2 {
		t.Fatal("force не запустил native перепроверку")
	}
}

// TestManagerReconsidersSourceForAnotherFunction не переносит частичный отказ на иной набор операций.
func TestManagerReconsidersSourceForAnotherFunction(t *testing.T) {
	m, _, _ := testManager(t)
	managed := installSynthetic(t, m, "ffmpeg")
	pair := externalPair(t)
	m.options.lookPath = func(name string) (string, error) { return filepath.Join(pair, name), nil }
	original := m.options.media
	m.options.media = func(ctx context.Context, manifest Manifest, pair FFmpegPair) (MediaReport, error) {
		r, err := original(ctx, manifest, pair)
		id := "audio-pcm"
		if strings.HasPrefix(pair.FFmpeg, managed) {
			id = "montage-export"
		}
		r.Operations[id] = ProbeOutcome{"incompatible", "нет возможности"}
		return r, err
	}
	snapshot, err := m.Check(context.Background(), []string{"montage-export"}, false)
	if err != nil || component(t, snapshot, "ffmpeg").Source != "path" || operation(t, snapshot, "montage-export").Status != "ready" {
		t.Fatal(err, snapshot)
	}
	snapshot, err = m.Check(context.Background(), []string{"audio-pcm"}, false)
	if err != nil || component(t, snapshot, "ffmpeg").Source != "managed" || operation(t, snapshot, "audio-pcm").Status != "ready" {
		t.Fatal("прежний PATH затенил пригодный managed", err, snapshot)
	}
}

// TestManagerMissingPATHReconsidersManaged забывает прежний fallback после исчезновения его файлов.
func TestManagerMissingPATHReconsidersManaged(t *testing.T) {
	m, _, _ := testManager(t)
	managed := installSynthetic(t, m, "ffmpeg")
	pair := externalPair(t)
	m.options.lookPath = func(name string) (string, error) {
		p := filepath.Join(pair, name)
		if _, err := os.Stat(p); err != nil {
			return "", err
		}
		return p, nil
	}
	original := m.options.media
	broken := true
	m.options.media = func(ctx context.Context, manifest Manifest, pair FFmpegPair) (MediaReport, error) {
		r, err := original(ctx, manifest, pair)
		if broken && strings.HasPrefix(pair.FFmpeg, managed) {
			r.Operations["montage-export"] = ProbeOutcome{"incompatible", "временный отказ"}
		}
		return r, err
	}
	if _, err := m.Check(context.Background(), []string{"montage-export"}, false); err != nil {
		t.Fatal(err)
	}
	broken = false
	os.Remove(filepath.Join(pair, "ffprobe"))
	snapshot, err := m.Check(context.Background(), []string{"montage-export"}, false)
	if err != nil || component(t, snapshot, "ffmpeg").Source != "managed" || operation(t, snapshot, "montage-export").Status != "ready" {
		t.Fatal("исчезнувший PATH затенил managed", err, snapshot)
	}
}
