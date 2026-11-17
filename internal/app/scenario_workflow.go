package app

import (
	"context"

	"songframe/internal/projectgit"
	"songframe/internal/scenarioworkflow"
	"songframe/internal/wire"
)

// ScenarioWorkflowService реализует группу window.api.scenarioWorkflow: сценарный проход агента
// (кастинг и части, планы, доработка), утверждения пары и сцен, применение и отклонение предложения.
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
	// Несохранённое состояние проекта уходит в точку Git до публикации сценария (если проект — репозиторий).
	projectgit.Before(context.Background(), project, projectgit.OperationScenarioApply)
	return wire.Done(s.workflow.Apply(project, id))
}

// ApproveCurrent — scenarioWorkflow.approveCurrent: утверждение сохранённых кастинга и частей сценария.
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

// CheckView — scenarioWorkflow.checkView: последняя проверка сценария агентом и доступность новой.
func (s *ScenarioWorkflowService) CheckView(project string) (scenarioworkflow.CheckView, error) {
	return wire.Done(s.workflow.CheckView(project))
}

// StartCheck — scenarioWorkflow.startCheck: запуск проверки сценария агентом; сценарий не меняется.
func (s *ScenarioWorkflowService) StartCheck(project string) (scenarioworkflow.CheckView, error) {
	return wire.Done(s.workflow.StartCheck(project))
}

// CheckFixPreview — scenarioWorkflow.checkFixPreview: правки выбранных проблем проверки и задетые
// ими планы, без записи.
func (s *ScenarioWorkflowService) CheckFixPreview(project string, issues []int) (scenarioworkflow.CheckFixPreview, error) {
	return wire.Done(s.workflow.CheckFixPreview(project, issues))
}

// ApplyCheckFixes — scenarioWorkflow.applyCheckFixes: запись правок проблем проверки в сценарий.
func (s *ScenarioWorkflowService) ApplyCheckFixes(input scenarioworkflow.CheckFixInput) (scenarioworkflow.CheckView, error) {
	// Сценарий до правок уходит в точку Git, как перед публикацией прохода.
	projectgit.Before(context.Background(), input.Project, projectgit.OperationScenarioApply)
	return wire.Done(s.workflow.ApplyCheckFixes(input))
}

// ResolveCheckIssue — scenarioWorkflow.resolveCheckIssue: отметка проблемы проверки «решено вручную».
func (s *ScenarioWorkflowService) ResolveCheckIssue(input scenarioworkflow.CheckResolveInput) (scenarioworkflow.CheckView, error) {
	return wire.Done(s.workflow.ResolveCheckIssue(input))
}
