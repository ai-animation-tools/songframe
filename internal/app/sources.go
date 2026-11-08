package app

import (
	"context"
	"encoding/json"

	"songframe/internal/referenceimage"
	"songframe/internal/sourceedit"
	"songframe/internal/wire"
)

// SourcesService реализует группу window.api.sources: просмотр, проверку и сохранение
// исходников проекта (логика — internal/sourceedit). Сохранение идёт через
// internal/referenceimage: при существующем plan/cast.json оно синхронизирует кастинг
// (новые виды референсов и проекция описаний).
type SourcesService struct {
	// ffprobe возвращает путь найденного ffprobe или "", если FFmpeg не подключён.
	ffprobe func() string
}

// NewSourcesService принимает поиск ffprobe у менеджера компонентов; nil — длительность трека null.
func NewSourcesService(ffprobe func() string) *SourcesService {
	return &SourcesService{ffprobe: ffprobe}
}

// View — sources.view: опись, тексты и пути предпросмотра без записи в проект. Закрепление
// референсов производством и типы сущностей кастинга вычисляет internal/referenceimage: им нужны
// реестр, состояние производства и кастинг, которых нет у формы исходников.
func (s *SourcesService) View(project string) (sourceedit.View, error) {
	view, err := sourceedit.ViewProject(project)
	if err != nil {
		return wire.Done(view, err)
	}
	view.PinnedReferences = referenceimage.PinnedReferences(project)
	view.EntityKinds = referenceimage.EntityKinds(project)
	return wire.Done(view, nil)
}

// Validate — sources.validate: список проблем формы без записи.
func (s *SourcesService) Validate(project string, input sourceedit.Input) ([]string, error) {
	return wire.Done(sourceedit.Validate(project, input))
}

// Save — sources.save: копирует файлы формы в source/, записывает опись и согласует с ней кастинг;
// возвращает новую опись.
func (s *SourcesService) Save(project string, input sourceedit.Input) (json.RawMessage, error) {
	probe := ""
	if s.ffprobe != nil {
		probe = s.ffprobe()
	}
	return wire.Done(referenceimage.SaveSources(context.Background(), project, input, sourceedit.DurationProbe(probe)))
}
