package app

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"songframe-go/internal/diagnostics"
	"songframe-go/internal/wire"
)

// PickFilter сохраняет фильтры существующего диалога; расширения передаются без точки.
type PickFilter struct {
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

// PickOptions совместим с общим TS-контрактом и не раскрывает renderer внутренние опции Wails.
type PickOptions struct {
	Title    string       `json:"title,omitempty"`
	Filters  []PickFilter `json:"filters,omitempty"`
	Multiple bool         `json:"multiple,omitempty"`
}

// PreviewInput описывает отдельное окно просмотра уже зарегистрированного медиа, а не монтажный редактор.
// Session принадлежит открывшей окно странице; адрес не сохраняется в проект, поскольку порт временный.
type PreviewInput struct {
	Session  string `json:"session"`
	MediaURL string `json:"mediaUrl"`
	Title    string `json:"title"`
}

// NotificationTarget — адрес перехода из уведомления; произвольный JS или URL здесь недопустимы.
type NotificationTarget struct {
	Project string `json:"project"`
	Route   string `json:"route"`
}

// FilesDropped передаёт настоящие пути ОС только тому окну, в котором произошёл drop.
type FilesDropped struct {
	WindowID uint     `json:"windowID"`
	Paths    []string `json:"paths"`
	TargetID string   `json:"targetID"`
}

// PreviewClosed сообщает владельцу, что пользователь закрыл отдельное окно просмотра.
type PreviewClosed struct {
	Session string `json:"session"`
}

// previewSession хранит модель и минимальные операции окна, что позволяет проверить очистку без GUI.
type previewSession struct {
	input PreviewInput
	close func()
	focus func()
	ready bool
}

// NativeService владеет диалогами, жизненным циклом дополнительных окон и диагностикой обоих renderer.
// GUI подключается после application.New; проектные записи и производственные действия здесь отсутствуют.
type NativeService struct {
	mu               sync.Mutex
	desktop          *application.App
	mainWindow       *application.WebviewWindow
	log              *diagnostics.Log
	diagnosticMu     sync.Mutex
	diagnosticClosed bool
	profileDir       string
	previews         map[string]*previewSession
	emit             func(string, any)
	validMediaURL    func(string) bool
	allowFile        func(string)
	openWindow       func(PreviewInput, func()) (func(), func(), error)
}

// NewNativeService подготавливает диагностику, но отказ диска не мешает показать экран восстановления.
// Ошибка повторяется через CrashNotice/ReportRendererError; после исправления профиля доступ восстанавливается.
func NewNativeService(profileDir string) (*NativeService, error) {
	service := &NativeService{profileDir: profileDir, previews: make(map[string]*previewSession)}
	// Обычный сеанс получает маркер уже при старте, даже если первое окно не успело загрузиться.
	// Неудача здесь не фатальна: доступ к журналу повторит операцию и вернёт причину renderer.
	_, _ = service.diagnosticsLog()
	return service, nil
}

// diagnosticsLog повторяет только неудавшуюся инициализацию и не перезаписывает маркер текущего сеанса.
// Отдельный мьютекс не задерживает управление окнами во время файловых операций.
func (s *NativeService) diagnosticsLog() (*diagnostics.Log, error) {
	s.diagnosticMu.Lock()
	defer s.diagnosticMu.Unlock()
	if s.diagnosticClosed {
		return nil, fmt.Errorf("диагностический сеанс завершён")
	}
	if s.log != nil {
		return s.log, nil
	}
	log, err := diagnostics.Open(s.profileDir)
	if err != nil {
		return nil, fmt.Errorf("диагностика недоступна: %w", err)
	}
	s.log = log
	return log, nil
}

// ConfigureNativeDesktop связывает сервис с Wails до запуска GUI; функция не экспортируется в bindings.
func ConfigureNativeDesktop(s *NativeService, desktop *application.App) {
	s.desktop = desktop
	s.emit = func(name string, data any) { desktop.Event.Emit(name, data) }
	s.openWindow = func(input PreviewInput, closed func()) (func(), func(), error) {
		window := desktop.Window.NewWithOptions(application.WebviewWindowOptions{
			Name: "preview-" + input.Session, Title: input.Title, URL: "/#/preview?session=" + url.QueryEscape(input.Session),
			Width: 1320, Height: 860, MinWidth: 1320, MinHeight: 860, BackgroundColour: application.NewRGB(244, 246, 248),
		})
		window.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { closed() })
		return window.Close, func() { window.Show(); window.Focus() }, nil
	}
}

// ConfigureNativeMedia принимает проверку регистрации URL от владельца HTTP listener.
// Проверка запрещает подменить окно просмотра произвольным сетевым или локальным адресом.
// allowFile разрешает выбранные в диалоге и перетащенные файлы для shell.fileUrl.
func ConfigureNativeMedia(s *NativeService, containsURL func(string) bool, allowFile func(string)) {
	s.validMediaURL = containsURL
	s.allowFile = allowFile
}

// allow отдаёт выбранные пользователем пути медиасерверу; без него (тесты) ничего не делает.
func (s *NativeService) allow(paths ...string) {
	if s.allowFile == nil {
		return
	}
	for _, path := range paths {
		s.allowFile(path)
	}
}

// AttachNativeWindow подключает drop к основному окну. Пути берутся из Wails, не из синтетического File.name.
// Возвращённое отключение вызывается владельцем окна; frontend также обязан снимать свою Events.On-подписку.
func AttachNativeWindow(s *NativeService, window *application.WebviewWindow) func() {
	s.mainWindow = window
	return window.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		ctx := event.Context()
		if ctx == nil {
			return
		}
		paths := ctx.DroppedFiles()
		if len(paths) == 0 {
			return
		}
		s.allow(paths...)
		payload := FilesDropped{WindowID: window.ID(), Paths: append([]string{}, paths...)}
		if target := ctx.DropTargetDetails(); target != nil {
			payload.TargetID = target.ElementID
		}
		window.EmitEvent("native:files-dropped", payload)
	})
}

// dialogOptions переводит только известные поля PickOptions и не смешивает выбор папки с выбором файла.
func dialogOptions(input *PickOptions, folder bool) (*application.OpenFileDialogOptions, error) {
	result := &application.OpenFileDialogOptions{CanChooseDirectories: folder, CanChooseFiles: !folder}
	if input == nil {
		return result, nil
	}
	result.Title = input.Title
	result.AllowsMultipleSelection = input.Multiple && !folder
	for _, filter := range input.Filters {
		patterns := make([]string, 0, len(filter.Extensions))
		for _, ext := range filter.Extensions {
			ext = strings.TrimPrefix(strings.TrimSpace(ext), ".")
			if ext == "*" {
				patterns = append(patterns, "*")
				continue
			}
			if ext == "" || strings.ContainsAny(ext, "/\\;*?\x00") {
				return nil, fmt.Errorf("недопустимое расширение в фильтре диалога")
			}
			patterns = append(patterns, "*."+ext)
		}
		if len(patterns) > 0 {
			result.Filters = append(result.Filters, application.FileFilter{DisplayName: filter.Name, Pattern: strings.Join(patterns, ";")})
		}
	}
	return result, nil
}

// PickFolder показывает настоящий системный диалог; отмена сохраняет nullable-контракт.
func (s *NativeService) PickFolder(input *PickOptions) (*string, error) {
	if s.desktop == nil {
		return nil, fmt.Errorf("нативное приложение ещё не запущено")
	}
	options, err := dialogOptions(input, true)
	if err != nil {
		return nil, err
	}
	options.Window = s.mainWindow
	path, err := s.desktop.Dialog.OpenFileWithOptions(options).PromptForSingleSelection()
	if err != nil || path == "" {
		return nil, err
	}
	return &path, nil
}

// PickFiles сохраняет порядок выбранных файлов и возвращает [] при отмене, никогда null.
func (s *NativeService) PickFiles(input *PickOptions) ([]string, error) {
	if s.desktop == nil {
		return nil, fmt.Errorf("нативное приложение ещё не запущено")
	}
	options, err := dialogOptions(input, false)
	if err != nil {
		return nil, err
	}
	options.Window = s.mainWindow
	dialog := s.desktop.Dialog.OpenFileWithOptions(options)
	if options.AllowsMultipleSelection {
		paths, err := dialog.PromptForMultipleSelection()
		s.allow(paths...)
		return wire.Fill(paths), err
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return []string{}, nil
	}
	s.allow(path)
	return []string{path}, nil
}

// ReportRendererError сохраняет ошибку любого окна в изолированный журнал приложения.
func (s *NativeService) ReportRendererError(report diagnostics.RendererErrorReport) error {
	log, err := s.diagnosticsLog()
	if err != nil {
		return err
	}
	return log.ReportRendererError(report)
}

// CrashNotice сообщает о незавершённом прошлом сеансе один раз за запуск.
func (s *NativeService) CrashNotice() (*diagnostics.PreviousSessionInfo, error) {
	log, err := s.diagnosticsLog()
	if err != nil {
		return nil, err
	}
	return log.CrashNotice(), nil
}

// SaveReport экспортирует диагностику только по выбранному в системном диалоге пути.
func (s *NativeService) SaveReport() (*string, error) {
	if s.desktop == nil {
		return nil, fmt.Errorf("нативное приложение ещё не запущено")
	}
	diagnosticLog, err := s.diagnosticsLog()
	if err != nil {
		return nil, err
	}
	path, err := s.desktop.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title: "Сохранить диагностический отчёт", Filename: "songframe-diagnostics.txt", Window: s.mainWindow,
		Filters: []application.FileFilter{{DisplayName: "Текстовый отчёт", Pattern: "*.txt"}},
	}).PromptForSingleSelection()
	if err != nil || path == "" {
		return nil, err
	}
	data, err := diagnosticLog.Report()
	if err != nil {
		return nil, err
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		return nil, fmt.Errorf("сохранение отчёта: %w", err)
	}
	return &path, nil
}

// OpenPreview создаёт окно один раз на session; повторное открытие того же медиа только возвращает фокус.
// Снимок регистрируется до создания окна, чтобы первый вызов Preview из renderer уже видел данные.
func (s *NativeService) OpenPreview(input PreviewInput) error {
	if strings.TrimSpace(input.Session) == "" || strings.ContainsAny(input.Session, "\x00\r\n") {
		return fmt.Errorf("не задана корректная сессия просмотра")
	}
	if s.validMediaURL == nil || !s.validMediaURL(input.MediaURL) {
		return fmt.Errorf("медиа не зарегистрировано локальным сервером")
	}
	if s.openWindow == nil {
		return fmt.Errorf("нативное приложение ещё не запущено")
	}
	s.mu.Lock()
	if old := s.previews[input.Session]; old != nil {
		if old.input != input {
			s.mu.Unlock()
			return fmt.Errorf("сессия просмотра уже использует другое медиа")
		}
		focus := old.focus
		s.mu.Unlock()
		if focus != nil {
			focus()
		}
		return nil
	}
	entry := &previewSession{input: input}
	s.previews[input.Session] = entry
	s.mu.Unlock()
	closeWindow, focusWindow, err := s.openWindow(input, func() { s.previewClosed(input.Session, entry) })
	s.mu.Lock()
	if err != nil {
		if s.previews[input.Session] == entry {
			delete(s.previews, input.Session)
		}
		s.mu.Unlock()
		return err
	}
	if s.previews[input.Session] != entry {
		s.mu.Unlock()
		closeWindow()
		return nil
	}
	entry.close = closeWindow
	entry.focus = focusWindow
	s.mu.Unlock()
	return nil
}

// Preview читает неизменяемую модель окна по session, а закрытая сессия возвращает явную ошибку.
func (s *NativeService) Preview(session string) (*PreviewInput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.previews[session]
	if entry == nil {
		return nil, fmt.Errorf("окно просмотра уже закрыто")
	}
	input := entry.input
	return &input, nil
}

// PreviewReady подтверждает готовность медиа после loadedmetadata в отдельном renderer.
// Повторный callback не умножает события; закрытая сессия не может сообщить ложный успех.
func (s *NativeService) PreviewReady(session string) error {
	s.mu.Lock()
	entry := s.previews[session]
	if entry == nil {
		s.mu.Unlock()
		return fmt.Errorf("окно просмотра уже закрыто")
	}
	if entry.ready {
		s.mu.Unlock()
		return nil
	}
	entry.ready = true
	s.mu.Unlock()
	if s.emit != nil {
		s.emit("preview:ready", PreviewClosed{Session: session})
	}
	return nil
}

// previewClosed удаляет только соответствующее окно; поздний callback прежнего окна не закрывает новое.
func (s *NativeService) previewClosed(session string, entry *previewSession) {
	s.mu.Lock()
	if s.previews[session] != entry {
		s.mu.Unlock()
		return
	}
	delete(s.previews, session)
	s.mu.Unlock()
	if s.emit != nil {
		s.emit("preview:closed", PreviewClosed{Session: session})
	}
}

// ClosePreview безопасен при повторном закрытии и гонке с первым созданием окна.
func (s *NativeService) ClosePreview(session string) error {
	s.mu.Lock()
	entry := s.previews[session]
	s.mu.Unlock()
	if entry == nil {
		return nil
	}
	s.previewClosed(session, entry)
	s.mu.Lock()
	closeWindow := entry.close
	s.mu.Unlock()
	if closeWindow != nil {
		closeWindow()
	}
	return nil
}

// RouteNotification выполняет переход из принятого события уведомления и фокусирует основное окно.
// Это граница навигации; отправка OS-уведомлений о производственных заданиях появится вместе с заданиями.
func (s *NativeService) RouteNotification(target NotificationTarget) error {
	switch target.Route {
	case "/project/timing", "/project/checks", "/project/animatic", "/project/scenario", "/project/production":
	default:
		return fmt.Errorf("неизвестный адрес уведомления")
	}
	if !filepath.IsAbs(target.Project) {
		return fmt.Errorf("в уведомлении отсутствует абсолютный путь проекта")
	}
	if s.emit == nil {
		return fmt.Errorf("нативное приложение ещё не запущено")
	}
	if s.mainWindow != nil {
		s.mainWindow.Show()
		s.mainWindow.Focus()
	}
	if s.mainWindow != nil {
		s.mainWindow.EmitEvent("notifications:open", target)
	} else {
		s.emit("notifications:open", target)
	}
	return nil
}

// close фиксирует штатное завершение диагностики; окна освобождает сам Wails при завершении приложения.
func (s *NativeService) close() error {
	s.diagnosticMu.Lock()
	defer s.diagnosticMu.Unlock()
	if s.diagnosticClosed {
		return nil
	}
	if s.log != nil {
		if err := s.log.Close(); err != nil {
			return err
		}
	}
	s.diagnosticClosed = true
	return nil
}

// ServiceShutdown обеспечивает чистый маркер и при завершении через системное меню Wails.
func (s *NativeService) ServiceShutdown() error { return s.close() }
