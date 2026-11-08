package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/diagnostics"
)

// TestNativePreviewLifecycle проверяет реальные переходы сервиса без зависимости от оконного менеджера.
func TestNativePreviewLifecycle(t *testing.T) {
	service, err := NewNativeService(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.ServiceShutdown()
	service.validMediaURL = func(value string) bool { return value == "http://127.0.0.1:1234/media/1/трек.mp3" }
	var events []string
	service.emit = func(name string, _ any) { events = append(events, name) }
	opened, closed, focused := 0, 0, 0
	var onClose func()
	service.openWindow = func(input PreviewInput, callback func()) (func(), func(), error) {
		opened++
		onClose = callback
		// Модель доступна ещё до возврата фабрики окна, когда renderer уже может вызвать binding.
		if got, err := service.Preview(input.Session); err != nil || *got != input {
			t.Fatalf("модель раннего renderer: %+v %v", got, err)
		}
		return func() { closed++; callback() }, func() { focused++ }, nil
	}
	input := PreviewInput{Session: "песня 1", MediaURL: "http://127.0.0.1:1234/media/1/трек.mp3", Title: "Просмотр"}
	if err := service.OpenPreview(input); err != nil {
		t.Fatal(err)
	}
	if err := service.OpenPreview(input); err != nil {
		t.Fatal(err)
	}
	if opened != 1 || focused != 1 {
		t.Fatalf("повтор создал окно: opened=%d focused=%d", opened, focused)
	}
	if err := service.PreviewReady(input.Session); err != nil {
		t.Fatal(err)
	}
	if err := service.PreviewReady(input.Session); err != nil {
		t.Fatal(err)
	}
	if err := service.ClosePreview(input.Session); err != nil {
		t.Fatal(err)
	}
	if err := service.ClosePreview(input.Session); err != nil {
		t.Fatal(err)
	}
	if closed != 1 || strings.Join(events, ",") != "preview:ready,preview:closed" {
		t.Fatalf("неверная очистка: closed=%d events=%v", closed, events)
	}
	if _, err := service.Preview(input.Session); err == nil {
		t.Fatal("закрытая модель осталась")
	}
	if err := service.PreviewReady(input.Session); err == nil {
		t.Fatal("закрытая модель сообщила готовность")
	}
	if err := service.OpenPreview(input); err != nil {
		t.Fatal(err)
	}
	previousOnClose := onClose
	if err := service.ClosePreview(input.Session); err != nil {
		t.Fatal(err)
	}
	if err := service.OpenPreview(input); err != nil {
		t.Fatal(err)
	}
	previousOnClose()
	if _, err := service.Preview(input.Session); err != nil {
		t.Fatal("позднее закрытие прежнего окна удалило новое")
	}
}

// TestNativePreviewRejectsUnregisteredURL не позволяет обойти регистрацию медиа через preview.
func TestNativePreviewRejectsUnregisteredURL(t *testing.T) {
	service, err := NewNativeService(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.ServiceShutdown()
	service.validMediaURL = func(string) bool { return false }
	if err := service.OpenPreview(PreviewInput{Session: "1", MediaURL: "https://example.com/video"}); err == nil {
		t.Fatal("неподтверждённый URL принят")
	}
}

// TestNativePreviewCloseDuringCreate проверяет закрытие владельца, пока система ещё создаёт окно.
func TestNativePreviewCloseDuringCreate(t *testing.T) {
	service, err := NewNativeService(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.ServiceShutdown()
	service.validMediaURL = func(string) bool { return true }
	closed := 0
	service.openWindow = func(input PreviewInput, callback func()) (func(), func(), error) {
		service.ClosePreview(input.Session)
		return func() { closed++; callback() }, func() {}, nil
	}
	if err := service.OpenPreview(PreviewInput{Session: "1", MediaURL: "local"}); err != nil {
		t.Fatal(err)
	}
	if closed != 1 {
		t.Fatalf("незавершённое окно не закрыто: %d", closed)
	}
	if _, err := service.Preview("1"); err == nil {
		t.Fatal("удалённая сессия восстановлена")
	}
}

// TestDialogOptions сохраняет фильтры, множественный выбор и отдельный режим папок.
func TestDialogOptions(t *testing.T) {
	input := &PickOptions{Title: "Песня", Multiple: true, Filters: []PickFilter{{Name: "Звук", Extensions: []string{"mp3", ".wav"}}}}
	files, err := dialogOptions(input, false)
	if err != nil {
		t.Fatal(err)
	}
	if !files.CanChooseFiles || files.CanChooseDirectories || !files.AllowsMultipleSelection || files.Filters[0].Pattern != "*.mp3;*.wav" {
		t.Fatalf("опции файлов: %+v", files)
	}
	folder, err := dialogOptions(input, true)
	if err != nil {
		t.Fatal(err)
	}
	if folder.CanChooseFiles || !folder.CanChooseDirectories || folder.AllowsMultipleSelection {
		t.Fatalf("опции папки: %+v", folder)
	}
	if _, err := dialogOptions(&PickOptions{Filters: []PickFilter{{Extensions: []string{"mp3;*"}}}}, false); err == nil {
		t.Fatal("инъекция фильтра принята")
	}
}

// TestNotificationTarget проверяет передачу проекта и маршрута без произвольной навигации.
func TestNotificationTarget(t *testing.T) {
	service, err := NewNativeService(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer service.ServiceShutdown()
	var received NotificationTarget
	service.emit = func(name string, data any) {
		if name != "notifications:open" {
			t.Fatal(name)
		}
		received = data.(NotificationTarget)
	}
	input := NotificationTarget{Project: t.TempDir(), Route: "/project/timing"}
	if err := service.RouteNotification(input); err != nil {
		t.Fatal(err)
	}
	if received != input {
		t.Fatalf("потерян адрес: %+v", received)
	}
	input.Route = "javascript:alert(1)"
	if err := service.RouteNotification(input); err == nil {
		t.Fatal("произвольный маршрут принят")
	}
}

// TestNativeDiagnosticsRecoversAfterUnavailableProfile сохраняет запуск GUI при ошибке диска.
// Повторная операция после исправления пути начинает диагностику без перезапуска приложения.
func TestNativeDiagnosticsRecoversAfterUnavailableProfile(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "профиль")
	if err := os.WriteFile(profile, []byte("не каталог"), 0600); err != nil {
		t.Fatal(err)
	}
	service, err := NewNativeService(profile)
	if err != nil || service == nil {
		t.Fatalf("ошибка диагностики остановила приложение: %v", err)
	}
	defer service.ServiceShutdown()
	if _, err := service.CrashNotice(); err == nil {
		t.Fatal("ошибка профиля скрыта от интерфейса")
	}
	if err := os.Remove(profile); err != nil {
		t.Fatal(err)
	}
	if notice, err := service.CrashNotice(); err != nil || notice != nil {
		t.Fatalf("профиль не восстановился: %+v %v", notice, err)
	}
	if err := service.ReportRendererError(diagnostics.RendererErrorReport{Kind: "error", Message: "после восстановления"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(profile, "logs", "app.log")); err != nil {
		t.Fatal(err)
	}
}
