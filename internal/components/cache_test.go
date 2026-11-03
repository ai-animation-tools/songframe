package components

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// explicitCachedManager подключает синтетические модели и runtime внешними путями.
// Это отделяет изменение управляемой папки от содержимого уже пригодных компонентов.
func explicitCachedManager(t *testing.T) (*Manager, *int, *int, Selection) {
	t.Helper()
	m, media, native := testManager(t)
	vocals := installSynthetic(t, m, "voc-ft")
	ctc := installSynthetic(t, m, "ctc-ru")
	vocab := installSynthetic(t, m, "ctc-vocab")
	runtime, _ := explicitORTLibrary(t, m)
	ctcRoot := filepath.Join(t.TempDir(), "Внешний CTC")
	if err := os.MkdirAll(ctcRoot, 0700); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{filepath.Join(ctc, "alignment.onnx"), filepath.Join(vocab, "vocab.json")} {
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(ctcRoot, filepath.Base(source)), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	selection := Selection{FFmpegDirectory: externalPair(t), ORTDirectory: runtime, VocalsFile: filepath.Join(vocals, "vocals.onnx"), CTCDirectory: ctcRoot}
	if _, err := m.Configure(selection); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Check(context.Background(), []string{"known-text-ctc"}, false); err != nil {
		t.Fatal(err)
	}
	return m, media, native, selection
}

// TestConfigurePreservesUnchangedNativeAndMedia подтверждает, что выбор другой папки загрузок не трогает готовые внешние компоненты.
// Повтор фоновой проверки после сохранения использует прежние fingerprints и не запускает probes заново.
func TestConfigurePreservesUnchangedNativeAndMedia(t *testing.T) {
	m, media, native, selection := explicitCachedManager(t)
	initial := m.State()
	selection.ManagedDirectory = filepath.Join(t.TempDir(), "Новая папка загрузок")
	state, err := m.Configure(selection)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(state.Components, initial.Components) || !reflect.DeepEqual(state.Operations, initial.Operations) {
		t.Fatalf("неизменившиеся компоненты потеряли готовность: %+v", state)
	}
	if _, err = m.Check(context.Background(), []string{"known-text-ctc"}, false); err != nil {
		t.Fatal(err)
	}
	if *media != 1 || *native != 1 {
		t.Fatalf("неизменившиеся компоненты перепроверены: media=%d native=%d", *media, *native)
	}
	if _, err = m.Configure(selection); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Check(context.Background(), []string{"known-text-ctc"}, false); err != nil {
		t.Fatal(err)
	}
	if *media != 1 || *native != 1 {
		t.Fatal("повторное сохранение того же выбора сбросило кэш")
	}
}

// TestConfigureFFmpegInvalidatesOnlyChangedPair не заставляет ORT повторно создавать model sessions ради другого FFmpeg.
// Новая пара получает собственный functional probe, остальные зависимости остаются готовыми.
func TestConfigureFFmpegInvalidatesOnlyChangedPair(t *testing.T) {
	m, media, native, selection := explicitCachedManager(t)
	selection.FFmpegDirectory = externalPair(t)
	state, err := m.Configure(selection)
	if err != nil {
		t.Fatal(err)
	}
	if component(t, state, "ffmpeg").Status != "unchecked" || component(t, state, "ort-cpu").Status != "ready" || component(t, state, "voc-ft").Status != "ready" {
		t.Fatalf("неверная область invalidation: %+v", state)
	}
	if _, err = m.Check(context.Background(), []string{"known-text-ctc"}, false); err != nil {
		t.Fatal(err)
	}
	if *media != 2 || *native != 1 {
		t.Fatalf("лишний native probe: media=%d native=%d", *media, *native)
	}
}

// TestConfigureKeepsSHAUntilMetadataOrForce изменяет bytes при сохранённых metadata, чтобы отличить повторное хеширование от reuse.
// Внешняя настройка не читает модель заново; явный Force всё ещё обнаруживает такое повреждение.
func TestConfigureKeepsSHAUntilMetadataOrForce(t *testing.T) {
	m, _, native, selection := explicitCachedManager(t)
	file := selection.VocalsFile
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	data[0] ^= 1
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	selection.ManagedDirectory = t.TempDir()
	if _, err = m.Configure(selection); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Check(context.Background(), []string{"prepare-vocals"}, false); err != nil {
		t.Fatalf("unchanged metadata не использовали ранее подтверждённый SHA: %v", err)
	}
	if *native != 1 {
		t.Fatal("unchanged native sessions перепроверены")
	}
	state, err := m.Check(context.Background(), []string{"prepare-vocals"}, true)
	if err == nil || component(t, state, "voc-ft").Status == "ready" {
		t.Fatal("Force не выявил повреждение модели")
	}
}

// TestConfigureNewModelMetadataAndRuntimeRequireCheck проверяет снятие ready при новых путях без обнуления остальных подтверждений.
// Уже загруженный runtime не наследует ready другого пути и сохраняет требование перезапуска от native boundary.
func TestConfigureNewModelMetadataAndRuntimeRequireCheck(t *testing.T) {
	m, media, native, selection := explicitCachedManager(t)
	originalFile := selection.VocalsFile
	data, err := os.ReadFile(originalFile)
	if err != nil {
		t.Fatal(err)
	}
	selection.VocalsFile = filepath.Join(t.TempDir(), "Новая копия модели.onnx")
	if err = os.WriteFile(selection.VocalsFile, data, 0600); err != nil {
		t.Fatal(err)
	}
	state, err := m.Configure(selection)
	if err != nil {
		t.Fatal(err)
	}
	if component(t, state, "voc-ft").Status != "unchecked" || component(t, state, "ctc-ru").Status != "ready" {
		t.Fatalf("новый путь не снял ready: %+v", state)
	}
	if _, err = m.Check(context.Background(), []string{"prepare-vocals"}, false); err != nil {
		t.Fatal(err)
	}
	if *media != 1 || *native != 2 {
		t.Fatalf("новая модель не проверена: media=%d native=%d", *media, *native)
	}
	replacement, _ := explicitORTLibrary(t, m)
	selection.ORTDirectory = replacement
	originalORT := m.options.ort
	m.options.ort = func(ctx context.Context, library string, models []ModelFile) (ORTReport, error) {
		*native++
		return ORTReport{RestartRequired: true}, errors.New("нужен перезапуск для смены runtime")
	}
	defer func() { m.options.ort = originalORT }()
	state, err = m.Configure(selection)
	if err != nil {
		t.Fatal(err)
	}
	if component(t, state, "ort-cpu").Status != "unchecked" || operation(t, state, "prepare-vocals").Status == "ready" {
		t.Fatal("новый runtime унаследовал старый ready")
	}
	state, err = m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if err == nil || component(t, state, "ort-cpu").Status != "restart_required" || *native != 3 {
		t.Fatalf("требование перезапуска обойдено: %v %+v calls=%d", err, state, *native)
	}
}

// TestConfigurePreservesManagedFallback сохраняет выбор подходящего PATH при неполной capability управляемой пары.
// Изменение только модели не должно возвращать пользователю уже отклонённый FFmpeg.
func TestConfigurePreservesManagedFallback(t *testing.T) {
	m, media, _ := testManager(t)
	managed := installSynthetic(t, m, "ffmpeg")
	pair := externalPair(t)
	m.options.lookPath = func(role string) (string, error) { return filepath.Join(pair, role), nil }
	original := m.options.media
	m.options.media = func(ctx context.Context, manifest Manifest, p FFmpegPair) (MediaReport, error) {
		report, err := original(ctx, manifest, p)
		if filepath.Dir(filepath.Dir(p.FFmpeg)) == managed {
			report.Operations["montage-export"] = ProbeOutcome{Status: "incompatible", Reason: "нет encoder"}
		}
		return report, err
	}
	before, err := m.Check(context.Background(), []string{"montage-export"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if component(t, before, "ffmpeg").Source != "path" {
		t.Fatalf("не выбран fallback: %+v", before)
	}
	calls := *media
	state, err := m.Configure(Selection{VocalsFile: filepath.Join(t.TempDir(), "Пока нет модели.onnx")})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(component(t, state, "ffmpeg"), component(t, before, "ffmpeg")) {
		t.Fatal("посторонняя настройка сбросила PATH fallback")
	}
	state, err = m.Check(context.Background(), []string{"montage-export"}, false)
	if err != nil || *media != calls || operation(t, state, "montage-export").Status != "ready" {
		t.Fatalf("повторный fallback probe: %v calls=%d expected=%d %+v", err, *media, calls, state)
	}
}

// TestInstallTransfersOnlySHAProofToPublished сохраняет проверку байтов после неизменяющего их rename.
// Check не перечитывает уже проверенную модель, но Force по-прежнему выявляет повреждение с прежними metadata.
func TestInstallTransfersOnlySHAProofToPublished(t *testing.T) {
	m, a, data := installationFixture(t)
	source := offlinePayload(t, data)
	if _, err := m.Install(context.Background(), InstallRequest{Components: []string{"voc-ft"}, LocalFiles: map[string]string{"voc-ft": source}}); err != nil {
		t.Fatal(err)
	}
	published := filepath.Join(managedArtifactDirectory(filepath.Join(m.profile, "components"), a), "vocals.onnx")
	initial := component(t, m.State(), "voc-ft")
	if initial.Status != "unchecked" {
		t.Fatal("установка ошибочно подтвердила native ready")
	}
	info, err := os.Stat(published)
	if err != nil {
		t.Fatal(err)
	}
	changed := append([]byte{}, data...)
	changed[0] ^= 1
	if err = os.WriteFile(published, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(published, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	// Компоненты зависимости здесь отсутствуют, однако Check всё равно должен проверить найденную модель.
	state, err := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if err == nil {
		t.Fatal("отсутствующие зависимости не определены")
	}
	if component(t, state, "voc-ft").Status != "blocked" {
		t.Fatalf("модель не сохранила подтверждённый SHA в ожидании runtime: %+v", component(t, state, "voc-ft"))
	}
	state, _ = m.Check(context.Background(), []string{"prepare-vocals"}, true)
	if component(t, state, "voc-ft").Status != "incompatible" {
		t.Fatal("Force не перечитал опубликованный файл")
	}
}

// TestInstallChangedPublishedMetadataDoesNotTransferSHA отклоняет подменённый payload до active publication.
// Неизменность metadata после rename обязательна для переноса SHA; прежняя установка остаётся доступной.
func TestInstallChangedPublishedMetadataDoesNotTransferSHA(t *testing.T) {
	m, a, data := installationFixture(t)
	request := InstallRequest{Components: []string{"voc-ft"}, LocalFiles: map[string]string{"voc-ft": offlinePayload(t, data)}}
	if _, err := m.Install(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	previous := managedArtifactDirectory(filepath.Join(m.profile, "components"), a)
	m.installOptions.rename = func(source, target string) error {
		if err := os.Rename(source, target); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(target, "vocals.onnx"), append(data, 0), 0600)
	}
	if _, err := m.Install(context.Background(), request); err == nil {
		t.Fatal("изменённый payload подключён")
	}
	if managedArtifactDirectory(filepath.Join(m.profile, "components"), a) != previous {
		t.Fatal("изменён active после подмены payload")
	}
	if got, err := os.ReadFile(filepath.Join(previous, "vocals.onnx")); err != nil || !reflect.DeepEqual(got, data) {
		t.Fatal("повреждена прежняя установка")
	}
}

// TestConfigureMetadataChangeAndCancellation сохраняет отсутствие ready при изменении файла и не уничтожает пригодные соседние компоненты при отмене.
// Следующая обычная проверка видит новое содержимое модели через metadata без ручного Force.
func TestConfigureMetadataChangeAndCancellation(t *testing.T) {
	m, media, native, selection := explicitCachedManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Check(ctx, []string{"known-text-ctc"}, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("не сохранена отмена: %v", err)
	}
	if component(t, m.State(), "ort-cpu").Status != "ready" {
		t.Fatal("отмена уничтожила пригодный runtime")
	}
	if err := os.WriteFile(selection.VocalsFile, []byte("новое содержимое другой длины"), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := m.Configure(selection)
	if err != nil {
		t.Fatal(err)
	}
	if component(t, state, "voc-ft").Status != "unchecked" || component(t, state, "ctc-ru").Status != "ready" {
		t.Fatalf("неверная invalidation: %+v", state)
	}
	state, err = m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if err == nil || component(t, state, "voc-ft").Status != "incompatible" || *media != 1 || *native != 1 {
		t.Fatalf("metadata change не выявлен: %v media=%d native=%d %+v", err, *media, *native, state)
	}
}
