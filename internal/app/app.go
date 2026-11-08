// Package app содержит границу между Wails и предметными сервисами приложения.
package app

import (
	"fmt"
	"os"
	"runtime"
	"sync"

	"songframe/internal/store"
	"songframe/internal/wire"
)

// AppID — собственный идентификатор приложения: по нему GTK держит единственный экземпляр, а
// окна и ярлыки не смешиваются с программами под другим app ID.
const AppID = "tools.songframe.desktop"

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
	Packaged bool                  `json:"packaged"`
	Problems []string              `json:"problems"`
	LocalDir string                `json:"localDir"`
	Current  *string               `json:"current"`
	History  []ProjectHistoryEntry `json:"history"`
	Platform string                `json:"platform"`
}

// RootAllower — часть медиасервера, которая разрешает показ файлов каталога по shell.fileUrl.
type RootAllower interface {
	AllowRoot(directory string) error
}

// AppService обслуживает только реализованные операции оболочки. Здесь нет
// поиска компонентов вроде ONNX Runtime и автоматического открытия клипа.
// Callback готовности принадлежит smoke-проверке main, а не пользовательскому workflow.
type AppService struct {
	profile   ProfileStore
	media     RootAllower
	packaged  bool
	platform  string
	ready     func(AppState) error
	mu        sync.Mutex
	lastState *AppState
}

// NewAppService связывает Wails с профилем, медиасервером и необязательной проверкой frontend.
// media может быть nil (тесты без медиасервера). Платформа нормализуется к существующему
// TS-контракту (Windows обозначается win32).
func NewAppService(profile ProfileStore, media RootAllower, packaged bool, ready func(AppState) error) *AppService {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	return &AppService{profile: profile, media: media, packaged: packaged, platform: platform, ready: ready}
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
	// Текущий проект и история читаются из каталога состояния: пропавшая папка текущего
	// проекта даёт null, повреждённый файл — ошибку старта с путём.
	local := store.NewLocalState(directory)
	current, err := local.Current()
	if err != nil {
		return AppState{}, err
	}
	if current != "" {
		if info, statErr := os.Stat(current); statErr == nil {
			state.Current = &current
			// Текущий проект из прошлого сеанса renderer не открывает заново (projects.open), а сразу
			// показывает его медиа: корень разрешается здесь, как в Open. Без этого трек, обложка и
			// референсы получали бы отказ медиасервера: он отдаёт файлы только разрешённых корней.
			// Ошибка разрешения не мешает старту: страница покажет обычную ошибку проигрывателя.
			if s.media != nil && info.IsDir() {
				_ = s.media.AllowRoot(current)
			}
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
