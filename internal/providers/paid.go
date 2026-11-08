package providers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
)

// Тексты общего платного адаптера. TestTextsMatchFrontend сверяет
// постоянные строки со словарём frontend/src/shared/texts/media.ts.
const (
	textJSONObjectRequired     = "Ожидается JSON-объект медиа."
	textSlotRequiresNamed      = "slot допустим только для именованного входа input."
	textModelNotDeclared       = "Модель не объявлена для выбранной команды."
	textInvalidRequest         = "Неверная команда, промпт или число результатов."
	textOutputCountMismatch    = "Число outputs отличается от параметра количества изображений."
	textInvalidNamedInput      = "Неверный именованный вход."
	textLocalInputsRequired    = "Подготовка принимает только локальные входы."
	textInvalidCombinedLimit   = "Общий лимит модели объявлен в неизвестном формате."
	textCombinedLimitExceeded  = "Превышен общий лимит входных материалов модели."
	textExecutorKindMismatch   = "Исполнитель не соответствует виду медиа."
	textRequestShaMissing      = "Подготовка не вернула SHA запроса."
	textExecutorRequestMismach = "Исполнитель не соответствует подготовленному запросу."
	textRequestChanged         = "Подготовленный запрос изменён или относится к другому медиа."
	textRequestInputsDamaged   = "Повреждены входы подготовленного запроса."
	textRequestInputChanged    = "Промпт или вход изменён: требуется новая подготовка."
	textAlreadySubmitted       = "Эта попытка уже отправлялась; продолжите её через resume."
	textOriginalsIncomplete    = "Оригиналы ещё не сохранены полностью."
	textOriginalListDamaged    = "Повреждён список оригиналов."
	textOriginalChanged        = "Сохранённый оригинал изменён."
	textOriginalHashMismatch   = "Хеш оригинала отличается от сохранённого."
	textInvalidImage           = "Результат не является изображением с корректными размерами."
	textImageExtensionMismatch = "Расширение оригинала не соответствует фактическому формату изображения. Исходный файл сохранён."
	textInvalidVideo           = "Результат не является корректным видео MP4."
)

func textInvalidArguments(title string) string {
	return title + " вернул неверное объявление параметров."
}
func textInvalidModels(title string) string {
	return title + " вернул неверное объявление моделей."
}
func textInvalidModel(title string) string {
	return title + " вернул неверное объявление модели."
}
func textPrepareFailed(title string) string {
	return "Не удалось подготовить запрос " + title + "."
}
func textCommandModelsMissing(command string) string {
	return command + ": модели аккаунта не объявлены."
}
func textCapabilitiesUnavailable(title string) string {
	return "Нет подтверждённых возможностей выбранного медиа " + title + "."
}
func textProjectOptionConflict(name, value, expected string) string {
	return "Параметр " + name + "=" + value + " конфликтует с явной настройкой проекта " + expected + "."
}
func textMixedInputs(flags string) string {
	return "Не смешивайте именованные входы с короткими флагами " + flags + "."
}
func textUnknownInputFlag(flag string) string {
	return "Неизвестный флаг входа " + flag + "."
}
func textAmbiguousInputSlot(flag string) string {
	return "Нет однозначного объявленного слота для " + flag + "; укажите именованные input slots."
}
func textUnreadableInitialFrame(path string) string {
	return "Начальный кадр не прочитан как изображение: " + path
}
func textInitialFrameRatioMismatch(width, height int, expected, name string) string {
	return fmt.Sprintf("Начальный кадр %d×%d не совпадает с пропорциями проекта %s (%s); ролик вышел бы другого формата. Используйте опору с пропорциями %s.", width, height, expected, name, expected)
}
func textUndeclaredParameter(name, value string) string {
	return "Параметр " + name + "=" + value + " не объявлен для модели или передаётся отдельно."
}
func textDuplicateParameter(name string) string {
	return "Параметр " + name + " указан дважды."
}
func textOutputCountNotDeclared(outputs int) string {
	return "Модель не объявляет выбор числа результатов outputs=" + strconv.Itoa(outputs) + "."
}
func textProjectParameterMismatch(name, value, expected string) string {
	return "Параметр " + name + "=" + value + " должен совпадать с настройкой проекта " + expected + "."
}
func textInputNotDeclared(name string) string {
	return "Вход " + name + " не объявлен для выбранной команды."
}
func textInputCountExceeded(name string) string {
	return "Превышено число входов " + name + "."
}
func textInputUnavailable(path string) string { return "Вход недоступен: " + path }
func textRequiredSlotMissing(name string) string {
	return "Не заполнен обязательный слот " + name + "."
}
func textRequiredParameterMissing(name string) string {
	return "Не заполнен обязательный параметр " + name + "."
}
func textItemCountExceeded(name string) string {
	return "Превышено число элементов " + name + "."
}
func textUnsupportedParameter(name, value, allowed string) string {
	return "Параметр " + name + " имеет неподдерживаемое значение " + value + "; допустимо: " + allowed + "."
}
func textDurationMismatch(duration, rule string, windowSeconds float64, minSeconds *float64, supported []float64) string {
	text := "Длительность duration=" + duration + " должна быть ближайшей поддерживаемой по правилу " + rule +
		" для окна " + dynvalue.NumberToString(windowSeconds) + " с"
	if minSeconds != nil && *minSeconds != 0 && !math.IsNaN(*minSeconds) {
		text += " и не короче " + dynvalue.NumberToString(*minSeconds) + " с"
	}
	if len(supported) > 0 {
		return text + ": " + dynvalue.NumberToString(slices.Min(supported)) + " с."
	}
	return text + "; подходящие длительности не объявлены."
}
func textCommandModelNotDeclared(id, command string) string {
	return "Модель " + id + " не объявлена для команды " + command + "."
}
func textPreferredModelCompatible(id string) string {
	return "Предпочтительная модель " + id + " поддерживает все параметры запроса."
}
func textPreferredModelRejected(preferred, failure, id string) string {
	return "Предпочтительная модель " + preferred + " не подходит: " + failure + " Выбрана совместимая модель " + id + "."
}
func textAutomaticModelSelected(id string, requested bool) string {
	suffix := ""
	if requested {
		suffix = ", указанная в запросе"
	}
	return "Предпочтительная модель не задана. Выбрана совместимая модель " + id + suffix + "."
}
func textCompatibleModelUnavailable(title, command, details string) string {
	if details == "" {
		details = "Аккаунт не объявляет модели этой команды."
	}
	return "Нет совместимой модели " + title + " для команды " + command + ". " + details
}

// PaidInputItem — вход платного запроса: короткий флаг провайдера (image, tailImage, …) или
// именованный вход flag "input" со слотом. Slot и Role — "", если поля нет.
type PaidInputItem struct {
	Flag string `json:"flag"`
	Slot string `json:"slot,omitempty"`
	Path string `json:"path"`
	Role string `json:"role,omitempty"`
}

// DurationConstraint — правило длительности ролика относительно окна плана. MinSeconds — нижняя
// граница сверх правила окна (речевой план: минимальная длина звукового входа); nil — нет.
type DurationConstraint struct {
	WindowSeconds float64
	// Rule — DurationRule контракта: exact_window, min_supported_not_less_than_window или
	// min_supported_greater_than_window.
	Rule       string
	MinSeconds *float64
}

// ModelSelection — MediaModelSelection контракта: предпочтение, выбранная модель и причина
// выбора. PreferredModel nil — null.
type ModelSelection struct {
	PreferredModel *string `json:"preferredModel"`
	SelectedModel  string  `json:"selectedModel"`
	Reason         string  `json:"reason"`
}

// object — model_selection снимка в порядке ключей, зафиксированном эталонами.
func (s ModelSelection) object() *dynvalue.Object {
	object := dynvalue.NewObject()
	if s.PreferredModel == nil {
		object.Set("preferredModel", nil)
	} else {
		object.Set("preferredModel", *s.PreferredModel)
	}
	object.Set("selectedModel", s.SelectedModel)
	object.Set("reason", s.Reason)
	return object
}

// PaidInput — черновик платного запроса до фиксации SHA. Значения параметров — значения dynvalue
// (internal/dynvalue): от их сравнения и печати зависят тексты ошибок, проверяемые эталонами.
type PaidInput struct {
	Project string
	WorkDir string
	Shot    string
	Kind    string
	Command string
	Model   string
	// PreferredModel — предпочтительная модель проекта: nil — не передана (предпочтением считается
	// Model), пустая строка — null, предпочтения нет. После SelectPaidRequest — выбранное
	// предпочтение ("" — null).
	PreferredModel *string
	// ModelSelection — прежний выбор: его причина сохраняется при том же выборе; nil — нет.
	ModelSelection     *ModelSelection
	DurationConstraint *DurationConstraint
	// RequiredParameters — настройки проекта, которые проверяются для объявленных параметров;
	// неподдерживаемые поля не дописываются в запрос. nil — нет.
	RequiredParameters *dynvalue.Object
	// ProjectOptions — явные options проекта: обязательны, черновик может только повторить их.
	ProjectOptions *dynvalue.Object
	Prompt         string
	Parameters     *dynvalue.Object
	Inputs         []PaidInputItem
	Outputs        int
	FrameID        string
}

// model — объявление модели, разобранное для проверки запроса.
type model struct {
	id, command              string
	arguments, slots, limits *dynvalue.Object
}

// parseModel разбирает mediaapi.Model в значения dynvalue; повреждённое поле — пустой объект.
func parseModel(source mediaapi.Model) model {
	object := func(raw []byte) *dynvalue.Object {
		value, err := dynvalue.Parse(raw)
		if result, ok := value.(*dynvalue.Object); err == nil && ok {
			return result
		}
		return dynvalue.NewObject()
	}
	return model{id: source.ID, command: source.Command, arguments: object(source.Arguments), slots: object(source.Slots), limits: object(source.Limits)}
}

// declared — объявление параметра или слота: Undefined, если его нет.
func declared(declarations *dynvalue.Object, name string) any { return declarations.Value(name) }

var underscoreLetter = regexp.MustCompile(`_([a-z])`)

// camel — snake_case → camelCase: «_» перед строчной латинской буквой заменяется её заглавной.
func camel(name string) string {
	return underscoreLetter.ReplaceAllStringFunc(name, func(match string) string { return strings.ToUpper(match[1:]) })
}

// ArgumentName — объявленное имя параметра и его camelCase-написание
// равнозначны; в снимок попадает точное имя объявления. "" — параметр не объявлен.
func ArgumentName(arguments *dynvalue.Object, supplied string) string {
	if arguments.Has(supplied) {
		return supplied
	}
	wanted := camel(supplied)
	for _, name := range arguments.Keys() {
		if camel(name) == wanted {
			return name
		}
	}
	return ""
}

// parameterName раскрывает эквивалентные имена по конкретной модели и синонимам провайдера, не
// меняя значение требования. "" — имя не объявлено.
func parameterName(rules mediaapi.RequestRules, kind string, item model, supplied string) string {
	if direct := ArgumentName(item.arguments, supplied); direct != "" {
		return direct
	}
	for _, alias := range rules.Aliases[kind] {
		if slices.Contains(alias.Names, supplied) {
			for _, name := range alias.Names {
				if found := ArgumentName(item.arguments, name); found != "" {
					return found
				}
			}
			return ""
		}
	}
	return ""
}

// orName — имя параметра модели или переданное имя, если оно не объявлено.
func orName(name, supplied string) string {
	if name == "" {
		return supplied
	}
	return name
}

// withProjectOptions — явные options проекта обязательны: черновик может только повторить их, но не
// заменить другим значением; отсутствующие дописываются под именем настройки.
func withProjectOptions(rules mediaapi.RequestRules, input PaidInput, item model, parameters *dynvalue.Object) (*dynvalue.Object, error) {
	merged := cloneObject(parameters)
	if input.ProjectOptions == nil {
		return merged, nil
	}
	for _, supplied := range input.ProjectOptions.Keys() {
		expected := input.ProjectOptions.Value(supplied)
		name := orName(parameterName(rules, input.Kind, item, supplied), supplied)
		matched := false
		for _, key := range merged.Keys() {
			if orName(parameterName(rules, input.Kind, item, key), key) != name {
				continue
			}
			matched = true
			if !dynvalue.DeepStrictEqual(merged.Value(key), expected) {
				return nil, errors.New(textProjectOptionConflict(name, dynvalue.JSONText(merged.Value(key)), dynvalue.JSONText(expected)))
			}
		}
		if !matched {
			merged.Set(supplied, expected)
		}
	}
	return merged, nil
}

// cloneObject — поверхностная копия ({...value}); nil — пустой объект.
func cloneObject(value *dynvalue.Object) *dynvalue.Object {
	if value == nil {
		return dynvalue.NewObject()
	}
	return value.Clone()
}

// normalizeInputs раскрывает короткие флаги входов в объявленные слоты до фиксации SHA и показа
// запроса человеку.
func normalizeInputs(rules mediaapi.RequestRules, input PaidInput, item model) ([]PaidInputItem, error) {
	named := slices.ContainsFunc(input.Inputs, func(entry PaidInputItem) bool { return entry.Flag == "input" })
	if named {
		if slices.ContainsFunc(input.Inputs, func(entry PaidInputItem) bool { return entry.Flag != "input" }) {
			flags := make([]string, len(rules.InputFlags))
			for index, flag := range rules.InputFlags {
				flags[index] = flag.Flag
			}
			return nil, errors.New(textMixedInputs(strings.Join(flags, "/")))
		}
		return slices.Clone(input.Inputs), nil
	}
	used := map[string]bool{}
	result := make([]PaidInputItem, 0, len(input.Inputs))
	for _, entry := range input.Inputs {
		if entry.Slot != "" {
			return nil, errors.New(textSlotRequiresNamed)
		}
		var pattern *regexp.Regexp
		for _, flag := range rules.InputFlags {
			if flag.Flag == entry.Flag {
				pattern = flag.Pattern
				break
			}
		}
		if pattern == nil {
			return nil, errors.New(textUnknownInputFlag(entry.Flag))
		}
		candidates := 0
		slot := ""
		for _, name := range item.slots.Keys() {
			if !pattern.MatchString(name) {
				continue
			}
			candidates++
			if slot == "" && !used[name] {
				slot = name
			}
		}
		if slot != "" {
			used[slot] = true
			entry.Flag, entry.Slot = "input", slot
			result = append(result, entry)
			continue
		}
		if candidates > 0 || ArgumentName(item.arguments, entry.Flag) == "" {
			return nil, errors.New(textAmbiguousInputSlot(entry.Flag))
		}
		result = append(result, entry)
	}
	return result, nil
}

var projectRatio = regexp.MustCompile(`^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$`)

// frameMatchesProject — пропорции начального кадра должны совпадать с настройкой проекта «W:H»,
// иначе ролик выйдет другого формата. Настройка не в виде «W:H» не проверяется.
func frameMatchesProject(path, name string, expected any) error {
	text, ok := expected.(string)
	if !ok {
		return nil
	}
	ratio := projectRatio.FindStringSubmatch(dynvalue.Trim(text))
	if ratio == nil {
		return nil
	}
	width, height, ok := mediafile.Dimensions(path)
	if !ok {
		return errors.New(textUnreadableInitialFrame(path))
	}
	left, _ := strconv.ParseFloat(ratio[1], 64)
	right, _ := strconv.ParseFloat(ratio[2], 64)
	wanted := left / right
	if math.Abs(float64(width)/float64(height)-wanted)/wanted > 0.01 {
		return errors.New(textInitialFrameRatioMismatch(width, height, text, name))
	}
	return nil
}

// arrayItems — элементы массива или одно значение как список из одного элемента.
func arrayItems(value any) []any {
	if items, ok := dynvalue.AsArray(value); ok {
		return items
	}
	return []any{value}
}

// stringList — строки массива allowed объявления (проверены при разборе возможностей).
func stringList(value any) ([]string, bool) {
	items, ok := dynvalue.AsArray(value)
	if !ok {
		return nil, false
	}
	result := make([]string, len(items))
	for index, entry := range items {
		result[index] = dynvalue.ToString(entry)
	}
	return result, true
}

// maxItems — declaration.max_items ?? fallback.
func maxItems(declaration any, fallback float64) float64 {
	value := dynvalue.Get(declaration, "max_items")
	if dynvalue.IsNullish(value) {
		return fallback
	}
	return dynvalue.ToNumber(value)
}

// lstatFile — существующий обычный файл без перехода по символической ссылке.
func lstatFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

var remoteInput = regexp.MustCompile(`(?i)^https?:`)

// validatePaid проверяет запрос по снимку возможностей: значения ограничений берутся только из
// переданного снимка, названия моделей не подменяются алиасами.
func validatePaid(rules mediaapi.RequestRules, input PaidInput, caps mediaapi.Capabilities) (*dynvalue.Object, []PaidInputItem, error) {
	index := slices.IndexFunc(caps.Models, func(item mediaapi.Model) bool { return item.Command == input.Command && item.ID == input.Model })
	if index < 0 {
		return nil, nil, errors.New(textModelNotDeclared)
	}
	item := parseModel(caps.Models[index])
	inputs, err := normalizeInputs(rules, input, item)
	if err != nil {
		return nil, nil, err
	}
	if dynvalue.Trim(input.Prompt) == "" || input.Outputs < 1 || input.Outputs > 9 {
		return nil, nil, errors.New(textInvalidRequest)
	}
	parameters := dynvalue.NewObject()
	if input.Parameters != nil {
		for _, supplied := range input.Parameters.Keys() {
			value := input.Parameters.Value(supplied)
			// Синонимы провайдера обозначают одно требование; значение не меняем.
			name := parameterName(rules, input.Kind, item, supplied)
			if name == "" || name == "prompt" || name == "model" {
				return nil, nil, errors.New(textUndeclaredParameter(supplied, dynvalue.JSONText(value)))
			}
			if parameters.Has(name) {
				return nil, nil, errors.New(textDuplicateParameter(name))
			}
			parameters.Set(name, value)
		}
	}
	// Обязательные значения провайдера (например, оригинал без логотипа) не переопределяются
	// старыми options.
	for _, rule := range rules.Enforced {
		for _, rejected := range rule.Rejected {
			if dynvalue.DeepStrictEqual(parameters.Value(rule.Name), rejected) {
				return nil, nil, errors.New(rule.Message)
			}
		}
		if dynvalue.Truthy(declared(item.arguments, rule.Name)) {
			parameters.Set(rule.Name, rule.Value)
		}
	}
	countParameter := ""
	for _, name := range rules.OutputCount {
		if item.arguments.Has(name) {
			countParameter = name
			break
		}
	}
	if countParameter == "" && input.Outputs != 1 {
		return nil, nil, errors.New(textOutputCountNotDeclared(input.Outputs))
	}
	if countParameter != "" && !parameters.Has(countParameter) {
		parameters.Set(countParameter, float64(input.Outputs))
	}
	values := parameters.Clone()
	values.Set("prompt", input.Prompt)
	values.Set("model", input.Model)
	for _, name := range parameters.Keys() {
		if slices.Contains(rules.OutputCount, name) && dynvalue.ToString(parameters.Value(name)) != strconv.Itoa(input.Outputs) {
			return nil, nil, errors.New(textOutputCountMismatch)
		}
	}
	var frame *PaidInputItem
	if rules.FrameDefined != nil {
		for position := range inputs {
			if inputs[position].Flag == "input" && rules.FrameDefined.Slots.MatchString(inputs[position].Slot) {
				frame = &inputs[position]
				break
			}
		}
	}
	if input.RequiredParameters != nil {
		for _, supplied := range input.RequiredParameters.Keys() {
			expected := input.RequiredParameters.Value(supplied)
			name := ArgumentName(item.arguments, supplied)
			// Параметр, который задаёт переданный начальный кадр, можно опустить: тогда с настройкой
			// сверяется сам кадр.
			if name != "" && frame != nil && parameters.Value(name) == dynvalue.Undefined && slices.Contains(rules.FrameDefined.Parameters, name) {
				if err := frameMatchesProject(dynvalue.Resolve(input.Project, frame.Path), name, expected); err != nil {
					return nil, nil, err
				}
				continue
			}
			if name != "" && !dynvalue.StrictEqual(parameters.Value(name), expected) {
				return nil, nil, errors.New(textProjectParameterMismatch(name, dynvalue.JSONText(parameters.Value(name)), dynvalue.JSONText(expected)))
			}
		}
	}
	assigned := map[string]int{}
	for _, entry := range inputs {
		name := entry.Slot
		if entry.Flag != "input" {
			name = ArgumentName(item.arguments, entry.Flag)
		}
		if name == "" || (entry.Flag != "input" && entry.Slot != "") {
			return nil, nil, errors.New(textInvalidNamedInput)
		}
		declarations := item.slots
		if entry.Flag != "input" {
			declarations = item.arguments
		}
		declaration := declared(declarations, name)
		if !dynvalue.Truthy(declaration) {
			return nil, nil, errors.New(textInputNotDeclared(name))
		}
		assigned[name]++
		if float64(assigned[name]) > maxItems(declaration, 1) {
			return nil, nil, errors.New(textInputCountExceeded(name))
		}
		if remoteInput.MatchString(entry.Path) {
			return nil, nil, errors.New(textLocalInputsRequired)
		}
		if !lstatFile(dynvalue.Resolve(input.Project, entry.Path)) {
			return nil, nil, errors.New(textInputUnavailable(entry.Path))
		}
	}
	for _, name := range item.slots.Keys() {
		if dynvalue.Truthy(dynvalue.Get(item.slots.Value(name), "required")) && assigned[name] == 0 {
			return nil, nil, errors.New(textRequiredSlotMissing(name))
		}
	}
	for _, name := range item.arguments.Keys() {
		declaration := item.arguments.Value(name)
		value := values.Value(name)
		if dynvalue.Truthy(dynvalue.Get(declaration, "required")) && value == dynvalue.Undefined && assigned[name] == 0 && dynvalue.Get(declaration, "default") == dynvalue.Undefined {
			return nil, nil, errors.New(textRequiredParameterMissing(name))
		}
		if value == dynvalue.Undefined {
			continue
		}
		items := arrayItems(value)
		if allowed, ok := stringList(dynvalue.Get(declaration, "allowed")); ok {
			for _, entry := range items {
				if !slices.Contains(allowed, dynvalue.ToString(entry)) {
					return nil, nil, errors.New(textUnsupportedParameter(name, dynvalue.JSONText(value), strings.Join(allowed, ", ")))
				}
			}
		}
		if limit := dynvalue.Get(declaration, "max_items"); limit != dynvalue.Undefined && float64(len(items)) > dynvalue.ToNumber(limit) {
			return nil, nil, errors.New(textItemCountExceeded(name))
		}
	}
	if constraint := input.DurationConstraint; constraint != nil {
		var supported []float64
		if allowed, ok := stringList(dynvalue.Get(item.arguments.Value("duration"), "allowed")); ok {
			minimum := 0.0
			if constraint.MinSeconds != nil {
				minimum = *constraint.MinSeconds
			}
			supported = []float64{}
			for _, text := range allowed {
				seconds := dynvalue.ToNumber(text)
				if !dynvalue.IsInteger(seconds) || seconds < minimum {
					continue
				}
				var fits bool
				switch constraint.Rule {
				case "exact_window":
					fits = seconds == constraint.WindowSeconds
				case "min_supported_not_less_than_window":
					fits = seconds >= constraint.WindowSeconds
				default:
					fits = seconds > constraint.WindowSeconds
				}
				if fits {
					supported = append(supported, seconds)
				}
			}
		}
		// Согласованную длительность не уменьшаем ради модели; правило проверяем для каждого кандидата.
		if len(supported) == 0 || dynvalue.ToNumber(parameters.Value("duration")) != slices.Min(supported) {
			return nil, nil, errors.New(textDurationMismatch(dynvalue.JSONText(parameters.Value("duration")), constraint.Rule, constraint.WindowSeconds, constraint.MinSeconds, supported))
		}
	}
	if err := combinedLimit(item.limits.Value("combined_item_cap"), values, assigned); err != nil {
		return nil, nil, err
	}
	return parameters, inputs, nil
}

// combinedLimit проверяет общий лимит входных материалов модели: значения перечисленных
// параметров и файловые входы, подходящие по имени или префиксу (один вход считается один раз).
func combinedLimit(limit any, values *dynvalue.Object, assigned map[string]int) error {
	if limit == dynvalue.Undefined {
		return nil
	}
	maximum := dynvalue.Get(limit, "maxItems")
	if !dynvalue.IsRecord(limit) || !dynvalue.IsInteger(maximum) || dynvalue.ToNumber(maximum) < 1 {
		return errors.New(textInvalidCombinedLimit)
	}
	names, _ := dynvalue.AsArray(dynvalue.Get(limit, "arguments"))
	prefixes, _ := dynvalue.AsArray(dynvalue.Get(limit, "inputPrefixes"))
	argumentNames := map[string]bool{}
	count := 0
	for _, name := range names {
		if text, ok := name.(string); ok {
			argumentNames[text] = true
		}
		value := values.Value(dynvalue.ToString(name))
		switch {
		case value == dynvalue.Undefined:
		case dynvalue.IsArray(value):
			items, _ := dynvalue.AsArray(value)
			count += len(items)
		default:
			count++
		}
	}
	for name, used := range assigned {
		matches := argumentNames[name]
		for _, prefix := range prefixes {
			if text, ok := prefix.(string); ok && strings.HasPrefix(name, text) {
				matches = true
			}
		}
		if matches {
			count += used
		}
	}
	if float64(count) > dynvalue.ToNumber(maximum) {
		return errors.New(textCombinedLimitExceeded)
	}
	return nil
}

// CandidateParameters — параметры черновика для конкретной модели (по умолчанию — input.Parameters).
type CandidateParameters func(model mediaapi.Model) *dynvalue.Object

// CheckedCandidateParameters — CandidateParameters, которые могут отказать для модели (обложка:
// конфликт явного разрешения или включённая серия). Отказ — причина отклонения этой модели в
// тексте «нет совместимой модели».
type CheckedCandidateParameters func(model mediaapi.Model) (*dynvalue.Object, error)

// SelectPaidRequest проверяет весь запрос для каждой модели до
// записи попытки и возвращает нормализованный запрос с выбором модели. Сначала пробуется
// предпочтение, затем модель запроса, затем остальные модели команды в порядке каталога;
// предпочтение не ограничивает совместимый выбор. ModelSelection результата заполнен всегда.
func SelectPaidRequest(paid Paid, input PaidInput, caps mediaapi.Capabilities, candidate CandidateParameters) (PaidInput, error) {
	var checked CheckedCandidateParameters
	if candidate != nil {
		checked = func(model mediaapi.Model) (*dynvalue.Object, error) { return candidate(model), nil }
	}
	return SelectCheckedPaidRequest(paid, input, caps, checked)
}

// SelectCheckedPaidRequest — SelectPaidRequest с параметрами, которые могут отказать для модели.
func SelectCheckedPaidRequest(paid Paid, input PaidInput, caps mediaapi.Capabilities, candidate CheckedCandidateParameters) (PaidInput, error) {
	title := Title(paid.ID, paid.ID)
	if caps.Provider != paid.ID || caps.Kind != input.Kind || !caps.Available {
		return PaidInput{}, errors.New(textCapabilitiesUnavailable(title))
	}
	preferred := input.Model
	if input.PreferredModel != nil {
		preferred = *input.PreferredModel
	}
	preferred = dynvalue.Trim(preferred)
	models := []mediaapi.Model{}
	for _, item := range caps.Models {
		if item.Command == input.Command {
			models = append(models, item)
		}
	}
	ids := []string{}
	for _, id := range append([]string{preferred, dynvalue.Trim(input.Model)}, modelIDs(models)...) {
		if id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	type failure struct{ id, reason string }
	failures := []failure{}
	failed := func(id string) string {
		for _, entry := range failures {
			if entry.id == id {
				return entry.reason
			}
		}
		return "undefined"
	}
	for _, id := range ids {
		position := slices.IndexFunc(models, func(item mediaapi.Model) bool { return item.ID == id })
		result, err := func() (PaidInput, error) {
			if position < 0 {
				return PaidInput{}, errors.New(textCommandModelNotDeclared(id, input.Command))
			}
			parameters := input.Parameters
			if candidate != nil {
				var err error
				if parameters, err = candidate(models[position]); err != nil {
					return PaidInput{}, err
				}
			}
			merged, err := withProjectOptions(paid.Rules, input, parseModel(models[position]), parameters)
			if err != nil {
				return PaidInput{}, err
			}
			next := input
			next.Model, next.Parameters = id, merged
			normalizedParameters, inputs, err := validatePaid(paid.Rules, next, caps)
			if err != nil {
				return PaidInput{}, err
			}
			next.Parameters, next.Inputs = normalizedParameters, inputs
			var reason string
			previous := input.ModelSelection
			switch {
			case previous != nil && previous.SelectedModel == id && optionalEqual(previous.PreferredModel, preferred):
				reason = previous.Reason
			case preferred == id:
				reason = textPreferredModelCompatible(id)
			case preferred != "":
				reason = textPreferredModelRejected(preferred, failed(preferred), id)
			default:
				reason = textAutomaticModelSelected(id, id == input.Model)
			}
			selection := ModelSelection{SelectedModel: id, Reason: reason}
			if preferred != "" {
				selection.PreferredModel = &preferred
			}
			next.PreferredModel = &preferred
			next.ModelSelection = &selection
			return next, nil
		}()
		if err == nil {
			return result, nil
		}
		failures = append(failures, failure{id, err.Error()})
	}
	details := make([]string, len(failures))
	for index, entry := range failures {
		details[index] = entry.id + ": " + entry.reason
	}
	return PaidInput{}, errors.New(textCompatibleModelUnavailable(title, input.Command, strings.Join(details, " ")))
}

// optionalEqual — сравнение preferredModel (nil — null) с вычисленным предпочтением ("" — null).
func optionalEqual(value *string, preferred string) bool {
	if value == nil {
		return preferred == ""
	}
	return *value == preferred && preferred != ""
}

// modelIDs — id моделей в порядке каталога.
func modelIDs(models []mediaapi.Model) []string {
	ids := make([]string, len(models))
	for index, item := range models {
		ids[index] = item.ID
	}
	return ids
}

// PreparedRequest — зафиксированная попытка платного провайдера.
type PreparedRequest struct {
	Provider   string `json:"provider"`
	Kind       string `json:"kind"`
	Project    string `json:"project"`
	RequestDir string `json:"requestDir"`
	RequestSha string `json:"requestSha"`
	FrameID    string `json:"frameId,omitempty"`
}

// Executor — отправка ("submit") или продолжение ("resume") зафиксированной попытки. Его
// предоставляет владелец согласования стоимости и заданий; адаптер не создаёт второй журнал
// отправки.
type Executor func(ctx context.Context, action string, request PreparedRequest) error

// PaidOptions — зависимости общего платного адаптера.
type PaidOptions struct {
	// Catalogs — общий свежий каталог моделей (один на приложение, чтобы одновременные вызовы
	// разных потребителей ждали один запрос). nil — собственный каталог адаптера.
	Catalogs *Catalogs
	// Run — запуск media_request prepare; nil — tools.RunContext.
	Run Runner
	// ValidateImage и ValidateVideo — дополнительная проверка декодированием; nil — без неё.
	ValidateImage func(path string) bool
	ValidateVideo func(path string) bool
	// Now — время проверки возможностей; nil — time.Now.
	Now func() time.Time
}

// PaidMedia — общий платный адаптер одного провайдера и вида медиа.
// Обнаружение и локальная подготовка не разрешают отправку; Submit и Resume делегируют её
// владельцу согласования и используют уже зафиксированный запрос.
type PaidMedia struct {
	Paid    Paid
	Kind    string
	options PaidOptions
}

// NewPaidMedia создаёт платный адаптер провайдера paid для вида медиа kind.
func NewPaidMedia(paid Paid, kind string, options PaidOptions) *PaidMedia {
	if options.Catalogs == nil {
		options.Catalogs = &Catalogs{Run: options.Run}
	}
	return &PaidMedia{Paid: paid, Kind: kind, options: options}
}

// title — название провайдера для текстов.
func (p *PaidMedia) title() string { return Title(p.Paid.ID, p.Paid.ID) }

// argumentsOK проверяет объект объявлений, где required — bool, allowed — массив
// строк, max_items — целое не меньше 1.
func argumentsOK(value any) bool {
	object, ok := value.(*dynvalue.Object)
	if !ok {
		return false
	}
	for _, name := range object.Keys() {
		entry, ok := object.Value(name).(*dynvalue.Object)
		if !ok {
			return false
		}
		if required, has := entry.Get("required"); has {
			if _, isBool := required.(bool); !isBool {
				return false
			}
		}
		if allowed, has := entry.Get("allowed"); has {
			items, isArray := dynvalue.AsArray(allowed)
			if !isArray {
				return false
			}
			for _, item := range items {
				if _, isString := item.(string); !isString {
					return false
				}
			}
		}
		if limit, has := entry.Get("max_items"); has && (!dynvalue.IsInteger(limit) || dynvalue.ToNumber(limit) < 1) {
			return false
		}
	}
	return true
}

// checkedAt — время UTC в формате ISO 8601 с миллисекундами и «Z».
func checkedAt(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000Z") }

// Capabilities — объявления моделей провайдера для вида медиа по свежему каталогу аккаунта.
// Отказ отдельной команды становится проблемой «команда: сообщение»; общий сбой обнаружения не
// выдаётся за отказы каждой команды и заменяет все проблемы одной.
func (p *PaidMedia) Capabilities(ctx context.Context, project string) mediaapi.Capabilities {
	models := []mediaapi.Model{}
	problems := []string{}
	catalog, err := p.options.Catalogs.Read(ctx, project, p.Paid.ID, p.Kind)
	if err != nil {
		models, problems = []mediaapi.Model{}, []string{err.Error()}
	} else {
		for _, problem := range catalog.Problems {
			problems = append(problems, problem.Command+": "+problem.Message)
		}
		for _, report := range catalog.Reports {
			command := report.Command
			commandModels := []mediaapi.Model{}
			var failure string
			for _, id := range report.Models.Keys() {
				value := report.Models.Value(id)
				limits, limitsOK := dynvalue.Get(value, "limits").(*dynvalue.Object)
				if !dynvalue.IsRecord(value) || !limitsOK {
					failure = textInvalidModel(p.title())
					break
				}
				arguments, slots := dynvalue.Get(value, "arguments"), dynvalue.Get(value, "slots")
				if !argumentsOK(arguments) || !argumentsOK(slots) {
					failure = textInvalidArguments(p.title())
					break
				}
				commandModels = append(commandModels, mediaapi.Model{
					ID: id, Command: command, Arguments: dynvalue.Raw(arguments), Slots: dynvalue.Raw(slots), Limits: dynvalue.Raw(limits),
				})
			}
			if failure != "" {
				problems = append(problems, command+": "+failure)
				continue
			}
			models = append(models, commandModels...)
			if len(commandModels) == 0 {
				problems = append(problems, textCommandModelsMissing(command))
			}
		}
	}
	now := time.Now
	if p.options.Now != nil {
		now = p.options.Now
	}
	return mediaapi.Capabilities{
		Provider: p.Paid.ID, Kind: p.Kind, Available: len(models) > 0, CheckedAt: checkedAt(now()),
		Models: models, Problems: problems, GenerationVerified: false,
	}
}

// specInput — вход spec.json в порядке ключей формата с абсолютным путём.
func specInput(project string, item PaidInputItem) *dynvalue.Object {
	object := dynvalue.NewObject()
	object.Set("flag", item.Flag)
	if item.Slot != "" {
		object.Set("slot", item.Slot)
	}
	object.Set("path", dynvalue.Resolve(project, item.Path))
	if item.Role != "" {
		object.Set("role", item.Role)
	}
	return object
}

// Prepare выбирает модель, замораживает запрос во временном spec.json через media_request prepare
// в папке попытки input.WorkDir и проверяет результат. Отправки не происходит.
func (p *PaidMedia) Prepare(ctx context.Context, input PaidInput, caps mediaapi.Capabilities) (PreparedRequest, error) {
	if input.Kind != p.Kind {
		return PreparedRequest{}, errors.New(textExecutorKindMismatch)
	}
	input, err := SelectPaidRequest(p.Paid, input, caps, nil)
	if err != nil {
		return PreparedRequest{}, err
	}
	directory, err := os.MkdirTemp("", "songframe-media-prepare-")
	if err != nil {
		return PreparedRequest{}, err
	}
	defer os.RemoveAll(directory)
	if err := os.WriteFile(filepath.Join(directory, "prompt.txt"), []byte(input.Prompt), 0o666); err != nil {
		return PreparedRequest{}, err
	}
	inputs := make([]any, len(input.Inputs))
	for index, item := range input.Inputs {
		inputs[index] = specInput(input.Project, item)
	}
	spec := dynvalue.NewObject()
	spec.Set("schema_version", float64(1))
	spec.Set("provider", p.Paid.ID)
	spec.Set("shot", input.Shot)
	spec.Set("kind", input.Kind)
	spec.Set("command", input.Command)
	spec.Set("model", input.Model)
	spec.Set("model_selection", input.ModelSelection.object())
	spec.Set("parameters", input.Parameters)
	spec.Set("outputs", float64(input.Outputs))
	spec.Set("inputs", &dynvalue.Array{Items: inputs})
	spec.Set("prompt_file", "prompt.txt")
	specPath := filepath.Join(directory, "spec.json")
	if err := os.WriteFile(specPath, []byte(dynvalue.Stringify(spec)), 0o666); err != nil {
		return PreparedRequest{}, err
	}
	requestDir := dynvalue.Resolve(input.Project, input.WorkDir)
	run := p.options.Run
	if run == nil {
		run = defaultRunner
	}
	result, err := run(ctx, input.Project, "media_request", []string{"prepare", "--request", specPath, "--work-dir", requestDir})
	if err != nil {
		return PreparedRequest{}, err
	}
	if result.Code == nil || *result.Code != 0 {
		if message := dynvalue.Trim(result.Stderr); message != "" {
			return PreparedRequest{}, errors.New(message)
		}
		return PreparedRequest{}, errors.New(textPrepareFailed(p.title()))
	}
	prepared, err := dynvalue.Parse([]byte(result.Stdout))
	if err != nil {
		return PreparedRequest{}, err
	}
	sha, ok := dynvalue.Get(prepared, "request_sha256").(string)
	if !dynvalue.IsRecord(prepared) || !ok || !requestSha.MatchString(sha) {
		return PreparedRequest{}, errors.New(textRequestShaMissing)
	}
	project, err := dynvalue.Realpath(input.Project)
	if err != nil {
		return PreparedRequest{}, err
	}
	reference := PreparedRequest{Provider: p.Paid.ID, Kind: p.Kind, Project: project, RequestDir: requestDir, RequestSha: sha, FrameID: input.FrameID}
	if _, _, err := p.verify(reference); err != nil {
		return PreparedRequest{}, err
	}
	return reference, nil
}

var requestSha = regexp.MustCompile(`^[a-f0-9]{64}$`)

// readObject читает JSON-объект файла попытки.
func readObject(path string) (*dynvalue.Object, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, dynvalue.FsError("open", path, err)
	}
	value, err := dynvalue.Parse(data)
	if err != nil {
		return nil, err
	}
	object, ok := value.(*dynvalue.Object)
	if !ok {
		return nil, errors.New(textJSONObjectRequired)
	}
	return object, nil
}

// fileHash — SHA-256 файла в hex.
func fileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", dynvalue.FsError("open", path, err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// verify сверяет зафиксированную попытку с подготовкой: SHA request.json, вид медиа и хеши промпта и
// входов внутри папки попытки.
func (p *PaidMedia) verify(reference PreparedRequest) (*dynvalue.Object, *dynvalue.Object, error) {
	if reference.Provider != p.Paid.ID || reference.Kind != p.Kind {
		return nil, nil, errors.New(textExecutorRequestMismach)
	}
	requestPath := filepath.Join(reference.RequestDir, "request.json")
	request, err := readObject(requestPath)
	if err != nil {
		return nil, nil, err
	}
	attempt, err := readObject(filepath.Join(reference.RequestDir, "attempt.json"))
	if err != nil {
		return nil, nil, err
	}
	hash, err := fileHash(requestPath)
	if err != nil {
		return nil, nil, err
	}
	if !dynvalue.StrictEqual(request.Value("kind"), p.Kind) || !dynvalue.StrictEqual(attempt.Value("request_sha256"), reference.RequestSha) || hash != reference.RequestSha {
		return nil, nil, errors.New(textRequestChanged)
	}
	inputs, ok := dynvalue.AsArray(request.Value("inputs"))
	if !dynvalue.IsRecord(request.Value("prompt")) || !ok {
		return nil, nil, errors.New(textRequestInputsDamaged)
	}
	for _, item := range append([]any{request.Value("prompt")}, inputs...) {
		path, pathOK := dynvalue.Get(item, "path").(string)
		expected, shaOK := dynvalue.Get(item, "sha256").(string)
		if !dynvalue.IsRecord(item) || !pathOK || !shaOK {
			return nil, nil, errors.New(textRequestInputChanged)
		}
		file, err := mediafile.LocalFile(reference.RequestDir, path)
		if err != nil {
			return nil, nil, err
		}
		actual, err := fileHash(file)
		if err != nil {
			return nil, nil, err
		}
		if actual != expected {
			return nil, nil, errors.New(textRequestInputChanged)
		}
	}
	return request, attempt, nil
}

// execution — ссылка на попытку для владельца заданий.
func (p *PaidMedia) execution(reference PreparedRequest) mediaapi.PaidExecutionRef {
	return mediaapi.PaidExecutionRef{Provider: p.Paid.ID, Kind: p.Kind, RequestDir: reference.RequestDir, RequestSha: reference.RequestSha}
}

// Submit отправляет ещё не отправленную попытку через execute (владельца согласования).
func (p *PaidMedia) Submit(ctx context.Context, reference PreparedRequest, execute Executor) (mediaapi.PaidExecutionRef, error) {
	_, attempt, err := p.verify(reference)
	if err != nil {
		return mediaapi.PaidExecutionRef{}, err
	}
	if !dynvalue.StrictEqual(attempt.Value("status"), "prepared") || dynvalue.Truthy(attempt.Value("generation_id")) {
		return mediaapi.PaidExecutionRef{}, errors.New(textAlreadySubmitted)
	}
	if err := execute(ctx, "submit", reference); err != nil {
		return mediaapi.PaidExecutionRef{}, err
	}
	return p.execution(reference), nil
}

// Resume продолжает отправленную попытку через execute: ожидание и скачивание без новой отправки.
func (p *PaidMedia) Resume(ctx context.Context, reference PreparedRequest, execute Executor) (mediaapi.PaidExecutionRef, error) {
	if _, _, err := p.verify(reference); err != nil {
		return mediaapi.PaidExecutionRef{}, err
	}
	if err := execute(ctx, "resume", reference); err != nil {
		return mediaapi.PaidExecutionRef{}, err
	}
	return p.execution(reference), nil
}

// Collect возвращает сохранённые оригиналы попытки по номерам: каждый — неизменённый локальный
// файл папки попытки нужного формата (изображение с размерами и верным расширением или MP4).
func (p *PaidMedia) Collect(reference PreparedRequest) ([]mediaapi.Artifact, error) {
	request, attempt, err := p.verify(reference)
	if err != nil {
		return nil, err
	}
	downloads, ok := dynvalue.AsArray(attempt.Value("downloads"))
	outputs := dynvalue.ToNumber(request.Value("outputs"))
	if !dynvalue.StrictEqual(attempt.Value("status"), "downloaded") || !ok || !dynvalue.StrictEqual(float64(len(downloads)), request.Value("outputs")) {
		return nil, errors.New(textOriginalsIncomplete)
	}
	seen := map[float64]bool{}
	artifacts := make([]mediaapi.Artifact, 0, len(downloads))
	for _, value := range downloads {
		path, pathOK := dynvalue.Get(value, "path").(string)
		number := dynvalue.Get(value, "number")
		if !dynvalue.IsRecord(value) || !pathOK || !dynvalue.IsInteger(number) || dynvalue.ToNumber(number) < 1 ||
			dynvalue.ToNumber(number) > outputs || seen[dynvalue.ToNumber(number)] {
			return nil, errors.New(textOriginalListDamaged)
		}
		seen[dynvalue.ToNumber(number)] = true
		file, err := mediafile.LocalFile(reference.RequestDir, path)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(file)
		if err != nil {
			return nil, dynvalue.FsError("lstat", file, err)
		}
		if !dynvalue.StrictEqual(float64(info.Size()), dynvalue.Get(value, "bytes")) {
			return nil, errors.New(textOriginalChanged)
		}
		sha, err := fileHash(file)
		if err != nil {
			return nil, err
		}
		if expected, isString := dynvalue.Get(value, "sha256").(string); isString && expected != sha {
			return nil, errors.New(textOriginalHashMismatch)
		}
		artifact := mediaapi.Artifact{Path: file, Index: int(dynvalue.ToNumber(number)), Kind: p.Kind, SHA256: sha, FrameID: reference.FrameID}
		switch p.Kind {
		case "image":
			width, height, ok := mediafile.Dimensions(file)
			if !ok || (p.options.ValidateImage != nil && !p.options.ValidateImage(file)) {
				return nil, errors.New(textInvalidImage)
			}
			if !mediafile.ExtensionMatches(file) {
				return nil, errors.New(textImageExtensionMismatch)
			}
			artifact.Width, artifact.Height = width, height
		case "video":
			if !mp4Header(file) || (p.options.ValidateVideo != nil && !p.options.ValidateVideo(file)) {
				return nil, errors.New(textInvalidVideo)
			}
		}
		artifacts = append(artifacts, artifact)
	}
	slices.SortStableFunc(artifacts, func(a, b mediaapi.Artifact) int { return a.Index - b.Index })
	return artifacts, nil
}

// mp4Header — первые байты файла содержат бокс ftyp (смещение 4..8).
func mp4Header(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	header := make([]byte, 16)
	read, _ := file.Read(header)
	return read >= 12 && string(header[4:8]) == "ftyp"
}
