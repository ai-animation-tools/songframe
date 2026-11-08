package kling

import (
	"fmt"
	"strings"

	"songframe/internal/toolregex"
	"songframe/internal/toolrt"
)

// KindCommands — команды генерации по видам медиа (порядок — порядок каталога возможностей).
var KindCommands = map[string][]string{
	"image": {"text_to_image", "image_to_image"},
	"video": {"text_to_video", "image_to_video", "omni_ref_video", "motion_control"},
}

// commands — COMMANDS: все команды.
var commands = map[string]bool{}

func init() {
	for _, items := range KindCommands {
		for _, command := range items {
			commands[command] = true
		}
	}
}

// reserved — RESERVED: флаги входов и служебные имена, недопустимые среди parameters.
var reserved = map[string]bool{
	"input": true, "image": true, "tailImage": true, "audio": true, "video": true,
	"model": true, "prompt": true, "rationale": true, "taskTraceId": true, "poll": true,
	"base-url": true, "credentials": true, "token": true,
}

// secretWords — подстроки имён, похожих на авторизацию.
var secretWords = []string{"token", "credential", "password", "base_url"}

// explicitResolutionModels — у v4_0 разрешение по умолчанию 720p, что ниже настроек проекта:
// требуется явное значение.
var explicitResolutionModels = map[string]bool{"kling-video-v4_0": true}

// PromptWarningChars — документированный предел промпта API Kling; поведение сервера при
// превышении не проверено, поэтому длинный промпт только предупреждает.
const PromptWarningChars = 2500

var (
	identifierPattern = toolregex.MustCompile(`[A-Za-z0-9_.-]+`, 0)
	parameterPattern  = toolregex.MustCompile(`[A-Za-z][A-Za-z0-9_-]*`, 0)
	slotPattern       = toolregex.MustCompile(`[A-Za-z][A-Za-z0-9_]*`, 0)
)

// fullMatch — совпадение pattern со всей строкой value; не строка — TypeError.
func fullMatch(pattern *toolregex.Regexp, value any) (bool, error) {
	text, ok := value.(string)
	if !ok {
		return false, toolrt.Raise(toolrt.TypeError, "ожидается строка, получено: %s", toolrt.TypeName(value))
	}
	_, matched := pattern.FullMatch(text)
	return matched, nil
}

// valueError — ValueError с данным текстом.
func valueError(message string) error { return toolrt.New(toolrt.ValueError, message) }

// FrozenFields — признак входит в зафиксированный запрос и его SHA, поэтому
// получаются только оригиналы без логотипа.
func (a *Adapter) FrozenFields() *toolrt.Dict {
	fields := toolrt.NewDict()
	fields.Set("video_without_watermark", true)
	return fields
}

// TaskTraceID — true: общий код сохраняет в attempt.json UUID v7 попытки, и он уходит с
// каждым вызовом попытки как taskTraceId.
func (a *Adapter) TaskTraceID() bool { return true }

// ValidateSpec — ограничения Kling поверх общей формы спецификации,
// проверенной request_snapshot. Нарушение — ValueError с текстом для пользователя; данные
// неожиданной формы дают TypeError/KeyError/AttributeError модели toolrt.
func (a *Adapter) ValidateSpec(spec *toolrt.Dict) error {
	command := spec.Value("command")
	if _, err := toolrt.HashKey(command); err != nil {
		return err
	}
	name, ok := command.(string)
	if !ok || !commands[name] {
		return valueError("Неизвестная команда генерации.")
	}
	model, _ := toolrt.DictGet(spec, "model", "")
	if matched, err := fullMatch(identifierPattern, model); err != nil {
		return err
	} else if !matched {
		return valueError("Не указан точный идентификатор модели.")
	}
	expected := "video"
	if strings.HasSuffix(name, "_image") {
		expected = "image"
	}
	kind, err := toolrt.GetItem(spec, "kind")
	if err != nil {
		return err
	}
	if !toolrt.Equal(expected, kind) {
		return valueError("Вид результата не соответствует команде.")
	}
	if spec.Has("model_selection") {
		preferred, err := toolrt.GetItem(spec.Value("model_selection"), "preferredModel")
		if err != nil {
			return err
		}
		if preferred != nil {
			if matched, err := fullMatch(identifierPattern, preferred); err != nil {
				return err
			} else if !matched {
				return valueError("preferredModel должен быть точным идентификатором модели или null.")
			}
		}
	}
	parameters, _ := toolrt.DictGet(spec, "parameters", toolrt.NewDict())
	names, err := toolrt.Iter(parameters)
	if err != nil {
		return err
	}
	for _, item := range names {
		matched, err := fullMatch(parameterPattern, item)
		if err != nil {
			return err
		}
		bad := !matched
		if !bad {
			text := item.(string)
			bad = reserved[text]
			for _, word := range secretWords {
				bad = bad || strings.Contains(strings.ToLower(text), word)
			}
		}
		if bad {
			return valueError("Недопустимый параметр команды; файлы передаются через inputs.")
		}
	}
	if toolrt.Equal(kind, "video") {
		modelName, _ := model.(string)
		hasMultiShot, err := toolrt.Contains(parameters, "prefer_multi_shots")
		if err != nil && multiShotModels[modelName] {
			return err
		}
		if multiShotModels[modelName] && !hasMultiShot {
			return valueError("Для этой модели укажите prefer_multi_shots явно: для единого плана — false.")
		}
		hasResolution, err := toolrt.Contains(parameters, "resolution")
		if err != nil && explicitResolutionModels[modelName] {
			return err
		}
		if explicitResolutionModels[modelName] && !hasResolution {
			return valueError("Для этой модели укажите resolution явно: по умолчанию сервис даёт 720p.")
		}
	}
	count, _ := toolrt.DictGet(spec, "outputs", toolrt.NewInt(1))
	inRange, err := toolrt.LessEqual(toolrt.NewInt(1), count)
	if err != nil {
		return err
	}
	if inRange {
		if inRange, err = toolrt.LessEqual(count, toolrt.NewInt(9)); err != nil {
			return err
		}
	}
	if !inRange {
		return valueError("Неверное число результатов.")
	}
	hasCount, err := toolrt.Contains(parameters, "imageCount")
	if err != nil {
		return err
	}
	if hasCount {
		value, err := toolrt.GetItem(parameters, "imageCount")
		if err != nil {
			return err
		}
		if toolrt.Str(value) != toolrt.Str(count) {
			return valueError("outputs и imageCount должны совпадать.")
		}
	}
	if !strings.HasPrefix(name, "text_to_") && !toolrt.Truthy(spec.Value("inputs")) {
		return valueError("Для этой команды нет входов.")
	}
	inputs, _ := toolrt.DictGet(spec, "inputs", []any{})
	items, err := toolrt.Iter(inputs)
	if err != nil {
		return err
	}
	slots := map[string]bool{}
	for _, item := range items {
		// Сервер принимает только именованные входы; короткие флаги приложение раскрывает в слоты
		// до SHA.
		flag, err := toolrt.DictGet(item, "flag", nil)
		if err != nil {
			return err
		}
		bad := !toolrt.Equal(flag, "input")
		if !bad {
			slot, _ := toolrt.DictGet(item, "slot", "")
			matched, err := fullMatch(slotPattern, slot)
			if err != nil {
				return err
			}
			bad = !matched
		}
		if bad {
			return valueError("Вход должен быть именованным слотом: flag=input и slot из объявления модели.")
		}
		slot := item.(*toolrt.Dict).Value("slot").(string)
		if slots[slot] {
			return valueError("Один входной слот указан дважды.")
		}
		slots[slot] = true
	}
	return nil
}

// ValidatePrompt — промпт уходит отдельным аргументом prompt без
// изменений; длиннее PromptWarningChars символов — только предупреждение.
func (a *Adapter) ValidatePrompt(prompt string) []string {
	length := toolrt.Len(prompt)
	if length > PromptWarningChars {
		return []string{fmt.Sprintf("Промпт длиннее %d символов (%d): сервис может обрезать или ослабить хвост текста.", PromptWarningChars, length)}
	}
	return []string{}
}
