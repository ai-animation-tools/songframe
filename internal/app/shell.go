package app

import (
	"fmt"

	"songframe-go/internal/desktop"
)

// FileServer — часть медиасервера, нужная группам shell, dialog и projects: базовый
// адрес для синхронного shell.fileUrl и разрешение файлов, выбранных приложением.
type FileServer interface {
	BaseURL() string
	AllowRoot(directory string) error
	AllowFile(path string)
	Register(path string) (string, error)
}

// ShellService реализует группу window.api.shell: открытие путей средствами ОС,
// чтение небольшого текста и адрес локальных файлов. Проектные данные здесь не пишутся.
type ShellService struct {
	files   FileServer
	desktop desktop.Desktop
}

// NewShellService связывает группу с медиасервером и системным открытием путей.
// open — нативное открытие Wails (Browser.OpenFile); в тестах подменяется.
func NewShellService(files FileServer, open desktop.Opener) *ShellService {
	return &ShellService{files: files, desktop: desktop.Default(open)}
}

// FileBase возвращает адрес loopback этого запуска. Адаптер получает его один раз
// до монтирования React и дальше строит URL файлов синхронно, как local-file:// в Electron.
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
