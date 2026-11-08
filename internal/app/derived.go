package app

import (
	"encoding/json"

	"songframe-go/internal/derivedworkflow"
	"songframe-go/internal/jobs"
	"songframe-go/internal/montage"
	"songframe-go/internal/wire"
)

// DerivedShotService реализует window.api.derivedShots (маршруты derivedShots:* ipc.ts оригинала):
// контекст страницы производного плана, настройки рецепта и запуск заданий сборки и приёмки. Логика
// — в internal/derivedworkflow, работу с файлами выполняет задание derive_shot. Рецепт приходит
// сырым JSON (json.RawMessage, в bindings — any): проверяется по форме, а не по типу Go.
type DerivedShotService struct{ workflow *derivedworkflow.Workflow }

// NewDerivedShotService связывает страницу с менеджером заданий (шаг derive_shot идёт через
// tools.RunContext).
func NewDerivedShotService(manager *jobs.Manager) *DerivedShotService {
	return &DerivedShotService{workflow: derivedworkflow.New(manager)}
}

// View — derivedShots:view: контекст плана без записи в проект.
func (s *DerivedShotService) View(project, shot string) (*derivedworkflow.View, error) {
	return wire.Done(s.workflow.View(project, shot))
}

// Save — derivedShots:save: настройки формы в plan/derived/<план>/draft.json.
func (s *DerivedShotService) Save(project, shot string, recipe json.RawMessage) (*derivedworkflow.View, error) {
	value, err := montage.ParseDraft(recipe)
	if err != nil {
		return nil, err
	}
	return wire.Done(s.workflow.Save(project, shot, value))
}

// Build — derivedShots:build: рецепт новой пробы и задание сборки.
func (s *DerivedShotService) Build(project, shot string, recipe json.RawMessage) (*derivedworkflow.View, error) {
	value, err := montage.ParseDraft(recipe)
	if err != nil {
		return nil, err
	}
	return wire.Done(s.workflow.Build(project, shot, value))
}

// Accept — derivedShots:accept: задание приёмки показанной свежей пробы. replace подтверждает
// замену уже принятого комплекта.
func (s *DerivedShotService) Accept(project, shot, previewID, resultToken string, replace bool) (*derivedworkflow.View, error) {
	return wire.Done(s.workflow.Accept(project, shot, previewID, resultToken, replace))
}
