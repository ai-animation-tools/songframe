// Package store отделяет постоянный профиль новой оболочки от профиля Electron.
package store

import (
	"fmt"
	"os"
	"path/filepath"
)

// ProfileName — отдельный каталог разработки; обновление оболочки не затрагивает рабочий SongFrame.
const ProfileName = "songframe-go-dev"

// Profile владеет только расположением состояния оболочки. Открытие проекта и чтение
// прежних настроек сюда не входят: эти операции появятся в соответствующих доменах.
type Profile struct {
	override string
}

// NewProfile получает исключительно SONGFRAME_GO_LOCAL_DIR от точки сборки приложения.
// Отложенная проверка каталога позволяет показать ошибку хранения в интерфейсе через State.
func NewProfile(override string) *Profile {
	return &Profile{override: override}
}

// Path определяет переносимый путь профиля без записи на диск. Относительное явное
// значение разрешается относительно cwd запуска, системный путь — через os.UserConfigDir.
func (p *Profile) Path() (string, error) {
	path := p.override
	if path == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("не удалось определить папку состояния: %w", err)
		}
		path = filepath.Join(base, ProfileName)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("не удалось определить путь состояния: %w", err)
	}
	return absolute, nil
}

// Directory подготавливает только каталог нового профиля и возвращает фактический путь.
// Ошибка не маскируется временным профилем: пользователь должен видеть причину недоступности.
func (p *Profile) Directory() (string, error) {
	path, err := p.Path()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return "", fmt.Errorf("не удалось подготовить папку состояния: %w", err)
	}
	return path, nil
}
