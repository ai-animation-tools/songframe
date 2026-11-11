package app

import (
	"context"

	"songframe/internal/agents"
	"songframe/internal/productionworkflow"
	"songframe/internal/wire"
)

// ProductionWorkflowService реализует группу window.api.productionWorkflow: проход агента
// производства одного плана — вид панели подготовки, запуск подготовки описания, видеопромпта или
// запроса, отклонение предложения. Состояние — записи предложений в каталоге состояния и задания
// менеджера агентов внутри productionworkflow.Workflow; файлы пакета меняет Apply (под журналом
// замены пакета). Создание следующей опоры и импорт своих опор (generateFrames, importFrames)
// готовят предложение опор; платная опора готовит запрос и вопрос согласования в пакете.
type ProductionWorkflowService struct {
	workflow *productionworkflow.Workflow
	access   *agents.AccessChecker
}

// NewProductionWorkflowService оборачивает проход для Wails; access — проверка доступа к агенту
// и провайдерам (nil — без проверки, только для тестов).
func NewProductionWorkflowService(workflow *productionworkflow.Workflow, access *agents.AccessChecker) *ProductionWorkflowService {
	return &ProductionWorkflowService{workflow: workflow, access: access}
}

// View — productionWorkflow.view: вид плана shot и пакета packageDir ("" — без пакета).
func (s *ProductionWorkflowService) View(project, shot, packageDir string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.View(project, shot, packageDir))
}

// Start — productionWorkflow.start: сначала проверка доступа KindAgent — сохранённый агент,
// найденная программа и вход, затем запуск подготовки.
func (s *ProductionWorkflowService) Start(ctx context.Context, input productionworkflow.StartInput) (productionworkflow.View, error) {
	if s.access != nil {
		project := input.Project
		if err := s.access.RequireAccess(ctx, &project, agents.KindAgent); err != nil {
			return productionworkflow.View{}, err
		}
	}
	return wire.Done(s.workflow.Start(ctx, input))
}

// Apply — productionWorkflow.apply: применение готового актуального предложения к пакету. Доступ
// к агенту здесь не проверяется: ответ уже получен; доступ к провайдеру видео проверяется внутри
// при подготовке запроса.
func (s *ProductionWorkflowService) Apply(ctx context.Context, project, shot, packageDir, id string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.Apply(ctx, project, shot, packageDir, id))
}

// BuildManual — productionWorkflow.buildManual: пакет ручной генерации речевого плана у
// провайдера без липсинка собирается без агента; доступ к ИИ и провайдеру не нужен.
func (s *ProductionWorkflowService) BuildManual(ctx context.Context, project, shot, packageDir string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.BuildManual(ctx, project, shot, packageDir))
}

// Discard — productionWorkflow.discard: отклонение непринятого предложения.
func (s *ProductionWorkflowService) Discard(project, shot, packageDir, id string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.Discard(project, shot, packageDir, id))
}

// GenerateFrames — productionWorkflow.generateFrames: сначала проверка доступа KindImage —
// выбранный провайдер изображений, его программа-агент или вход в платного провайдера, затем
// следующая опора плана. Внутри генерации выбор второй раз не проверяется.
func (s *ProductionWorkflowService) GenerateFrames(ctx context.Context, project, shot, packageDir string) (productionworkflow.View, error) {
	if s.access != nil {
		selected := project
		if err := s.access.RequireAccess(ctx, &selected, agents.KindImage); err != nil {
			return productionworkflow.View{}, err
		}
	}
	return wire.Done(s.workflow.GenerateFrames(ctx, project, shot, packageDir))
}

// ImportFrames — productionWorkflow.importFrames: свои изображения опор; проверку «настоящие
// изображения» выполняет сам проход. Доступ к ИИ не нужен.
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

// Busy сообщает, занят ли план shot (и пакет packageDir) проходом агента.
func (f productionFlow) Busy(project, shot, packageDir string) bool {
	return f.workflow.Busy(project, shot, packageDir)
}

// Proposals — непринятые предложения агента по планам с подписью proposalAttention.
func (f productionFlow) Proposals(project string) map[string]Proposal {
	result := map[string]Proposal{}
	for shot, summary := range f.workflow.PendingProposals(project) {
		result[shot] = Proposal{Value: summary.Value, Attention: summary.Attention}
	}
	return result
}
