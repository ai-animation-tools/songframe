package agents

import (
	"context"
	"encoding/json"
	"errors"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/projectfile"
)

// Виды действий ИИ (AiActionKind): текстовый этап агента или генерация медиа своего вида.
const (
	KindAgent = "agent"
	KindImage = mediaproviders.Image
	KindVideo = mediaproviders.Video
)

// ExecutorAccess — AiExecutorAccess: явный выбор исполнителя и подтверждённая доступность.
// Provider nil — исполнитель не выбран. Значения по умолчанию не дают разрешения запуска.
type ExecutorAccess struct {
	Provider  *string `json:"provider"`
	Selected  bool    `json:"selected"`
	Available bool    `json:"available"`
	Message   string  `json:"message"`
}

// Access — AiAccess: агент и провайдеры медиа выбираются независимо: агент нужен только
// текстовым этапам, медиа — собственный провайдер.
type Access struct {
	Agent ExecutorAccess `json:"agent"`
	Image ExecutorAccess `json:"image"`
	Video ExecutorAccess `json:"video"`
}

// ProviderAuth — вход в платного провайдера, проверенный его программой (ProviderAuth оригинала).
type ProviderAuth struct {
	Status  string `json:"status"` // authenticated, unauthenticated или unknown
	Message string `json:"message,omitempty"`
}

// AccessChecker — ai-access оригинала: выбор исполнителей проверяется до диагностики, доступность
// программы и вход подтверждаются отдельно. Состояния не хранит: каждый вызов читает настройки заново.
type AccessChecker struct {
	Settings *SettingsStore
	// Check — диагностика программы-агента; nil — Check адаптера с окружением приложения.
	Check func(ctx context.Context, config Settings) (CheckResult, error)
	// ProviderAuth — вход в платного провайдера (CheckAuth слоя провайдеров). Обязателен, если
	// проверяется доступность выбранного платного провайдера медиа.
	ProviderAuth func(ctx context.Context, provider string) (ProviderAuth, error)
}

// mediaSelectionRequired — aiAccessTexts.main.mediaSelectionRequired.
func mediaSelectionRequired(kind string) string {
	if kind == KindImage {
		return textMediaImageRequired
	}
	return textMediaVideoRequired
}

// blocked — исполнитель не выбран; message объясняет, что сделать.
func blocked(message string) ExecutorAccess { return ExecutorAccess{Message: message} }

// executor возвращает поле Access по виду.
func (a *Access) executor(kind string) *ExecutorAccess {
	switch kind {
	case KindImage:
		return &a.Image
	case KindVideo:
		return &a.Video
	}
	return &a.Agent
}

// generation — блок generation plan/project.json как значение JS (nil — блока нет).
func generation(project string) (any, error) {
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return nil, err
	}
	return jscompat.Parse(settings.Generation)
}

// selection — явный выбор без диагностики: сохранённый агент и провайдеры медиа с
// provider_selected: true. Ошибка чтения настроек или проекта возвращается как есть.
func (c *AccessChecker) selection(project *string) (Access, error) {
	agent, err := c.Settings.Agent()
	if err != nil {
		return Access{}, err
	}
	access := Access{
		Agent: blocked(textAgentRequired),
		Image: blocked(mediaSelectionRequired(KindImage)),
		Video: blocked(mediaSelectionRequired(KindVideo)),
	}
	if agent != nil {
		provider := agent.Provider
		access.Agent = ExecutorAccess{Provider: &provider, Selected: true, Message: textAgentUnchecked}
	}
	if project == nil {
		return access, nil
	}
	value, err := generation(*project)
	if err != nil {
		return Access{}, err
	}
	for _, kind := range []string{KindImage, KindVideo} {
		config := jscompat.Get(value, kind)
		if jscompat.Get(config, "provider_selected") != true {
			continue
		}
		// provider — значение JS: не строка даёт «не поддерживается», как isMediaProvider.
		raw := jscompat.Get(config, "provider")
		var provider *string
		if text, ok := raw.(string); ok {
			provider = &text
		}
		message := textProviderUnsupported
		if mediaproviders.Supports(raw, kind) {
			message = textProviderUnchecked
		}
		*access.executor(kind) = ExecutorAccess{Provider: provider, Selected: true, Message: message}
	}
	return access, nil
}

// AssertSelection — синхронный запрет до подготовки: без явного выбора исполнителя действие не
// создаёт временных файлов и не начинает подготовку из сохранённых значений по умолчанию.
func (c *AccessChecker) AssertSelection(project *string, kind string) error {
	access, err := c.selection(project)
	if err != nil {
		return err
	}
	if executor := access.executor(kind); !executor.Selected {
		return errors.New(executor.Message)
	}
	return nil
}

// availability — доступность и сообщение диагностики.
type availability struct {
	available bool
	message   string
}

// GetAccess — ai.access: выбор и проверенная доступность исполнителей. requiredKind "" проверяет
// все выбранные; иначе только нужный вид. Одинаковая конфигурация агента проверяется один раз.
// Ошибка чтения настроек блокирует всех исполнителей с её текстом.
func (c *AccessChecker) GetAccess(ctx context.Context, project *string, requiredKind string) (Access, error) {
	access, err := c.selection(project)
	if err != nil {
		return Access{Agent: blocked(err.Error()), Image: blocked(err.Error()), Video: blocked(err.Error())}, nil
	}
	diagnose := c.Check
	if diagnose == nil {
		diagnose = func(ctx context.Context, config Settings) (CheckResult, error) {
			return NewAdapter(config.Provider).Check(ctx, config)
		}
	}
	checks := map[Settings]availability{}
	agentAvailability := func(config Settings) (availability, error) {
		if result, ok := checks[config]; ok {
			return result, nil
		}
		result, err := diagnose(ctx, config)
		if err != nil {
			return availability{}, err
		}
		value := availability{available: result.Availability == Available && result.Authorization == Authenticated, message: result.Message}
		checks[config] = value
		return value, nil
	}
	auth := map[string]ProviderAuth{}
	// Провайдер-агент проверяется как программа агента; платный — по входу в его собственную программу.
	mediaAvailability := func(provider string) (availability, error) {
		info, _ := mediaproviders.Lookup(provider)
		if info.Executor != "" {
			config, err := ImageAgent(info.Executor, "")
			if err != nil {
				return availability{}, err
			}
			return agentAvailability(config)
		}
		result, ok := auth[provider]
		if !ok {
			if result, err = c.ProviderAuth(ctx, provider); err != nil {
				return availability{}, err
			}
			auth[provider] = result
		}
		available := result.Status == Authenticated
		message := result.Message
		if message == "" && available {
			message = textLoginConfirmed(info.Title)
		} else if message == "" {
			message = textLoginRequired(info.Title)
		}
		return availability{available: available, message: message}, nil
	}
	agentConfig, err := c.Settings.Agent()
	if err != nil {
		return Access{}, err
	}
	if access.Agent.Selected && agentConfig != nil && (requiredKind == "" || requiredKind == KindAgent) {
		if result, err := agentAvailability(*agentConfig); err != nil {
			access.Agent.Message = err.Error()
		} else {
			access.Agent.Available, access.Agent.Message = result.available, result.message
		}
	}
	for _, kind := range []string{KindImage, KindVideo} {
		executor := access.executor(kind)
		if !executor.Selected || executor.Provider == nil || !mediaproviders.Supports(*executor.Provider, kind) || (requiredKind != "" && requiredKind != kind) {
			continue
		}
		if result, err := mediaAvailability(*executor.Provider); err != nil {
			executor.Message = err.Error()
		} else {
			executor.Available, executor.Message = result.available, result.message
		}
	}
	return access, nil
}

// fingerprint — выбор агента и блок generation: разрешение не переживает их смену во время проверки.
func (c *AccessChecker) fingerprint(project *string) (string, error) {
	agent, err := c.Settings.Agent()
	if err != nil {
		return "", err
	}
	value := struct {
		Agent      *Settings       `json:"agent"`
		Generation json.RawMessage `json:"generation"`
	}{Agent: agent, Generation: json.RawMessage("null")}
	if project != nil {
		settings, err := projectfile.ReadSettings(*project)
		if err != nil {
			return "", err
		}
		value.Generation = settings.Generation
	}
	data, err := json.Marshal(value)
	return string(data), err
}

// RequireAccess — разрешение действия вида kind: явный выбор, диагностика, повторная проверка
// выбора и неизменности настроек, затем причина блокировки. Асинхронная диагностика не сохраняет
// разрешение после отключения или замены исполнителя.
func (c *AccessChecker) RequireAccess(ctx context.Context, project *string, kind string) error {
	if err := c.AssertSelection(project, kind); err != nil {
		return err
	}
	before, err := c.fingerprint(project)
	if err != nil {
		return err
	}
	access, err := c.GetAccess(ctx, project, kind)
	if err != nil {
		return err
	}
	if err := c.AssertSelection(project, kind); err != nil {
		return err
	}
	after, err := c.fingerprint(project)
	if err != nil {
		return err
	}
	if before != after {
		return errors.New(textSettingsChanged)
	}
	if problem := ActionProblem(access, kind); problem != "" {
		return errors.New(problem)
	}
	return nil
}

// ActionProblem — aiActionProblem: причина блокировки действия или "" — можно запускать.
// Текстовые этапы требуют агента; генерация медиа — только своего провайдера.
func ActionProblem(access Access, kind string) string {
	executor := access.executor(kind)
	if executor.Selected && executor.Available {
		return ""
	}
	if executor.Message != "" {
		return executor.Message
	}
	switch kind {
	case KindImage:
		return textAvailableImageRequired
	case KindVideo:
		return textAvailableVideoRequired
	}
	return textAvailableAgentRequired
}
