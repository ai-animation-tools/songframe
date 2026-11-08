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

	"songframe-go/internal/cast"
	"songframe-go/internal/castregistry"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// Parser — разбор аргументов в семантике argparse: код плана позиционным аргументом, фаза и
// формат вывода.
var Parser = pycompat.ArgParser{
	Prog:        "continuity_brief.py",
	Description: "Врезка непрерывности и чек-лист для плана.",
	Flags: []pycompat.Flag{
		{Name: "--phase", Value: true, Choices: []string{"before", "after"}},
		{Name: "--json"},
		{Name: "--paragraph", Help: "Только абзац для вставки в промпт"},
	},
	Positionals: []pycompat.Positional{{Name: "shot", Help: "Код плана, например M37"}},
}

// phaseTitles — заголовок врезки по фазе плана.
var phaseTitles = map[string]string{"before": "Состояние на первый кадр", "after": "Состояние на последний кадр"}

// defaultProperties и genericProperties — словари свойств по типу сущности и общий набор моделью
// значений Python. Источник — встроенный словарь internal/cast/default_properties.json,
// разобранный один раз.
var defaultProperties, genericProperties = loadDefaults()

// loadDefaults переводит встроенный словарь кастинга из модели JS в модель Python через JSON:
// в словаре только строки, списки и объекты, поэтому перевод без потерь.
func loadDefaults() (*pycompat.Dict, []any) {
	defaults := cast.LoadDefaults()
	parse := func(value any) any {
		result, err := pycompat.LoadsJSON(jscompat.Stringify(value))
		if err != nil {
			panic("встроенный словарь кастинга не разбирается моделью Python: " + err.Error())
		}
		return result
	}
	return parse(defaults.Default).(*pycompat.Dict), parse(defaults.Generic).([]any)
}

// props — словарь свойств одного типа сущности {key: свойство}: ключи — любые хешируемые
// значения item["key"] (семантика словаря Python), поиск — по строковому ключу состояния.
type props map[string]*pycompat.Dict

// get — props.get(key, {}): свойство или nil.
func (p props) get(key string) *pycompat.Dict {
	hash, _ := pycompat.HashKey(key)
	return p[hash]
}

// propsOf — {item["key"]: item for item in items}: ошибки неверной формы словаря — исключения
// Python (не итерируемое, нет key, нехешируемый ключ).
func propsOf(items any) (props, error) {
	list, err := pycompat.Iter(items)
	if err != nil {
		return nil, err
	}
	result := props{}
	for _, item := range list {
		key, err := pycompat.GetItem(item, "key")
		if err != nil {
			return nil, err
		}
		hash, err := pycompat.HashKey(key)
		if err != nil {
			return nil, err
		}
		// item["key"] удался, значит item — словарь (у списка и строки индекс строкой — TypeError).
		result[hash] = item.(*pycompat.Dict)
	}
	return result, nil
}

// labels — labels(cast) из cast_registry: подписи свойств по типу сущности; типу без словаря
// достаётся общий набор. nil-кастинг — словарь по умолчанию.
func labels(castData *pycompat.Dict) (map[string]props, error) {
	result := map[string]props{}
	source := defaultProperties
	if castData != nil {
		source = castData.Value("properties").(*pycompat.Dict)
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
			kind := item.(*pycompat.Dict).Value("kind").(string)
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

// entityNames — {e["id"]: (e["name"], e["kind"])}: кастинг уже прошёл validate_cast, поэтому
// id, имя и тип — строки.
func entityNames(castData *pycompat.Dict) (map[string]entity, []string) {
	names := map[string]entity{}
	known := []string{}
	if castData == nil {
		return names, known
	}
	for _, item := range castData.Value("entities").([]any) {
		record := item.(*pycompat.Dict)
		id := record.Value("id").(string)
		names[id] = entity{name: record.Value("name").(string), kind: record.Value("kind").(string)}
		known = append(known, id)
	}
	return names, known
}

// entityOrder — мир первым, дальше порядок кастинга, затем сущности, которых в
// кастинге нет (по алфавиту кодовых точек).
func entityOrder(castData *pycompat.Dict, state *pycompat.Dict) []string {
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

// lookup — имя, словарь свойств и значения состояния сущности (names.get(eid, (eid, None)),
// vocab.get(kind, {}) и state[eid]).
func lookup(names map[string]entity, vocab map[string]props, state *pycompat.Dict, id string) (string, props, *pycompat.Dict) {
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
	values, _ := state.Value(id).(*pycompat.Dict)
	if values == nil {
		values = pycompat.NewDict()
	}
	return record.name, properties, values
}

// describe — describe(cast, state): строки «Имя: подпись свойства: значение; …» для каждой
// сущности с состоянием. Подпись без label — ключ с пробелами вместо «_».
func describe(castData *pycompat.Dict, state *pycompat.Dict) ([]string, error) {
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
				return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'lower'", pycompat.TypeName(label))
			}
			parts = append(parts, pythonLower(text)+": "+pycompat.Str(values.Value(key)))
		}
		lines = append(lines, name+": "+strings.Join(parts, "; ")+".")
	}
	return lines, nil
}

// checklist — checklist(cast, state): вопросы «да или нет» по свойствам с шаблоном checklist в
// словаре (template.format(value=значение)); остальные свойства не спрашиваются.
func checklist(castData *pycompat.Dict, state *pycompat.Dict) ([]string, error) {
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
			if item == nil || !pycompat.Truthy(item.Value("checklist")) {
				continue
			}
			template, ok := item.Value("checklist").(string)
			if !ok {
				return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'format'", pycompat.TypeName(item.Value("checklist")))
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

// actionHeading — f"{scene['action'][:80]}{'…' if len(scene['action']) > 80 else ”}": первые 80
// кодовых точек действия и многоточие у длинного. Список режется по элементам и печатается repr;
// прочие типы — исключения Python (срез словаря в 3.12 — KeyError slice(None, 80, None)).
func actionHeading(scene *pycompat.Dict) (string, error) {
	action, err := pycompat.GetItem(scene, "action")
	if err != nil {
		return "", err
	}
	switch value := action.(type) {
	case string:
		runes := pycompat.Runes(value)
		if len(runes) > 80 {
			return pycompat.FromRunes(runes[:80]) + "…", nil
		}
		return value, nil
	case []any:
		if len(value) > 80 {
			return pycompat.Repr(value[:80]) + "…", nil
		}
		return pycompat.Repr(value), nil
	case *pycompat.Dict:
		return "", pycompat.New(pycompat.KeyError, "slice(None, 80, None)")
	}
	return "", pycompat.Raise(pycompat.TypeError, "'%s' object is not subscriptable", pycompat.TypeName(action))
}

// Brief — врезка плана sid реестра data на фазу before/after. castData — кастинг
// castregistry.Load (nil — нет кастинга), initial — начальное состояние сущностей
// (sceneregistry.InitialStatesFor проекта). Результат — словарь {shot, phase, state, paragraph,
// checklist, text} в порядке ключей вывода --json.
func Brief(data *pycompat.Dict, castData *pycompat.Dict, sid, phase string, initial *pycompat.Dict) (*pycompat.Dict, error) {
	states, err := sceneregistry.SceneState(data, sid, initial)
	if err != nil {
		return nil, err
	}
	state, err := pycompat.GetItem(states, phase)
	if err != nil {
		return nil, err
	}
	stateDict := state.(*pycompat.Dict)
	var scene *pycompat.Dict
	for _, item := range data.Value("scenes").([]any) {
		if record := item.(*pycompat.Dict); record.Value("id") == sid {
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
	return pytool.Record(
		"shot", sid,
		"phase", phase,
		"state", stateDict,
		"paragraph", paragraph,
		"checklist", pytool.Strings(questions),
		"text", strings.Join(text, "\n"),
	), nil
}

// expected — ожидаемые исключения: они печатаются текстом с кодом 1, остальные — трассировкой.
func expected(err error) bool {
	return pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError)
}

// Run — main() инструмента на разрешённом корне проекта: реестр (load), кастинг (load_cast),
// проверка кода плана и врезка; печать текста, абзаца или JSON.
func Run(root string, args []string) pytool.Output {
	parsed, exit := pytool.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &pytool.Printer{}
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
		if text, err = pytool.JSON(result); err == nil {
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
func build(root, shot, phase string) (*pycompat.Dict, error) {
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
		if item.(*pycompat.Dict).Value("id") == shot {
			found = true
			break
		}
	}
	if !found {
		return nil, pycompat.Raise(pycompat.ValueError, "%s: сцена отсутствует в реестре.", shot)
	}
	// Начальное состояние сущностей берётся из кастинга проекта.
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	return Brief(data, castData, shot, phase, initial)
}
