package app

import (
	"errors"
	"fmt"
	"net/url"

	"songframe/internal/desktop"
)

// FileServer — часть медиасервера, нужная группам shell, dialog и projects: базовый
// адрес для синхронного shell.fileUrl и разрешение файлов, выбранных приложением.
type FileServer interface {
	BaseURL() string
	AllowRoot(directory string) error
	AllowFile(path string)
	Register(path string) (string, error)
}

// ShellService реализует группу window.api.shell: открытие путей и веб-адресов средствами ОС,
// чтение небольшого текста и адрес локальных файлов. Проектные данные здесь не пишутся.
type ShellService struct {
	files     FileServer
	desktop   desktop.Desktop
	openURL   func(address string) error
	clipboard func() (string, bool)
}

// NewShellService связывает группу с медиасервером, системным открытием путей и браузером ОС.
// open — нативное открытие Wails (Browser.OpenFile), openURL — Browser.OpenURL, clipboard — чтение
// текста буфера обмена Wails (Clipboard.Text); в тестах подменяются.
func NewShellService(files FileServer, open desktop.Opener, openURL func(address string) error, clipboard func() (string, bool)) *ShellService {
	return &ShellService{files: files, desktop: desktop.Default(open), openURL: openURL, clipboard: clipboard}
}

// ClipboardText возвращает текст буфера обмена ОС для пункта «Вставить» контекстного меню полей.
// WebKit не даёт странице читать буфер без разрешения пользователя, а Wails читает его в главном
// потоке GTK или Win32. Пустой буфер — пустая строка; запись в буфер страница делает сама.
func (s *ShellService) ClipboardText() (string, error) {
	if s.clipboard == nil {
		return "", errors.New("буфер обмена недоступен")
	}
	text, ok := s.clipboard()
	if !ok {
		return "", errors.New("буфер обмена не содержит текста или занят другой программой")
	}
	return text, nil
}

// OpenExternal открывает веб-адрес в браузере ОС. Встроенный WebView ссылки с target="_blank"
// во внешнем браузере не открывает, поэтому страницы (кабинет провайдера, вход агента, заметки
// выпуска) открывают их через этот метод. Принимаются только адреса http и https.
func (s *ShellService) OpenExternal(address string) error {
	parsed, err := url.Parse(address)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("«%s» не является веб-адресом", address)
	}
	if s.openURL == nil {
		return errors.New("браузер ОС недоступен")
	}
	return s.openURL(address)
}

// FileBase возвращает адрес loopback этого запуска. Адаптер получает его один раз
// до монтирования React и дальше строит URL файлов синхронно.
func (s *ShellService) FileBase() (string, error) {
	if s.files == nil {
		return "", fmt.Errorf("медиасервер не запущен")
	}
	return s.files.BaseURL(), nil
}

// OpenPath открывает файл приложением по умолчанию или папку в файловом менеджере.
func (s *ShellService) OpenPath(path string) error { return s.desktop.OpenPath(path) }

// ReadText читает текст песни или идеи (до 2 МБ) и разрешает показ файла по URL,
// потому что путь выбран пользователем.
func (s *ShellService) ReadText(path string) (string, error) {
	text, err := desktop.ReadText(path)
	if err == nil && s.files != nil {
		s.files.AllowFile(path)
	}
	return text, err
}
