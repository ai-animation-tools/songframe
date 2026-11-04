package app

import (
	"context"
	"encoding/json"

	"songframe-go/internal/referenceimage"
	"songframe-go/internal/sourceedit"
	"songframe-go/internal/wire"
)

// SourcesService реализует группу window.api.sources: просмотр, проверку и сохранение
// исходников проекта (src/main/sources.ts оригинала, логика — internal/sourceedit). Сохранение
// идёт через internal/referenceimage: при существующем plan/cast.json оно синхронизирует кастинг
// (новые виды референсов и проекция описаний, saveSourcesWithCastImages оригинала).
type SourcesService struct {
	// ffprobe возвращает путь найденного ffprobe или "", если FFmpeg не подключён.
	ffprobe func() string
}

// NewSourcesService принимает поиск ffprobe у менеджера компонентов; nil — длительность трека null.
func NewSourcesService(ffprobe func() string) *SourcesService {
	return &SourcesService{ffprobe: ffprobe}
}

// View — sources.view: опись, тексты и пути предпросмотра без записи в проект.
func (s *SourcesService) View(project string) (sourceedit.View, error) {
	return wire.Done(sourceedit.ViewProject(project))
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
