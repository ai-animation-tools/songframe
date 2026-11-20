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

// windowKind — вид отдельного окна: всё, чем окно плеера монтажа отличается от окна вида из камеры.
// События адаптер frontend/src/platform слушает через Events.On: сообщение получает только
// противоположная сторона пары, закрытие — только владелец.
type windowKind struct {
	// name — префикс имени окна Wails и событий: «<name>-window:message» и «<name>-window:closed».
	name string
	// url — маршрут страницы окна внутри приложения.
	url string
	// title — заголовок нативного окна; openFailed — текст ошибки открытия, renderer показывает его как есть.
	title      string
	openFailed string
	// boundsFile хранит последнее обычное положение окна в каталоге состояния профиля.
	boundsFile string
	// Размер окна по умолчанию и его минимум.
	defaultWidth, defaultHeight int
	minWidth, minHeight         int
}

// messageEvent и closedEvent — имена событий окна этого вида.
func (k windowKind) messageEvent() string { return k.name + "-window:message" }
func (k windowKind) closedEvent() string  { return k.name + "-window:closed" }

// windowOwner — то, что сервису нужно от окна-владельца: опознать его в вызове binding,
// доставить событие только ему и узнать о его закрытии. application.Window подходит как есть;
// тесты подставляют поддельное окно без GUI.
type windowOwner interface {
	ID() uint
	DispatchWailsEvent(event *application.CustomEvent)
	RegisterHook(eventType events.WindowEventType, callback func(event *application.WindowEvent)) func()
}

// detachedWindow — отдельное окно: кроме возможностей владельца сервис закрывает его и читает
// сохраняемое положение (kind.boundsFile). Свёрнутое, развёрнутое и полноэкранное окно не даёт
// «обычного» положения, поэтому состояние проверяется отдельно.
type detachedWindow interface {
	windowOwner
	Close()
	Bounds() application.Rect
	IsMinimised() bool
	IsMaximised() bool
	IsFullscreen() bool
}

// detachedWindowEvent — DetachedWindowEvent общего контракта (frontend/src/shared/detached-window.ts).
// Сообщение пересылается сырым JSON: сервис его не разбирает и не меняет.
type detachedWindowEvent struct {
	Session string          `json:"session"`
	Message json.RawMessage `json:"message"`
}

// windowSession — одна открытая пара «владелец — отдельное окно». done защищает от повторного
// завершения: закрытие приходит и из Close/закрытия владельца, и из хука WindowClosing отдельного окна.
type windowSession struct {
	session      string
	owner        windowOwner
	detached     detachedWindow
	cancelOwner  func()
	cancelPlayer func()
	done         bool
}

// detachedWindows — отдельное окно одного вида (плеер монтажа, вид из камеры) для Wails-сервиса этого
// вида. Одновременно существует не больше одного окна вида, и принадлежит оно странице, которая его
// открыла: сообщения ходят только между владельцем и окном, закрытие владельца закрывает окно, а
// закрытие окна сообщает владельцу. Окно-источник вызова Wails кладёт в контекст
// (application.WindowKey), поэтому отправителя не нужно передавать аргументом.
// Положение окна хранится в <каталог состояния>/<kind.boundsFile> и восстанавливается, только
// если окно останется видимым на одном из экранов (windowKind.usableBounds).
type detachedWindows struct {
	kind     windowKind
	mu       sync.Mutex
	localDir string
	current  *windowSession
	// caller опознаёт окно вызова binding; create и screens подключает configure.
	caller  func(context.Context) windowOwner
	create  func(application.WebviewWindowOptions) detachedWindow
	screens func() []*application.Screen
}

// newDetachedWindows создаёт окна вида kind над каталогом состояния профиля; окна появятся только
// после configure, когда создано приложение Wails.
func newDetachedWindows(kind windowKind, localDir string) *detachedWindows {
	return &detachedWindows{kind: kind, localDir: localDir, caller: callerWindow}
}

// configure связывает окна с GUI Wails: создание окна и рабочие области экранов.
func (s *detachedWindows) configure(desktop *application.App) {
	s.create = func(options application.WebviewWindowOptions) detachedWindow {
		return placeDetachedWindow(newDetachedNativeWindow(desktop, options), options)
	}
	s.screens = desktop.Screen.GetAll
}

// callerWindow достаёт окно-источник вызова binding. Вызов не из окна (без WindowKey) владельца
// не имеет, и сервис его отвергает.
func callerWindow(ctx context.Context) windowOwner {
	if ctx == nil {
		return nil
	}
	if window, ok := ctx.Value(application.WindowKey).(application.Window); ok && window != nil {
		return window
	}
	return nil
}

// Open создаёт отдельное окно для session вызывающего окна. Второе открытие при уже открытом окне,
// пустая сессия или вызов не из окна — ошибка kind.openFailed. Open не ждёт загрузки страницы:
// Wails создаёт окно асинхронно, а готовность окно само сообщает владельцу сообщением
// { type: 'ready' }.
func (s *detachedWindows) open(ctx context.Context, session string) error {
	owner := s.caller(ctx)
	if owner == nil || session == "" {
		return errors.New(s.kind.openFailed)
	}
	if s.create == nil {
		return fmt.Errorf("нативное приложение ещё не запущено")
	}
	s.mu.Lock()
	if s.current != nil {
		s.mu.Unlock()
		return errors.New(s.kind.openFailed)
	}
	entry := &windowSession{session: session, owner: owner}
	s.current = entry
	s.mu.Unlock()

	// Хук владельца ставится до создания окна: закрытие владельца в этот момент не оставит отдельное окно.
	// Хук выполняется синхронно до уничтожения владельца, поэтому отдельное окно закрывается раньше него.
	cancelOwner := owner.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) { s.ownerClosing(entry) })
	detached := s.create(s.windowOptions(session))
	// Хук, а не OnWindowEvent: обработчики Wails идут в отдельных горутинах после хуков, и к их
	// запуску окно уже помечено уничтоженным — положение было бы не прочитать.
	cancelPlayer := detached.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) { s.finish(entry, true) })
	s.mu.Lock()
	entry.detached, entry.cancelOwner, entry.cancelPlayer = detached, cancelOwner, cancelPlayer
	closedEarly := entry.done
	s.mu.Unlock()
	if closedEarly {
		// Владелец закрылся, пока окно создавалось: finish уже прошёл без этих хуков и окна,
		// поэтому снимаем хуки здесь и закрываем только что созданное окно.
		cancelOwner()
		cancelPlayer()
		detached.Close()
	}
	return nil
}

// Close закрывает окно только по запросу его владельца и только своей сессии; иначе ничего не
// делает. Завершение выполняется сразу: владелец получает closed, а
// положение сохраняется до того, как Wails асинхронно уничтожит окно.
func (s *detachedWindows) close(ctx context.Context, session string) error {
	caller := s.caller(ctx)
	s.mu.Lock()
	entry := s.current
	var detached detachedWindow
	if entry != nil {
		detached = entry.detached
	}
	s.mu.Unlock()
	if entry == nil || caller == nil || entry.session != session || caller.ID() != entry.owner.ID() {
		return nil
	}
	s.finish(entry, true)
	if detached != nil {
		detached.Close()
	}
	return nil
}

// Send пересылает сообщение противоположной стороне открытой пары вместе с её сессией.
// Сообщения посторонних окон и сообщения без открытого окна отбрасываются молча (send
// контракта ничего не возвращает). Порядок сообщений одного окна сохраняет адаптер frontend,
// отправляя их последовательно; доставку в окно Wails выполняет через его очередь событий.
func (s *detachedWindows) send(ctx context.Context, message json.RawMessage) {
	caller := s.caller(ctx)
	if caller == nil {
		return
	}
	s.mu.Lock()
	entry := s.current
	var destination windowOwner
	if entry != nil && entry.detached != nil {
		switch caller.ID() {
		case entry.owner.ID():
			destination = entry.detached
		case entry.detached.ID():
			destination = entry.owner
		}
	}
	s.mu.Unlock()
	if destination == nil {
		return
	}
	destination.DispatchWailsEvent(&application.CustomEvent{Name: s.kind.messageEvent(), Data: detachedWindowEvent{Session: entry.session, Message: message}})
}

// ownerClosing закрывает отдельное окно вместе с владельцем. Владелец уже уходит, поэтому событие
// closed ему не отправляется.
func (s *detachedWindows) ownerClosing(entry *windowSession) {
	s.finish(entry, false)
	s.mu.Lock()
	detached := entry.detached
	s.mu.Unlock()
	if detached != nil {
		detached.Close()
	}
}

// finish один раз завершает сессию: освобождает место для нового окна, снимает хуки, сохраняет
// положение окна и при notify сообщает владельцу. Повторные вызовы (хук WindowClosing после
// Close) ничего не делают; поздний хук прежнего окна не трогает новую сессию.
func (s *detachedWindows) finish(entry *windowSession, notify bool) {
	s.mu.Lock()
	if entry.done {
		s.mu.Unlock()
		return
	}
	entry.done = true
	if s.current == entry {
		s.current = nil
	}
	detached, cancelOwner, cancelPlayer := entry.detached, entry.cancelOwner, entry.cancelPlayer
	s.mu.Unlock()
	if cancelOwner != nil {
		cancelOwner()
	}
	if cancelPlayer != nil {
		cancelPlayer()
	}
	if detached != nil {
		s.saveBounds(detached)
	}
	if notify {
		entry.owner.DispatchWailsEvent(&application.CustomEvent{Name: s.kind.closedEvent(), Data: entry.session})
	}
}

// windowOptions собирает параметры окна: размер по умолчанию либо сохранённое положение,
// пригодное для текущих экранов. Абсолютные координаты передаются через экран и смещение от
// его рабочей области: так Wails ставит окно одинаково в Linux и Windows (без Screen Linux
// трактует X/Y относительно текущего экрана); в сборке GTK4 окно до показа ставит
// newDetachedNativeWindow. В Wayland положение окну не задаётся вовсе.
func (s *detachedWindows) windowOptions(session string) application.WebviewWindowOptions {
	options := application.WebviewWindowOptions{
		Name: s.kind.name + "-window-" + session, Title: s.kind.title, URL: s.kind.url,
		Width: s.kind.defaultWidth, Height: s.kind.defaultHeight, MinWidth: s.kind.minWidth, MinHeight: s.kind.minHeight,
		BackgroundColour: application.NewRGB(244, 246, 248),
	}
	data, err := os.ReadFile(filepath.Join(s.localDir, s.kind.boundsFile))
	if err != nil || s.screens == nil {
		// При первом запуске или недоступном файле окно создаётся в обычном месте.
		return options
	}
	screens := s.screens()
	areas := make([]application.Rect, 0, len(screens))
	for _, screen := range screens {
		areas = append(areas, screen.WorkArea)
	}
	bounds, index, ok := s.kind.usableBounds(data, areas)
	if !ok {
		return options
	}
	// Дробные значения из файла приводятся к целым отбрасыванием дробной части; сам сервис
	// записывает только целые.
	x, y := int(bounds.X), int(bounds.Y)
	options.Width, options.Height = int(bounds.Width), int(bounds.Height)
	options.InitialPosition = application.WindowXY
	options.Screen = screens[index]
	options.X, options.Y = x-areas[index].X, y-areas[index].Y
	return options
}

// saveBounds пишет обычное положение окна компактным JSON {"x","y","width","height"} без
// перевода строки. Свёрнутое, развёрнутое или полноэкранное окно файл не меняет: остаётся
// прежнее обычное положение. Ошибка записи не мешает закрытию окна.
func (s *detachedWindows) saveBounds(detached detachedWindow) {
	if detached.IsMinimised() || detached.IsMaximised() || detached.IsFullscreen() {
		return
	}
	rect := detached.Bounds()
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
	_ = os.WriteFile(filepath.Join(s.localDir, s.kind.boundsFile), data, 0o644)
}

// windowBounds — сохранённое положение в единицах окна (DIP). Числа дробные: проверка
// выполняется над значениями файла до приведения к целым.
type windowBounds struct {
	X, Y, Width, Height float64
}

// usableWindowBounds разбирает и проверяет сохранённое положение: data — содержимое
// файла положения, areas — рабочие области экранов. Положение годится, если это объект с
// четырьмя конечными числами, окно не
// меньше 480×270 и хотя бы на одном экране видно не меньше 100×100 точек, причём верх окна
// не выше рабочей области и не ниже её низа минус 30 точек. Возвращает и индекс первого такого
// экрана — по нему окно ставится в абсолютные координаты. Любой сбой разбора — «нет положения».
func (k windowKind) usableBounds(data []byte, areas []application.Rect) (windowBounds, int, bool) {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		// Включая числа вне double: они не конечны, и положение отвергается.
		return windowBounds{}, 0, false
	}
	object, ok := raw.(map[string]any)
	if !ok || len(areas) == 0 {
		return windowBounds{}, 0, false
	}
	var values [4]float64
	for i, key := range []string{"x", "y", "width", "height"} {
		number, ok := object[key].(float64)
		if !ok || math.IsInf(number, 0) || math.IsNaN(number) {
			return windowBounds{}, 0, false
		}
		values[i] = number
	}
	bounds := windowBounds{X: values[0], Y: values[1], Width: values[2], Height: values[3]}
	if bounds.Width < float64(k.minWidth) || bounds.Height < float64(k.minHeight) {
		return windowBounds{}, 0, false
	}
	for index, area := range areas {
		ax, ay, aw, ah := float64(area.X), float64(area.Y), float64(area.Width), float64(area.Height)
		width := math.Min(bounds.X+bounds.Width, ax+aw) - math.Max(bounds.X, ax)
		height := math.Min(bounds.Y+bounds.Height, ay+ah) - math.Max(bounds.Y, ay)
		if width >= 100 && height >= 100 && bounds.Y >= ay && bounds.Y < ay+ah-30 {
			return bounds, index, true
		}
	}
	return windowBounds{}, 0, false
}
