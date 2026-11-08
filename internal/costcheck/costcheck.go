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

	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediarequest"
	"songframe-go/internal/pyargparse"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/requestsnapshot"
)

// ObservationsFile — файл наблюдений расхода в папке провайдера каталога состояния.
const ObservationsFile = "pricing-observations.json"

// verdictLabels — подписи вердиктов оценки.
var verdictLabels = map[string]string{
	"ok":                      "средств достаточно",
	"insufficient_balance":    "средств не хватает",
	"cost_or_balance_unknown": "стоимость или баланс неизвестны",
}

func valueError(message string) error { return pycompat.New(pycompat.ValueError, message) }

// PricingPath — явный файл тарифов (прогоны без расхода) либо
// базовая таблица адаптера провайдера запроса.
func PricingPath(request *pycompat.Dict, path string) (string, error) {
	if path != "" {
		return path, nil
	}
	provider, err := pycompat.Item(request, "provider")
	if err != nil {
		return "", err
	}
	service, err := mediaadapters.Lookup(provider)
	if err != nil {
		return "", err
	}
	filer, ok := service.(mediaapi.PricingFiler)
	if !ok {
		return "", valueError("Провайдер " + pycompat.Repr(provider) + " не поддерживает это действие.")
	}
	file, err := filer.PricingFile()
	if err != nil {
		return "", pycompat.OSErrorFrom(err, file)
	}
	return file, nil
}

// ObservationsPath — файл наблюдений провайдера в каталоге
// состояния localDir. Id провайдера — одно имя папки.
func ObservationsPath(localDir string, provider any) (string, error) {
	text, ok := provider.(string)
	if !ok || text == "" || pycompat.PathName(text) != text || text == "." || text == ".." {
		return "", valueError("Некорректный идентификатор провайдера.")
	}
	return filepath.Join(pycompat.ResolvePath(localDir), "providers", text, ObservationsFile), nil
}

// LoadObservations — отсутствующий файл — пустой список, повреждённый —
// ValueError (файл не перезаписывается).
func LoadObservations(localDir string, provider any) ([]any, error) {
	path, err := ObservationsPath(localDir, provider)
	if err != nil {
		return nil, err
	}
	data, damaged := pycompat.ReadJSON(path)
	if data == nil && !damaged {
		return []any{}, nil
	}
	dict, ok := data.(*pycompat.Dict)
	observed, isList := dict.Value("observed").([]any)
	if damaged || !ok || !pycompat.Equal(dict.Value("schema_version"), pycompat.NewInt(1)) || !isList {
		return nil, valueError("Файл наблюдений цен повреждён: " + path + ". Исправьте или удалите его.")
	}
	return observed, nil
}

// LoadPricing — базовая таблица; с провайдером к её наблюдениям
// добавляются наблюдения каталога состояния. Они идут после базовых, а оценка берёт последнее
// подходящее, поэтому наблюдения состояния в приоритете.
func LoadPricing(path, localDir string, provider any) (*pycompat.Dict, error) {
	value, err := pycompat.LoadJSONFile(path)
	if err != nil {
		return nil, err
	}
	return pricingTable(value, localDir, provider)
}

// pricingTable проверяет схему прочитанной таблицы цен и добавляет наблюдения каталога состояния.
func pricingTable(value any, localDir string, provider any) (*pycompat.Dict, error) {
	schema, err := pycompat.DictGet(value, "schema_version", nil)
	if err != nil {
		return nil, err
	}
	data := value.(*pycompat.Dict)
	if _, ok := data.Value("models").(*pycompat.Dict); !pycompat.Equal(schema, pycompat.NewInt(1)) || !ok {
		return nil, valueError("Неизвестная схема таблицы цен.")
	}
	if !data.Has("observed") {
		data.Set("observed", []any{})
	}
	if provider != nil {
		base, err := pycompat.Iter(data.Value("observed"))
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
func PricingFor(request *pycompat.Dict, path, localDir string) (*pycompat.Dict, error) {
	if path == "" {
		// Таблица, встроенная в адаптер (Go-поставка без файлов tools), читается из памяти.
		if service, ok := mediaadapters.Get(request.Value("provider")); ok {
			if embedded, ok := service.(mediaapi.PricingDataer); ok {
				value, err := pycompat.LoadsJSON(string(embedded.PricingData()))
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
func LoadRequest(root, workDir, request string) (*pycompat.Dict, error) {
	if workDir != "" {
		directory, err := mediarequest.WorkPath(root, workDir)
		if err != nil {
			return nil, err
		}
		return loadDict(filepath.Join(directory, "request.json"))
	}
	value, err := pycompat.LoadJSONFile(request)
	if err != nil {
		return nil, err
	}
	if err := requestsnapshot.ValidateSpec(value); err != nil {
		return nil, err
	}
	spec := value.(*pycompat.Dict)
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
// .get (модель Python, от неё зависит текст ошибки).
func loadDict(path string) (*pycompat.Dict, error) {
	value, err := pycompat.LoadJSONFile(path)
	if err != nil {
		return nil, err
	}
	dict, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'get'", pycompat.TypeName(value))
	}
	return dict, nil
}

// number — number(value): float(value) либо None (nil) при TypeError/ValueError.
func number(value any) *float64 {
	result, err := pycompat.Float(value)
	if err != nil {
		return nil
	}
	return &result
}

// toInt — int(value) Python для outputs: целое, bool, float (отбрасывание дроби), строка цифр.
func toInt(value any) (int64, error) {
	switch item := value.(type) {
	case pycompat.Int:
		result, ok := item.Int64()
		if !ok {
			return 0, pycompat.New(pycompat.OverflowError, "int too large")
		}
		return result, nil
	case bool:
		if item {
			return 1, nil
		}
		return 0, nil
	case float64:
		return pycompat.FloatToInt(item, false)
	case string:
		result, err := strconv.ParseInt(pycompat.Strip(item), 10, 64)
		if err != nil {
			return 0, pycompat.Raise(pycompat.ValueError, "invalid literal for int() with base 10: %s", pycompat.Repr(item))
		}
		return result, nil
	}
	return 0, pycompat.Raise(pycompat.TypeError, "int() argument must be a string, a bytes-like object or a real number, not '%s'", pycompat.TypeName(value))
}

// get — d.get(key, fallback) для словаря запроса.
func get(dict *pycompat.Dict, key string, fallback any) any {
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
	case *pycompat.Dict:
		result := pycompat.NewDict()
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
func ImageSignature(request *pycompat.Dict) (string, error) {
	inputs := []any{}
	list, err := pycompat.Iter(get(request, "inputs", []any{}))
	if err != nil {
		return "", err
	}
	for _, element := range list {
		entry := pycompat.NewDict()
		for _, key := range []string{"flag", "slot"} {
			if contained, err := pycompat.Contains(element, key); err != nil {
				return "", err
			} else if contained {
				value, err := pycompat.Item(element, key)
				if err != nil {
					return "", err
				}
				entry.Set(key, value)
			}
		}
		inputs = append(inputs, entry)
	}
	configuration := pycompat.NewDict()
	configuration.Set("command", request.Value("command"))
	configuration.Set("parameters", parametersOnly(get(request, "parameters", pycompat.NewDict())))
	configuration.Set("outputs", get(request, "outputs", pycompat.NewInt(1)))
	configuration.Set("inputs", inputs)
	return pycompat.DumpsJSON(configuration, pycompat.DumpOptions{SortKeys: true, Compact: true, RejectNaN: true})
}

// Estimate — итог оценки: кредиты (nil — неизвестно), источник и недостающие сведения.
type Estimate struct {
	Credits *float64
	Source  any
	Missing []string
}

// field — o.get(key) элемента списка наблюдений (AttributeError у не-словаря).
func field(entry any, key string, fallback any) (any, error) {
	return pycompat.DictGet(entry, key, fallback)
}

// matches — все пары ключ/значение совпадают (==) у словаря наблюдения.
func matches(entry any, pairs ...any) (bool, error) {
	for index := 0; index+1 < len(pairs); index += 2 {
		value, err := field(entry, pairs[index].(string), nil)
		if err != nil {
			return false, err
		}
		if !pycompat.Equal(value, pairs[index+1]) {
			return false, nil
		}
	}
	return true, nil
}

// modelEntry — pricing["models"].get(model).
func modelEntry(pricing *pycompat.Dict, model any) (any, error) {
	models, err := pycompat.Item(pricing, "models")
	if err != nil {
		return nil, err
	}
	text, ok := model.(string)
	if !ok {
		if _, err := pycompat.HashKey(model); err != nil {
			return nil, err
		}
		return nil, nil
	}
	return pycompat.DictGet(models, text, nil)
}

// estimateImage — наблюдение не переносится на другую команду, разрешение,
// quality, число результатов или референсов; ручной per_image — явное решение владельца таблицы.
func estimateImage(pricing, request *pycompat.Dict) (Estimate, error) {
	model := request.Value("model")
	signature, err := ImageSignature(request)
	if err != nil {
		return Estimate{}, err
	}
	observed, err := pycompat.Iter(pricing.Value("observed"))
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
	if !pycompat.Truthy(entry) {
		entry = pycompat.NewDict()
	}
	perImageValue, err := field(entry, "per_image", nil)
	if err != nil {
		return Estimate{}, err
	}
	if perImage := number(perImageValue); perImage != nil {
		outputs, err := toInt(get(request, "outputs", pycompat.NewInt(1)))
		if err != nil {
			return Estimate{}, err
		}
		credits := *perImage * float64(outputs)
		return Estimate{Credits: &credits, Source: "таблица цен", Missing: []string{}}, nil
	}
	return Estimate{Missing: []string{"цена изображения " + pycompat.Str(model) + " не задана и точная конфигурация запроса не наблюдалась"}}, nil
}

// EstimateCost — оценка в кредитах по таблице цен, при пробеле — по
// наблюдениям того же тарифа (точная по длительности либо пересчёт по секундам).
func EstimateCost(pricing, request *pycompat.Dict) (Estimate, error) {
	model, kind := request.Value("model"), request.Value("kind")
	if pycompat.Equal(kind, "image") {
		return estimateImage(pricing, request)
	}
	parameters := get(request, "parameters", pycompat.NewDict())
	outputs, err := toInt(get(request, "outputs", pycompat.NewInt(1)))
	if err != nil {
		return Estimate{}, err
	}
	var resolution *string
	if contained, err := pycompat.Contains(parameters, "resolution"); err != nil {
		return Estimate{}, err
	} else if contained {
		value, err := pycompat.Item(parameters, "resolution")
		if err != nil {
			return Estimate{}, err
		}
		text := pycompat.Str(value)
		resolution = &text
	}
	durationValue, err := pycompat.DictGet(parameters, "duration", nil)
	if err != nil {
		return Estimate{}, err
	}
	duration := number(durationValue)
	entry, err := modelEntry(pricing, model)
	if err != nil {
		return Estimate{}, err
	}
	if entry == nil {
		return Estimate{Missing: []string{"модель " + pycompat.Str(model) + " отсутствует в таблице цен"}}, nil
	}
	if !pycompat.Equal(kind, "video") {
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
	if !pycompat.Truthy(perSecondTable) {
		perSecondTable = pycompat.NewDict()
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
	all, err := pycompat.Iter(pricing.Value("observed"))
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
		if ok && pycompat.Equal(itemKind, "video") && pycompat.Str(itemResolution) == *resolution && number(credits) != nil {
			observed = append(observed, item)
		}
	}
	var exact any
	for _, item := range observed {
		durationItem, _ := field(item, "duration", nil)
		if itemDuration := number(durationItem); itemDuration == nil || *itemDuration != *duration {
			continue
		}
		outputsItem, _ := field(item, "outputs", pycompat.NewInt(1))
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
		outputsItem, _ := field(last, "outputs", pycompat.NewInt(1))
		lastDuration := number(durationItem)
		if lastDuration == nil {
			return Estimate{}, pycompat.New(pycompat.TypeError, "unsupported operand type(s) for /: 'float' and 'NoneType'")
		}
		count, err := toInt(outputsItem)
		if err != nil {
			return Estimate{}, err
		}
		if *lastDuration == 0 || count == 0 {
			return Estimate{}, pycompat.New(pycompat.ZeroDivisionError, "float division by zero")
		}
		perSecond := *number(creditsValue) / *lastDuration / float64(count)
		credits := perSecond * *duration * float64(outputs)
		return Estimate{Credits: &credits, Source: "наблюдение, пересчёт по секундам", Missing: []string{}}, nil
	}
	return Estimate{Missing: []string{"цена " + pycompat.Str(model) + " при " + *resolution + " не задана и не наблюдалась"}}, nil
}

// Check — отчёт с
// вердиктом. balance — остаток вручную (nil — спросить адаптер, если useAccount).
func Check(ctx context.Context, request, pricing *pycompat.Dict, balance *float64, useAccount bool, timeout float64) (*pycompat.Dict, error) {
	estimated, err := EstimateCost(pricing, request)
	if err != nil {
		return nil, err
	}
	var source string
	switch {
	case balance == nil && useAccount:
		// Единственное обращение к сервису — информационный остаток через адаптер провайдера.
		provider, err := pycompat.Item(request, "provider")
		if err != nil {
			return nil, err
		}
		service, err := mediaadapters.Lookup(provider)
		if err != nil {
			return nil, err
		}
		reader, ok := service.(mediaapi.AccountReader)
		if !ok {
			return nil, valueError("Провайдер " + pycompat.Repr(provider) + " не поддерживает это действие.")
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
	report := pycompat.NewDict()
	report.Set("model", request.Value("model"))
	report.Set("kind", request.Value("kind"))
	report.Set("command", request.Value("command"))
	report.Set("parameters", get(request, "parameters", pycompat.NewDict()))
	report.Set("outputs", get(request, "outputs", pycompat.NewInt(1)))
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
func Learn(root, workDir, pricing, localDir string) (*pycompat.Dict, error) {
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
	parameters := get(request, "parameters", pycompat.NewDict())
	parameter := func(key string) (any, error) { return pycompat.DictGet(parameters, key, nil) }
	kind, err := pycompat.Item(request, "kind")
	if err != nil {
		return nil, err
	}
	model, err := pycompat.Item(request, "model")
	if err != nil {
		return nil, err
	}
	observation := pycompat.NewDict()
	observation.Set("model", model)
	if pycompat.Equal(kind, "image") {
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
	observation.Set("outputs", get(request, "outputs", pycompat.NewInt(1)))
	observation.Set("credits", *credits)
	table, err := PricingFor(request, pricing, localDir)
	if err != nil {
		return nil, err
	}
	known, err := pycompat.Contains(table.Value("observed"), observation)
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
		if err := pycompat.WriteJSONAtomic(path, pytool.Record("schema_version", pycompat.NewInt(1), "observed", append(observed, observation))); err != nil {
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
func Table(report *pycompat.Dict) (string, error) {
	parameters := report.Value("parameters")
	parameter := func(key string) (string, error) {
		value, err := pycompat.DictGet(parameters, key, "—")
		if err != nil {
			return "", err
		}
		return pycompat.Str(value), nil
	}
	keys := []string{"duration", "resolution"}
	prefix := ""
	if pycompat.Equal(report.Value("kind"), "image") {
		keys = []string{"img_resolution", "quality"}
		prefix = "command=" + pycompat.Str(report.Value("command")) + ", "
	}
	first, err := parameter(keys[0])
	if err != nil {
		return "", err
	}
	second, err := parameter(keys[1])
	if err != nil {
		return "", err
	}
	details := prefix + keys[0] + "=" + first + ", " + keys[1] + "=" + second + ", результатов " + pycompat.Str(report.Value("outputs"))
	source := "нет данных"
	if value := report.Value("estimate_source"); pycompat.Truthy(value) {
		source = pycompat.Str(value)
	}
	lines := []string{
		"| Параметр | Значение |",
		"| --- | --- |",
		"| Модель | " + pycompat.Str(report.Value("model")) + " (" + pycompat.Str(report.Value("kind")) + ") |",
		"| Параметры | " + details + " |",
		"| Оценка | " + formatCredits(report.Value("estimate_credits")) + " (" + source + ") |",
		"| Остаток | " + formatCredits(report.Value("balance_credits")) + " (" + pycompat.Str(report.Value("balance_source")) + ") |",
		"| Вердикт | " + pycompat.Str(report.Value("verdict_label")) + " (`" + pycompat.Str(report.Value("verdict")) + "`) |",
	}
	reasons, _ := report.Value("reasons").([]any)
	for _, reason := range reasons {
		lines = append(lines, "| Причина | "+pycompat.Str(reason)+" |")
	}
	return strings.Join(lines, "\n"), nil
}

// Parser — аргументы инструмента cost_check в модели argparse.
var Parser = pyargparse.Parser{
	Prog:        "cost_check.py",
	Description: "Оценка стоимости запроса и остатка кредитов перед таблицей; @link README.md",
	Dest:        "action",
	Commands: []pyargparse.Command{
		{Name: "check", Exclusive: []string{"--work-dir", "--request"}, ExclusiveRequired: true, Options: []pyargparse.Option{
			{Name: "--work-dir"},
			{Name: "--request"},
			{Name: "--balance", Float: true, Help: "Остаток из кабинета, если account недоступен."},
			{Name: "--no-account", Flag: true, Help: "Не обращаться к аккаунту."},
			{Name: "--pricing", Help: "Файл тарифов вместо базовой таблицы адаптера провайдера."},
			{Name: "--timeout", Float: true},
			{Name: "--json", Flag: true},
		}},
		{Name: "learn", Options: []pyargparse.Option{
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
func Run(ctx context.Context, root string, args []string, localDir string) pytool.Output {
	parsed, exit := Parser.Parse(args)
	if exit != nil {
		return pytool.Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
	}
	printer := &pytool.Printer{}
	output, err := run(ctx, root, parsed, localDir, printer)
	if err != nil {
		return failure(printer, err)
	}
	return output
}

func failure(printer *pytool.Printer, err error) pytool.Output {
	var exception *pycompat.Exception
	switch {
	case pycompat.Is(err, pycompat.ValueError) && !pycompat.Is(err, pycompat.JSONDecodeError):
		return printer.Fail(err.Error())
	case pycompat.IsAny(err, pycompat.OSError, pycompat.KeyError, pycompat.TypeError, pycompat.JSONDecodeError):
		return printer.Fail(textHidden)
	case errors.As(err, &exception):
		return printer.Crash(err)
	}
	return printer.Fail(textHidden)
}

func run(ctx context.Context, root string, args pyargparse.Result, localDir string, printer *pytool.Printer) (pytool.Output, error) {
	pricing, _ := args.Value("--pricing")
	workDir, _ := args.Value("--work-dir")
	if args.Action == "learn" {
		observation, err := Learn(root, workDir, pricing, localDir)
		if err != nil {
			return pytool.Output{}, err
		}
		text, err := pycompat.DumpsJSON(observation, pycompat.DumpOptions{})
		if err != nil {
			return pytool.Output{}, err
		}
		if err := printer.Print("Наблюдение записано: " + text); err != nil {
			return pytool.Output{}, err
		}
		return printer.Exit(0), nil
	}
	requestPath, _ := args.Value("--request")
	request, err := LoadRequest(root, workDir, requestPath)
	if err != nil {
		return pytool.Output{}, err
	}
	table, err := PricingFor(request, pricing, localDir)
	if err != nil {
		return pytool.Output{}, err
	}
	var balance *float64
	if value, ok := args.Floats["--balance"]; ok {
		balance = &value
	}
	report, err := Check(ctx, request, table, balance, !args.Bools["--no-account"], args.Float("--timeout", 60))
	if err != nil {
		return pytool.Output{}, err
	}
	var text string
	if args.Bools["--json"] {
		text, err = pytool.JSON(report)
	} else {
		text, err = Table(report)
	}
	if err != nil {
		return pytool.Output{}, err
	}
	if err := printer.Print(text); err != nil {
		return pytool.Output{}, err
	}
	if report.Value("verdict") != "ok" {
		return printer.Exit(2), nil
	}
	return printer.Exit(0), nil
}

// VerdictLabel — подпись вердикта оценки.
func VerdictLabel(verdict string) string { return verdictLabels[verdict] }
