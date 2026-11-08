package app

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"songframe-go/internal/components"
)

// autoComponentsService создаёт настоящий Manager с управляемой границей проверки.
// Это проверяет планирование без системного FFmpeg, моделей и времени native-вызовов.
func autoComponentsService(t *testing.T, probe componentProbe) *ComponentsService {
	t.Helper()
	manager, err := components.NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := newComponentsService(manager, probe)
	t.Cleanup(func() { _ = service.ServiceShutdown(); waitComponentWorker(t, service) })
	return service
}

// waitComponentWorker ограничивает ожидание, чтобы ошибка отмены не подвешивала весь набор.
func waitComponentWorker(t *testing.T, service *ComponentsService) {
	t.Helper()
	service.mu.Lock()
	done := service.done
	service.mu.Unlock()
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("фоновая проверка не завершилась")
	}
}

// TestComponentsAutomaticStateOnly стартует весь набор один раз, не требуя открытия страницы.
// Многократный poll State не запускает повторную работу и не использует Force.
func TestComponentsAutomaticStateOnly(t *testing.T) {
	started := make(chan []string, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	service := autoComponentsService(t, func(ctx context.Context, operations []string, force bool) (components.Snapshot, error) {
		calls.Add(1)
		if force {
			t.Error("обычная автопроверка принудительно хеширует файлы")
		}
		started <- operations
		select {
		case <-release:
		case <-ctx.Done():
		}
		return components.Snapshot{}, nil
	})
	if state := service.requestCheck(); !state.Checking {
		t.Fatal("запланированная проверка не видна UI")
	}
	operations := <-started
	hasML, hasMedia := false, false
	for _, op := range operations {
		hasML = hasML || op == "known-text-ctc"
		hasMedia = hasMedia || op == "audio-pcm"
	}
	if !hasML || !hasMedia {
		t.Fatal("при запуске проверяется не весь нужный состав", operations)
	}
	for range 20 {
		_ = service.State()
	}
	close(release)
	waitComponentWorker(t, service)
	for range 20 {
		if service.State().Checking {
			t.Fatal("проверка осталась активной")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("poll запустил повторную проверку: %d", calls.Load())
	}
}

// TestComponentsAutomaticMutationCoalesces воспроизводит изменение после освобождения
// Manager.work, пока worker ещё завершается. Несколько изменений дают один следующий проход.
func TestComponentsAutomaticMutationCoalesces(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	service := autoComponentsService(t, func(ctx context.Context, _ []string, _ bool) (components.Snapshot, error) {
		if calls.Add(1) == 1 {
			started <- struct{}{}
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		return components.Snapshot{}, nil
	})
	service.requestCheck()
	<-started
	for _, name := range []string{"Первый каталог", "Другой каталог"} {
		selection := service.State().Selection
		selection.ManagedDirectory = t.TempDir() + "/" + name
		if _, err := service.Configure(selection); err != nil {
			t.Fatal(err)
		}
	}
	close(release)
	waitComponentWorker(t, service)
	if calls.Load() != 2 {
		t.Fatalf("изменение потеряно или продублировано: %d", calls.Load())
	}
}

// TestComponentsCancelDiscardsPending подтверждает, что после остановки отложенная волна
// не запускается сама. Повторные открытия страницы читают тот же терминальный статус.
func TestComponentsCancelDiscardsPending(t *testing.T) {
	started := make(chan struct{}, 1)
	var calls atomic.Int32
	service := autoComponentsService(t, func(ctx context.Context, _ []string, _ bool) (components.Snapshot, error) {
		calls.Add(1)
		started <- struct{}{}
		<-ctx.Done()
		return components.Snapshot{}, ctx.Err()
	})
	service.requestCheck()
	<-started
	selection := service.State().Selection
	selection.ManagedDirectory = t.TempDir()
	if _, err := service.Configure(selection); err != nil {
		t.Fatal(err)
	}
	service.Cancel()
	waitComponentWorker(t, service)
	for range 20 {
		_ = service.State()
	}
	if calls.Load() != 1 {
		t.Fatalf("отмена запустила отложенную проверку: %d", calls.Load())
	}
}

// TestComponentsShutdownRejectsNewWork отменяет проверку независимо от renderer и не
// допускает новую волну от позднего изменения после начала завершения приложения.
func TestComponentsShutdownRejectsNewWork(t *testing.T) {
	started := make(chan struct{}, 1)
	var calls atomic.Int32
	service := autoComponentsService(t, func(ctx context.Context, _ []string, _ bool) (components.Snapshot, error) {
		calls.Add(1)
		started <- struct{}{}
		<-ctx.Done()
		return components.Snapshot{}, ctx.Err()
	})
	service.requestCheck()
	<-started
	if err := service.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	waitComponentWorker(t, service)
	service.requestCheck()
	if calls.Load() != 1 || service.State().Checking {
		t.Fatal("работа возобновлена после shutdown")
	}
}

// TestComponentsMutationAfterCancel сохраняет новое явное подключение, сделанное пока
// отменённый worker ещё выходит. Новый проход получает новый, не отменённый контекст.
func TestComponentsMutationAfterCancel(t *testing.T) {
	started := make(chan struct{}, 1)
	finish := make(chan struct{})
	var calls atomic.Int32
	service := autoComponentsService(t, func(ctx context.Context, _ []string, _ bool) (components.Snapshot, error) {
		if calls.Add(1) == 1 {
			started <- struct{}{}
			<-ctx.Done()
			<-finish
		} else if ctx.Err() != nil {
			t.Error("новое подключение унаследовало отменённый контекст")
		}
		return components.Snapshot{}, nil
	})
	service.requestCheck()
	<-started
	service.Cancel()
	selection := service.State().Selection
	selection.ManagedDirectory = t.TempDir()
	if _, err := service.Configure(selection); err != nil {
		t.Fatal(err)
	}
	close(finish)
	waitComponentWorker(t, service)
	if calls.Load() != 2 {
		t.Fatalf("новое подключение потеряно после отмены: %d", calls.Load())
	}
}

// TestComponentsAutomaticNative проверяет требование пользовательского сценария на реальных
// инструментах: NewComponentsService сам доводит найденный набор до ready без команд renderer.
// Входы читаются только из явно переданных разработчиком каталогов, профиль — временный.
func TestComponentsAutomaticNative(t *testing.T) {
	media, library, models := os.Getenv("SONGFRAME_TEST_MEDIA_BIN"), os.Getenv("SONGFRAME_ORT_LIBRARY"), os.Getenv("SONGFRAME_ORT_MODEL_DIR")
	if media == "" || library == "" || models == "" {
		t.Skip("не заданы каталоги реальных компонентов")
	}
	manager, err := components.NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ffmpegName := "ffmpeg"
	if runtime.GOOS == "windows" {
		ffmpegName += ".exe"
	}
	// Сохранённые подключения создаются тем же распознаванием файлов, что и единая кнопка UI.
	for _, selected := range []struct{ id, path string }{
		{"ffmpeg", filepath.Join(media, ffmpegName)}, {"ort-cpu", library},
		{"voc-ft", filepath.Join(models, "vocals.onnx")}, {"ctc-ru", filepath.Join(models, "alignment.onnx")},
		{"ctc-vocab", filepath.Join(models, "vocab.json")},
	} {
		if _, err = manager.Connect(context.Background(), selected.id, selected.path); err != nil {
			t.Fatal(selected.id, err)
		}
	}
	service := NewComponentsService(manager)
	defer service.ServiceShutdown()
	service.mu.Lock()
	done := service.done
	service.mu.Unlock()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("автоматическая проверка реальных компонентов не завершилась")
	}
	state := service.State()
	if state.Checking {
		t.Fatal("автоматическая проверка осталась активной")
	}
	for _, component := range state.Components {
		if component.Status != "ready" {
			t.Fatalf("%s не готов после автоматического запуска: %s", component.ID, component.Reason)
		}
	}
	t.Logf("При старте автоматически готовы %d компонентов без вызова Check из renderer", len(state.Components))
}

// TestComponentsConnectSchedulesReadiness проверяет единый пользовательский выбор:
// сырой файл подключается без копии, а проверку запускает сервис, не renderer.
func TestComponentsConnectSchedulesReadiness(t *testing.T) {
	var calls atomic.Int32
	service := autoComponentsService(t, func(context.Context, []string, bool) (components.Snapshot, error) {
		calls.Add(1)
		return components.Snapshot{}, nil
	})
	file := filepath.Join(t.TempDir(), "Выбранная модель.onnx")
	if err := os.WriteFile(file, []byte("synthetic model for selection"), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := service.Connect(context.Background(), "voc-ft", file)
	if err != nil {
		t.Fatal(err)
	}
	if state.Selection.VocalsFile != file {
		t.Fatal("потерян выбранный файл", state.Selection)
	}
	waitComponentWorker(t, service)
	if calls.Load() != 1 {
		t.Fatal("готовность не запланирована автоматически", calls.Load())
	}
	if info, err := os.Stat(file); err != nil || info.Size() == 0 {
		t.Fatal("исходный файл изменён", err)
	}
}
