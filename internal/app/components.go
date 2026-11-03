package app

import (
	"context"
	"songframe-go/internal/components"
)

// ComponentsService открывает только известные операции обнаружения нового профиля.
// Конструктор не запускает FFmpeg и не загружает ORT; UI установки появится отдельно.
type ComponentsService struct{ manager *components.Manager }

// NewComponentsService связывает Wails с единым владельцем выбора и отмены проверки.
func NewComponentsService(manager *components.Manager) *ComponentsService {
	return &ComponentsService{manager: manager}
}

// State возвращает лёгкий снимок по функциям без хеширования моделей и нативных вызовов.
func (s *ComponentsService) State() components.Snapshot { return s.manager.State() }

// Configure сохраняет явные пути в новом профиле, без копирования или удаления установки.
func (s *ComponentsService) Configure(selection components.Selection) (components.Snapshot, error) {
	return s.manager.Configure(selection)
}

// Check проверяет только зависимости выбранных ID; контекст Wails отменяет закрытый вызов.
// При ошибке актуальное объяснение доступно через State, частичный успех других функций сохраняется.
func (s *ComponentsService) Check(ctx context.Context, operations []string, force bool) (components.Snapshot, error) {
	return s.manager.Check(ctx, operations, force)
}

// Cancel останавливает текущую проверку, оставляя окно и чтение проектов доступными.
func (s *ComponentsService) Cancel() { s.manager.Cancel() }
