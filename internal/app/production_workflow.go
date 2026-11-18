package app

import (
	"context"
	"songframe/internal/projectgit"

	"songframe/internal/agents"
	"songframe/internal/production"
	"songframe/internal/productionworkflow"
	"songframe/internal/wire"
)

// ProductionWorkflowService реализует группу window.api.productionWorkflow: проход агента
// производства одного плана — вид панели подготовки, запуск подготовки описания или видеопромпта,
// отклонение предложения; запрос видео собирает приложение (prepareRequest). Состояние — записи предложений в каталоге состояния и задания
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
	projectgit.Before(ctx, project, projectgit.OperationProductionApply)
	return wire.Done(s.workflow.Apply(ctx, project, shot, packageDir, id))
}

// PrepareRequest — productionWorkflow.prepareRequest: запрос видео попытки собирает приложение без
// агента (change == nil — следующий шаг после утверждённого промпта, иначе «Изменить» на вопросе
// «Отправить»). Доступ к провайдеру видео проверяется внутри перед чтением объявлений моделей.
func (s *ProductionWorkflowService) PrepareRequest(ctx context.Context, project, shot, packageDir string, change *productionworkflow.RequestChange) (productionworkflow.View, error) {
	return wire.Done(s.workflow.PrepareRequest(ctx, project, shot, packageDir, change))
}

// RequestOptions — productionWorkflow.requestOptions: модели и выбираемые параметры для «Изменить»
// запрос попытки на вопросе «Отправить».
func (s *ProductionWorkflowService) RequestOptions(ctx context.Context, project, shot, packageDir string) (productionworkflow.RequestOptions, error) {
	return wire.Done(s.workflow.RequestOptions(ctx, project, shot, packageDir))
}

// SaveOwn — productionWorkflow.saveOwn: своё описание с планом опор или свой видеопромпт
// применяются без агента; доступ к ИИ и провайдеру не нужен.
func (s *ProductionWorkflowService) SaveOwn(ctx context.Context, input productionworkflow.OwnInput) (productionworkflow.View, error) {
	return wire.Done(s.workflow.SaveOwn(ctx, input))
}

// ReferenceImages — productionWorkflow.referenceImages: изображения, которые может назвать опора
// своего плана опор (разрешённые входы плана).
func (s *ProductionWorkflowService) ReferenceImages(project, shot string) ([]string, error) {
	return wire.Done(s.workflow.ReferenceImages(project, shot))
}

// BuildManual — productionWorkflow.buildManual: пакет ручной генерации речевого плана у
// провайдера без липсинка собирается без агента; доступ к ИИ и провайдеру не нужен.
func (s *ProductionWorkflowService) BuildManual(ctx context.Context, project, shot, packageDir string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.BuildManual(ctx, project, shot, packageDir))
}

// SetGenerationMethod — productionWorkflow.setGenerationMethod: способ генерации видео попытки
// («Провайдер проекта» или «Вручную вне приложения»); доступ к ИИ не нужен.
func (s *ProductionWorkflowService) SetGenerationMethod(project, shot, packageDir, method string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.SetGenerationMethod(project, shot, packageDir, method))
}

// Discard — productionWorkflow.discard: отклонение непринятого предложения.
func (s *ProductionWorkflowService) Discard(project, shot, packageDir, id string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.Discard(project, shot, packageDir, id))
}

// FixScenario — productionWorkflow.fixScenario: исправления из отказа агента записываются в
// состояние плана в сценарии, отказ отклоняется. Агент не запускается; перед записью — точка
// истории проекта, как перед применением изменений плана.
func (s *ProductionWorkflowService) FixScenario(ctx context.Context, project, shot, packageDir, id string) (productionworkflow.View, error) {
	projectgit.Before(ctx, project, projectgit.OperationProductionApply)
	return wire.Done(s.workflow.FixScenario(project, shot, packageDir, id))
}

// RetryWithFrames — productionWorkflow.retryWithFrames: новая попытка плана с описанием, опорами и
// срезом речи выбранной попытки и неутверждённым промптом. Попытки лежат вне Git, поэтому точка
// истории проекта не нужна.
func (s *ProductionWorkflowService) RetryWithFrames(ctx context.Context, project, shot, packageDir string) (productionworkflow.View, error) {
	return wire.Done(s.workflow.RetryWithFrames(ctx, project, shot, packageDir))
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

// CreateOwnVideo — попытка своего видео плана (productionworkflow.Workflow.CreateOwnVideo).
func (f productionFlow) CreateOwnVideo(ctx context.Context, project, shot string, generation production.OwnVideoGeneration) (string, error) {
	return f.workflow.CreateOwnVideo(ctx, project, shot, generation)
}

// Proposals — непринятые предложения агента по планам с подписью proposalAttention.
func (f productionFlow) Proposals(project string) map[string]Proposal {
	result := map[string]Proposal{}
	for shot, summary := range f.workflow.PendingProposals(project) {
		result[shot] = Proposal{Value: summary.Value, Attention: summary.Attention}
	}
	return result
}
