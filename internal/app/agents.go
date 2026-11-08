package app

import (
	"context"

	"github.com/wailsapp/wails/v3/pkg/application"

	"songframe-go/internal/agents"
	"songframe-go/internal/wire"
)

// AgentEvent — имя события Wails для window.api.agents.onEvent (agents:event в Electron).
const AgentEvent = "agents:event"

// AgentsService реализует группу window.api.agents: настройки агента в settings.json каталога
// состояния, диагностику CLI, сведения аккаунта, каталог моделей и задания агента. Менеджер
// заданий принадлежит main: им же пользуются доменные сервисы (предложения сценария, разбор видео).
type AgentsService struct {
	settings *agents.SettingsStore
	manager  *agents.Manager
	access   *agents.AccessChecker
}

// NewAgentsService связывает группу с общими настройками, менеджером и проверкой доступа ИИ.
func NewAgentsService(settings *agents.SettingsStore, manager *agents.Manager, access *agents.AccessChecker) *AgentsService {
	return &AgentsService{settings: settings, manager: manager, access: access}
}

// GetSettings — сохранённый агент или null, если агент не выбран.
func (s *AgentsService) GetSettings() (*agents.Settings, error) { return s.settings.Agent() }

// GetProviderSettings — профиль конкретного CLI: модель другого агента не переносится при смене.
func (s *AgentsService) GetProviderSettings(provider string) (*agents.Settings, error) {
	return s.settings.ProviderAgent(provider)
}

// SaveProviderSettings сохраняет профиль CLI; если он выбран, обновляется и текущий агент.
func (s *AgentsService) SaveProviderSettings(settings agents.Settings) (agents.Settings, error) {
	return s.settings.SaveProviderAgent(&settings)
}

// SaveSettings выбирает агента (null — снимает выбор); остальные поля settings.json сохраняются.
func (s *AgentsService) SaveSettings(settings *agents.Settings) (*agents.Settings, error) {
	return s.settings.SaveAgent(settings)
}

// Check проверяет форму без сохранения, генерации и проверки доступа к модели.
func (s *AgentsService) Check(ctx context.Context, settings agents.Settings) (agents.CheckResult, error) {
	return agents.CheckAgent(ctx, settings, agents.CheckOptions{})
}

// Account — сведения аккаунта и лимиты служебными вызовами CLI, без хода модели.
func (s *AgentsService) Account(ctx context.Context, settings agents.Settings) (agents.AccountResult, error) {
	config, err := agents.Normalize(&settings)
	if err != nil {
		return agents.AccountResult{}, err
	}
	return wire.Done(agents.NewAdapter(config.Provider).Account(ctx, *config))
}

// Models — каталог моделей найденного CLI; пустой список не запрещает ввод модели вручную.
func (s *AgentsService) Models(ctx context.Context, settings agents.Settings) (agents.ModelsResult, error) {
	config, err := agents.Normalize(&settings)
	if err != nil {
		return agents.ModelsResult{}, err
	}
	return wire.Done(agents.ReadModels(ctx, agents.NewAdapter(config.Provider), *config, agents.CheckOptions{}))
}

// Start запускает задание агента после проверки явного выбора и доступности агента, как
// маршрут agents:start оригинала; итог приходит событием agents:event.
func (s *AgentsService) Start(ctx context.Context, input agents.StartInput) (agents.Job, error) {
	project := input.Project
	if err := s.access.RequireAccess(ctx, &project, agents.KindAgent); err != nil {
		return agents.Job{}, err
	}
	return s.manager.Start(input)
}

// Cancel останавливает задание вместе с деревом процессов CLI.
func (s *AgentsService) Cancel(id string) (agents.Job, error) { return s.manager.Cancel(id) }

// Get — снимок задания или null.
func (s *AgentsService) Get(id string) *agents.Job {
	job, ok := s.manager.Get(id)
	if !ok {
		return nil
	}
	return &job
}

// List — задания проекта (null — все), новые первыми.
func (s *AgentsService) List(project *string) []agents.Job {
	filter := ""
	if project != nil {
		filter = *project
	}
	return wire.Fill(s.manager.List(filter))
}

// AIService реализует window.api.ai: явный выбор исполнителей и проверенная доступность.
type AIService struct{ access *agents.AccessChecker }

// NewAIService связывает группу с общей проверкой доступа.
func NewAIService(access *agents.AccessChecker) *AIService { return &AIService{access: access} }

// Access — выбор и доступность агента и провайдеров медиа проекта (null — без проекта).
func (s *AIService) Access(ctx context.Context, project *string) (agents.Access, error) {
	return s.access.GetAccess(ctx, project, "")
}

// ConfigureAgentEvents передаёт события заданий агента в renderer событием Wails; функция не
// экспортируется в bindings. Возвращает отписку.
func ConfigureAgentEvents(manager *agents.Manager, desktop *application.App) func() {
	return manager.OnEvent(func(event agents.Event) { desktop.Event.Emit(AgentEvent, event) })
}
