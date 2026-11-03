package store

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"songframe-go/internal/projectfs"
)

// CurrentFile и HistoryFile — те же имена, что у Electron (src/main/state.ts): текущий проект
// и история открытых проектов в каталоге состояния приложения.
const (
	CurrentFile  = "current-project.json"
	HistoryFile  = "projects.json"
	historyLimit = 30
)

// HistoryEntry — элемент истории для UI (ProjectHistoryEntry в shared/types.ts).
// Exists проверяется при каждом чтении: папку могли перенести или удалить.
type HistoryEntry struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	LastOpened string `json:"lastOpened"`
	Exists     bool   `json:"exists"`
}

// currentDocument и historyDocument сохраняют порядок ключей файлов оригинала.
type currentDocument struct {
	SchemaVersion int    `json:"schema_version"`
	Path          string `json:"path"`
	SelectedAt    string `json:"selected_at"`
}

type historyRecord struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	LastOpened string `json:"last_opened"`
}

type historyDocument struct {
	SchemaVersion int             `json:"schema_version"`
	Projects      []historyRecord `json:"projects"`
}

// LocalState владеет current-project.json и projects.json в каталоге состояния.
// Повреждённый файл не перезаписывается молча: чтение и запись возвращают ошибку
// с путём, как в оригинале. Параллельного доступа нет (одно окно управления проектами).
type LocalState struct {
	Dir string
	Now func() time.Time
}

// NewLocalState привязывает состояние к каталогу профиля.
func NewLocalState(dir string) *LocalState { return &LocalState{Dir: dir, Now: time.Now} }

func (s *LocalState) currentPath() string { return filepath.Join(s.Dir, CurrentFile) }
func (s *LocalState) historyPath() string { return filepath.Join(s.Dir, HistoryFile) }

// Current возвращает путь текущего проекта или "", если он не выбран.
func (s *LocalState) Current() (string, error) {
	var raw map[string]any
	found, err := projectfs.ReadJSON(s.currentPath(), &raw)
	if err != nil || !found {
		return "", err
	}
	path, ok := raw["path"].(string)
	if version, _ := raw["schema_version"].(float64); version != 1 || !ok || path == "" {
		return "", fmt.Errorf("Неверный формат %s. Файл сохранён; выберите резервную копию или исправьте path.", s.currentPath())
	}
	return path, nil
}

// WriteCurrent делает проект текущим; прежний файл сначала проверяется на корректность.
func (s *LocalState) WriteCurrent(path string) error {
	if _, err := s.Current(); err != nil {
		return err
	}
	selected := s.Now().UTC().Format("2006-01-02T15:04:05") + "+00:00"
	return projectfs.WriteJSON(s.currentPath(), currentDocument{SchemaVersion: 1, Path: path, SelectedAt: selected})
}

// ClearCurrent снимает выбор текущего проекта; отсутствующий файл — не ошибка.
func (s *LocalState) ClearCurrent() error {
	if err := os.Remove(s.currentPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// History читает историю в сохранённом порядке; пустое имя заменяется именем папки.
func (s *LocalState) History() ([]HistoryEntry, error) {
	var raw map[string]any
	found, err := projectfs.ReadJSON(s.historyPath(), &raw)
	if err != nil {
		return nil, err
	}
	entries := []HistoryEntry{}
	if !found {
		return entries, nil
	}
	invalid := fmt.Errorf("Неверный формат %s. Файл сохранён; исправьте список projects.", s.historyPath())
	list, ok := raw["projects"].([]any)
	if version, _ := raw["schema_version"].(float64); version != 1 || !ok {
		return nil, invalid
	}
	for _, item := range list {
		record, ok := item.(map[string]any)
		if !ok {
			return nil, invalid
		}
		path, ok := record["path"].(string)
		if !ok {
			return nil, invalid
		}
		if path == "" {
			continue
		}
		name, _ := record["name"].(string)
		if name == "" {
			name = filepath.Base(path)
		}
		opened, _ := record["last_opened"].(string)
		_, statErr := os.Stat(path)
		entries = append(entries, HistoryEntry{Path: path, Name: name, LastOpened: opened, Exists: statErr == nil})
	}
	return entries, nil
}

// Touch переносит проект в начало истории (не больше 30 записей) с новым временем открытия.
func (s *LocalState) Touch(path, name string) error {
	history, err := s.History()
	if err != nil {
		return err
	}
	records := []historyRecord{{Path: path, Name: name, LastOpened: s.Now().UTC().Format("2006-01-02T15:04:05.000Z")}}
	for _, entry := range history {
		if entry.Path != path {
			records = append(records, historyRecord{Path: entry.Path, Name: entry.Name, LastOpened: entry.LastOpened})
		}
	}
	if len(records) > historyLimit {
		records = records[:historyLimit]
	}
	return projectfs.WriteJSON(s.historyPath(), historyDocument{SchemaVersion: 1, Projects: records})
}

// Remove убирает проект из истории, сохраняя порядок остальных записей.
func (s *LocalState) Remove(path string) error {
	history, err := s.History()
	if err != nil {
		return err
	}
	records := []historyRecord{}
	for _, entry := range history {
		if entry.Path != path {
			records = append(records, historyRecord{Path: entry.Path, Name: entry.Name, LastOpened: entry.LastOpened})
		}
	}
	return projectfs.WriteJSON(s.historyPath(), historyDocument{SchemaVersion: 1, Projects: records})
}
