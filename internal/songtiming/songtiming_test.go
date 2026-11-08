package songtiming

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe/internal/components"
	"songframe/internal/jobs"
	"songframe/internal/songml"
)

// fakeComponents — менеджер компонентов без файлов: статусы задаются тестом, Check ждёт release.
type fakeComponents struct {
	mu        sync.Mutex
	statuses  map[string]string
	checking  chan struct{}
	release   chan struct{}
	downloads [][]string
}

func newFakeComponents(status string) *fakeComponents {
	statuses := map[string]string{}
	for _, id := range []string{"ffmpeg", "ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"} {
		statuses[id] = status
	}
	return &fakeComponents{statuses: statuses, checking: make(chan struct{}, 8), release: make(chan struct{})}
}

func (f *fakeComponents) State() components.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	snapshot := components.Snapshot{Components: []components.ComponentState{}, Operations: []components.OperationState{}}
	for id, status := range f.statuses {
		snapshot.Components = append(snapshot.Components, components.ComponentState{ID: id, Status: status, Paths: map[string]string{}})
	}
	return snapshot
}

func (f *fakeComponents) Check(ctx context.Context, _ []string, _ bool) (components.Snapshot, error) {
	f.checking <- struct{}{}
	select {
	case <-ctx.Done():
	case <-f.release:
	}
	return f.State(), ctx.Err()
}

func (f *fakeComponents) Download(_ context.Context, ids []string) (components.InstallSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.downloads = append(f.downloads, ids)
	for _, id := range ids {
		f.statuses[id] = "unchecked"
	}
	return components.InstallSnapshot{}, nil
}

// Installation — журнал последней установки: до загрузки пуст, после неё — строка итога.
func (f *fakeComponents) Installation() components.InstallSnapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.downloads) == 0 {
		return components.InstallSnapshot{Log: []components.InstallLog{}}
	}
	return components.InstallSnapshot{Log: []components.InstallLog{{Message: "установлено"}}}
}
func (f *fakeComponents) CancelInstall() {}
func (f *fakeComponents) Catalog() []components.InstallPackage {
	return []components.InstallPackage{{Component: "ffmpeg", Bytes: 10}, {Component: "ort-cpu", Bytes: 20}, {Component: "voc-ft", Bytes: 30}, {Component: "ctc-ru", Bytes: 40}, {Component: "ctc-vocab", Bytes: 1}}
}

// fixture — проект с треком и текстом и профиль с готовым выбранным вокалом.
type fixture struct {
	project, profile string
	sourceSHA, id    string
	service          *Service
	manager          *jobs.Manager
	parts            *fakeComponents
}

func newFixture(t *testing.T, status string) *fixture {
	t.Helper()
	root := t.TempDir()
	f := &fixture{project: filepath.Join(root, "project"), profile: filepath.Join(root, "profile"), parts: newFakeComponents(status)}
	write := func(path string, data []byte) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	track := []byte("ID3 тестовый трек")
	write(filepath.Join(f.project, "source", "track.mp3"), track)
	write(filepath.Join(f.project, "source", "text.md"), []byte("[Куплет]\nПервая строка\n"))
	write(filepath.Join(f.project, "plan", "audio", "timing.json"), []byte("{\"version\": 2}\n"))
	digest := sha256.Sum256(track)
	f.sourceSHA = hex.EncodeToString(digest[:])
	f.id = "0f0e0d0c-0b0a-4908-8706-050403020100"
	f.writeResult(t, f.id, "2026-11-04T10:00:00.000000+00:00")
	f.manager = jobs.New(filepath.Join(root, "state"), jobs.Options{SkipRestore: true})
	f.service = New(f.manager, f.parts, f.profile, nil)
	return f
}

// writeResult пишет корректный канонический результат выделения (4 отсчёта тишины).
func (f *fixture) writeResult(t *testing.T, id, created string) {
	t.Helper()
	directory := filepath.Join(f.profile, "vocal-results", f.sourceSHA, id)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	audio := filepath.Join(directory, "vocals.wav")
	file, err := os.Create(audio)
	if err != nil {
		t.Fatal(err)
	}
	if err := songml.WriteStereoWAV(file, [2][]float32{make([]float32, 4), make([]float32, 4)}); err != nil {
		t.Fatal(err)
	}
	file.Close()
	digest, err := fileSHA256(audio)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(metadata{SchemaVersion: 1, SourceSHA256: f.sourceSHA, ModelID: "voc-ft", ModelSHA256: knownModels[0].SHA256, RecipeVersion: 1, SampleRate: 44100, Channels: 2, Samples: 4, AudioFile: "vocals.wav", AudioSHA256: digest, CreatedAt: created})
	if err := os.WriteFile(filepath.Join(directory, "result.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func wait(t *testing.T, manager *jobs.Manager, id string) jobs.Info {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := manager.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

// TestVocalStoreViewSelectDelete — проверка WAV, выбор, порча результата и удаление в корзину
// со сбросом и восстановлением выбора.
func TestVocalStoreViewSelectDelete(t *testing.T) {
	f := newFixture(t, "unchecked")
	view := f.service.VocalsView(f.project)
	if len(view.Results) != 1 || view.SelectedID != nil || len(view.Problems) != 0 || !view.Models[0].Installed || view.Models[0].TotalBytes != 60 {
		t.Fatalf("%+v", view)
	}
	if view.Results[0].Duration != 4.0/44100 || view.Results[0].ModelLabel != "Voc FT" {
		t.Fatalf("%+v", view.Results[0])
	}
	if _, err := f.service.Start(f.project, GenerateOptions{Vocals: true}); err == nil || err.Error() != textSelectRequired {
		t.Fatalf("без выбора: %v", err)
	}
	if _, err := f.service.SelectVocal(f.project, "../x"); err == nil {
		t.Fatal("неверный ID должен отклоняться")
	}
	view, err := f.service.SelectVocal(f.project, f.id)
	if err != nil || view.SelectedID == nil || *view.SelectedID != f.id {
		t.Fatalf("%v %+v", err, view)
	}
	// Корзина отказала: выбор возвращается.
	if _, err := f.service.DeleteVocal(f.project, f.id, func(string) error { return errors.New("корзина недоступна") }); err == nil {
		t.Fatal("ошибка корзины должна возвращаться")
	}
	if view := f.service.VocalsView(f.project); view.SelectedID == nil {
		t.Fatal("выбор не восстановлен")
	}
	// Порча WAV делает вариант неисправным.
	second := "1f0e0d0c-0b0a-4908-8706-050403020100"
	f.writeResult(t, second, "2026-11-04T11:00:00.000000+00:00")
	if view := f.service.VocalsView(f.project); len(view.Results) != 2 || view.Results[0].ID != second {
		t.Fatalf("новые варианты сверху: %+v", view.Results)
	}
	wav := filepath.Join(f.profile, "vocal-results", f.sourceSHA, second, "vocals.wav")
	data, _ := os.ReadFile(wav)
	data[len(data)-1] = 1
	os.WriteFile(wav, data, 0o600)
	if view := f.service.VocalsView(f.project); len(view.Results) != 1 || len(view.Problems) != 1 || view.Problems[0] != textResultInvalid {
		t.Fatalf("испорченный WAV: %+v", view)
	}
	var moved string
	view, err = f.service.DeleteVocal(f.project, f.id, func(path string) error { moved = path; return os.RemoveAll(path) })
	if err != nil || view.SelectedID != nil || !strings.HasSuffix(moved, f.id) {
		t.Fatalf("%v %+v %s", err, view, moved)
	}
	if view.Problems == nil || len(view.Results) != 0 {
		t.Fatalf("%+v", view)
	}
}

// TestStartCancelKeepsTiming — отмена разметки до публикации не меняет timing.json, задание
// завершается причиной разметки, удержание вокала снимается.
func TestStartCancelKeepsTiming(t *testing.T) {
	f := newFixture(t, "unchecked")
	if _, err := f.service.SelectVocal(f.project, f.id); err != nil {
		t.Fatal(err)
	}
	timingPath := filepath.Join(f.project, "plan", "audio", "timing.json")
	before, _ := os.ReadFile(timingPath)
	info, err := f.service.Start(f.project, GenerateOptions{Vocals: true})
	if err != nil {
		t.Fatal(err)
	}
	if info.Steps[0].Tool != "align_lyrics" || info.Steps[0].Label != textTimingVocals || info.Title != textJobTitle {
		t.Fatalf("%+v", info)
	}
	<-f.parts.checking
	if _, err := f.service.Start(f.project, GenerateOptions{}); err == nil || err.Error() != textTimingBusy {
		t.Fatalf("повторный запуск: %v", err)
	}
	if _, err := f.service.SeparateVocals(f.project, "voc-ft"); err == nil || err.Error() != textVocalBusy {
		t.Fatalf("выделение во время разметки: %v", err)
	}
	if _, err := f.service.DeleteVocal(f.project, f.id, os.RemoveAll); err == nil || err.Error() != textDeleteBusy {
		t.Fatalf("удаление занятого вокала: %v", err)
	}
	if _, err := f.service.Cancel(info.ID); err != nil {
		t.Fatal(err)
	}
	final := wait(t, f.manager, info.ID)
	if final.Status != jobs.StatusFailed || final.Error == nil || *final.Error != textTimingCancelled {
		t.Fatalf("%+v", final)
	}
	after, _ := os.ReadFile(timingPath)
	if string(after) != string(before) {
		t.Fatal("отмена изменила timing.json")
	}
	if _, err := f.service.Cancel("unknown"); err == nil || err.Error() != textNoJob {
		t.Fatalf("неизвестное задание: %v", err)
	}
	// Удержание снято: удаление теперь разрешено.
	if _, err := f.service.DeleteVocal(f.project, f.id, os.RemoveAll); err != nil {
		t.Fatal(err)
	}
}

// TestSeparationCancelRemovesAttempt — отменённое выделение не оставляет каталога попытки.
func TestSeparationCancelRemovesAttempt(t *testing.T) {
	f := newFixture(t, "unchecked")
	info, err := f.service.SeparateVocals(f.project, "voc-ft")
	if err != nil {
		t.Fatal(err)
	}
	if info.Title != "Выделение вокала · Voc FT" || info.Steps[0].Tool != "separate_vocals" {
		t.Fatalf("%+v", info)
	}
	<-f.parts.checking
	if _, err := f.service.Cancel(info.ID); err != nil {
		t.Fatal(err)
	}
	final := wait(t, f.manager, info.ID)
	if final.Error == nil || *final.Error != textVocalCancelled {
		t.Fatalf("%+v", final)
	}
	entries, _ := os.ReadDir(filepath.Join(f.profile, "vocal-results", f.sourceSHA))
	if len(entries) != 1 || entries[0].Name() != f.id {
		t.Fatalf("остались попытки: %v", entries)
	}
	if _, err := f.service.SeparateVocals(f.project, "kim-vocal-1"); err == nil || err.Error() != textModelUnknown {
		t.Fatalf("новая Kim-модель: %v", err)
	}
}

// TestDownloadsMissingComponents — загрузка ставит только недостающие компоненты набора,
// повторный вызов во время загрузки возвращает то же задание.
func TestDownloadsMissingComponents(t *testing.T) {
	f := newFixture(t, "missing")
	setup := f.service.SongModelSetup()
	if setup.Installed || setup.TotalBytes != 10+20+40+1 || setup.Directory != filepath.Join(f.profile, "components") {
		t.Fatalf("%+v", setup)
	}
	if _, err := f.service.Start(f.project, GenerateOptions{}); err == nil || err.Error() != textTimingMissing {
		t.Fatalf("без моделей: %v", err)
	}
	f.parts.mu.Lock()
	f.parts.statuses["ffmpeg"] = "ready"
	f.parts.mu.Unlock()
	info, err := f.service.DownloadSongModels()
	if err != nil {
		t.Fatal(err)
	}
	if info.ModelDownload == nil || info.ModelDownload.Model != SongModelID || info.Kind != jobs.KindModelDownload {
		t.Fatalf("%+v", info)
	}
	final := wait(t, f.manager, info.ID)
	if final.Status != jobs.StatusDone || !strings.Contains(final.Log, "установлено") {
		t.Fatalf("%+v", final)
	}
	if len(f.parts.downloads) != 1 || strings.Join(f.parts.downloads[0], ",") != "ort-cpu,ctc-ru,ctc-vocab" {
		t.Fatalf("%v", f.parts.downloads)
	}
	if setup := f.service.SongModelSetup(); !setup.Installed || setup.TotalBytes != 71 {
		t.Fatalf("%+v", setup)
	}
	if _, err := f.service.DownloadVocalModel("kim-vocal-2"); err == nil {
		t.Fatal("загрузка только Voc FT")
	}
}
