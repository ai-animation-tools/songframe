package app

import (
	"songframe/internal/promptlog"
	"songframe/internal/wire"
)

// PromptLogService реализует window.api.promptLog страницы «Отправки»: список отправок проекта
// агенту и сервисам генерации и полная запись одной из них. Только чтение журнала
// plan/prompt-log (internal/promptlog); повторной отправки нет.
type PromptLogService struct{}

// NewPromptLogService создаёт сервис журнала отправок.
func NewPromptLogService() *PromptLogService { return &PromptLogService{} }

// List — promptLog:list: отправки проекта от новых к старым, без полных текстов.
func (s *PromptLogService) List(project string) ([]promptlog.Summary, error) {
	return wire.Done(promptlog.List(project))
}

// Get — promptLog:get: полная запись отправки с промптом, контекстом, вложениями и ответом;
// null, если записи нет.
func (s *PromptLogService) Get(project, id string) (*promptlog.Record, error) {
	return wire.Done(promptlog.Get(project, id))
}
