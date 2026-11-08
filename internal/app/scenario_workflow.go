package app

import (
	"songframe-go/internal/scenarioworkflow"
	"songframe-go/internal/wire"
)

// ScenarioWorkflowService реализует группу window.api.scenarioWorkflow: сценарный проход агента
// (трактовка, сцены, доработка), утверждения пары и сцен, применение и отклонение предложения.
// Состояние — локальные записи в каталоге состояния и задания менеджера агентов внутри
// scenarioworkflow.Workflow; файлы проекта меняет только применение через журнал публикаций.
type ScenarioWorkflowService struct{ workflow *scenarioworkflow.Workflow }

// NewScenarioWorkflowService оборачивает сценарный проход для Wails.
func NewScenarioWorkflowService(workflow *scenarioworkflow.Workflow) *ScenarioWorkflowService {
	return &ScenarioWorkflowService{workflow: workflow}
}

// View — scenarioWorkflow.view: доступность действий, проблемы, предложение и задание агента.
func (s *ScenarioWorkflowService) View(project string) (scenarioworkflow.View, error) {
	return wire.Done(s.workflow.View(project))
}

// Start — scenarioWorkflow.start: запуск прохода агентом в режиме предложения.
func (s *ScenarioWorkflowService) Start(input scenarioworkflow.StartInput) (scenarioworkflow.View, error) {
	return wire.Done(s.workflow.Start(input))
}

// Apply — scenarioWorkflow.apply: проверка и публикация готового предложения.
func (s *ScenarioWorkflowService) Apply(project, id string) (scenarioworkflow.View, error) {
	return wire.Done(s.workflow.Apply(project, id))
}

// ApproveCurrent — scenarioWorkflow.approveCurrent: утверждение сохранённых кастинга и трактовки.
func (s *ScenarioWorkflowService) ApproveCurrent(project string) (scenarioworkflow.View, error) {
	return wire.Done(s.workflow.ApproveCurrent(project))
}

// ApproveScenes — scenarioWorkflow.approveScenes: утверждение ручной постановки сцен.
func (s *ScenarioWorkflowService) ApproveScenes(project string) (scenarioworkflow.View, error) {
	return wire.Done(s.workflow.ApproveScenes(project))
}

// Discard — scenarioWorkflow.discard: отклонение ожидающего предложения.
func (s *ScenarioWorkflowService) Discard(project, id string) (scenarioworkflow.View, error) {
	return wire.Done(s.workflow.Discard(project, id))
}
