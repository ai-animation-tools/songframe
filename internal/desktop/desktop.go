// Package desktop открывает файлы и папки системными средствами и читает небольшие тексты,
// выбранные пользователем. В Linux папка показывается через org.freedesktop.FileManager1.ShowFolders, иначе xdg-open
// с проверкой кода выхода; ошибки объясняют, что не удалось открыть.
package desktop

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"songframe-go/internal/process"
)

// TextLimit — предел ReadText: текст песни или идея, а не произвольный документ.
const TextLimit = 2 * 1024 * 1024

// Runner запускает системную команду без shell и возвращает понятную ошибку.
// Подменяется в тестах; по умолчанию — RunCommand с таймаутом 8 секунд.
type Runner func(command string, args ...string) error

// Opener открывает путь средствами ОС, кроме папки в Linux (её показывает ShowFolders).
type Opener func(path string) error

// Desktop связывает правила открытия с выполнением команд и нативным открытием Wails.
type Desktop struct {
	Platform string
	Run      Runner
	Open     Opener
}

// RunCommand повторяет runDesktopCommand: таймаут, отсутствующая программа и stderr
// превращаются в отдельные сообщения. Запуск — через общий process: без окна консоли
// в Windows и с завершением потомков при таймауте; stderr ограничен 64 КиБ, как maxBuffer.
func RunCommand(command string, args ...string) error {
	result, err := process.Run(context.Background(), process.Command{
		Path: command, Args: args, Timeout: 8 * time.Second, StderrLimit: 64 * 1024,
	})
	if err == nil {
		return nil
	}
	if errors.Is(err, process.ErrTimeout) {
		return errors.New("Системная команда открытия не ответила вовремя.")
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("Не найдена системная команда %s.", command)
	}
	if text := strings.TrimSpace(string(result.Stderr)); text != "" {
		return errors.New(truncate(text, 1000))
	}
	return errors.New("Системная команда открытия завершилась с ошибкой.")
}

// OpenPath открывает файл приложением по умолчанию, а папку — в файловом менеджере.
func (d Desktop) OpenPath(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("Не удалось открыть «%s»: файл или папка не найдены либо недоступны.", path)
	}
	if err := d.open(path, info.IsDir()); err != nil {
		return fmt.Errorf("Не удалось открыть «%s»: %s", path, err.Error())
	}
	return nil
}

func (d Desktop) open(path string, directory bool) error {
	if d.Platform == "linux" && directory {
		// ShowFolders открывает содержимое папки, а не выделяет её в родительском каталоге.
		uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
		if err := d.Run("gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1",
			"--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowFolders",
			`["`+strings.ReplaceAll(uri, `"`, `\"`)+`"]`, ""); err == nil {
			return nil
		}
		return d.Run("xdg-open", path)
	}
	return d.Open(path)
}

// ReadText читает небольшой UTF-8 файл для подстановки в форму (shell.readText).
func ReadText(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > TextLimit {
		return "", errors.New("Файл больше 2 МБ: выберите текстовый файл меньшего размера.")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Default — платформа текущей ОС в обозначениях TS-контракта (win32 для Windows).
func Default(open Opener) Desktop {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	return Desktop{Platform: platform, Run: RunCommand, Open: open}
}

func truncate(text string, limit int) string {
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}
