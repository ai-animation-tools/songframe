package kling

import (
	"context"
	"sort"
	"strings"
	"time"

	"songframe/internal/providers/kling/mcp"
	"songframe/internal/toolregex"
	"songframe/internal/toolrt"
)

// Каталог возможностей: tools/list (какие команды есть у аккаунта) и who_am_i {tools: [...]}
// (объявления моделей, их аргументов, слотов и ограничений). Наружу уходят только объявления
// команд, без полей аккаунта и сырого ответа.

// textBadField — общий текст неверного объявления параметра или слота.
const textBadField = "who_am_i вернул неверное объявление параметров или слотов."

// capabilityFields — объявленные параметры или слоты по имени с
// нормализованными именами полей контракта приложения (allowed, max_items).
func capabilityFields(values any) (*toolrt.Dict, error) {
	list, ok := values.([]any)
	if !ok {
		return nil, valueError(textBadField)
	}
	fields := toolrt.NewDict()
	for _, item := range list {
		value, ok := item.(*toolrt.Dict)
		name, isName := value.Value("name").(string)
		_, isBool := value.Value("required").(bool)
		if !ok || !isName || name == "" || fields.Has(name) || (value.Has("required") && !isBool) {
			return nil, valueError(textBadField)
		}
		entry := toolrt.NewDict()
		for _, key := range []string{"required", "default", "description"} {
			if field, found := value.Get(key); found {
				entry.Set(key, field)
			}
		}
		allowed, found := value.Get("allowedValues")
		if !found {
			allowed = value.Value("allowed_values")
		}
		if allowed != nil {
			items, ok := allowed.([]any)
			for _, element := range items {
				if _, isText := element.(string); !isText {
					ok = false
				}
			}
			if !ok {
				return nil, valueError("who_am_i вернул неверные допустимые значения параметра.")
			}
			entry.Set("allowed", allowed)
		}
		if limit, found := value.Get("maxItems"); found {
			number, ok := limit.(toolrt.Int)
			if !ok || number.Sign() < 1 {
				return nil, valueError("who_am_i вернул неверный лимит параметра или слота.")
			}
			entry.Set("max_items", limit)
		}
		fields.Set(name, entry)
	}
	return fields, nil
}

// catalog — снимок tools/list + who_am_i одного сеанса.
type catalog struct {
	tools map[string]bool
	body  *toolrt.Dict
}

// capabilityCatalog — один снимок аккаунта обслуживает
// все команды (параллельные who_am_i давали случайные частичные ошибки). Нет входа — ValueError
// с текстом входа; прочие сбои клиента — ValueError без сырого ответа.
func (a *Adapter) capabilityCatalog(ctx context.Context, timeout time.Duration, commands []string) (catalog, error) {
	session := a.open(timeout, nil)
	wrap := func(err error) error {
		if mcp.IsAuthRequired(err) {
			return valueError(err.Error() + " Объявления моделей недоступны.")
		}
		if mcp.IsKlingError(err) || toolrt.Is(err, toolrt.OSError) {
			return valueError("Discovery " + mcp.Title + " недоступен: сервер не ответил или ответил ошибкой.")
		}
		return err
	}
	tools, err := session.Tools(ctx)
	if err != nil {
		return catalog{}, wrap(err)
	}
	for _, tool := range tools {
		if _, ok := tool.(*toolrt.Dict); !ok {
			return catalog{}, valueError("tools/list вернул неверное объявление команд.")
		}
	}
	arguments := toolrt.NewDict()
	if len(commands) > 0 {
		names := make([]any, len(commands))
		for index, command := range commands {
			names[index] = command
		}
		arguments.Set("tools", names)
	}
	body, err := session.Call(ctx, "who_am_i", arguments, 0, nil)
	if err != nil {
		return catalog{}, wrap(err)
	}
	values, ok := body.(*toolrt.Dict)
	if !ok {
		return catalog{}, valueError("who_am_i вернул неверный ответ; сырой ответ скрыт.")
	}
	names := map[string]bool{}
	for _, tool := range tools {
		if name, ok := tool.(*toolrt.Dict).Value("name").(string); ok {
			names[name] = true
		}
	}
	return catalog{tools: names, body: values}, nil
}

// commandCapabilities — объявление одной
// команды проверяется отдельно, не теряя остальные корректные модели снимка. model nil — все
// модели, иначе только указанная (необъявленная — ValueError со списком).
func commandCapabilities(command string, model any, snapshot catalog) (*toolrt.Dict, error) {
	if !snapshot.tools[command] {
		return nil, valueError("Команда не объявлена в tool_list текущего аккаунта.")
	}
	available, found := snapshot.body.Get("availableModels")
	if !found {
		available = snapshot.body.Value("available_models")
	}
	declared, ok := available.(*toolrt.Dict)
	if !ok {
		return nil, valueError("who_am_i не вернул объявления моделей.")
	}
	entries, found := declared.Get(command)
	if !found {
		entries = []any{}
	}
	if group, ok := entries.(*toolrt.Dict); ok {
		if entries, found = group.Get("models"); !found {
			entries = []any{}
		}
	}
	list, ok := entries.([]any)
	if !ok {
		return nil, valueError("who_am_i вернул неверное объявление моделей команды.")
	}
	models := toolrt.NewDict()
	for _, item := range list {
		value, ok := item.(*toolrt.Dict)
		name, isName := value.Value("model").(string)
		if !ok || !isName || name == "" || models.Has(name) {
			return nil, valueError("who_am_i вернул неверное объявление модели.")
		}
		limits := toolrt.NewDict()
		for _, pair := range [][2]string{
			{"combinedItemCap", "combined_item_cap"},
			{"combinedItemCaps", "combined_item_caps"},
			{"elementSupport", "element_support"},
		} {
			if field, found := value.Get(pair[0]); found {
				limits.Set(pair[1], field)
			}
		}
		arguments, _ := toolrt.DictGet(value, "arguments", []any{})
		argumentFields, err := capabilityFields(arguments)
		if err != nil {
			return nil, err
		}
		inputs, _ := toolrt.DictGet(value, "inputs", []any{})
		slotFields, err := capabilityFields(inputs)
		if err != nil {
			return nil, err
		}
		entry := toolrt.NewDict()
		entry.Set("arguments", argumentFields)
		entry.Set("slots", slotFields)
		entry.Set("limits", limits)
		models.Set(name, entry)
	}
	if models.Len() == 0 {
		return nil, valueError("who_am_i не объявил модели для этой команды; обновите возможности и проверьте доступность команды.")
	}
	if model != nil {
		has, err := toolrt.Contains(models, model)
		if err != nil {
			return nil, err
		}
		if !has {
			names := models.Keys()
			sort.Strings(names)
			return nil, valueError("Модель не объявлена для этой команды: " + strings.Join(names, ", "))
		}
		name := model.(string)
		only := toolrt.NewDict()
		only.Set(name, models.Value(name))
		models = only
	}
	result := toolrt.NewDict()
	result.Set("command", command)
	result.Set("models", models)
	return result, nil
}

// capabilityReport — отчёт вида медиа по снимку: команды с объявлениями и проблемы отдельных
// команд (только ValueError проверки объявления; прочие ошибки прерывают отчёт).
func capabilityReport(kind string, snapshot catalog) (*toolrt.Dict, error) {
	reports, problems := []any{}, []any{}
	for _, command := range KindCommands[kind] {
		report, err := commandCapabilities(command, nil, snapshot)
		if err != nil {
			if !toolrt.Is(err, toolrt.ValueError) {
				return nil, err
			}
			problem := toolrt.NewDict()
			problem.Set("command", command)
			problem.Set("message", err.Error())
			problems = append(problems, problem)
			continue
		}
		reports = append(reports, report)
	}
	result := toolrt.NewDict()
	result.Set("reports", reports)
	result.Set("problems", problems)
	return result, nil
}

// Capabilities — согласованный каталог команд вида медиа за два
// вызова MCP (tools/list и who_am_i) независимо от числа команд: {"reports": [...],
// "problems": [{command, message}]}. Не загружает опоры и не создаёт генераций. Неизвестный kind —
// KeyError; общий сбой discovery — ValueError без сырого ответа.
func (a *Adapter) Capabilities(ctx context.Context, kind string, timeout time.Duration) (*toolrt.Dict, error) {
	commands, ok := KindCommands[kind]
	if !ok {
		return nil, toolrt.NewKeyError(kind)
	}
	snapshot, err := a.capabilityCatalog(ctx, timeout, commands)
	if err != nil {
		return nil, err
	}
	return capabilityReport(kind, snapshot)
}

// legacySlots — короткие флаги входов и шаблоны объявленных слотов,
// в которые они раскрываются (те же, что inputFlags правил приложения).
var legacySlots = map[string]*toolregex.Regexp{
	"image":     toolregex.MustCompile(`^(?:first_image|image(?:_\d+)?|keyframe_\d+)$`, 0),
	"tailImage": toolregex.MustCompile(`^tail_image(?:_\d+)?$`, 0),
	"audio":     toolregex.MustCompile(`^audio(?:_\d+)?$`, 0),
	"video":     toolregex.MustCompile(`^video(?:_\d+)?$`, 0),
}

// NormalizeInputs раскрывает короткие флаги входов (image, tailImage, audio, video) в
// объявленные слоты модели до фиксации запроса повтора.
// Изменяет spec на месте и возвращает его же; если все входы уже именованные, к сервису не
// обращается. Нет подходящего слота — ValueError с объяснением.
func (a *Adapter) NormalizeInputs(ctx context.Context, spec *toolrt.Dict, timeout time.Duration) (*toolrt.Dict, error) {
	return a.normalizeInputs(spec, func(command string) (catalog, error) {
		return a.capabilityCatalog(ctx, timeout, []string{command})
	})
}

// normalizeInputs — тело NormalizeInputs с источником снимка (тесты эталонов подменяют его).
func (a *Adapter) normalizeInputs(spec *toolrt.Dict, load func(command string) (catalog, error)) (*toolrt.Dict, error) {
	inputs, err := toolrt.GetItem(spec, "inputs")
	if err != nil {
		return nil, err
	}
	items, err := toolrt.Iter(inputs)
	if err != nil {
		return nil, err
	}
	named := true
	for _, item := range items {
		flag, err := toolrt.DictGet(item, "flag", nil)
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(flag, "input") {
			named = false
			break
		}
	}
	if named {
		return spec, nil
	}
	command, err := toolrt.GetItem(spec, "command")
	if err != nil {
		return nil, err
	}
	model, err := toolrt.GetItem(spec, "model")
	if err != nil {
		return nil, err
	}
	commandName, ok := command.(string)
	if !ok {
		return nil, toolrt.Raise(toolrt.TypeError, "unhashable or non-string command %s", toolrt.Repr(command))
	}
	snapshot, err := load(commandName)
	if err != nil {
		return nil, err
	}
	report, err := commandCapabilities(commandName, model, snapshot)
	if err != nil {
		return nil, err
	}
	declared := report.Value("models").(*toolrt.Dict).Value(model.(string)).(*toolrt.Dict).Value("slots").(*toolrt.Dict).Keys()
	used := map[string]bool{}
	for _, item := range items {
		values, err := asDict(item)
		if err != nil {
			return nil, err
		}
		if toolrt.Equal(values.Value("flag"), "input") && toolrt.Truthy(values.Value("slot")) {
			slot, err := toolrt.HashKey(values.Value("slot"))
			if err != nil {
				return nil, err
			}
			used[slot] = true
		}
	}
	for _, item := range items {
		values, err := asDict(item)
		if err != nil {
			return nil, err
		}
		flag := values.Value("flag")
		if toolrt.Equal(flag, "input") {
			continue
		}
		if _, err := toolrt.HashKey(flag); err != nil {
			return nil, err
		}
		name, _ := flag.(string)
		pattern := legacySlots[name]
		slot := ""
		for _, candidate := range declared {
			if pattern == nil {
				break
			}
			if _, ok := pattern.MatchString(candidate); ok && !used["s"+candidate] {
				slot = candidate
				break
			}
		}
		if slot == "" {
			return nil, valueError("Для входа " + toolrt.Str(flag) + " модель " + toolrt.Str(model) +
				" не объявляет подходящего слота; повторите запрос вручную в новой подготовке.")
		}
		used["s"+slot] = true
		values.Set("flag", "input")
		values.Set("slot", slot)
	}
	return spec, nil
}

// asDict — значение как словарь для чтения полей: не словарь — AttributeError.
func asDict(value any) (*toolrt.Dict, error) {
	values, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, toolrt.Raise(toolrt.AttributeError, "'%s' object has no attribute 'get'", toolrt.TypeName(value))
	}
	return values, nil
}
