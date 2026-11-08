package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// События отдельного окна плеера монтажа — те же имена каналов, что у Electron-оригинала
// (src/main/montage-window.ts): адаптер frontend/src/platform подписывается на них через
// Events.On. Сообщение получает только противоположная сторона, закрытие — только владелец.
const (
	montageMessageEvent = "montage-window:message"
	montageClosedEvent  = "montage-window:closed"
	// montageBoundsFile хранит последнее обычное положение окна в каталоге состояния профиля.
	montageBoundsFile = "montage-window.json"
	// montageWindowTitle и montageOpenFailed повторяют montageTexts.main оригинала: заголовок
	// нативного окна задаёт Go, а текст ошибки renderer показывает как есть.
	montageWindowTitle = "Плеер монтажа — SongFrame"
	montageOpenFailed  = "Не удалось открыть отдельное окно плеера."
	// Размер по умолчанию и минимум окна оригинала (BrowserWindow 820×540, min 480×270).
	montageDefaultWidth  = 820
	montageDefaultHeight = 540
	montageMinWidth      = 480
	montageMinHeight     = 270
)

// montageOwner — то, что сервису нужно от окна-владельца: опознать его в вызове binding,
// доставить событие только ему и узнать о его закрытии. application.Window подходит как есть;
// тесты подставляют поддельное окно без GUI.
type montageOwner interface {
	ID() uint
	DispatchWailsEvent(event *application.CustomEvent)
	RegisterHook(eventType events.WindowEventType, callback func(event *application.WindowEvent)) func()
}

// montagePlayer — окно плеера: кроме возможностей владельца сервис закрывает его и читает
// положение для montage-window.json. Свёрнутое, развёрнутое и полноэкранное окно не даёт
// «обычного» положения (getNormalBounds оригинала), поэтому состояние проверяется отдельно.
type montagePlayer interface {
	montageOwner
	Close()
	Bounds() application.Rect
	IsMinimised() bool
	IsMaximised() bool
	IsFullscreen() bool
}

// montageWindowEvent — MontageWindowEvent общего контракта (shared/montage-window.ts).
// Сообщение пересылается сырым JSON: сервис его не разбирает и не меняет, как ipcMain оригинала.
type montageWindowEvent struct {
	Session string          `json:"session"`
	Message json.RawMessage `json:"message"`
}

// montageSession — одна открытая пара «владелец — плеер». done защищает от повторного
// завершения: закрытие приходит и из Close/закрытия владельца, и из хука WindowClosing плеера.
type montageSession struct {
	session      string
	owner        montageOwner
	player       montagePlayer
	cancelOwner  func()
	cancelPlayer func()
	done         bool
}

// MontageWindowService — второе окно плеера монтажа (window.api.montageWindow). Одновременно
// существует не больше одного окна, и принадлежит оно странице, которая его открыла: сообщения
// ходят только между владельцем и плеером, закрытие владельца закрывает плеер, а закрытие
// плеера сообщает владельцу. Окно-источник вызова Wails кладёт в контекст (application.WindowKey),
// поэтому, как и event.sender оригинала, отправителя не нужно передавать аргументом.
// Положение окна хранится в <каталог состояния>/montage-window.json и восстанавливается, только
// если окно останется видимым на одном из экранов (usableMontageBounds).
type MontageWindowService struct {
	mu       sync.Mutex
	localDir string
	current  *montageSession
	// caller опознаёт окно вызова binding; create и screens подключает ConfigureMontageWindow.
	caller  func(context.Context) montageOwner
	create  func(application.WebviewWindowOptions) montagePlayer
	screens func() []*application.Screen
}

// NewMontageWindowService создаёт сервис над каталогом состояния профиля; окна появятся только
// после ConfigureMontageWindow, когда создано приложение Wails.
func NewMontageWindowService(localDir string) *MontageWindowService {
	return &MontageWindowService{localDir: localDir, caller: callerWindow}
}

// ConfigureMontageWindow связывает сервис с GUI Wails: создание окна и рабочие области экранов.
// Функция не экспортируется в bindings (не метод сервиса).
func ConfigureMontageWindow(s *MontageWindowService, desktop *application.App) {
	s.create = func(options application.WebviewWindowOptions) montagePlayer {
		return placeMontageWindow(newMontageNativeWindow(desktop, options), options)
	}
	s.screens = desktop.Screen.GetAll
}

// callerWindow достаёт окно-источник вызова binding. Вызов не из окна (без WindowKey) владельца
// не имеет, и сервис его отвергает так же, как Electron — неизвестный webContents.
func callerWindow(ctx context.Context) montageOwner {
	if ctx == nil {
		return nil
	}
	if window, ok := ctx.Value(application.WindowKey).(application.Window); ok && window != nil {
		return window
	}
	return nil
}

// Open создаёт окно плеера для session вызывающего окна. Второе открытие при уже открытом окне,
// пустая сессия или вызов не из окна — ошибка windowOpenFailed оригинала. В отличие от Electron
// Open не ждёт загрузки страницы: Wails создаёт окно асинхронно, а готовность плеер сам сообщает
// владельцу сообщением { type: 'ready' }.
func (s *MontageWindowService) Open(ctx context.Context, session string) error {
	owner := s.caller(ctx)
	if owner == nil || session == "" {
		return errors.New(montageOpenFailed)
	}
	if s.create == nil {
		return fmt.Errorf("нативное приложение ещё не запущено")
	}
	s.mu.Lock()
	if s.current != nil {
		s.mu.Unlock()
		return errors.New(montageOpenFailed)
	}
	entry := &montageSession{session: session, owner: owner}
	s.current = entry
	s.mu.Unlock()

	// Хук владельца ставится до создания окна: закрытие владельца в этот момент не оставит плеер.
	// Хук выполняется синхронно до уничтожения владельца, поэтому плеер закрывается раньше него.
	cancelOwner := owner.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) { s.ownerClosing(entry) })
	player := s.create(s.windowOptions(session))
	// Хук, а не OnWindowEvent: обработчики Wails идут в отдельных горутинах после хуков, и к их
	// запуску окно уже помечено уничтоженным — положение было бы не прочитать.
	cancelPlayer := player.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) { s.finish(entry, true) })
	s.mu.Lock()
	entry.player, entry.cancelOwner, entry.cancelPlayer = player, cancelOwner, cancelPlayer
	closedEarly := entry.done
	s.mu.Unlock()
	if closedEarly {
		// Владелец закрылся, пока окно создавалось: finish уже прошёл без этих хуков и окна,
		// поэтому снимаем хуки здесь и закрываем только что созданный плеер.
		cancelOwner()
		cancelPlayer()
		player.Close()
	}
	return nil
}

// Close закрывает окно только по запросу его владельца и только своей сессии; иначе ничего не
// делает, как ipcMain оригинала. Завершение выполняется сразу: владелец получает closed, а
// положение сохраняется до того, как Wails асинхронно уничтожит окно.
func (s *MontageWindowService) Close(ctx context.Context, session string) error {
	caller := s.caller(ctx)
	s.mu.Lock()
	entry := s.current
	var player montagePlayer
	if entry != nil {
		player = entry.player
	}
	s.mu.Unlock()
	if entry == nil || caller == nil || entry.session != session || caller.ID() != entry.owner.ID() {
		return nil
	}
	s.finish(entry, true)
	if player != nil {
		player.Close()
	}
	return nil
}

// Send пересылает сообщение противоположной стороне открытой пары вместе с её сессией.
// Сообщения посторонних окон и сообщения без открытого окна отбрасываются молча (send
// контракта ничего не возвращает). Порядок сообщений одного окна сохраняет адаптер frontend,
// отправляя их последовательно; доставку в окно Wails выполняет через его очередь событий.
func (s *MontageWindowService) Send(ctx context.Context, message json.RawMessage) {
	caller := s.caller(ctx)
	if caller == nil {
		return
	}
	s.mu.Lock()
	entry := s.current
	var destination montageOwner
	if entry != nil && entry.player != nil {
		switch caller.ID() {
		case entry.owner.ID():
			destination = entry.player
		case entry.player.ID():
			destination = entry.owner
		}
	}
	s.mu.Unlock()
	if destination == nil {
		return
	}
	destination.DispatchWailsEvent(&application.CustomEvent{Name: montageMessageEvent, Data: montageWindowEvent{Session: entry.session, Message: message}})
}

// ownerClosing закрывает плеер вместе с владельцем. Владелец уже уходит, поэтому событие
// closed ему не отправляется (оригинал проверял owner.isDestroyed()).
func (s *MontageWindowService) ownerClosing(entry *montageSession) {
	s.finish(entry, false)
	s.mu.Lock()
	player := entry.player
	s.mu.Unlock()
	if player != nil {
		player.Close()
	}
}

// finish один раз завершает сессию: освобождает место для нового окна, снимает хуки, сохраняет
// положение плеера и при notify сообщает владельцу. Повторные вызовы (хук WindowClosing после
// Close) ничего не делают; поздний хук прежнего окна не трогает новую сессию.
func (s *MontageWindowService) finish(entry *montageSession, notify bool) {
	s.mu.Lock()
	if entry.done {
		s.mu.Unlock()
		return
	}
	entry.done = true
	if s.current == entry {
		s.current = nil
	}
	player, cancelOwner, cancelPlayer := entry.player, entry.cancelOwner, entry.cancelPlayer
	s.mu.Unlock()
	if cancelOwner != nil {
		cancelOwner()
	}
	if cancelPlayer != nil {
		cancelPlayer()
	}
	if player != nil {
		s.saveBounds(player)
	}
	if notify {
		entry.owner.DispatchWailsEvent(&application.CustomEvent{Name: montageClosedEvent, Data: entry.session})
	}
}

// windowOptions собирает параметры окна: размер по умолчанию либо сохранённое положение,
// пригодное для текущих экранов. Абсолютные координаты передаются через экран и смещение от
// его рабочей области: так Wails ставит окно одинаково в Linux и Windows (без Screen Linux
// трактует X/Y относительно текущего экрана); в сборке GTK4 окно до показа ставит
// newMontageNativeWindow. В Wayland положение окну не задаётся вовсе.
func (s *MontageWindowService) windowOptions(session string) application.WebviewWindowOptions {
	options := application.WebviewWindowOptions{
		Name: "montage-player-" + session, Title: montageWindowTitle, URL: "/#/montage-player",
		Width: montageDefaultWidth, Height: montageDefaultHeight, MinWidth: montageMinWidth, MinHeight: montageMinHeight,
		BackgroundColour: application.NewRGB(244, 246, 248),
	}
	data, err := os.ReadFile(filepath.Join(s.localDir, montageBoundsFile))
	if err != nil || s.screens == nil {
		// При первом запуске или недоступном файле окно создаётся в обычном месте.
		return options
	}
	screens := s.screens()
	areas := make([]application.Rect, 0, len(screens))
	for _, screen := range screens {
		areas = append(areas, screen.WorkArea)
	}
	bounds, index, ok := usableMontageBounds(data, areas)
	if !ok {
		return options
	}
	// Electron приводил дробные значения к целым отбрасыванием дробной части; сохранённые им
	// и этим сервисом значения всегда целые.
	x, y := int(bounds.X), int(bounds.Y)
	options.Width, options.Height = int(bounds.Width), int(bounds.Height)
	options.InitialPosition = application.WindowXY
	options.Screen = screens[index]
	options.X, options.Y = x-areas[index].X, y-areas[index].Y
	return options
}

// saveBounds пишет обычное положение окна в формате оригинала
// (JSON.stringify(getNormalBounds()) — {"x","y","width","height"} без перевода строки).
// Свёрнутое, развёрнутое или полноэкранное окно файл не меняет: остаётся прежнее обычное
// положение, как у getNormalBounds. Ошибка записи не мешает закрытию плеера.
func (s *MontageWindowService) saveBounds(player montagePlayer) {
	if player.IsMinimised() || player.IsMaximised() || player.IsFullscreen() {
		return
	}
	rect := player.Bounds()
	if rect.Width <= 0 || rect.Height <= 0 {
		return
	}
	data, err := json.Marshal(struct {
		X      int `json:"x"`
		Y      int `json:"y"`
		Width  int `json:"width"`
		Height int `json:"height"`
	}{rect.X, rect.Y, rect.Width, rect.Height})
	if err != nil {
		return
	}
	if err := os.MkdirAll(s.localDir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(s.localDir, montageBoundsFile), data, 0o644)
}

// montageBounds — сохранённое положение в единицах окна (DIP). Числа дробные, как в JS:
// проверка оригинала выполняется над значениями файла до приведения к целым.
type montageBounds struct {
	X, Y, Width, Height float64
}

// usableMontageBounds переносит одноимённую функцию src/main/montage-window-bounds.ts вместе с
// JSON.parse из registerMontageWindow: data — содержимое montage-window.json, areas — рабочие
// области экранов. Положение годится, если это объект с четырьмя конечными числами, окно не
// меньше 480×270 и хотя бы на одном экране видно не меньше 100×100 точек, причём верх окна
// не выше рабочей области и не ниже её низа минус 30 точек. Возвращает и индекс первого такого
// экрана — по нему окно ставится в абсолютные координаты. Любой сбой разбора — «нет положения».
func usableMontageBounds(data []byte, areas []application.Rect) (montageBounds, int, bool) {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		// Включая числа вне double: JSON.parse даёт Infinity, и оригинал отвергает их как не конечные.
		return montageBounds{}, 0, false
	}
	object, ok := raw.(map[string]any)
	if !ok || len(areas) == 0 {
		return montageBounds{}, 0, false
	}
	var values [4]float64
	for i, key := range []string{"x", "y", "width", "height"} {
		number, ok := object[key].(float64)
		if !ok || math.IsInf(number, 0) || math.IsNaN(number) {
			return montageBounds{}, 0, false
		}
		values[i] = number
	}
	bounds := montageBounds{X: values[0], Y: values[1], Width: values[2], Height: values[3]}
	if bounds.Width < montageMinWidth || bounds.Height < montageMinHeight {
		return montageBounds{}, 0, false
	}
	for index, area := range areas {
		ax, ay, aw, ah := float64(area.X), float64(area.Y), float64(area.Width), float64(area.Height)
		width := math.Min(bounds.X+bounds.Width, ax+aw) - math.Max(bounds.X, ax)
		height := math.Min(bounds.Y+bounds.Height, ay+ah) - math.Max(bounds.Y, ay)
		if width >= 100 && height >= 100 && bounds.Y >= ay && bounds.Y < ay+ah-30 {
			return bounds, index, true
		}
	}
	return montageBounds{}, 0, false
}
