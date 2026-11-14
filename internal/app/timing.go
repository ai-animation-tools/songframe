package app

import (
	"context"
	"encoding/json"
	"songframe/internal/projectgit"

	"songframe/internal/components"
	"songframe/internal/dynvalue"
	"songframe/internal/jobs"
	"songframe/internal/songtiming"
	"songframe/internal/timing"
	"songframe/internal/trash"
	"songframe/internal/wire"
)

// TimingService реализует группу window.api.timing: просмотр и сохранение разметки
// (internal/timing) и локальную автоматическую разметку по готовому вокалу
// (internal/songtiming: выделение вокала, CTC-выравнивание, загрузка компонентов).
// Длительные операции идут заданиями общего менеджера; методы сами не ждут их завершения.
type TimingService struct {
	local *songtiming.Service
}

// NewTimingService связывает разметку с менеджером заданий и компонентов. profile — каталог
// состояния приложения (кэш вокала и CTC-вероятностей); после загрузки компонентов сервис
// компонентов перепроверяет их в фоне, чтобы окна получили новое состояние.
func NewTimingService(manager *jobs.Manager, parts *components.Manager, service *ComponentsService, profile string) *TimingService {
	recheck := func() {}
	if service != nil {
		recheck = func() { service.requestCheck() }
	}
	return &TimingService{local: songtiming.New(manager, parts, profile, recheck)}
}

// View возвращает разметку, строки текста и сведения трека без записи в проект.
func (s *TimingService) View(project string) (timing.View, error) {
	return wire.Done(timing.ViewProject(project))
}

// Save — saveTiming: проверка и нормализация разметки (internal/timing), затем атомарная запись
// plan/audio/timing.json через барьер записи проекта. Возвращает сохранённый документ.
func (s *TimingService) Save(project string, input json.RawMessage) (json.RawMessage, error) {
	value, err := dynvalue.Parse(input)
	if err != nil {
		return nil, err
	}
	result, err := timing.SaveProject(project, value)
	if err != nil {
		return nil, err
	}
	return wire.Done(json.RawMessage(timing.Encode(result)), nil)
}

// VocalsView — готовые варианты вокала трека и состояние комплекта выделения.
func (s *TimingService) VocalsView(project string) songtiming.VocalPreparationView {
	return wire.Fill(s.local.VocalsView(project))
}

// DownloadVocalModel запускает загрузку недостающих компонентов выделения вокала.
func (s *TimingService) DownloadVocalModel(model string) (jobs.Info, error) {
	return wire.Done(s.local.DownloadVocalModel(model))
}

// SeparateVocals запускает выделение вокала в кэш вне проекта.
func (s *TimingService) SeparateVocals(project, model string) (jobs.Info, error) {
	return wire.Done(s.local.SeparateVocals(project, model))
}

// SelectVocal делает вариант вокала выбранным для разметки.
func (s *TimingService) SelectVocal(project, id string) (songtiming.VocalPreparationView, error) {
	return wire.Done(s.local.SelectVocal(project, id))
}

// DeleteVocal перемещает вариант вокала в корзину ОС.
func (s *TimingService) DeleteVocal(project, id string) (songtiming.VocalPreparationView, error) {
	return wire.Done(s.local.DeleteVocal(project, id, trash.Move))
}

// SongModelSetup — готовность комплекта уточнения границ.
func (s *TimingService) SongModelSetup() songtiming.SongModelSetup {
	return s.local.SongModelSetup()
}

// DownloadSongModels запускает загрузку недостающих компонентов уточнения границ.
func (s *TimingService) DownloadSongModels() (jobs.Info, error) {
	return wire.Done(s.local.DownloadSongModels())
}

// Start запускает разметку по выбранному вокалу.
func (s *TimingService) Start(project string, options songtiming.GenerateOptions) (jobs.Info, error) {
	projectgit.Before(context.Background(), project, projectgit.OperationTimingAlign)
	return wire.Done(s.local.Start(project, options))
}

// Cancel останавливает задание разметки, выделения или загрузки.
func (s *TimingService) Cancel(jobID string) (jobs.Info, error) {
	return wire.Done(s.local.Cancel(jobID))
}
