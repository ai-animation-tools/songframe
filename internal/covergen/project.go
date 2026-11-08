package covergen

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
	"songframe/internal/providers/agentexec"
)

// ProjectOptions — зависимости подготовки запроса провайдером изображений проекта.
type ProjectOptions struct {
	// AssertSelection проверяет явный выбор провайдера изображений в проекте.
	AssertSelection func(project string) error
	// Paid готовит запрос платного провайдера provider (PreparePaid с адаптером слоя провайдеров).
	Paid func(ctx context.Context, input CandidateInput, provider string) (*Candidate, error)
	// Agent — исполнитель провайдера-агента с закреплённой программой и моделью; nil — исполнитель
	// из таблицы адаптеров провайдеров (providers.Agent).
	Agent func(provider string, config agents.Settings) (agentexec.CoverRunner, error)
}

// adapterCover — исполнитель обложки из адаптера провайдера-агента. Текст отсутствия адаптера —
// всегда текст обложки, и для референса тоже.
func adapterCover(provider string, config agents.Settings) (agentexec.CoverRunner, error) {
	adapter, ok := providers.Agent(provider)
	if !ok || adapter.Cover == nil {
		info, _ := mediaproviders.Lookup(provider)
		return nil, errors.New(coverTexts.adapterMissing(info.Title))
	}
	return adapter.Cover(config), nil
}

// PrepareProject — запрос готовит провайдер изображений проекта;
// выбранный текстовый агент на него не влияет. Платный провайдер делегируется options.Paid.
// Провайдер-агент получает программу из реестра медиа и модель проекта (пустая модель — настройки
// самой программы); исполнитель проверяет свой транспорт до выдачи SHA. SHA запроса агента —
// SHA-256 JSON {prompt, config, workDir, references?}: опоры входят в SHA, поэтому подмена их
// копий после подготовки обнаруживается перед запуском.
func PrepareProject(ctx context.Context, input CandidateInput, options ProjectOptions) (*Candidate, error) {
	t := textsFor(input.Purpose == agentexec.PurposeReference)
	if err := options.AssertSelection(input.Project); err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, errors.New(t.preparationStopped)
	}
	settings, err := imageSettings(input.Project)
	if err != nil {
		return nil, err
	}
	provider, _ := dynvalue.Get(settings, "provider").(string)
	if !mediaproviders.Supports(provider, mediaproviders.Image) {
		return nil, errors.New(imageProviderRequired())
	}
	references, err := mediafile.CheckedReferences(input.References)
	if err != nil {
		return nil, err
	}
	frozen := input
	frozen.References = references
	info, _ := mediaproviders.Lookup(provider)
	if info.Executor == "" {
		return options.Paid(ctx, frozen, provider)
	}
	model, err := trimmedModel(settings)
	if err != nil {
		return nil, err
	}
	config, err := agents.ImageAgent(info.Executor, model)
	if err != nil {
		return nil, err
	}
	agent := options.Agent
	if agent == nil {
		agent = adapterCover
	}
	runner, err := agent(provider, config)
	if err != nil {
		return nil, err
	}
	if err := runner.ValidateInput(frozen); err != nil {
		return nil, err
	}
	var configModel *string
	if config.Model != "" {
		value := config.Model
		configModel = &value
	}
	return &Candidate{
		Provider:   provider,
		Model:      configModel,
		RequestSha: agentRequestSha(input.Prompt, config, input.WorkDir, references),
		Generate: func(ctx context.Context, _ bool) (string, error) {
			run := frozen
			if len(references) > 0 {
				checked, err := mediafile.CheckedReferences(references)
				if err != nil {
					return "", err
				}
				run.References = checked
			}
			return runner.Run(ctx, run)
		},
	}, nil
}

// agentRequestSha — SHA-256 JSON {prompt, config, workDir, references?}: ключи в порядке вставки,
// references только при наличии; от байтов зависит сохранённый SHA запроса агента.
func agentRequestSha(prompt string, config agents.Settings, workDir string, references []mediaapi.ReferenceImage) string {
	value := dynvalue.NewObject()
	value.Set("prompt", prompt)
	agent := dynvalue.NewObject()
	agent.Set("provider", config.Provider)
	if config.Model != "" {
		agent.Set("model", config.Model)
	}
	value.Set("config", agent)
	value.Set("workDir", workDir)
	if len(references) > 0 {
		items := make([]any, len(references))
		for index, image := range references {
			item := dynvalue.NewObject()
			item.Set("path", image.Path)
			item.Set("label", image.Label)
			item.Set("sha256", image.SHA256)
			item.Set("bytes", float64(image.Bytes))
			items[index] = item
		}
		value.Set("references", &dynvalue.Array{Items: items})
	}
	sum := sha256.Sum256([]byte(dynvalue.Stringify(value)))
	return hex.EncodeToString(sum[:])
}
