// Package project читает существующие проекты без преобразования и записи их файлов.
package project

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

// MediaFile связывает выбранный локальный файл с временным URL медиасервера.
// URL существует только в памяти сеанса и никогда не записывается в проект.
type MediaFile struct {
	Path string `json:"path"`
	URL  string `json:"url"`
	Kind string `json:"kind"`
}

// Snapshot представляет минимальное чтение проекта, а не производственный ProjectStatus.
// Timing сохраняет неизвестные поля JSON; текст сохраняет физические строки для analyzeLyrics frontend.
// Blocked запрещает выдавать содержимое частично опубликованного проекта без его восстановления.
type Snapshot struct {
	Path        string          `json:"path"`
	Name        string          `json:"name"`
	LyricsText  string          `json:"lyricsText"`
	Timing      json.RawMessage `json:"timing"`
	Track       *MediaFile      `json:"track"`
	TrackSha256 *string         `json:"trackSha256"`
	Duration    *float64        `json:"duration"`
	Problems    []string        `json:"problems"`
	Blocked     bool            `json:"blocked"`
}

// Reader не хранит выбранный проект и не зависит от профиля, процессов или ML.
// Повторное чтение после переноса папки строит пути заново и не требует миграции JSON.
type Reader struct{}

// Read проверяет маркер и известные проектные журналы, затем читает исходный текст и тайминги.
// Ошибка маркера отменяет открытие; ошибки необязательных документов возвращаются в Problems.
// Журналы scenario/production старого профиля сюда не входят: этот срез не выполняет recovery.
func (Reader) Read(path string) (Snapshot, error) {
	absolute, err := filepath.Abs(path)
	if err != nil || path == "" {
		return Snapshot{}, fmt.Errorf("не удалось определить папку проекта: %q", path)
	}
	result := Snapshot{Path: absolute, Problems: []string{}, Timing: json.RawMessage("null")}
	marker, err := readObject(filepath.Join(absolute, "plan", "project.json"))
	if err != nil {
		return Snapshot{}, fmt.Errorf("не удалось прочитать plan/project.json: %w", err)
	}
	if err := json.Unmarshal(marker["name"], &result.Name); err != nil || result.Name == "" {
		return Snapshot{}, fmt.Errorf("в plan/project.json отсутствует название проекта")
	}
	result.Problems = pendingJournals(absolute)
	if len(result.Problems) > 0 {
		result.Blocked = true
		return result, nil
	}
	text, err := readLimited(filepath.Join(absolute, "source", "text.md"), 8<<20)
	if err != nil {
		result.Problems = append(result.Problems, fmt.Sprintf("Не удалось прочитать source/text.md: %v", err))
	} else if !utf8.Valid(text) {
		result.Problems = append(result.Problems, "source/text.md содержит некорректный UTF-8.")
	} else {
		result.LyricsText = string(text)
	}
	timing, err := readLimited(filepath.Join(absolute, "plan", "audio", "timing.json"), 16<<20)
	if err != nil && !os.IsNotExist(err) {
		result.Problems = append(result.Problems, fmt.Sprintf("Не удалось прочитать plan/audio/timing.json: %v", err))
	} else if err == nil {
		if validTimingObject(timing) {
			result.Timing = append(json.RawMessage(nil), timing...)
		} else {
			result.Problems = append(result.Problems, "Некорректный формат plan/audio/timing.json: ожидается объект с массивом строк lines.")
		}
	}
	manifest, err := readObject(filepath.Join(absolute, "source", "manifest.json"))
	if err != nil && !os.IsNotExist(err) {
		result.Problems = append(result.Problems, fmt.Sprintf("Не удалось прочитать source/manifest.json: %v", err))
	} else if err == nil {
		var version int
		if json.Unmarshal(manifest["schema_version"], &version) != nil || version != 1 {
			result.Problems = append(result.Problems, "Неизвестный формат source/manifest.json: ожидается schema_version 1.")
		} else {
			var track struct {
				SHA      *string  `json:"sha256"`
				Duration *float64 `json:"duration_seconds"`
			}
			if raw, ok := manifest["track"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
				if json.Unmarshal(raw, &track) != nil {
					result.Problems = append(result.Problems, "Некорректное описание трека в source/manifest.json.")
				} else {
					result.TrackSha256 = track.SHA
					result.Duration = track.Duration
				}
			}
		}
	}
	trackPath := filepath.Join(absolute, "source", "track.mp3")
	info, err := os.Stat(trackPath)
	if err != nil {
		result.Problems = append(result.Problems, fmt.Sprintf("Не удалось открыть source/track.mp3: %v", err))
	} else if !info.Mode().IsRegular() {
		result.Problems = append(result.Problems, "source/track.mp3 не является обычным файлом.")
	} else {
		result.Track = &MediaFile{Path: trackPath, Kind: "audio"}
	}
	return result, nil
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

// validTimingObject проверяет оболочку документа без нормализации ручных границ и неизвестных полей.
// Подробные правила candidates/sections применяет общий валидатор frontend перед отображением.
func validTimingObject(data []byte) bool {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return true
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || object == nil {
		return false
	}
	var lines []map[string]json.RawMessage
	if json.Unmarshal(object["lines"], &lines) != nil || lines == nil {
		return false
	}
	for _, line := range lines {
		if line == nil {
			return false
		}
	}
	return true
}

// pendingJournals замечает прерванную публикацию montage/derived в самой копии проекта.
// Нечитаемый журнал также блокирует просмотр: угадывать целостность или откатывать файлы здесь нельзя.
func pendingJournals(project string) []string {
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
				problems = append(problems, fmt.Sprintf("Не удалось проверить журнал plan/%s/%s/journal.json. Откройте исходный проект в прежнем приложении для проверки восстановления.", kind, entry.Name()))
			} else if state == "publishing" {
				problems = append(problems, fmt.Sprintf("Незавершённая публикация plan/%s/%s: просмотр заблокирован до восстановления в прежнем приложении.", kind, entry.Name()))
			}
		}
	}
	return problems
}
