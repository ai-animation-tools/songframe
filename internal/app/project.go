package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/project"
)

// MediaRegistry отдаёт URL только выбранного приложением файла; сервер владеет потоковой выдачей.
// В тестах подменяется без HTTP listener, а регистрация не меняет содержимое файла.
type MediaRegistry interface {
	Register(path string) (string, error)
}

// ProjectService связывает чтение копии проекта с медиасервером и Wails bindings.
// Сервис не сохраняет JSON, не запускает recovery и не выдаёт неполный производственный статус.
type ProjectService struct{ media MediaRegistry }

// NewProjectService принимает уже запущенный медиасервер; жизненным циклом владеет main.
func NewProjectService(media MediaRegistry) *ProjectService { return &ProjectService{media: media} }

// Open возвращает свежий read-only snapshot; URL трека добавляется только после проверки журналов.
// Недоступность медиа становится проблемой страницы, сохраняя возможность прочитать текст.
func (s *ProjectService) Open(path string) (project.Snapshot, error) {
	snapshot, err := (project.Reader{}).Read(path)
	if err != nil {
		return snapshot, err
	}
	if snapshot.Track != nil {
		media, err := s.Media(snapshot.Track.Path)
		if err != nil {
			snapshot.Problems = append(snapshot.Problems, err.Error())
			snapshot.Track = nil
		} else {
			snapshot.Track = &media
		}
	}
	return snapshot, nil
}

// Media регистрирует выбранный локальный WAV/MP3/MP4/WebM для основного и второго окна.
// Неизвестный формат и отсутствующий файл возвращают объяснение вместо пустого URL плеера.
func (s *ProjectService) Media(path string) (project.MediaFile, error) {
	absolute, err := filepath.Abs(path)
	if err != nil || path == "" {
		return project.MediaFile{}, fmt.Errorf("не задан путь медиа")
	}
	kind := ""
	switch strings.ToLower(filepath.Ext(absolute)) {
	case ".wav", ".mp3":
		kind = "audio"
	case ".mp4", ".webm":
		kind = "video"
	default:
		return project.MediaFile{}, fmt.Errorf("для просмотра выберите WAV, MP3, MP4 или WebM")
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return project.MediaFile{}, fmt.Errorf("медиа недоступно: %w", err)
	}
	if !info.Mode().IsRegular() {
		return project.MediaFile{}, fmt.Errorf("медиа должно быть обычным файлом")
	}
	if s.media == nil {
		return project.MediaFile{}, fmt.Errorf("медиасервер не запущен")
	}
	url, err := s.media.Register(absolute)
	if err != nil {
		return project.MediaFile{}, fmt.Errorf("не удалось открыть медиа: %w", err)
	}
	return project.MediaFile{Path: absolute, URL: url, Kind: kind}, nil
}
