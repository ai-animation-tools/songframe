// Package app содержит границу между Wails и предметными сервисами приложения.
package app

import (
	"fmt"
	"os"
	"runtime"
	"sync"

	"songframe-go/internal/store"
	"songframe-go/internal/wire"
)

// AppID отделяет приложение разработки от установленного Electron SongFrame.
const AppID = "tools.songframe.go.dev"

// ProfileStore — нужная оболочке граница файловой системы. Сервис не определяет
// каталоги ОС сам; в тестах ошибка хранения подменяется без настоящего профиля.
type ProfileStore interface {
	Directory() (string, error)
}

// ProjectHistoryEntry сохраняет JSON-контракт истории проектов renderer.
// Поля совпадают с store.HistoryEntry: каталог состояния владеет историей.
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

// AppService обслуживает только реализованные операции оболочки. Здесь нет
// поиска Python/Node/ORT, автоматического открытия клипа или чтения старого профиля.
// Callback готовности принадлежит smoke-проверке main, а не пользовательскому workflow.
type AppService struct {
	profile   ProfileStore
	packaged  bool
	platform  string
	ready     func(AppState) error
	mu        sync.Mutex
	lastState *AppState
}

// NewAppService связывает Wails с профилем и необязательной проверкой frontend.
// Платформа нормализуется к существующему TS-контракту (Windows обозначается win32).
func NewAppService(profile ProfileStore, packaged bool, ready func(AppState) error) *AppService {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	return &AppService{profile: profile, packaged: packaged, platform: platform, ready: ready}
}

// State готовит профиль и возвращает снимок без проектных действий. Если диск
// недоступен, ошибка проходит через Wails в экран восстановления, а не даёт ложный успех.
func (s *AppService) State() (AppState, error) {
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
	// Текущий проект и история — те же файлы и правила, что Projects.appState оригинала:
	// пропавшая папка текущего проекта даёт null, повреждённый файл — ошибку старта с путём.
	local := store.NewLocalState(directory)
	current, err := local.Current()
	if err != nil {
		return AppState{}, err
	}
	if current != "" {
		if _, statErr := os.Stat(current); statErr == nil {
			state.Current = &current
		}
	}
	history, err := local.History()
	if err != nil {
		return AppState{}, err
	}
	for _, entry := range history {
		state.History = append(state.History, ProjectHistoryEntry(entry))
	}
	s.mu.Lock()
	s.lastState = &state
	s.mu.Unlock()
	return wire.Fill(state), nil
}

// FrontendReady вызывается платформенным адаптером после State и монтажа React.
// В обычной работе это no-op; smoke требует успешный State и завершает проверку
// реального frontend → generated binding → Go, а не только загрузки HTML.
func (s *AppService) FrontendReady() error {
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
