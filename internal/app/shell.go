// Package app содержит границу между Wails и предметными сервисами приложения.
package app

import (
	"fmt"
	"runtime"
	"sync"
)

// AppID отделяет приложение разработки от установленного Electron SongFrame.
const AppID = "tools.songframe.go.dev"

// ProfileStore — нужная оболочке граница файловой системы. Сервис не определяет
// каталоги ОС сам; в тестах ошибка хранения подменяется без настоящего профиля.
type ProfileStore interface {
	Directory() (string, error)
}

// ProjectHistoryEntry сохраняет JSON-контракт истории проектов renderer.
// На этапе оболочки история пуста: чтение и открытие проектов ещё недоступны.
type ProjectHistoryEntry struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	LastOpened string `json:"lastOpened"`
	Exists     bool   `json:"exists"`
}

// AppState — совместимый снимок оболочки для window.api.app.state. Nullable-поля
// явно сериализуются как null, пустые коллекции — как [], а не как null.
type AppState struct {
	Packaged  bool                  `json:"packaged"`
	Problems  []string              `json:"problems"`
	ToolsRoot *string               `json:"toolsRoot"`
	LocalDir  string                `json:"localDir"`
	Current   *string               `json:"current"`
	History   []ProjectHistoryEntry `json:"history"`
	Platform  string                `json:"platform"`
}

// ShellService обслуживает только реализованные операции оболочки. Здесь нет
// поиска Python/Node/ORT, автоматического открытия клипа или чтения старого профиля.
// Callback готовности принадлежит smoke-проверке main, а не пользовательскому workflow.
type ShellService struct {
	profile   ProfileStore
	packaged  bool
	platform  string
	ready     func(AppState) error
	mu        sync.Mutex
	lastState *AppState
}

// NewShellService связывает Wails с профилем и необязательной проверкой frontend.
// Платформа нормализуется к существующему TS-контракту (Windows обозначается win32).
func NewShellService(profile ProfileStore, packaged bool, ready func(AppState) error) *ShellService {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	return &ShellService{profile: profile, packaged: packaged, platform: platform, ready: ready}
}

// State готовит профиль и возвращает снимок без проектных действий. Если диск
// недоступен, ошибка проходит через Wails в экран восстановления, а не даёт ложный успех.
func (s *ShellService) State() (AppState, error) {
	directory, err := s.profile.Directory()
	if err != nil {
		return AppState{}, fmt.Errorf("состояние приложения недоступно: %w", err)
	}
	state := AppState{
		Packaged: s.packaged,
		Problems: []string{},
		LocalDir: directory,
		History:  []ProjectHistoryEntry{},
		Platform: s.platform,
	}
	s.mu.Lock()
	s.lastState = &state
	s.mu.Unlock()
	return state, nil
}

// FrontendReady вызывается платформенным адаптером после State и монтажа React.
// В обычной работе это no-op; smoke требует успешный State и завершает проверку
// реального frontend → generated binding → Go, а не только загрузки HTML.
func (s *ShellService) FrontendReady() error {
	if s.ready == nil {
		return nil
	}
	s.mu.Lock()
	state := s.lastState
	s.mu.Unlock()
	if state == nil {
		return fmt.Errorf("интерфейс сообщил готовность до чтения состояния")
	}
	return s.ready(*state)
}
