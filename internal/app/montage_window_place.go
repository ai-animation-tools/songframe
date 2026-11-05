package app

import (
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// placedMontageWindow — настоящее окно плеера с поправкой положения. Wails 3 в GTK4/X11 ставит
// окно (XMoveWindow) и читает его положение (XTranslateCoordinates) в разных системах отсчёта:
// прочитанный верх отличается от заданного на высоту заголовка, и сохранённое окно при каждом
// открытии сползало бы вниз. Поправка — разница прочитанного и заданного положения сразу после
// открытия; Bounds вычитает её, поэтому montage-window.json хранит те же координаты, которыми
// окно было поставлено. В Windows поправка нулевая, в Wayland положение не задаётся и не
// читается (0, 0) — файл сохраняет прежние координаты, а размер обновляется.
type placedMontageWindow struct {
	*application.WebviewWindow
	mu     sync.Mutex
	dx, dy int
}

// placeMontageWindow измеряет поправку один раз, когда страница окна загрузилась (к этому
// времени оконный менеджер уже поставил окно); повторная загрузка страницы (политика
// автозапуска в Linux) поправку не меняет. Без сохранённого положения поправка нулевая.
// Проверено нативной проверкой на X11: три открытия подряд дают одинаковый montage-window.json.
func placeMontageWindow(window *application.WebviewWindow, options application.WebviewWindowOptions) *placedMontageWindow {
	placed := &placedMontageWindow{WebviewWindow: window}
	var once sync.Once
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		once.Do(func() {
			if options.InitialPosition != application.WindowXY || options.Screen == nil {
				return
			}
			bounds := window.Bounds()
			placed.mu.Lock()
			placed.dx = bounds.X - (options.Screen.WorkArea.X + options.X)
			placed.dy = bounds.Y - (options.Screen.WorkArea.Y + options.Y)
			placed.mu.Unlock()
		})
	})
	return placed
}

// Bounds возвращает положение окна в координатах, которыми его ставит windowOptions.
func (w *placedMontageWindow) Bounds() application.Rect {
	rect := w.WebviewWindow.Bounds()
	w.mu.Lock()
	defer w.mu.Unlock()
	rect.X -= w.dx
	rect.Y -= w.dy
	return rect
}
