package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/project"
	"songframe-go/internal/status"
	"songframe-go/internal/store"
	"songframe-go/internal/wire"
)

// MediaRegistry отдаёт URL только выбранного приложением файла; сервер владеет потоковой выдачей.
// В тестах подменяется без HTTP listener, а регистрация не меняет содержимое файла.
type MediaRegistry interface {
	Register(path string) (string, error)
	AllowRoot(directory string) error
}

// ProjectService реализует группу window.api.projects (Projects оригинала, src/main/projects.ts):
// открытие делает папку текущим проектом и поднимает её в истории каталога состояния,
// статус вычисляется заново из файлов проекта (status.Compute) и нигде не хранится.
// Файлы проекта сервис не пишет. Recovery прерванных публикаций монтажа и производных планов,
// которое оригинал запускает при открытии, перенесётся вместе с этими областями (этапы 44–45).
type ProjectService struct {
	media MediaRegistry
	state *store.LocalState
}

// NewProjectService принимает уже запущенный медиасервер и каталог состояния приложения.
func NewProjectService(media MediaRegistry, localDir string) *ProjectService {
	return &ProjectService{media: media, state: store.NewLocalState(localDir)}
}

// Open — projects.open: только папка с plan/project.json и названием становится текущей.
// Ошибка повторяет текст оригинала с абсолютным путём после resolve.
func (s *ProjectService) Open(path string) (status.ProjectStatus, error) {
	target, err := filepath.Abs(path)
	if err != nil {
		return status.ProjectStatus{}, err
	}
	marker := status.ReadMarker(target)
	if marker == nil {
		return status.ProjectStatus{}, fmt.Errorf("В папке нет plan/project.json с названием проекта: %s", target)
	}
	if _, err := s.state.History(); err != nil {
		return status.ProjectStatus{}, err
	}
	if err := s.state.WriteCurrent(target); err != nil {
		return status.ProjectStatus{}, err
	}
	if err := s.state.Touch(target, marker.Name); err != nil {
		return status.ProjectStatus{}, err
	}
	// Файлы открытого проекта показываются по shell.fileUrl без регистрации каждого кадра.
	if s.media != nil {
		if err := s.media.AllowRoot(target); err != nil {
			return status.ProjectStatus{}, err
		}
	}
	return wire.Done(status.Compute(target))
}

// Status — projects.status: полный read-only статус, включая проверку согласования сценария.
// Ошибка соответствует исключению оригинала на повреждённых данных (например, план без id).
func (s *ProjectService) Status(path string) (status.ProjectStatus, error) {
	return wire.Done(status.Compute(path))
}

// Close снимает текущий проект; история не меняется.
func (s *ProjectService) Close() error { return s.state.ClearCurrent() }

// Forget убирает проект из истории и, если он текущий, снимает выбор.
func (s *ProjectService) Forget(path string) error {
	if err := s.state.Remove(path); err != nil {
		return err
	}
	current, err := s.state.Current()
	if err != nil {
		return err
	}
	if current == path {
		return s.state.ClearCurrent()
	}
	return nil
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
