package app

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// TestCameraWindow — окно вида из камеры идёт по общей механике отдельных окон со своими страницей,
// событиями и файлом положения: сообщения не смешиваются с плеером монтажа.
func TestCameraWindow(t *testing.T) {
	service := NewCameraWindowService(t.TempDir())
	service.caller = func(ctx context.Context) windowOwner {
		window, _ := ctx.Value(montageCallerKey{}).(windowOwner)
		return window
	}
	var created []application.WebviewWindowOptions
	var view *fakeMontageWindow
	service.create = func(options application.WebviewWindowOptions) detachedWindow {
		created = append(created, options)
		view = newFakeMontageWindow(200)
		return view
	}
	owner := newFakeMontageWindow(1)
	if err := service.Open(from(owner), "s1"); err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 || created[0].URL != "/#/camera-view" || created[0].Name != "camera-window-s1" || created[0].Title != "Вид из камеры — SongFrame" {
		t.Fatalf("параметры окна: %+v", created)
	}
	if err := service.Open(from(owner), "s2"); err == nil || err.Error() != cameraWindowKind.openFailed {
		t.Fatalf("второе окно: %v", err)
	}
	service.Send(from(owner), json.RawMessage(`{"type":"state"}`))
	expectEvents(t, view, `camera-window:message {"session":"s1","message":{"type":"state"}}`)
	if err := service.Close(from(owner), "s1"); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, owner, `camera-window:closed "s1"`)
}
