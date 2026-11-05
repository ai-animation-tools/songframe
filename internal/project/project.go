// Package project содержит общие сведения о папке проекта, которые нужны нескольким областям:
// описание медиафайла для медиасервера и распознавание незавершённых многофайловых публикаций.
package project

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// MediaFile связывает выбранный локальный файл с временным URL медиасервера.
// URL существует только в памяти сеанса и никогда не записывается в проект.
type MediaFile struct {
	Path string `json:"path"`
	URL  string `json:"url"`
	Kind string `json:"kind"`
}

// readLimited ограничивает только объём небольших документов, не аудио/видео.
// Проверка обычного файла предотвращает зависание на FIFO; превышение лимита явно объясняется.
func readLimited(path string, limit int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("путь не является обычным файлом")
	}
	if info.Size() > limit {
		return nil, fmt.Errorf("документ больше допустимых %d байт", limit)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("документ больше допустимых %d байт", limit)
	}
	return data, nil
}

// readObject сохраняет сырые значения полей и отличает объект от null/массива.
func readObject(path string) (map[string]json.RawMessage, error) {
	data, err := readLimited(path, 16<<20)
	if err != nil {
		return nil, err
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if value == nil {
		return nil, fmt.Errorf("ожидается JSON-объект")
	}
	return value, nil
}

// PendingJournals замечает прерванную публикацию montage/derived в самой копии проекта.
// Нечитаемый журнал также блокирует просмотр: угадывать целостность или откатывать файлы здесь нельзя.
// Источник для шлюза записи projectfs (запрет записи) и будущего recovery монтажа/производных:
// обе стороны должны одинаково распознавать незавершённые многофайловые операции.
// Возвращает непустой срез сообщений при блокировке и пустой (не nil) — когда журналов нет.
func PendingJournals(project string) []string {
	problems := []string{}
	for _, kind := range []string{"montage-history", "derived-history"} {
		directory := filepath.Join(project, "plan", kind)
		entries, err := os.ReadDir(directory)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			problems = append(problems, fmt.Sprintf("Не удалось проверить plan/%s: %v", kind, err))
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			path := filepath.Join(directory, entry.Name(), "journal.json")
			journal, err := readObject(path)
			if os.IsNotExist(err) {
				continue
			}
			var state string
			if err != nil || json.Unmarshal(journal["state"], &state) != nil || state == "" {
				problems = append(problems, fmt.Sprintf("Не удалось проверить журнал plan/%s/%s/journal.json. %s", kind, entry.Name(), recoveryHint(kind, "Откройте проект заново для проверки восстановления.", "Откройте исходный проект в прежнем приложении для проверки восстановления.")))
			} else if state == "publishing" {
				problems = append(problems, fmt.Sprintf("Незавершённая публикация plan/%s/%s: просмотр заблокирован до восстановления %s.", kind, entry.Name(), recoveryHint(kind, "при открытии проекта", "в прежнем приложении")))
			}
		}
	}
	return problems
}

// recoveryHint — где восстанавливается журнал вида kind: журналы ручного монтажа откатывает
// montage.RecoverOpened при открытии проекта (этап 46b), производные планы переносит этап 46c,
// до него их восстанавливает прежнее приложение.
func recoveryHint(kind, ported, legacy string) string {
	if kind == "montage-history" {
		return ported
	}
	return legacy
}
