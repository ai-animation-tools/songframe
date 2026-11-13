// Package costcheck оценивает стоимость запроса генерации и сверяет её с остатком кредитов до
// таблицы согласования (check), а после отправки записывает фактический расход наблюдением
// (learn); это инструмент cost_check.
//
// Генерацию пакет не отправляет; единственное обращение к сервису — информационный остаток через
// Account адаптера провайдера запроса. Базовая таблица цен — PricingFile адаптера (в поставке,
// только читается), наблюдения — <каталог состояния>/providers/<id>/pricing-observations.json.
// Вердикты (ok, insufficient_balance, cost_or_balance_unknown), тексты, коды выхода и записанный
// файл наблюдений зафиксированы эталонами testdata/golden/cost-check. Каталог состояния
// передаётся параметром.
package costcheck

import (
	"context"
	"errors"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/mediarequest"
	"songframe/internal/requestsnapshot"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
	"songframe/internal/toolsubcmd"
)

// ObservationsFile — файл наблюдений расхода в папке провайдера каталога состояния.
const ObservationsFile = "pricing-observations.json"

// verdictLabels — подписи вердиктов оценки.
var verdictLabels = map[string]string{
	"ok":                      "средств достаточно",
	"insufficient_balance":    "средств не хватает",
	"cost_or_balance_unknown": "стоимость или баланс неизвестны",
}

func valueError(message string) error { return toolrt.New(toolrt.ValueError, message) }

// PricingPath — явный файл тарифов (прогоны без расхода) либо
// базовая таблица адаптера провайдера запроса.
func PricingPath(request *toolrt.Dict, path string) (string, error) {
	if path != "" {
		return path, nil
	}
	provider, err := toolrt.Item(request, "provider")
	if err != nil {
		return "", err
	}
	service, err := mediaadapters.Lookup(provider)
	if err != nil {
		return "", err
	}
	filer, ok := service.(mediaapi.PricingFiler)
	if !ok {
		return "", valueError("Провайдер " + toolrt.Repr(provider) + " не поддерживает это действие.")
	}
	file, err := filer.PricingFile()
	if err != nil {
		return "", toolrt.OSErrorFrom(err, file)
	}
	return file, nil
}

// ObservationsPath — файл наблюдений провайдера в каталоге
// состояния localDir. Id провайдера — одно имя папки.
func ObservationsPath(localDir string, provider any) (string, error) {
	text, ok := provider.(string)
	if !ok || text == "" || toolrt.PathName(text) != text || text == "." || text == ".." {
		return "", valueError("Некорректный идентификатор провайдера.")
	}
	return filepath.Join(toolrt.ResolvePath(localDir), "providers", text, ObservationsFile), nil
}

// LoadObservations — отсутствующий файл — пустой список, повреждённый —
// ValueError (файл не перезаписывается).
func LoadObservations(localDir string, provider any) ([]any, error) {
	path, err := ObservationsPath(localDir, provider)
	if err != nil {
		return nil, err
	}
	data, damaged := toolrt.ReadJSON(path)
	if data == nil && !damaged {
		return []any{}, nil
	}
	dict, ok := data.(*toolrt.Dict)
	observed, isList := dict.Value("observed").([]any)
	if damaged || !ok || !toolrt.Equal(dict.Value("schema_version"), toolrt.NewInt(1)) || !isList {
		return nil, valueError("Файл наблюдений цен повреждён: " + path + ". Исправьте или удалите его.")
	}
	return observed, nil
}

// LoadPricing — базовая таблица; с провайдером к её наблюдениям
// добавляются наблюдения каталога состояния. Они идут после базовых, а оценка берёт последнее
// подходящее, поэтому наблюдения состояния в приоритете.
func LoadPricing(path, localDir string, provider any) (*toolrt.Dict, error) {
	value, err := toolrt.LoadJSONFile(path)
	if err != nil {
		return nil, err
	}
	return pricingTable(value, localDir, provider)
}

// pricingTable проверяет схему прочитанной таблицы цен и добавляет наблюдения каталога состояния.
func pricingTable(value any, localDir string, provider any) (*toolrt.Dict, error) {
	schema, err := toolrt.DictGet(value, "schema_version", nil)
	if err != nil {
		return nil, err
	}
	data := value.(*toolrt.Dict)
	if _, ok := data.Value("models").(*toolrt.Dict); !toolrt.Equal(schema, toolrt.NewInt(1)) || !ok {
		return nil, valueError("Неизвестная схема таблицы цен.")
	}
	if !data.Has("observed") {
		data.Set("observed", []any{})
	}
	if provider != nil {
		base, err := toolrt.Iter(data.Value("observed"))
		if err != nil {
			return nil, err
		}
		extra, err := LoadObservations(localDir, provider)
		if err != nil {
			return nil, err
		}
		data.Set("observed", append(append([]any{}, base...), extra...))
	}
	return data, nil
}

// PricingFor — таблица цен запроса вместе с наблюдениями.
func PricingFor(request *toolrt.Dict, path, localDir string) (*toolrt.Dict, error) {
	if path == "" {
		// Таблица, встроенная в адаптер (в поставке нет отдельного файла), читается из памяти.
		if service, ok := mediaadapters.Get(request.Value("provider")); ok {
			if embedded, ok := service.(mediaapi.PricingDataer); ok {
				value, err := toolrt.LoadsJSON(string(embedded.PricingData()))
				if err != nil {
					return nil, err
				}
				return pricingTable(value, localDir, request.Value("provider"))
			}
		}
	}
	file, err := PricingPath(request, path)
	if err != nil {
		return nil, err
	}
	return LoadPricing(file, localDir, request.Value("provider"))
}

// LoadRequest — зафиксированный request.json попытки либо
// спецификация до подготовки (её проверяют общая форма и адаптер провайдера).
func LoadRequest(root, workDir, request string) (*toolrt.Dict, error) {
	if workDir != "" {
		directory, err := mediarequest.WorkPath(root, workDir)
		if err != nil {
			return nil, err
		}
		return loadDict(filepath.Join(directory, "request.json"))
	}
	value, err := toolrt.LoadJSONFile(request)
	if err != nil {
		return nil, err
	}
	if err := requestsnapshot.ValidateSpec(value); err != nil {
		return nil, err
	}
	spec := value.(*toolrt.Dict)
	service, err := mediaadapters.Lookup(spec.Value("provider"))
	if err != nil {
		return nil, err
	}
	if validator, ok := service.(mediaapi.SpecValidator); ok {
		if err := validator.ValidateSpec(spec); err != nil {
			return nil, err
		}
	}
	return spec, nil
}

// loadDict — JSON-документ файла как объект; иное значение — AttributeError первого обращения
// к полю (текст ошибки зафиксирован эталоном).
func loadDict(path string) (*toolrt.Dict, error) {
	value, err := toolrt.LoadJSONFile(path)
	if err != nil {
		return nil, err
	}
	dict, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(value))
	}
	return dict, nil
}

// number — значение как float (toolrt.Float) либо nil, если оно не приводится к числу.
func number(value any) *float64 {
	result, err := toolrt.Float(value)
	if err != nil {
		return nil
	}
	return &result
}

// toInt — целое для outputs: целое, bool, float (отбрасывание дроби), строка цифр.
func toInt(value any) (int64, error) {
	switch item := value.(type) {
	case toolrt.Int:
		result, ok := item.Int64()
		if !ok {
			return 0, toolrt.New(toolrt.OverflowError, "слишком большое число")
		}
		return result, nil
	case bool:
		if item {
			return 1, nil
		}
		return 0, nil
	case float64:
		return toolrt.FloatToInt(item, false)
	case string:
		result, err := strconv.ParseInt(toolrt.Strip(item), 10, 64)
		if err != nil {
			return 0, toolrt.Raise(toolrt.ValueError, "не целое число: %s", toolrt.Repr(item))
		}
		return result, nil
	}
	return 0, toolrt.Raise(toolrt.TypeError, "ожидается число или строка, получено: %s", toolrt.TypeName(value))
}

// get — поле key словаря запроса или fallback, если поля нет.
func get(dict *toolrt.Dict, key string, fallback any) any {
	if value, has := dict.Get(key); has {
		return value
	}
	return fallback
}

// secretKey — ключи авторизации, не задающие тариф.
var secretKey = regexp.MustCompile(`(?i)credential|token|password|authorization|secret|api[_-]?key`)

// parametersOnly — параметры без текста промпта и полей авторизации (рекурсивно).
func parametersOnly(value any) any {
	switch item := value.(type) {
	case *toolrt.Dict:
		result := toolrt.NewDict()
		for _, key := range item.Keys() {
			switch strings.ToLower(key) {
			case "prompt", "prompt_text", "prompt_file", "negative_prompt":
				continue
			}
			if secretKey.MatchString(key) {
				continue
			}
			result.Set(key, parametersOnly(item.Value(key)))
		}
		return result
	case []any:
		result := make([]any, len(item))
		for index, element := range item {
			result[index] = parametersOnly(element)
		}
		return result
	}
	return value
}

// ImageSignature — тариф изображения связан со всей конфигурацией
// запроса (команда, параметры без промпта и секретов, число результатов, flag/slot входов) в
// canonical JSON; содержимое и подпись role входов тариф не задают.
func ImageSignature(request *toolrt.Dict) (string, error) {
	inputs := []any{}
	list, err := toolrt.Iter(get(request, "inputs", []any{}))
	if err != nil {
		return "", err
	}
	for _, element := range list {
		entry := toolrt.NewDict()
		for _, key := range []string{"flag", "slot"} {
			if contained, err := toolrt.Contains(element, key); err != nil {
				return "", err
			} else if contained {
				value, err := toolrt.Item(element, key)
				if err != nil {
					return "", err
				}
				entry.Set(key, value)
			}
		}
		inputs = append(inputs, entry)
	}
	configuration := toolrt.NewDict()
	configuration.Set("command", request.Value("command"))
	configuration.Set("parameters", parametersOnly(get(request, "parameters", toolrt.NewDict())))
	configuration.Set("outputs", get(request, "outputs", toolrt.NewInt(1)))
	configuration.Set("inputs", inputs)
	return toolrt.DumpsJSON(configuration, toolrt.DumpOptions{SortKeys: true, Compact: true, RejectNaN: true})
}

// Estimate — итог оценки: кредиты (nil — неизвестно), источник и недостающие сведения.
type Estimate struct {
	Credits *float64
	Source  any
	Missing []string
}

// field — поле key элемента списка наблюдений или fallback (AttributeError у не-словаря).
func field(entry any, key string, fallback any) (any, error) {
	return toolrt.DictGet(entry, key, fallback)
}

// matches — все пары ключ/значение совпадают (toolrt.Equal) у словаря наблюдения.
func matches(entry any, pairs ...any) (bool, error) {
	for index := 0; index+1 < len(pairs); index += 2 {
		value, err := field(entry, pairs[index].(string), nil)
		if err != nil {
			return false, err
		}
		if !toolrt.Equal(value, pairs[index+1]) {
			return false, nil
		}
	}
	return true, nil
}

// modelEntry — запись модели в pricing["models"] или nil; без раздела models — KeyError.
func modelEntry(pricing *toolrt.Dict, model any) (any, error) {
	models, err := toolrt.Item(pricing, "models")
	if err != nil {
		return nil, err
	}
	text, ok := model.(string)
	if !ok {
		if _, err := toolrt.HashKey(model); err != nil {
			return nil, err
		}
		return nil, nil
	}
	return toolrt.DictGet(models, text, nil)
}

// estimateImage — наблюдение не переносится на другую команду, разрешение,
// quality, число результатов или референсов; ручной per_image — явное решение владельца таблицы.
func estimateImage(pricing, request *toolrt.Dict) (Estimate, error) {
	model := request.Value("model")
	signature, err := ImageSignature(request)
	if err != nil {
		return Estimate{}, err
	}
	observed, err := toolrt.Iter(pricing.Value("observed"))
	if err != nil {
		return Estimate{}, err
	}
	var last any
	for _, entry := range observed {
		ok, err := matches(entry, "model", model, "kind", "image", "image_signature", signature)
		if err != nil {
			return Estimate{}, err
		}
		if ok {
			credits, _ := field(entry, "credits", nil)
			if number(credits) != nil {
				last = entry
			}
		}
	}
	if last != nil {
		credits, _ := field(last, "credits", nil)
		return Estimate{Credits: number(credits), Source: "наблюдение за точно таким же запросом изображения", Missing: []string{}}, nil
	}
	entry, err := modelEntry(pricing, model)
	if err != nil {
		return Estimate{}, err
	}
	if !toolrt.Truthy(entry) {
		entry = toolrt.NewDict()
	}
	perImageValue, err := field(entry, "per_image", nil)
	if err != nil {
		return Estimate{}, err
	}
	if perImage := number(perImageValue); perImage != nil {
		outputs, err := toInt(get(request, "outputs", toolrt.NewInt(1)))
		if err != nil {
			return Estimate{}, err
		}
		credits := *perImage * float64(outputs)
		return Estimate{Credits: &credits, Source: "таблица цен", Missing: []string{}}, nil
	}
	return Estimate{Missing: []string{"цена изображения " + toolrt.Str(model) + " не задана и точная конфигурация запроса не наблюдалась"}}, nil
}

// EstimateCost — оценка в кредитах по таблице цен, при пробеле — по
// наблюдениям того же тарифа (точная по длительности либо пересчёт по секундам).
func EstimateCost(pricing, request *toolrt.Dict) (Estimate, error) {
	model, kind := request.Value("model"), request.Value("kind")
	if toolrt.Equal(kind, "image") {
		return estimateImage(pricing, request)
	}
	parameters := get(request, "parameters", toolrt.NewDict())
	outputs, err := toInt(get(request, "outputs", toolrt.NewInt(1)))
	if err != nil {
		return Estimate{}, err
	}
	var resolution *string
	if contained, err := toolrt.Contains(parameters, "resolution"); err != nil {
		return Estimate{}, err
	} else if contained {
		value, err := toolrt.Item(parameters, "resolution")
		if err != nil {
			return Estimate{}, err
		}
		text := toolrt.Str(value)
		resolution = &text
	}
	durationValue, err := toolrt.DictGet(parameters, "duration", nil)
	if err != nil {
		return Estimate{}, err
	}
	duration := number(durationValue)
	entry, err := modelEntry(pricing, model)
	if err != nil {
		return Estimate{}, err
	}
	if entry == nil {
		return Estimate{Missing: []string{"модель " + toolrt.Str(model) + " отсутствует в таблице цен"}}, nil
	}
	if !toolrt.Equal(kind, "video") {
		return Estimate{Missing: []string{"неизвестный вид результата"}}, nil
	}
	missing := []string{}
	if resolution == nil {
		missing = append(missing, "в запросе нет resolution")
	}
	if duration == nil {
		missing = append(missing, "в запросе нет duration")
	}
	if len(missing) > 0 {
		return Estimate{Missing: missing}, nil
	}
	perSecondTable, err := field(entry, "per_second", nil)
	if err != nil {
		return Estimate{}, err
	}
	if !toolrt.Truthy(perSecondTable) {
		perSecondTable = toolrt.NewDict()
	}
	perSecondValue, err := field(perSecondTable, *resolution, nil)
	if err != nil {
		return Estimate{}, err
	}
	if perSecond := number(perSecondValue); perSecond != nil {
		baseValue, _ := field(entry, "base_credits", nil)
		base := 0.0
		if value := number(baseValue); value != nil {
			base = *value
		}
		credits := (base + *perSecond**duration) * float64(outputs)
		return Estimate{Credits: &credits, Source: "таблица цен", Missing: []string{}}, nil
	}
	all, err := toolrt.Iter(pricing.Value("observed"))
	if err != nil {
		return Estimate{}, err
	}
	observed := []any{}
	for _, item := range all {
		ok, err := matches(item, "model", model)
		if err != nil {
			return Estimate{}, err
		}
		itemKind, _ := field(item, "kind", "video")
		itemResolution, _ := field(item, "resolution", nil)
		credits, _ := field(item, "credits", nil)
		if ok && toolrt.Equal(itemKind, "video") && toolrt.Str(itemResolution) == *resolution && number(credits) != nil {
			observed = append(observed, item)
		}
	}
	var exact any
	for _, item := range observed {
		durationItem, _ := field(item, "duration", nil)
		if itemDuration := number(durationItem); itemDuration == nil || *itemDuration != *duration {
			continue
		}
		outputsItem, _ := field(item, "outputs", toolrt.NewInt(1))
		count, err := toInt(outputsItem)
		if err != nil {
			return Estimate{}, err
		}
		if count == 1 {
			exact = item
		}
	}
	if exact != nil {
		creditsValue, _ := field(exact, "credits", nil)
		credits := *number(creditsValue) * float64(outputs)
		return Estimate{Credits: &credits, Source: "наблюдение за прежним запросом", Missing: []string{}}, nil
	}
	if len(observed) > 0 {
		last := observed[len(observed)-1]
		creditsValue, _ := field(last, "credits", nil)
		durationItem, _ := field(last, "duration", nil)
		outputsItem, _ := field(last, "outputs", toolrt.NewInt(1))
		lastDuration := number(durationItem)
		if lastDuration == nil {
			return Estimate{}, toolrt.New(toolrt.TypeError, "операция «/» неприменима: дробное число и null")
		}
		count, err := toInt(outputsItem)
		if err != nil {
			return Estimate{}, err
		}
		if *lastDuration == 0 || count == 0 {
			return Estimate{}, toolrt.New(toolrt.ZeroDivisionError, "деление на ноль")
		}
		perSecond := *number(creditsValue) / *lastDuration / float64(count)
		credits := perSecond * *duration * float64(outputs)
		return Estimate{Credits: &credits, Source: "наблюдение, пересчёт по секундам", Missing: []string{}}, nil
	}
	return Estimate{Missing: []string{"цена " + toolrt.Str(model) + " при " + *resolution + " не задана и не наблюдалась"}}, nil
}

// Check — отчёт проверки стоимости запроса: оценка по pricing, остаток и вердикт (ok,
// insufficient_balance или cost_or_balance_unknown) с причинами. balance — остаток вручную (nil —
// спросить адаптер провайдера, если useAccount); других обращений к сервису нет.
func Check(ctx context.Context, request, pricing *toolrt.Dict, balance *float64, useAccount bool, timeout float64) (*toolrt.Dict, error) {
	estimated, err := EstimateCost(pricing, request)
	if err != nil {
		return nil, err
	}
	var source string
	switch {
	case balance == nil && useAccount:
		// Единственное обращение к сервису — информационный остаток через адаптер провайдера.
		provider, err := toolrt.Item(request, "provider")
		if err != nil {
			return nil, err
		}
		service, err := mediaadapters.Lookup(provider)
		if err != nil {
			return nil, err
		}
		reader, ok := service.(mediaapi.AccountReader)
		if !ok {
			return nil, valueError("Провайдер " + toolrt.Repr(provider) + " не поддерживает это действие.")
		}
		account, err := reader.Account(ctx, mediaapi.Seconds(timeout))
		if err != nil {
			return nil, err
		}
		balance, source = account.Balance, account.Source
	case balance != nil:
		source = "указан вручную"
	default:
		source = "запрос к аккаунту отключён"
	}
	verdict := "insufficient_balance"
	switch {
	case estimated.Credits == nil || balance == nil:
		verdict = "cost_or_balance_unknown"
	case *balance >= *estimated.Credits:
		verdict = "ok"
	}
	reasons := []any{}
	for _, reason := range estimated.Missing {
		reasons = append(reasons, reason)
	}
	if balance == nil {
		reasons = append(reasons, "остаток неизвестен: "+source)
	}
	report := toolrt.NewDict()
	report.Set("model", request.Value("model"))
	report.Set("kind", request.Value("kind"))
	report.Set("command", request.Value("command"))
	report.Set("parameters", get(request, "parameters", toolrt.NewDict()))
	report.Set("outputs", get(request, "outputs", toolrt.NewInt(1)))
	report.Set("estimate_credits", floatOrNone(estimated.Credits))
	report.Set("estimate_source", estimated.Source)
	report.Set("balance_credits", floatOrNone(balance))
	report.Set("balance_source", source)
	report.Set("verdict", verdict)
	report.Set("verdict_label", verdictLabels[verdict])
	report.Set("reasons", reasons)
	return report, nil
}

func floatOrNone(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

// Learn — фактический credits_consumed отправленной попытки
// наблюдением в каталоге состояния. Таблица поставки не меняется; совпадающее с таблицей или
// состоянием наблюдение повторно не добавляется.
func Learn(root, workDir, pricing, localDir string) (*toolrt.Dict, error) {
	directory, err := mediarequest.WorkPath(root, workDir)
	if err != nil {
		return nil, err
	}
	request, err := loadDict(filepath.Join(directory, "request.json"))
	if err != nil {
		return nil, err
	}
	attempt, err := loadDict(filepath.Join(directory, "attempt.json"))
	if err != nil {
		return nil, err
	}
	credits := number(attempt.Value("credits_consumed"))
	if credits == nil {
		return nil, valueError("В attempt.json нет credits_consumed; наблюдение не записано.")
	}
	parameters := get(request, "parameters", toolrt.NewDict())
	parameter := func(key string) (any, error) { return toolrt.DictGet(parameters, key, nil) }
	kind, err := toolrt.Item(request, "kind")
	if err != nil {
		return nil, err
	}
	model, err := toolrt.Item(request, "model")
	if err != nil {
		return nil, err
	}
	observation := toolrt.NewDict()
	observation.Set("model", model)
	if toolrt.Equal(kind, "image") {
		resolution, err := parameter("img_resolution")
		if err != nil {
			return nil, err
		}
		quality, err := parameter("quality")
		if err != nil {
			return nil, err
		}
		signature, err := ImageSignature(request)
		if err != nil {
			return nil, err
		}
		observation.Set("kind", "image")
		observation.Set("command", request.Value("command"))
		observation.Set("img_resolution", resolution)
		observation.Set("quality", quality)
		observation.Set("image_signature", signature)
	} else {
		resolution, err := parameter("resolution")
		if err != nil {
			return nil, err
		}
		duration, err := parameter("duration")
		if err != nil {
			return nil, err
		}
		observation.Set("kind", kind)
		observation.Set("resolution", resolution)
		observation.Set("duration", duration)
	}
	observation.Set("outputs", get(request, "outputs", toolrt.NewInt(1)))
	observation.Set("credits", *credits)
	table, err := PricingFor(request, pricing, localDir)
	if err != nil {
		return nil, err
	}
	known, err := toolrt.Contains(table.Value("observed"), observation)
	if err != nil {
		return nil, err
	}
	if !known {
		provider := request.Value("provider")
		observed, err := LoadObservations(localDir, provider)
		if err != nil {
			return nil, err
		}
		path, err := ObservationsPath(localDir, provider)
		if err != nil {
			return nil, err
		}
		if err := toolrt.WriteJSONAtomic(path, toolcli.Record("schema_version", toolrt.NewInt(1), "observed", append(observed, observation))); err != nil {
			return nil, err
		}
	}
	return observation, nil
}

// formatCredits — «<value:g> кредитов» либо «неизвестно».
func formatCredits(value any) string {
	number, ok := value.(float64)
	if !ok {
		return "неизвестно"
	}
	var text string
	switch {
	case math.IsNaN(number):
		text = "nan"
	case math.IsInf(number, 1):
		text = "inf"
	case math.IsInf(number, -1):
		text = "-inf"
	case number == 0 && math.Signbit(number):
		text = "-0"
	default:
		text = strconv.FormatFloat(number, 'g', 6, 64)
	}
	return text + " кредитов"
}

// Table — таблица Markdown для человека.
func Table(report *toolrt.Dict) (string, error) {
	parameters := report.Value("parameters")
	parameter := func(key string) (string, error) {
		value, err := toolrt.DictGet(parameters, key, "—")
		if err != nil {
			return "", err
		}
		return toolrt.Str(value), nil
	}
	keys := []string{"duration", "resolution"}
	prefix := ""
	if toolrt.Equal(report.Value("kind"), "image") {
		keys = []string{"img_resolution", "quality"}
		prefix = "command=" + toolrt.Str(report.Value("command")) + ", "
	}
	first, err := parameter(keys[0])
	if err != nil {
		return "", err
	}
	second, err := parameter(keys[1])
	if err != nil {
		return "", err
	}
	details := prefix + keys[0] + "=" + first + ", " + keys[1] + "=" + second + ", результатов " + toolrt.Str(report.Value("outputs"))
	source := "нет данных"
	if value := report.Value("estimate_source"); toolrt.Truthy(value) {
		source = toolrt.Str(value)
	}
	lines := []string{
		"| Параметр | Значение |",
		"| --- | --- |",
		"| Модель | " + toolrt.Str(report.Value("model")) + " (" + toolrt.Str(report.Value("kind")) + ") |",
		"| Параметры | " + details + " |",
		"| Оценка | " + formatCredits(report.Value("estimate_credits")) + " (" + source + ") |",
		"| Остаток | " + formatCredits(report.Value("balance_credits")) + " (" + toolrt.Str(report.Value("balance_source")) + ") |",
		"| Вердикт | " + toolrt.Str(report.Value("verdict_label")) + " (`" + toolrt.Str(report.Value("verdict")) + "`) |",
	}
	reasons, _ := report.Value("reasons").([]any)
	for _, reason := range reasons {
		lines = append(lines, "| Причина | "+toolrt.Str(reason)+" |")
	}
	return strings.Join(lines, "\n"), nil
}

// Parser — аргументы инструмента cost_check.
var Parser = toolsubcmd.Parser{
	Prog:        "cost_check",
	Description: "Оценка стоимости запроса и остатка кредитов перед таблицей; @link README.md",
	Dest:        "action",
	Commands: []toolsubcmd.Command{
		{Name: "check", Exclusive: []string{"--work-dir", "--request"}, ExclusiveRequired: true, Options: []toolsubcmd.Option{
			{Name: "--work-dir"},
			{Name: "--request"},
			{Name: "--balance", Float: true, Help: "Остаток из кабинета, если account недоступен."},
			{Name: "--no-account", Flag: true, Help: "Не обращаться к аккаунту."},
			{Name: "--pricing", Help: "Файл тарифов вместо базовой таблицы адаптера провайдера."},
			{Name: "--timeout", Float: true},
			{Name: "--json", Flag: true},
		}},
		{Name: "learn", Options: []toolsubcmd.Option{
			{Name: "--work-dir", Required: true},
			{Name: "--pricing", Help: "Файл тарифов вместо базовой таблицы адаптера провайдера."},
		}},
	},
}

// textHidden — общий отказ без сырого вывода.
const textHidden = "Ошибка локальных данных; сырой вывод скрыт."

// Run выполняет cost_check на проекте root с каталогом состояния localDir. Код 2 — любой
// вердикт кроме ok (вызывающий код не может пропустить проверку молча), 1 — ошибка: текст
// ValueError (кроме ошибки разбора JSON) либо общий текст для OSError/KeyError/TypeError.
func Run(ctx context.Context, root string, args []string, localDir string) toolcli.Output {
	parsed, exit := Parser.Parse(args)
	if exit != nil {
		return toolcli.Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	printer := &toolcli.Printer{}
	output, err := run(ctx, root, parsed, localDir, printer)
	if err != nil {
		return failure(printer, err)
	}
	return output
}

func failure(printer *toolcli.Printer, err error) toolcli.Output {
	var exception *toolrt.Exception
	switch {
	case toolrt.Is(err, toolrt.ValueError) && !toolrt.Is(err, toolrt.JSONDecodeError):
		return printer.Fail(err.Error())
	case toolrt.IsAny(err, toolrt.OSError, toolrt.KeyError, toolrt.TypeError, toolrt.JSONDecodeError):
		return printer.Fail(textHidden)
	case errors.As(err, &exception):
		return printer.Crash(err)
	}
	return printer.Fail(textHidden)
}

func run(ctx context.Context, root string, args toolsubcmd.Result, localDir string, printer *toolcli.Printer) (toolcli.Output, error) {
	pricing, _ := args.Value("--pricing")
	workDir, _ := args.Value("--work-dir")
	if args.Action == "learn" {
		observation, err := Learn(root, workDir, pricing, localDir)
		if err != nil {
			return toolcli.Output{}, err
		}
		text, err := toolrt.DumpsJSON(observation, toolrt.DumpOptions{})
		if err != nil {
			return toolcli.Output{}, err
		}
		if err := printer.Print("Наблюдение записано: " + text); err != nil {
			return toolcli.Output{}, err
		}
		return printer.Exit(0), nil
	}
	requestPath, _ := args.Value("--request")
	request, err := LoadRequest(root, workDir, requestPath)
	if err != nil {
		return toolcli.Output{}, err
	}
	table, err := PricingFor(request, pricing, localDir)
	if err != nil {
		return toolcli.Output{}, err
	}
	var balance *float64
	if value, ok := args.Floats["--balance"]; ok {
		balance = &value
	}
	report, err := Check(ctx, request, table, balance, !args.Bools["--no-account"], args.Float("--timeout", 60))
	if err != nil {
		return toolcli.Output{}, err
	}
	var text string
	if args.Bools["--json"] {
		text, err = toolcli.JSON(report)
	} else {
		text, err = Table(report)
	}
	if err != nil {
		return toolcli.Output{}, err
	}
	if err := printer.Print(text); err != nil {
		return toolcli.Output{}, err
	}
	if report.Value("verdict") != "ok" {
		return printer.Exit(2), nil
	}
	return printer.Exit(0), nil
}

// VerdictLabel — подпись вердикта оценки.
func VerdictLabel(verdict string) string { return verdictLabels[verdict] }
