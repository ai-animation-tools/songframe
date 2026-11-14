package app

import (
	"context"

	"songframe/internal/projectgit"
	"songframe/internal/wire"
)

// historyLimit — сколько последних точек показывает страница «Проект»: история длиннее
// просматривается обычными средствами Git.
const historyLimit = 30

// ProjectHistoryService реализует window.api.projectHistory блока истории на странице «Проект»:
// точки сохранения проекта в Git (internal/projectgit). Без Git или вне корня репозитория
// status сообщает недоступность, и блок не показывается. Автоматические точки перед крупными
// операциями вызывают сами сервисы этих операций; checkpoint нужен операциям, которые
// выполняет frontend (пересчёт границ планов).
type ProjectHistoryService struct{}

// NewProjectHistoryService создаёт сервис истории проекта.
func NewProjectHistoryService() *ProjectHistoryService { return &ProjectHistoryService{} }

// Status — projectHistory.status: несохранённые изменения по разделам и последняя точка.
func (s *ProjectHistoryService) Status(ctx context.Context, project string) (projectgit.Status, error) {
	return wire.Done(projectgit.GetStatus(ctx, project))
}

// Save — projectHistory.save: «Сохранить точку» с подписью пользователя.
func (s *ProjectHistoryService) Save(ctx context.Context, project, message string) (projectgit.Status, error) {
	return wire.Done(projectgit.Save(ctx, project, message))
}

// Checkpoint — projectHistory.checkpoint: автоматическая точка перед операцией frontend.
// Ошибка Git не возвращается (операция пользователя продолжается), а показывается в статусе.
func (s *ProjectHistoryService) Checkpoint(ctx context.Context, project string, operation projectgit.Operation) error {
	projectgit.Before(ctx, project, operation)
	return nil
}

// Points — projectHistory.points: последние точки от новых к старым.
func (s *ProjectHistoryService) Points(ctx context.Context, project string) ([]projectgit.Point, error) {
	return wire.Done(projectgit.History(ctx, project, historyLimit))
}

// Restore — projectHistory.restore: возврат файлов-источников раздела к точке.
func (s *ProjectHistoryService) Restore(ctx context.Context, project, point string, section projectgit.Section) (projectgit.RestoreResult, error) {
	return wire.Done(projectgit.Restore(ctx, project, point, section))
}

// CompareScenario — projectHistory.compareScenario: чем сценарий точки отличается от текущего.
func (s *ProjectHistoryService) CompareScenario(ctx context.Context, project, point string) (projectgit.ScenarioComparison, error) {
	return wire.Done(projectgit.CompareScenario(ctx, project, point))
}
