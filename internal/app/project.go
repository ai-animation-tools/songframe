package app

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/derivedworkflow"
	"songframe-go/internal/montage"
	"songframe-go/internal/project"
	"songframe-go/internal/scenarioapply"
	"songframe-go/internal/scenarioworkflow"
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
// Запись проекта (создание, переименование, настройки) — в project_edit.go. Сам сервис при открытии
// пишет в проект только при восстановлении прерванной публикации сценария (scenarioapply): открытие
// сначала возвращает файлы к согласованному состоянию, и лишь затем проект становится текущим.
// Прерванные публикации ручного монтажа (internal/montage) и приёмки производного плана
// (internal/derivedworkflow) откатываются там же, до проверки маркера.
type ProjectService struct {
	media    MediaRegistry
	state    *store.LocalState
	scenario scenarioapply.Store
	// template — шаблон нового проекта; nil означает встроенный resources.ProjectTemplate.
	template fs.FS
	// review — проблема актуальности сценария для projects.status (reviewProblem оригинала);
	// nil — только проверка входов status.Compute.
	review func(string) string
}

// ConnectScenarioReview подключает сценарный проход к projects.status: сценарий, требующий
// проверки после правки кастинга, трактовки или исходников, становится проблемой статуса проекта.
// Вызывается один раз при сборке сервисов, до регистрации в Wails. Это функция, а не метод:
// экспортированный метод стал бы частью Wails-сервиса и попал бы в bindings frontend.
func ConnectScenarioReview(s *ProjectService, workflow *scenarioworkflow.Workflow) {
	s.review = func(project string) string { return reviewProblem(workflow, project) }
}

// NewProjectService принимает уже запущенный медиасервер и каталог состояния приложения; журнал
// публикаций сценария лежит в том же каталоге состояния.
func NewProjectService(media MediaRegistry, localDir string) *ProjectService {
	return &ProjectService{media: media, state: store.NewLocalState(localDir), scenario: scenarioapply.NewStore(localDir)}
}

// Open — projects.open: только папка с plan/project.json и названием становится текущей.
// Ошибка повторяет текст оригинала с абсолютным путём после resolve.
func (s *ProjectService) Open(path string) (status.ProjectStatus, error) {
	target, err := filepath.Abs(path)
	if err != nil {
		return status.ProjectStatus{}, err
	}
	// Прерванная публикация ручного монтажа откатывается до проверки маркера, как projects:open
	// оригинала; живое применение этого процесса (apply_montage) не трогается. Ошибка (ручная
	// правка после сбоя, повреждённый резерв) оставляет журнал и не открывает проект.
	if err := montage.RecoverOpened(target); err != nil {
		return status.ProjectStatus{}, err
	}
	// Прерванная приёмка производного плана — то же правило; задание derive_shot этого проекта не
	// откатывается.
	if err := derivedworkflow.RecoverOpened(target); err != nil {
		return status.ProjectStatus{}, err
	}
	marker := status.ReadMarker(target)
	if marker == nil {
		return status.ProjectStatus{}, fmt.Errorf("В папке нет plan/project.json с названием проекта: %s", target)
	}
	// Незавершённая публикация сценария восстанавливается до того, как проект станет текущим.
	// Конфликт или ошибка оставляют журнал (запись запрещена шлюзом) и не открывают проект.
	if err := s.scenario.Recover(target); err != nil {
		return status.ProjectStatus{}, err
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
	if s.review != nil {
		return wire.Done(status.ComputeWith(path, s.review))
	}
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
