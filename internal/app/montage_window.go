package app

import (
	"context"
	"encoding/json"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// montageWindowKind — отдельное окно плеера монтажа: страница /#/montage-player, положение в
// montage-window.json каталога состояния.
var montageWindowKind = windowKind{
	name:          "montage",
	url:           "/#/montage-player",
	title:         "Плеер монтажа — SongFrame",
	openFailed:    "Не удалось открыть отдельное окно плеера.",
	boundsFile:    "montage-window.json",
	defaultWidth:  820,
	defaultHeight: 540,
	minWidth:      480,
	minHeight:     270,
}

// MontageWindowService — второе окно плеера монтажа (window.api.montageWindow): несохранённый монтаж
// основного окна воспроизводится в нём, часы воспроизведения — только там. Механика окна — detachedWindows.
type MontageWindowService struct {
	*detachedWindows
}

// NewMontageWindowService создаёт сервис над каталогом состояния профиля; окна появятся только
// после ConfigureMontageWindow, когда создано приложение Wails.
func NewMontageWindowService(localDir string) *MontageWindowService {
	return &MontageWindowService{newDetachedWindows(montageWindowKind, localDir)}
}

// ConfigureMontageWindow связывает сервис с GUI Wails. Функция не экспортируется в bindings (не метод сервиса).
func ConfigureMontageWindow(s *MontageWindowService, desktop *application.App) {
	s.configure(desktop)
}

// Open создаёт окно плеера для session вызывающего окна (detachedWindows.open).
func (s *MontageWindowService) Open(ctx context.Context, session string) error {
	return s.open(ctx, session)
}

// Close закрывает окно плеера по запросу его владельца (detachedWindows.close).
func (s *MontageWindowService) Close(ctx context.Context, session string) error {
	return s.close(ctx, session)
}

// Send пересылает сообщение противоположной стороне пары (detachedWindows.send).
func (s *MontageWindowService) Send(ctx context.Context, message json.RawMessage) {
	s.send(ctx, message)
}
