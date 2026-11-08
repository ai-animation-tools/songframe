package app

import (
	"songframe/internal/checks"
	"songframe/internal/jobs"
	"songframe/internal/wire"
)

// ChecksService реализует window.api.checks: список проверок, их запуск, пересборку карточек и
// списков и пробы стыков (сборка build_review заданием, список и удаление собранных проб)
// заданиями общего менеджера (internal/checks).
type ChecksService struct{ checks *checks.Service }

// NewChecksService связывает проверки с менеджером заданий приложения.
func NewChecksService(manager *jobs.Manager) *ChecksService {
	return &ChecksService{checks: checks.New(manager)}
}

// List — перечень проверок: id, подписи, инструмент и needsScenes каждой проверки.
func (s *ChecksService) List() []checks.Info { return wire.Fill(checks.List()) }

// Run — checks.run(project, id, options): одна проверка заданием с журналом и кодом.
func (s *ChecksService) Run(project string, id checks.ID, options checks.Options) (jobs.Info, error) {
	return wire.Done(s.checks.Run(project, id, options))
}

// RunAll — checks.runAll(project, options): все пять проверок одним заданием без остановки на
// первой ошибке.
func (s *ChecksService) RunAll(project string, options checks.Options) (jobs.Info, error) {
	return wire.Done(s.checks.RunAll(project, options))
}

// UpdateViews — checks.updateViews(project): задание «Обновление карточек и списков»
// (update_scene_views без --check).
func (s *ChecksService) UpdateViews(project string) (jobs.Info, error) {
	return wire.Done(s.checks.UpdateViews(project))
}

// BuildReview — checks.buildReview(project, options): задание «Проба …» вида review с шагом
// build_review в новую папку plan/batches/review-<планы>-<время>.
func (s *ChecksService) BuildReview(project string, options checks.ReviewOptions) (jobs.Info, error) {
	return wire.Done(s.checks.BuildReview(project, options))
}

// ListReviews — checks.listReviews(project): собранные пробы plan/batches, новые первыми.
func (s *ChecksService) ListReviews(project string) ([]checks.ReviewInfo, error) {
	return wire.Done(checks.ListReviews(project))
}

// RemoveReview — checks.removeReview(project, path): удалить MP4 найденной пробы и её рецепт.
func (s *ChecksService) RemoveReview(project, path string) error {
	return s.checks.RemoveReview(project, path)
}
