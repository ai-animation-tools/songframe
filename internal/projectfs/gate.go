package projectfs

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"

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
// незавершённых или нечитаемых журналов многофайловых операций (montage/derived) и
// зарегистрированные проверки (SetWriteCheck) не сообщают о незавершённой публикации.
// Иначе запись поверх частично опубликованного результата смешала бы версии файлов.
// Журналы распознаёт project.PendingJournals — тот же код, что блокирует просмотр.
// Проверка читает журналы при каждом вызове: состояние не кэшируется, поэтому
// завершённое восстановление сразу снимает запрет. Само восстановление пишет мимо шлюза.
func CheckWrite(root string) error {
	absolute, err := filepath.Abs(root)
	if err != nil || root == "" {
		return fmt.Errorf("не удалось определить папку проекта: %q", root)
	}
	problems := project.PendingJournals(absolute)
	for _, check := range registeredChecks() {
		problems = append(problems, check(absolute)...)
	}
	if len(problems) > 0 {
		return &BlockedError{Root: absolute, Problems: problems}
	}
	return nil
}

// WriteCheck — дополнительная проверка шлюза: сообщения, по которым запись в проект (абсолютный
// путь) запрещена, или пусто. Журналы, которые лежат вне проекта (каталог состояния приложения,
// например публикации сценария), шлюз узнаёт только так: проектный журнал видит PendingJournals.
type WriteCheck func(root string) []string

var (
	checksMu sync.RWMutex
	checks   = map[string]WriteCheck{}
)

// SetWriteCheck регистрирует проверку под именем владельца; повторная регистрация заменяет
// прежнюю, nil снимает её. Приложение регистрирует проверки при старте (main), тесты — на время
// проверки. Порядок сообщений — по имени владельца.
func SetWriteCheck(name string, check WriteCheck) {
	checksMu.Lock()
	defer checksMu.Unlock()
	if check == nil {
		delete(checks, name)
		return
	}
	checks[name] = check
}

func registeredChecks() []WriteCheck {
	checksMu.RLock()
	defer checksMu.RUnlock()
	names := make([]string, 0, len(checks))
	for name := range checks {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]WriteCheck, 0, len(names))
	for _, name := range names {
		result = append(result, checks[name])
	}
	return result
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
