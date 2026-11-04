package app

import (
	"songframe-go/internal/checks"
	"songframe-go/internal/jobs"
	"songframe-go/internal/wire"
)

// ChecksService реализует перенесённую часть window.api.checks: список проверок и их запуск
// заданиями общего менеджера (internal/checks). Пробы стыков, пересборка представлений и
// проверка «Карточки и списки» переносятся позже и в адаптере renderer числятся недоступными.
type ChecksService struct{ checks *checks.Service }

// NewChecksService связывает проверки с менеджером заданий приложения.
func NewChecksService(manager *jobs.Manager) *ChecksService {
	return &ChecksService{checks: checks.New(manager)}
}

// List — CHECKS оригинала: id, подписи, инструмент и needsScenes каждой проверки.
func (s *ChecksService) List() []checks.Info { return wire.Fill(checks.List()) }

// Run — checks.run(project, id, options): одна проверка заданием с журналом и кодом.
func (s *ChecksService) Run(project string, id checks.ID, options checks.Options) (jobs.Info, error) {
	return wire.Done(s.checks.Run(project, id, options))
}

// RunAll — checks.runAll(project, options): все перенесённые проверки одним заданием без
// остановки на первой ошибке.
func (s *ChecksService) RunAll(project string, options checks.Options) (jobs.Info, error) {
	return wire.Done(s.checks.RunAll(project, options))
}
