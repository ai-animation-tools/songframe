package agents

import (
	"context"
	"errors"

	"songframe/internal/dynvalue"
)

// Model — AgentModel: id передаётся в --model, подпись показывается в настройках.
type Model struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	IsDefault   bool   `json:"isDefault,omitempty"`
}

// ModelsResult — AgentModelsResult: пустой список с сообщением означает, что каталог недоступен
// и модель можно ввести вручную.
type ModelsResult struct {
	Models  []Model `json:"models"`
	Message string  `json:"message,omitempty"`
}

// ReadModels — каталог моделей выбранного CLI для настроек. Сначала обычная проверка программы;
// недоступный или пустой каталог не мешает ввести модель вручную, текст ошибки CLI не показывается.
// Версии и модели агента не связаны с каталогами провайдеров медиа.
func ReadModels(ctx context.Context, adapter Adapter, config Settings, options CheckOptions) (ModelsResult, error) {
	check, err := adapter.Check(ctx, config)
	if err != nil {
		return ModelsResult{}, err
	}
	if check.Availability != Available || check.ExecutablePath == "" {
		return ModelsResult{Models: []Model{}, Message: check.Message}, nil
	}
	options = options.resolve()
	process := options.process()
	models, err := adapter.Models(ctx, check.ExecutablePath, process)
	title := Title(config.Provider)
	switch {
	case err != nil:
		return ModelsResult{Models: []Model{}, Message: textModelsUnavailable(title)}, nil
	case len(models) == 0:
		return ModelsResult{Models: []Model{}, Message: textModelsEmpty(title)}, nil
	}
	return ModelsResult{Models: models}, nil
}

// readClaudeModels — список моделей из ответа initialize control protocol (как supportedModels()
// Agent SDK; формат экспериментальный). Псевдоним default означает выбор самого CLI и совпадает
// с пустым полем, поэтому не показывается.
func readClaudeModels(ctx context.Context, executable string, options ProcessOptions) ([]Model, error) {
	initialize := dynvalue.NewObject()
	initialize.Set("subtype", "initialize")
	responses, err := claudeControl(ctx, executable, options, []*dynvalue.Object{initialize})
	if err != nil {
		return nil, err
	}
	rows, ok := dynvalue.AsArray(dynvalue.Get(responses[0], "models"))
	if !ok {
		return nil, errors.New("Claude не вернул список моделей.")
	}
	if len(rows) > 100 {
		rows = rows[:100]
	}
	models := []Model{}
	for _, raw := range rows {
		row, ok := raw.(*dynvalue.Object)
		if !ok {
			continue
		}
		id := ""
		if value, ok := row.Value("value").(string); ok {
			id = dynvalue.Trim(value)
		}
		if id == "" || id == "default" || utf16Len(id) > 128 || spaces.MatchString(id) {
			continue
		}
		model := Model{ID: id, Label: id}
		if label, ok := row.Value("displayName").(string); ok && dynvalue.Trim(label) != "" {
			model.Label = utf16Slice(dynvalue.Trim(label), 128)
		}
		if description, ok := row.Value("description").(string); ok && dynvalue.Trim(description) != "" {
			model.Description = utf16Slice(dynvalue.Trim(description), 200)
		}
		models = append(models, model)
	}
	return models, nil
}

// CodexModel — объявление каталога model/list: точное имя для --model, подпись и признак
// модели по умолчанию. Каталог не подтверждает наличие инструмента изображений.
type CodexModel struct {
	Model       string
	DisplayName string
	IsDefault   bool
}

// CodexModels читает все страницы видимых моделей Codex штатным model/list app-server. Он нужен
// и текстовому агенту (настройки), и провайдеру изображений, который исполняет Codex.
func CodexModels(ctx context.Context, executable string, options ProcessOptions) ([]CodexModel, error) {
	return codexRPC(ctx, executable, options, func(request func(string, *dynvalue.Object) (any, error)) ([]CodexModel, error) {
		order := []string{}
		models := map[string]CodexModel{}
		cursors := map[string]bool{}
		cursor := ""
		for {
			params := dynvalue.NewObject()
			params.Set("limit", float64(100))
			params.Set("includeHidden", false)
			if cursor != "" {
				params.Set("cursor", cursor)
			}
			value, err := request("model/list", params)
			if err != nil {
				return nil, err
			}
			result, ok := value.(*dynvalue.Object)
			next := dynvalue.Undefined
			var data []any
			if ok {
				next = result.Value("nextCursor")
				data, ok = dynvalue.AsArray(result.Value("data"))
			}
			if _, isString := next.(string); !ok || !(dynvalue.IsNullish(next) || isString) {
				return nil, errors.New("Codex вернул неизвестный формат каталога моделей.")
			}
			for _, raw := range data {
				item, isObject := raw.(*dynvalue.Object)
				name, isString := dynvalue.Get(raw, "model").(string)
				if !isObject || !isString || dynvalue.Trim(name) == "" {
					return nil, errors.New("Codex вернул модель без точного имени.")
				}
				if item.Value("hidden") == true {
					continue
				}
				// В exec передаётся именно model из объявления; displayName не идентификатор CLI.
				model := CodexModel{Model: name, IsDefault: item.Value("isDefault") == true}
				if label, ok := item.Value("displayName").(string); ok && dynvalue.Trim(label) != "" {
					model.DisplayName = utf16Slice(dynvalue.Trim(label), 128)
				}
				if _, seen := models[name]; !seen {
					order = append(order, name)
				}
				models[name] = model
			}
			cursor, _ = next.(string)
			if cursor == "" {
				break
			}
			if cursors[cursor] {
				return nil, errors.New("Codex повторил страницу каталога моделей.")
			}
			cursors[cursor] = true
		}
		result := make([]CodexModel, len(order))
		for index, name := range order {
			result[index] = models[name]
		}
		return result, nil
	})
}

// readCodexAgentModels — модели текстового агента Codex для выбора в настройках.
func readCodexAgentModels(ctx context.Context, executable string, options ProcessOptions) ([]Model, error) {
	rows, err := CodexModels(ctx, executable, options)
	if err != nil {
		return nil, err
	}
	models := make([]Model, len(rows))
	for index, row := range rows {
		label := row.DisplayName
		if label == "" {
			label = row.Model
		}
		models[index] = Model{ID: row.Model, Label: label, IsDefault: row.IsDefault}
	}
	return models, nil
}

// textCodexImageModelsOnly — каталог моделей изображений запрошен не у агента Codex.
const textCodexImageModelsOnly = "Каталог моделей доступен только для агента Codex."

// CodexImageModels — каталог моделей программы-агента провайдера
// изображений, которого исполняет Codex. Вызывается штатный model/list найденной в PATH программы
// с окружением агента; каталог не подтверждает наличие инструмента изображений.
func CodexImageModels(ctx context.Context, config Settings, options CheckOptions) ([]CodexModel, error) {
	if config.Provider != Codex {
		return nil, errors.New(textCodexImageModelsOnly)
	}
	options = options.resolve()
	return CodexModels(ctx, Providers[Codex].Executable, options.process())
}
