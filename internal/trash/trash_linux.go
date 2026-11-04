package trash

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// move — корзина freedesktop.org (Trash specification 1.0): сначала домашняя корзина
// $XDG_DATA_HOME/Trash; если объект на другом томе (rename даёт EXDEV), — $topdir/.Trash-$uid
// этого тома. Сначала атомарно создаётся info/<имя>.trashinfo (O_EXCL резервирует имя), затем
// объект переносится rename; при неудаче переноса запись info удаляется.
func move(path string) error {
	if _, err := os.Lstat(path); err != nil {
		return err
	}
	home, err := homeTrash()
	if err != nil {
		return err
	}
	err = moveInto(home, path, path)
	if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	top, err := mountPoint(path)
	if err != nil {
		return err
	}
	directory := filepath.Join(top, ".Trash-"+strconv.Itoa(os.Getuid()))
	relative, err := filepath.Rel(top, path)
	if err != nil {
		return err
	}
	// В корзине тома путь хранится относительно его корня.
	return moveInto(directory, path, relative)
}

// homeTrash — $XDG_DATA_HOME/Trash или ~/.local/share/Trash.
func homeTrash() (string, error) {
	if data := os.Getenv("XDG_DATA_HOME"); filepath.IsAbs(data) {
		return filepath.Join(data, "Trash"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("не найден домашний каталог для корзины: %w", err)
	}
	return filepath.Join(home, ".local", "share", "Trash"), nil
}

// moveInto переносит path в корзину directory; original — значение Path в .trashinfo.
func moveInto(directory, path, original string) error {
	files, info := filepath.Join(directory, "files"), filepath.Join(directory, "info")
	for _, folder := range []string{files, info} {
		if err := os.MkdirAll(folder, 0o700); err != nil {
			return err
		}
	}
	base := filepath.Base(path)
	escaped := (&url.URL{Path: original}).EscapedPath()
	content := "[Trash Info]\nPath=" + escaped + "\nDeletionDate=" + time.Now().Format("2006-01-02T15:04:05") + "\n"
	for attempt := 1; attempt < 10000; attempt++ {
		name := base
		if attempt > 1 {
			extension := filepath.Ext(base)
			name = strings.TrimSuffix(base, extension) + "." + strconv.Itoa(attempt) + extension
		}
		record := filepath.Join(info, name+".trashinfo")
		file, err := os.OpenFile(record, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		_, err = file.WriteString(content)
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		target := filepath.Join(files, name)
		if err == nil {
			if _, statErr := os.Lstat(target); statErr == nil {
				os.Remove(record)
				continue
			}
			err = os.Rename(path, target)
		}
		if err != nil {
			os.Remove(record)
		}
		return err
	}
	return errors.New("не удалось выбрать имя в корзине")
}

// mountPoint — корень тома, содержащего path: ближайший предок с другим st_dev родителя.
func mountPoint(path string) (string, error) {
	device := func(name string) (uint64, error) {
		info, err := os.Lstat(name)
		if err != nil {
			return 0, err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return 0, ErrUnsupported
		}
		return uint64(stat.Dev), nil
	}
	current := path
	own, err := device(current)
	if err != nil {
		return "", err
	}
	for {
		parent := filepath.Dir(current)
		if parent == current {
			return current, nil
		}
		value, err := device(parent)
		if err != nil {
			return "", err
		}
		if value != own {
			return current, nil
		}
		current = parent
	}
}
