package app

import (
	"context"

	"songframe-go/internal/agents"
	"songframe-go/internal/productionworkflow"
	"songframe-go/internal/wire"
)

// ProductionWorkflowService реализует группу window.api.productionWorkflow: проход агента
// производства одного плана — вид панели подготовки, запуск подготовки описания, видеопромпта или
// запроса, отклонение предложения. Состояние — записи предложений в каталоге состояния и задания
// менеджера агентов внутри productionworkflow.Workflow; файлы проекта проход не меняет. Apply,
// generateFrames и importFrames зарегистрированы, но до этапов 45g.2 и 45g.3 отказывают текстом
// «не перенесено».
type ProductionWorkflowService struct {
	workflow *productionworkflow.Workflow
	access   *agents.AccessChecker
}

// NewProductionWorkflowService оборачивает проход для Wails; access — ai.requireAccess оригинала
// (nil — без проверки, только для тестов).
func NewProductionWorkflowService(workflow *productionworkflow.Workflow, access *agents.AccessChecker) *ProductionWorkflowService {
	return &ProductionWorkflowService{workflow: workflow, access: access}
}

// View — productionWorkflow.view: вид плана shot и пакета packageDir ("" — без пакета).
func (s *ProductionWorkflowService) View(project, shot, packageDir string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.View(project, shot, packageDir))
}

// Start — productionWorkflow.start: как в ipc.ts оригинала, сначала ai.requireAccess(project,
// 'agent') — сохранённый агент, найденная программа и вход, затем запуск подготовки.
func (s *ProductionWorkflowService) Start(ctx context.Context, input productionworkflow.StartInput) (productionworkflow.View, error) {
	if s.access != nil {
		project := input.Project
		if err := s.access.RequireAccess(ctx, &project, agents.KindAgent); err != nil {
			return productionworkflow.View{}, err
		}
	}
	return wire.Done(s.workflow.Start(ctx, input))
}

// Apply — productionWorkflow.apply: применение готового предложения (этап 45g.2).
func (s *ProductionWorkflowService) Apply(project, shot, packageDir, id string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.Apply(project, shot, packageDir, id))
}

// Discard — productionWorkflow.discard: отклонение непринятого предложения.
func (s *ProductionWorkflowService) Discard(project, shot, packageDir, id string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.Discard(project, shot, packageDir, id))
}

// GenerateFrames — productionWorkflow.generateFrames: следующая опора плана (этап 45g.3).
func (s *ProductionWorkflowService) GenerateFrames(ctx context.Context, project, shot, packageDir string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.GenerateFrames(ctx, project, shot, packageDir))
}

// ImportFrames — productionWorkflow.importFrames: свои изображения опор (этап 45g.3).
func (s *ProductionWorkflowService) ImportFrames(project, shot, packageDir string, images []productionworkflow.FrameCandidate) (productionworkflow.View, error) {
	return wire.Done(s.workflow.ImportFrames(project, shot, packageDir, images))
}

// productionFlow — ProductionFlow для маршрутов производства поверх прохода агента: занятость
// плана и непринятые предложения в списке планов.
type productionFlow struct{ workflow *productionworkflow.Workflow }

// NewProductionFlow подключает проход агента производства к ProductionService.
func NewProductionFlow(workflow *productionworkflow.Workflow) ProductionFlow {
	return productionFlow{workflow: workflow}
}

// Busy — view(project, shot, packageDir).busy оригинала.
func (f productionFlow) Busy(project, shot, packageDir string) bool {
	return f.workflow.Busy(project, shot, packageDir)
}

// Proposals — pendingProposals оригинала с подписью proposalAttention.
func (f productionFlow) Proposals(project string) map[string]Proposal {
	result := map[string]Proposal{}
	for shot, summary := range f.workflow.PendingProposals(project) {
		result[shot] = Proposal{Value: summary.Value, Attention: summary.Attention}
	}
	return result
}
