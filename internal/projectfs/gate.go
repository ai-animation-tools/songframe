package projectfs

import (
	"fmt"
	"path/filepath"
	"strings"

	"songframe-go/internal/project"
)

// BlockedError объясняет, почему запись в проект запрещена. Problems — те же сообщения,
// что показывает Reader при блокировке просмотра; вызывающий может вывести их списком.
type BlockedError struct {
	Root     string
	Problems []string
}

func (e *BlockedError) Error() string {
	return "Запись в проект запрещена: " + strings.Join(e.Problems, " ")
}

// CheckWrite — шлюз записи: разрешает запись в проект, только если в нём нет
// незавершённых или нечитаемых журналов многофайловых операций (montage/derived).
// Иначе запись поверх частично опубликованного результата смешала бы версии файлов.
// Журналы распознаёт project.PendingJournals — тот же код, что блокирует просмотр.
// Проверка читает журналы при каждом вызове: состояние не кэшируется, поэтому
// завершённое восстановление сразу снимает запрет. Само восстановление пишет мимо шлюза.
func CheckWrite(root string) error {
	absolute, err := filepath.Abs(root)
	if err != nil || root == "" {
		return fmt.Errorf("не удалось определить папку проекта: %q", root)
	}
	if problems := project.PendingJournals(absolute); len(problems) > 0 {
		return &BlockedError{Root: absolute, Problems: problems}
	}
	return nil
}

// WriteProjectJSON проверяет шлюз и атомарно записывает документ по пути rel от корня проекта
// (например, "plan/audio/timing.json"). rel должен оставаться внутри проекта.
func WriteProjectJSON(root, rel string, value any) error {
	path, err := projectPath(root, rel)
	if err != nil {
		return err
	}
	if err := CheckWrite(root); err != nil {
		return err
	}
	return WriteJSON(path, value)
}

// projectPath разрешает только локальный относительный путь: «..», абсолютные пути и
// имена устройств Windows не выводят запись за пределы папки проекта.
func projectPath(root, rel string) (string, error) {
	local := filepath.FromSlash(rel)
	if !filepath.IsLocal(local) {
		return "", fmt.Errorf("путь %q должен быть относительным путём внутри проекта", rel)
	}
	return filepath.Join(root, local), nil
}
