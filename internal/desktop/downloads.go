package desktop

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DownloadsDir — папка загрузок пользователя: туда приложение кладёт файлы для работы вне клипа
// (кадры принятого видео для референсов), чтобы они не попадали в Git проекта. В Linux — каталог
// XDG_DOWNLOAD_DIR из user-dirs.dirs (в русской системе это «Загрузки»), иначе ~/Downloads; в
// Windows — Downloads в профиле пользователя. Папка может ещё не существовать: её создаёт тот, кто
// пишет файл.
func DownloadsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("Не найдена домашняя папка пользователя.")
	}
	if runtime.GOOS == "linux" {
		config := os.Getenv("XDG_CONFIG_HOME")
		if config == "" {
			config = filepath.Join(home, ".config")
		}
		if dir := xdgDownloadDir(filepath.Join(config, "user-dirs.dirs"), home); dir != "" {
			return dir, nil
		}
	}
	return filepath.Join(home, "Downloads"), nil
}

// xdgDownloadDir — XDG_DOWNLOAD_DIR из файла user-dirs.dirs: строка вида
// XDG_DOWNLOAD_DIR="$HOME/Загрузки"; "" — файла или строки нет, путь не абсолютный или равен
// домашней папке (так xdg-user-dirs отключает каталог).
func xdgDownloadDir(path, home string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		value, ok := strings.CutPrefix(line, "XDG_DOWNLOAD_DIR=")
		if !ok {
			continue
		}
		value = strings.Trim(value, `"`)
		if rest, ok := strings.CutPrefix(value, "$HOME"); ok {
			value = home + rest
		}
		value = filepath.Clean(value)
		if !filepath.IsAbs(value) || value == filepath.Clean(home) {
			return ""
		}
		return value
	}
	return ""
}
