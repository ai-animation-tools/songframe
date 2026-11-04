package kling

import (
	"fmt"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
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
	identifierPattern = pyre.MustCompile(`[A-Za-z0-9_.-]+`, 0)
	parameterPattern  = pyre.MustCompile(`[A-Za-z][A-Za-z0-9_-]*`, 0)
	slotPattern       = pyre.MustCompile(`[A-Za-z][A-Za-z0-9_]*`, 0)
)

// fullMatch — re.fullmatch(pattern, value): не строка — TypeError Python 3.12.
func fullMatch(pattern *pyre.Regexp, value any) (bool, error) {
	text, ok := value.(string)
	if !ok {
		return false, pycompat.Raise(pycompat.TypeError, "expected string or bytes-like object, got '%s'", pycompat.TypeName(value))
	}
	_, matched := pattern.FullMatch(text)
	return matched, nil
}

// valueError — ValueError оригинала с данным текстом.
func valueError(message string) error { return pycompat.New(pycompat.ValueError, message) }

// FrozenFields — FROZEN_FIELDS: признак входит в замороженный запрос и его SHA, поэтому
// получаются только оригиналы без логотипа.
func (a *Adapter) FrozenFields() *pycompat.Dict {
	fields := pycompat.NewDict()
	fields.Set("video_without_watermark", true)
	return fields
}

// TaskTraceID — TASK_TRACE_ID: общий код сохраняет в attempt.json UUID v7 попытки, и он уходит с
// каждым вызовом попытки как taskTraceId.
func (a *Adapter) TaskTraceID() bool { return true }

// ValidateSpec — validate_spec(spec): ограничения Kling поверх общей формы спецификации,
// проверенной request_snapshot. Нарушение — ValueError с текстом оригинала; данные неожиданной
// формы дают те же TypeError/KeyError/AttributeError, что Python.
func (a *Adapter) ValidateSpec(spec *pycompat.Dict) error {
	command := spec.Value("command")
	if _, err := pycompat.HashKey(command); err != nil {
		return err
	}
	name, ok := command.(string)
	if !ok || !commands[name] {
		return valueError("Неизвестная команда генерации.")
	}
	model, _ := pycompat.DictGet(spec, "model", "")
	if matched, err := fullMatch(identifierPattern, model); err != nil {
		return err
	} else if !matched {
		return valueError("Не указан точный идентификатор модели.")
	}
	expected := "video"
	if strings.HasSuffix(name, "_image") {
		expected = "image"
	}
	kind, err := pycompat.GetItem(spec, "kind")
	if err != nil {
		return err
	}
	if !pycompat.Equal(expected, kind) {
		return valueError("Вид результата не соответствует команде.")
	}
	if spec.Has("model_selection") {
		preferred, err := pycompat.GetItem(spec.Value("model_selection"), "preferredModel")
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
	parameters, _ := pycompat.DictGet(spec, "parameters", pycompat.NewDict())
	names, err := pycompat.Iter(parameters)
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
	if pycompat.Equal(kind, "video") {
		modelName, _ := model.(string)
		hasMultiShot, err := pycompat.Contains(parameters, "prefer_multi_shots")
		if err != nil && multiShotModels[modelName] {
			return err
		}
		if multiShotModels[modelName] && !hasMultiShot {
			return valueError("Для этой модели укажите prefer_multi_shots явно: для единого плана — false.")
		}
		hasResolution, err := pycompat.Contains(parameters, "resolution")
		if err != nil && explicitResolutionModels[modelName] {
			return err
		}
		if explicitResolutionModels[modelName] && !hasResolution {
			return valueError("Для этой модели укажите resolution явно: по умолчанию сервис даёт 720p.")
		}
	}
	count, _ := pycompat.DictGet(spec, "outputs", pycompat.NewInt(1))
	inRange, err := pycompat.LessEqual(pycompat.NewInt(1), count)
	if err != nil {
		return err
	}
	if inRange {
		if inRange, err = pycompat.LessEqual(count, pycompat.NewInt(9)); err != nil {
			return err
		}
	}
	if !inRange {
		return valueError("Неверное число результатов.")
	}
	hasCount, err := pycompat.Contains(parameters, "imageCount")
	if err != nil {
		return err
	}
	if hasCount {
		value, err := pycompat.GetItem(parameters, "imageCount")
		if err != nil {
			return err
		}
		if pycompat.Str(value) != pycompat.Str(count) {
			return valueError("outputs и imageCount должны совпадать.")
		}
	}
	if !strings.HasPrefix(name, "text_to_") && !pycompat.Truthy(spec.Value("inputs")) {
		return valueError("Для этой команды нет входов.")
	}
	inputs, _ := pycompat.DictGet(spec, "inputs", []any{})
	items, err := pycompat.Iter(inputs)
	if err != nil {
		return err
	}
	slots := map[string]bool{}
	for _, item := range items {
		// Сервер принимает только именованные входы; короткие флаги приложение раскрывает в слоты
		// до SHA.
		flag, err := pycompat.DictGet(item, "flag", nil)
		if err != nil {
			return err
		}
		bad := !pycompat.Equal(flag, "input")
		if !bad {
			slot, _ := pycompat.DictGet(item, "slot", "")
			matched, err := fullMatch(slotPattern, slot)
			if err != nil {
				return err
			}
			bad = !matched
		}
		if bad {
			return valueError("Вход должен быть именованным слотом: flag=input и slot из объявления модели.")
		}
		slot := item.(*pycompat.Dict).Value("slot").(string)
		if slots[slot] {
			return valueError("Один входной слот указан дважды.")
		}
		slots[slot] = true
	}
	return nil
}

// ValidatePrompt — validate_prompt(prompt): промпт уходит отдельным аргументом prompt без
// изменений; длиннее PromptWarningChars символов — только предупреждение.
func (a *Adapter) ValidatePrompt(prompt string) []string {
	length := pycompat.Len(prompt)
	if length > PromptWarningChars {
		return []string{fmt.Sprintf("Промпт длиннее %d символов (%d): сервис может обрезать или ослабить хвост текста.", PromptWarningChars, length)}
	}
	return []string{}
}
