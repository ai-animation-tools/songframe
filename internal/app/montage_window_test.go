package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"songframe-go/internal/golden"
)

// fakeMontageWindow заменяет окно Wails: записывает доставленные события, хранит хуки и
// при Close синхронно выполняет хуки WindowClosing (в Wails это происходит асинхронно).
type fakeMontageWindow struct {
	id        uint
	mu        sync.Mutex
	events    []montageDelivered
	hooks     map[uint][]*func(*application.WindowEvent)
	closed    int
	bounds    application.Rect
	maximised bool
}

// montageDelivered — имя и данные доставленного окну события (CustomEvent копировать нельзя).
type montageDelivered struct {
	name string
	data any
}

func newFakeMontageWindow(id uint) *fakeMontageWindow {
	return &fakeMontageWindow{id: id, hooks: map[uint][]*func(*application.WindowEvent){}, bounds: application.Rect{X: 100, Y: 100, Width: 800, Height: 500}}
}

func (w *fakeMontageWindow) ID() uint { return w.id }
func (w *fakeMontageWindow) DispatchWailsEvent(event *application.CustomEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.events = append(w.events, montageDelivered{name: event.Name, data: event.Data})
}
func (w *fakeMontageWindow) RegisterHook(eventType events.WindowEventType, callback func(*application.WindowEvent)) func() {
	w.mu.Lock()
	defer w.mu.Unlock()
	hook := &callback
	w.hooks[uint(eventType)] = append(w.hooks[uint(eventType)], hook)
	return func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		hooks := w.hooks[uint(eventType)]
		for i, item := range hooks {
			if item == hook {
				w.hooks[uint(eventType)] = append(hooks[:i:i], hooks[i+1:]...)
				return
			}
		}
	}
}
func (w *fakeMontageWindow) Close() {
	w.mu.Lock()
	w.closed++
	hooks := append([]*func(*application.WindowEvent){}, w.hooks[uint(events.Common.WindowClosing)]...)
	w.mu.Unlock()
	for _, hook := range hooks {
		(*hook)(application.NewWindowEvent())
	}
}
func (w *fakeMontageWindow) Bounds() application.Rect { return w.bounds }
func (w *fakeMontageWindow) IsMinimised() bool        { return false }
func (w *fakeMontageWindow) IsMaximised() bool        { return w.maximised }
func (w *fakeMontageWindow) IsFullscreen() bool       { return false }

// received возвращает доставленные окну события в виде JSON, как их увидит renderer.
func (w *fakeMontageWindow) received(t *testing.T) []string {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	result := []string{}
	for _, event := range w.events {
		data, err := json.Marshal(event.data)
		if err != nil {
			t.Fatal(err)
		}
		result = append(result, event.name+" "+string(data))
	}
	return result
}

func (w *fakeMontageWindow) hookCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.hooks[uint(events.Common.WindowClosing)])
}

type montageCallerKey struct{}

// montageHarness — сервис с подменённым созданием окон и опознанием окна вызова.
type montageHarness struct {
	service *MontageWindowService
	dir     string
	players []*fakeMontageWindow
	options []application.WebviewWindowOptions
	// onCreate выполняется внутри фабрики окна — для гонок с созданием.
	onCreate func()
}

func newMontageHarness(t *testing.T) *montageHarness {
	h := &montageHarness{dir: filepath.Join(t.TempDir(), "профиль")}
	h.service = NewMontageWindowService(h.dir)
	h.service.caller = func(ctx context.Context) montageOwner {
		window, _ := ctx.Value(montageCallerKey{}).(montageOwner)
		return window
	}
	h.service.create = func(options application.WebviewWindowOptions) montagePlayer {
		player := newFakeMontageWindow(uint(100 + len(h.players)))
		h.players = append(h.players, player)
		h.options = append(h.options, options)
		if h.onCreate != nil {
			h.onCreate()
		}
		return player
	}
	return h
}

func from(window montageOwner) context.Context {
	return context.WithValue(context.Background(), montageCallerKey{}, window)
}

func expectEvents(t *testing.T, window *fakeMontageWindow, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := window.received(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("события окна %d:\n got %q\nwant %q", window.id, got, want)
	}
}

// TestMontageWindowSessionIsolation повторяет первый сценарий montage-window.test.ts:
// пересылка только между владельцем и плеером, закрытие чужой сессии ничего не делает.
func TestMontageWindowSessionIsolation(t *testing.T) {
	h := newMontageHarness(t)
	owner, other := newFakeMontageWindow(1), newFakeMontageWindow(2)
	if err := h.service.Open(from(owner), "first"); err != nil {
		t.Fatal(err)
	}
	if len(h.players) != 1 {
		t.Fatalf("создано окон: %d", len(h.players))
	}
	options := h.options[0]
	if options.Title != "Плеер монтажа — SongFrame" || options.URL != "/#/montage-player" || options.Width != 820 || options.Height != 540 ||
		options.MinWidth != 480 || options.MinHeight != 270 || options.InitialPosition != application.WindowCentered || options.Screen != nil {
		t.Fatalf("параметры окна: %+v", options)
	}
	player := h.players[0]
	h.service.Send(from(player), json.RawMessage(`{"type":"ready"}`))
	h.service.Send(from(owner), json.RawMessage(`{"type":"command","action":"toggle"}`))
	// Сообщение постороннего окна и вызов без окна не доставляются никому.
	h.service.Send(from(other), json.RawMessage(`{"type":"ready"}`))
	h.service.Send(context.Background(), json.RawMessage(`{"type":"ready"}`))
	expectEvents(t, owner, `montage-window:message {"session":"first","message":{"type":"ready"}}`)
	expectEvents(t, player, `montage-window:message {"session":"first","message":{"type":"command","action":"toggle"}}`)
	expectEvents(t, other)

	// Закрыть может только владелец и только свою сессию.
	_ = h.service.Close(from(other), "first")
	_ = h.service.Close(from(owner), "second")
	_ = h.service.Close(from(player), "first")
	if player.closed != 0 {
		t.Fatal("окно закрыто не владельцем")
	}
	if err := h.service.Close(from(owner), "first"); err != nil {
		t.Fatal(err)
	}
	if player.closed != 1 {
		t.Fatalf("Close: %d", player.closed)
	}
	expectEvents(t, owner, `montage-window:message {"session":"first","message":{"type":"ready"}}`, `montage-window:closed "first"`)
	if owner.hookCount() != 0 || player.hookCount() != 0 {
		t.Fatal("хуки закрытия не сняты")
	}
	data, err := os.ReadFile(filepath.Join(h.dir, "montage-window.json"))
	if err != nil || string(data) != `{"x":100,"y":100,"width":800,"height":500}` {
		t.Fatalf("положение: %q %v", data, err)
	}
	// После закрытия сообщения не ходят, а новое окно открывается.
	h.service.Send(from(player), json.RawMessage(`{"type":"frame","frame":3}`))
	if err := h.service.Open(from(owner), "second"); err != nil {
		t.Fatal(err)
	}
	_ = h.service.Close(from(owner), "first")
	if h.players[1].closed != 0 {
		t.Fatal("закрытие прежней сессии закрыло новое окно")
	}
	expectEvents(t, owner, `montage-window:message {"session":"first","message":{"type":"ready"}}`, `montage-window:closed "first"`)
}

// TestMontageWindowSingleOwner — повторное открытие при открытом окне отвергается текстом
// оригинала и не создаёт второе окно; вызов без окна и пустая сессия тоже отвергаются.
func TestMontageWindowSingleOwner(t *testing.T) {
	h := newMontageHarness(t)
	owner := newFakeMontageWindow(1)
	// Вызов не из окна и пустая сессия.
	if err := h.service.Open(context.Background(), "original"); err == nil || err.Error() != "Не удалось открыть отдельное окно плеера." {
		t.Fatalf("вызов без окна: %v", err)
	}
	if err := h.service.Open(from(owner), ""); err == nil || err.Error() != "Не удалось открыть отдельное окно плеера." {
		t.Fatalf("пустая сессия: %v", err)
	}
	if len(h.players) != 0 {
		t.Fatal("отказ создал окно")
	}
	if err := h.service.Open(from(owner), "original"); err != nil {
		t.Fatal(err)
	}
	for _, window := range []montageOwner{owner, newFakeMontageWindow(2)} {
		if err := h.service.Open(from(window), "duplicate"); err == nil || err.Error() != "Не удалось открыть отдельное окно плеера." {
			t.Fatalf("повторное открытие: %v", err)
		}
	}
	if len(h.players) != 1 || h.players[0].closed != 0 {
		t.Fatalf("повтор затронул окно: %d %d", len(h.players), h.players[0].closed)
	}
	// Без подключённого GUI окно не создаётся.
	bare := NewMontageWindowService(t.TempDir())
	if err := bare.Open(from(owner), "x"); err == nil {
		t.Fatal("окно без GUI")
	}
}

// TestMontageWindowClosesWithOwner — закрытие владельца закрывает плеер; closed владельцу не
// отправляется, потому что он уже уходит (третий и четвёртый сценарии оригинала).
func TestMontageWindowClosesWithOwner(t *testing.T) {
	h := newMontageHarness(t)
	owner := newFakeMontageWindow(1)
	if err := h.service.Open(from(owner), "owner"); err != nil {
		t.Fatal(err)
	}
	owner.Close()
	if h.players[0].closed != 1 {
		t.Fatal("плеер не закрыт вместе с владельцем")
	}
	expectEvents(t, owner)
	if err := h.service.Open(from(newFakeMontageWindow(3)), "next"); err != nil {
		t.Fatal(err)
	}
}

// TestMontageWindowUserClose — пользователь закрыл плеер: владелец получает closed, положение
// сохраняется; развёрнутое окно файл не меняет (обычное положение getNormalBounds).
func TestMontageWindowUserClose(t *testing.T) {
	h := newMontageHarness(t)
	owner := newFakeMontageWindow(1)
	if err := h.service.Open(from(owner), "a"); err != nil {
		t.Fatal(err)
	}
	h.players[0].bounds = application.Rect{X: -1000, Y: 50, Width: 640, Height: 360}
	h.players[0].Close()
	expectEvents(t, owner, `montage-window:closed "a"`)
	path := filepath.Join(h.dir, "montage-window.json")
	if data, _ := os.ReadFile(path); string(data) != `{"x":-1000,"y":50,"width":640,"height":360}` {
		t.Fatalf("положение: %q", data)
	}
	if err := h.service.Open(from(owner), "b"); err != nil {
		t.Fatal(err)
	}
	h.players[1].maximised = true
	h.players[1].Close()
	if data, _ := os.ReadFile(path); string(data) != `{"x":-1000,"y":50,"width":640,"height":360}` {
		t.Fatalf("развёрнутое окно перезаписало положение: %q", data)
	}
	expectEvents(t, owner, `montage-window:closed "a"`, `montage-window:closed "b"`)
}

// TestMontageWindowCloseWhileCreating — закрытие владельцем до того, как фабрика вернула окно
// (в оригинале — ещё загружающееся окно): созданное окно закрывается, closed приходит один раз.
func TestMontageWindowCloseWhileCreating(t *testing.T) {
	h := newMontageHarness(t)
	owner := newFakeMontageWindow(1)
	h.onCreate = func() { _ = h.service.Close(from(owner), "early") }
	if err := h.service.Open(from(owner), "early"); err != nil {
		t.Fatal(err)
	}
	if h.players[0].closed != 1 || owner.hookCount() != 0 || h.players[0].hookCount() != 0 {
		t.Fatalf("окно осталось: closed=%d hooks=%d/%d", h.players[0].closed, owner.hookCount(), h.players[0].hookCount())
	}
	expectEvents(t, owner, `montage-window:closed "early"`)
	h.onCreate = nil
	if err := h.service.Open(from(owner), "next"); err != nil {
		t.Fatal(err)
	}
}

// TestMontageWindowRestoresBounds — сохранённое положение ставится через экран, на котором окно
// видно, со смещением от его рабочей области; непригодное — окно по умолчанию в центре.
func TestMontageWindowRestoresBounds(t *testing.T) {
	h := newMontageHarness(t)
	primary := &application.Screen{ID: "1", WorkArea: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1080}}
	left := &application.Screen{ID: "2", WorkArea: application.Rect{X: -1280, Y: 24, Width: 1280, Height: 1000}}
	h.service.screens = func() []*application.Screen { return []*application.Screen{primary, left} }
	if err := os.MkdirAll(h.dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(h.dir, "montage-window.json")
	if err := os.WriteFile(path, []byte(`{"x":-1000,"y":50,"width":640.9,"height":360}`), 0o644); err != nil {
		t.Fatal(err)
	}
	owner := newFakeMontageWindow(1)
	if err := h.service.Open(from(owner), "a"); err != nil {
		t.Fatal(err)
	}
	options := h.options[0]
	if options.InitialPosition != application.WindowXY || options.Screen != left || options.X != 280 || options.Y != 26 || options.Width != 640 || options.Height != 360 {
		t.Fatalf("восстановление: %+v", options)
	}
	h.players[0].maximised = true // файл не меняется при закрытии
	_ = h.service.Close(from(owner), "a")
	if err := os.WriteFile(path, []byte(`{"x":5000,"y":50,"width":640,"height":360}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := h.service.Open(from(owner), "b"); err != nil {
		t.Fatal(err)
	}
	if options := h.options[1]; options.InitialPosition != application.WindowCentered || options.Screen != nil || options.Width != 820 || options.Height != 540 {
		t.Fatalf("непригодное положение применено: %+v", options)
	}
}

// TestUsableMontageBoundsGolden сверяет перенос с эталоном montage-window-bounds, снятым с
// usableMontageBounds и JSON.parse registerMontageWindow оригинала.
func TestUsableMontageBoundsGolden(t *testing.T) {
	var file struct {
		Written string `json:"written"`
		Cases   []struct {
			Name     string `json:"name"`
			Text     string `json:"text"`
			Displays []struct {
				X, Y, Width, Height int
			} `json:"displays"`
			Expected map[string]any `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "montage-window-bounds", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("пустой эталон")
	}
	for _, item := range file.Cases {
		t.Run(item.Name, func(t *testing.T) {
			areas := []application.Rect{}
			for _, display := range item.Displays {
				areas = append(areas, application.Rect{X: display.X, Y: display.Y, Width: display.Width, Height: display.Height})
			}
			bounds, index, ok := usableMontageBounds([]byte(item.Text), areas)
			if ok != (item.Expected != nil) {
				t.Fatalf("пригодность %v, эталон %v", ok, item.Expected)
			}
			if !ok {
				return
			}
			// Оригинал возвращает сам объект файла с лишними полями; Go берёт только геометрию.
			got := map[string]float64{"x": bounds.X, "y": bounds.Y, "width": bounds.Width, "height": bounds.Height}
			for key, value := range got {
				if item.Expected[key] != value {
					t.Fatalf("%s=%v, эталон %v", key, value, item.Expected[key])
				}
			}
			if index < 0 || index >= len(areas) {
				t.Fatalf("индекс экрана %d", index)
			}
		})
	}
	// Формат записи совпадает с JSON.stringify(getNormalBounds()) оригинала.
	h := newMontageHarness(t)
	h.service.saveBounds(newFakeMontageWindow(1))
	if data, _ := os.ReadFile(filepath.Join(h.dir, "montage-window.json")); string(data) != file.Written {
		t.Fatalf("формат файла: %q, эталон %q", data, file.Written)
	}
}
