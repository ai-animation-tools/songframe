// Package continuitybrief строит врезку непрерывности для плана (инструмент continuity_brief):
// состояние мира и героев словами на первый или последний кадр и чек-лист «да или нет» для
// проверки полученного изображения.
//
// Текст детерминированно выводится из вычисленного состояния реестра сцен (sceneregistry) и
// словаря свойств кастинга: приложение вкладывает абзац в задание агента для дословной вставки в
// промпты опор и видео, поэтому контроль непрерывности не зависит от памяти агента. Вывод CLI
// (текст, --paragraph, --json), коды завершения и тексты ошибок зафиксированы эталоном
// testdata/golden/continuity-brief:
// ожидаемые отказы (ValueError, OSError, KeyError) — текст в stderr и код 1, прочие исключения —
// трассировка. Пакет только читает файлы проекта.
package continuitybrief

import (
	"sort"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/castregistry"
	"songframe/internal/dynvalue"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Parser — разбор аргументов toolrt.ArgParser: код плана позиционным аргументом, фаза и
// формат вывода.
var Parser = toolrt.ArgParser{
	Prog:        "continuity_brief",
	Description: "Врезка непрерывности и чек-лист для плана.",
	Flags: []toolrt.Flag{
		{Name: "--phase", Value: true, Choices: []string{"before", "after"}},
		{Name: "--json"},
		{Name: "--paragraph", Help: "Только абзац для вставки в промпт"},
	},
	Positionals: []toolrt.Positional{{Name: "shot", Help: "Код плана, например M37"}},
}

// phaseTitles — заголовок врезки по фазе плана.
var phaseTitles = map[string]string{"before": "Состояние на первый кадр", "after": "Состояние на последний кадр"}

// defaultProperties и genericProperties — словари свойств по типу сущности и общий набор в
// модели значений toolrt. Источник — встроенный словарь internal/cast/default_properties.json,
// разобранный один раз.
var defaultProperties, genericProperties = loadDefaults()

// loadDefaults переводит встроенный словарь кастинга из дерева dynvalue в значения toolrt через
// JSON: в словаре только строки, списки и объекты, поэтому перевод без потерь.
func loadDefaults() (*toolrt.Dict, []any) {
	defaults := cast.LoadDefaults()
	parse := func(value any) any {
		result, err := toolrt.LoadsJSON(dynvalue.Stringify(value))
		if err != nil {
			panic("встроенный словарь кастинга не разбирается моделью Python: " + err.Error())
		}
		return result
	}
	return parse(defaults.Default).(*toolrt.Dict), parse(defaults.Generic).([]any)
}

// props — словарь свойств одного типа сущности {key: свойство}: ключ — toolrt.HashKey значения
// поля key, поиск — по строковому ключу состояния.
type props map[string]*toolrt.Dict

// get — свойство по строковому ключу состояния или nil.
func (p props) get(key string) *toolrt.Dict {
	hash, _ := toolrt.HashKey(key)
	return p[hash]
}

// propsOf — словарь свойств по полю key элементов items; при повторе ключа побеждает последний.
// Ошибки неверной формы словаря — исключения toolrt (не итерируемое, нет key, нехешируемый ключ).
func propsOf(items any) (props, error) {
	list, err := toolrt.Iter(items)
	if err != nil {
		return nil, err
	}
	result := props{}
	for _, item := range list {
		key, err := toolrt.GetItem(item, "key")
		if err != nil {
			return nil, err
		}
		hash, err := toolrt.HashKey(key)
		if err != nil {
			return nil, err
		}
		// Поле key прочиталось, значит item — словарь (у списка и строки индекс строкой — TypeError).
		result[hash] = item.(*toolrt.Dict)
	}
	return result, nil
}

// labels — подписи свойств по типу сущности кастинга; типу без словаря
// достаётся общий набор. nil-кастинг — словарь по умолчанию.
func labels(castData *toolrt.Dict) (map[string]props, error) {
	result := map[string]props{}
	source := defaultProperties
	if castData != nil {
		source = castData.Value("properties").(*toolrt.Dict)
	}
	for _, kind := range source.Keys() {
		items, err := propsOf(source.Value(kind))
		if err != nil {
			return nil, err
		}
		result[kind] = items
	}
	if castData != nil {
		for _, item := range castData.Value("entities").([]any) {
			kind := item.(*toolrt.Dict).Value("kind").(string)
			generic, err := propsOf(genericProperties)
			if err != nil {
				return nil, err
			}
			if _, ok := result[kind]; !ok {
				result[kind] = generic
			}
		}
	}
	return result, nil
}

// entity — имя и тип сущности кастинга.
type entity struct{ name, kind string }

// entityNames — имя и тип по коду сущности: кастинг уже прошёл castregistry.Validate, поэтому
// id, имя и тип — строки.
func entityNames(castData *toolrt.Dict) (map[string]entity, []string) {
	names := map[string]entity{}
	known := []string{}
	if castData == nil {
		return names, known
	}
	for _, item := range castData.Value("entities").([]any) {
		record := item.(*toolrt.Dict)
		id := record.Value("id").(string)
		names[id] = entity{name: record.Value("name").(string), kind: record.Value("kind").(string)}
		known = append(known, id)
	}
	return names, known
}

// entityOrder — мир первым, дальше порядок кастинга, затем сущности, которых в
// кастинге нет (по алфавиту кодовых точек).
func entityOrder(castData *toolrt.Dict, state *toolrt.Dict) []string {
	_, known := entityNames(castData)
	ordered := []string{}
	inCast := map[string]bool{}
	for _, id := range known {
		inCast[id] = true
		if state.Has(id) {
			ordered = append(ordered, id)
		}
	}
	sort.SliceStable(ordered, func(a, b int) bool {
		return ordered[a] == castregistry.WorldID && ordered[b] != castregistry.WorldID
	})
	rest := []string{}
	for _, id := range state.Keys() {
		if !inCast[id] {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	return append(ordered, rest...)
}

// lookup — имя, словарь свойств и значения состояния сущности id. Сущности вне кастинга
// называются своим кодом и не имеют словаря свойств.
func lookup(names map[string]entity, vocab map[string]props, state *toolrt.Dict, id string) (string, props, *toolrt.Dict) {
	record, ok := names[id]
	if !ok {
		record = entity{name: id}
	}
	properties := props{}
	if record.kind != "" {
		if found, ok := vocab[record.kind]; ok {
			properties = found
		}
	}
	values, _ := state.Value(id).(*toolrt.Dict)
	if values == nil {
		values = toolrt.NewDict()
	}
	return record.name, properties, values
}

// describe — строки «Имя: подпись свойства: значение; …» для каждой
// сущности с состоянием. Подпись без label — ключ с пробелами вместо «_».
func describe(castData *toolrt.Dict, state *toolrt.Dict) ([]string, error) {
	names, _ := entityNames(castData)
	vocab, err := labels(castData)
	if err != nil {
		return nil, err
	}
	lines := []string{}
	for _, id := range entityOrder(castData, state) {
		name, properties, values := lookup(names, vocab, state, id)
		parts := []string{}
		for _, key := range values.Keys() {
			var label any = strings.ReplaceAll(key, "_", " ")
			if item := properties.get(key); item != nil && item.Has("label") {
				label = item.Value("label")
			}
			text, ok := label.(string)
			if !ok {
				return nil, toolrt.Raise(toolrt.AttributeError, "'%s' object has no attribute 'lower'", toolrt.TypeName(label))
			}
			parts = append(parts, unicodeLower(text)+": "+toolrt.Str(values.Value(key)))
		}
		lines = append(lines, name+": "+strings.Join(parts, "; ")+".")
	}
	return lines, nil
}

// checklist — вопросы «да или нет» по свойствам с шаблоном checklist в словаре (значение
// подставляет formatValue); остальные свойства не спрашиваются.
func checklist(castData *toolrt.Dict, state *toolrt.Dict) ([]string, error) {
	names, _ := entityNames(castData)
	vocab, err := labels(castData)
	if err != nil {
		return nil, err
	}
	questions := []string{}
	for _, id := range entityOrder(castData, state) {
		name, properties, values := lookup(names, vocab, state, id)
		for _, key := range values.Keys() {
			item := properties.get(key)
			if item == nil || !toolrt.Truthy(item.Value("checklist")) {
				continue
			}
			template, ok := item.Value("checklist").(string)
			if !ok {
				return nil, toolrt.Raise(toolrt.AttributeError, "'%s' object has no attribute 'format'", toolrt.TypeName(item.Value("checklist")))
			}
			text, err := formatValue(template, values.Value(key))
			if err != nil {
				return nil, err
			}
			questions = append(questions, name+": "+text)
		}
	}
	return questions, nil
}

// actionHeading — заголовок по действию сцены: первые 80 кодовых точек и многоточие у длинного.
// Список режется по элементам и печатается repr-записью; словарь даёт KeyError, прочие типы —
// TypeError (тексты зафиксированы эталоном).
func actionHeading(scene *toolrt.Dict) (string, error) {
	action, err := toolrt.GetItem(scene, "action")
	if err != nil {
		return "", err
	}
	switch value := action.(type) {
	case string:
		runes := toolrt.Runes(value)
		if len(runes) > 80 {
			return toolrt.FromRunes(runes[:80]) + "…", nil
		}
		return value, nil
	case []any:
		if len(value) > 80 {
			return toolrt.Repr(value[:80]) + "…", nil
		}
		return toolrt.Repr(value), nil
	case *toolrt.Dict:
		return "", toolrt.New(toolrt.KeyError, "slice(None, 80, None)")
	}
	return "", toolrt.Raise(toolrt.TypeError, "'%s' object is not subscriptable", toolrt.TypeName(action))
}

// Brief — врезка плана sid реестра data на фазу before/after. castData — кастинг
// castregistry.Load (nil — нет кастинга), initial — начальное состояние сущностей
// (sceneregistry.InitialStatesFor проекта). Результат — словарь {shot, phase, state, paragraph,
// checklist, text} в порядке ключей вывода --json.
func Brief(data *toolrt.Dict, castData *toolrt.Dict, sid, phase string, initial *toolrt.Dict) (*toolrt.Dict, error) {
	states, err := sceneregistry.SceneState(data, sid, initial)
	if err != nil {
		return nil, err
	}
	state, err := toolrt.GetItem(states, phase)
	if err != nil {
		return nil, err
	}
	stateDict := state.(*toolrt.Dict)
	var scene *toolrt.Dict
	for _, item := range data.Value("scenes").([]any) {
		if record := item.(*toolrt.Dict); record.Value("id") == sid {
			scene = record
			break
		}
	}
	description, err := describe(castData, stateDict)
	if err != nil {
		return nil, err
	}
	questions, err := checklist(castData, stateDict)
	if err != nil {
		return nil, err
	}
	title := phaseTitles[phase]
	paragraph := title + " " + sid + ": состояние не задано."
	if len(description) > 0 {
		paragraph = title + " " + sid + ". " + strings.Join(description, " ")
	}
	heading, err := actionHeading(scene)
	if err != nil {
		return nil, err
	}
	text := []string{title + " " + sid + " (" + heading + ")", ""}
	if len(description) > 0 {
		text = append(text, description...)
	} else {
		text = append(text, "Состояние не задано: в кастинге нет начального состояния, а в сценах нет изменений.")
	}
	if len(questions) > 0 {
		text = append(text, "", "Проверить по кадру:")
		for _, question := range questions {
			text = append(text, "- [ ] "+question)
		}
	}
	return toolcli.Record(
		"shot", sid,
		"phase", phase,
		"state", stateDict,
		"paragraph", paragraph,
		"checklist", toolcli.Strings(questions),
		"text", strings.Join(text, "\n"),
	), nil
}

// expected — ожидаемые исключения: они печатаются текстом с кодом 1, остальные — трассировкой.
func expected(err error) bool {
	return toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError)
}

// Run — инструмент continuity_brief на разрешённом корне проекта: реестр сцен, кастинг (castregistry.Load),
// проверка кода плана и врезка; печать текста, абзаца или JSON.
func Run(root string, args []string) toolcli.Output {
	parsed, exit := toolcli.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &toolcli.Printer{}
	shot := parsed.Values["shot"][0]
	phase := "before"
	if values := parsed.Values["--phase"]; len(values) > 0 {
		phase = values[0]
	}
	result, err := build(root, shot, phase)
	if err != nil {
		if expected(err) {
			return printer.Fail(err.Error())
		}
		return printer.Crash(err)
	}
	switch {
	case parsed.Bools["--json"]:
		var text string
		if text, err = toolcli.JSON(result); err == nil {
			err = printer.Print(text)
		}
	case parsed.Bools["--paragraph"]:
		err = printer.Print(result.Value("paragraph").(string))
	default:
		err = printer.Print(result.Value("text").(string))
	}
	if err != nil {
		// Ошибка печати не входит в ожидаемые: UnicodeEncodeError одиночного суррогата — трассировка.
		return printer.Crash(err)
	}
	return printer.Exit(0)
}

// build — чтение реестра и кастинга, проверка наличия плана и построение врезки.
func build(root, shot, phase string) (*toolrt.Dict, error) {
	data, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	castData, err := castregistry.Load(root)
	if err != nil {
		return nil, err
	}
	found := false
	for _, item := range data.Value("scenes").([]any) {
		if item.(*toolrt.Dict).Value("id") == shot {
			found = true
			break
		}
	}
	if !found {
		return nil, toolrt.Raise(toolrt.ValueError, "%s: сцена отсутствует в реестре.", shot)
	}
	// Начальное состояние сущностей берётся из кастинга проекта.
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	return Brief(data, castData, shot, phase, initial)
}
