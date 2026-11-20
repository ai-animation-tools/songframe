package app

import (
	"context"
	"encoding/json"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// cameraWindowKind — отдельное окно вида из камеры точки съёмки: страница /#/camera-view, положение в
// camera-window.json каталога состояния.
var cameraWindowKind = windowKind{
	name:          "camera",
	url:           "/#/camera-view",
	title:         "Вид из камеры — SongFrame",
	openFailed:    "Не удалось открыть отдельное окно вида из камеры.",
	boundsFile:    "camera-window.json",
	defaultWidth:  960,
	defaultHeight: 600,
	minWidth:      480,
	minHeight:     300,
}

// CameraWindowService — отдельное окно вида из камеры (window.api.cameraWindow): карта точки съёмки
// в основном окне присылает ему схему, точку и рост героев, окно показывает кадры и отвечает только зумом
// объектива — точки правятся в карте. Механика окна — detachedWindows.
type CameraWindowService struct {
	*detachedWindows
}

// NewCameraWindowService создаёт сервис над каталогом состояния профиля; окна появятся только
// после ConfigureCameraWindow, когда создано приложение Wails.
func NewCameraWindowService(localDir string) *CameraWindowService {
	return &CameraWindowService{newDetachedWindows(cameraWindowKind, localDir)}
}

// ConfigureCameraWindow связывает сервис с GUI Wails. Функция не экспортируется в bindings (не метод сервиса).
func ConfigureCameraWindow(s *CameraWindowService, desktop *application.App) {
	s.configure(desktop)
}

// Open создаёт окно вида из камеры для session вызывающего окна (detachedWindows.open).
func (s *CameraWindowService) Open(ctx context.Context, session string) error {
	return s.open(ctx, session)
}

// Close закрывает окно по запросу его владельца (detachedWindows.close).
func (s *CameraWindowService) Close(ctx context.Context, session string) error {
	return s.close(ctx, session)
}

// Send пересылает сообщение противоположной стороне пары (detachedWindows.send).
func (s *CameraWindowService) Send(ctx context.Context, message json.RawMessage) {
	s.send(ctx, message)
}
