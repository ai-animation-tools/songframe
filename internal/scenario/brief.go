package scenario

import (
	"encoding/json"
	"sort"
	"strings"
	"unicode/utf16"

	"songframe-go/internal/cast"
	"songframe-go/internal/jscompat"
)

// Brief — BriefResult контракта, ответ scenario.brief: вычисленное состояние плана на первом или
// последнем кадре, его источники и подписи, абзац для производственного промпта, чек-лист и
// Markdown-текст в формате continuity_brief. Объекты состояния передаются с порядком ключей
// оригинала: от него зависит порядок строк врезки в интерфейсе.
type Brief struct {
	Shot      string          `json:"shot"`
	Phase     string          `json:"phase"`
	State     json.RawMessage `json:"state"`
	Sources   json.RawMessage `json:"sources"`
	Labels    json.RawMessage `json:"labels"`
	Inherited json.RawMessage `json:"inherited"`
	Paragraph string          `json:"paragraph"`
	Checklist []string        `json:"checklist"`
	Text      string          `json:"text"`
}

// property — элемент словаря свойств, нужный врезке: подпись и шаблон вопроса чек-листа.
type property struct {
	label     any
	checklist any
}

// vocabulary — Map «код свойства → свойство» одного типа (`new Map(items.map((p) => [p.key, p]))`).
type vocabulary struct {
	keys  []string
	props map[string]property
}

func newVocabulary(items []any) (*vocabulary, error) {
	result := &vocabulary{props: map[string]property{}}
	for _, item := range items {
		key, err := jscompat.Prop(item, "key")
		if err != nil {
			return nil, err
		}
		name := jscompat.ToString(key)
		if _, ok := result.props[name]; !ok {
			result.keys = append(result.keys, name)
		}
		result.props[name] = property{label: jscompat.Get(item, "label"), checklist: jscompat.Get(item, "checklist")}
	}
	return result, nil
}

// replaceFirst — String.prototype.replace со строковым образцом: первая подстановка, в строке
// замены действуют шаблоны $$, $&, $` и $'.
func replaceFirst(text, pattern, replacement string) string {
	index := strings.Index(text, pattern)
	if index < 0 {
		return text
	}
	var builder strings.Builder
	for i := 0; i < len(replacement); i++ {
		if replacement[i] != '$' || i+1 >= len(replacement) {
			builder.WriteByte(replacement[i])
			continue
		}
		switch replacement[i+1] {
		case '$':
			builder.WriteByte('$')
		case '&':
			builder.WriteString(pattern)
		case '`':
			builder.WriteString(text[:index])
		case '\'':
			builder.WriteString(text[index+len(pattern):])
		default:
			builder.WriteByte('$')
			continue
		}
		i++
	}
	return text[:index] + builder.String() + text[index+len(pattern):]
}

// sliceUTF16 — `text.slice(0, limit)` и `text.length > limit` по кодовым единицам UTF-16.
func sliceUTF16(text string, limit int) (string, bool) {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text, false
	}
	return string(utf16.Decode(units[:limit])), true
}

// BuildBrief — buildBrief (continuity_brief): мир первым, затем сущности кастинга в его порядке,
// затем коды вне кастинга по алфавиту; подписи — из словаря кастинга или общего набора по
// умолчанию для типа без словаря. data — черновик реестра со страницы, castValue — кастинг проекта
// или nil. Ошибка — неизвестный план или фаза и исключение вычисления состояния.
func BuildBrief(data, castValue any, sid, phase string) (Brief, error) {
	initial, err := cast.InitialStates(castValue)
	if err != nil {
		return Brief{}, err
	}
	details, err := ResolveDetailed(data, initial)
	if err != nil {
		return Brief{}, err
	}
	detail, found := details[sid]
	var state, inherited, sources *jscompat.Object
	if found {
		switch phase {
		case "before":
			state, inherited = detail.State.Before, detail.Inherited.Before
		case "after":
			state, inherited = detail.State.After, detail.Inherited.After
		}
		sources = detail.Sources[phase]
	}
	list, err := jscompat.Iterate(jscompat.Get(data, "scenes"))
	if err != nil {
		return Brief{}, err
	}
	var scene any
	sceneFound := false
	for _, item := range list {
		if jscompat.StrictEqual(jscompat.Get(item, "id"), sid) {
			scene, sceneFound = item, true
			break
		}
	}
	if state == nil || !sceneFound {
		return Brief{}, errorText(textBriefShotMissing(sid))
	}
	defaults := cast.LoadDefaults()
	entities, err := jscompat.Iterate(jscompat.Coalesce(jscompat.Get(castValue, "entities"), &jscompat.Array{}))
	if err != nil {
		return Brief{}, err
	}
	type info struct{ name, kind any }
	names := map[string]info{}
	namesHas := func(id string) bool { _, ok := names[id]; return ok }
	for _, entity := range entities {
		id, err := jscompat.Prop(entity, "id")
		if err != nil {
			return Brief{}, err
		}
		names[jscompat.ToString(id)] = info{jscompat.Get(entity, "name"), jscompat.Get(entity, "kind")}
	}
	vocab := map[string]*vocabulary{}
	propertiesEntries, err := jscompat.Entries(jscompat.Coalesce(jscompat.Get(castValue, "properties"), jscompat.NewObject()))
	if err != nil {
		return Brief{}, err
	}
	for _, entry := range propertiesEntries {
		items, ok := jscompat.AsArray(entry.Value)
		if !ok {
			return Brief{}, &jscompat.TypeError{Message: "items.map is not a function"}
		}
		if vocab[entry.Key], err = newVocabulary(items); err != nil {
			return Brief{}, err
		}
	}
	for _, entity := range entities {
		kind := jscompat.ToString(jscompat.Get(entity, "kind"))
		if _, ok := vocab[kind]; !ok {
			if vocab[kind], err = newVocabulary(defaults.Generic.Items); err != nil {
				return Brief{}, err
			}
		}
	}
	propsOf := func(entity string) *vocabulary {
		if item, ok := names[entity]; ok {
			return vocab[jscompat.ToString(item.kind)]
		}
		return nil
	}
	lookup := func(props *vocabulary, key string) (property, bool) {
		if props == nil {
			return property{}, false
		}
		item, ok := props.props[key]
		return item, ok
	}
	// Порядок: сущности кастинга с состоянием (мир первым, устойчиво), затем прочие коды по UTF-16.
	var known []string
	for _, entity := range entities {
		id := jscompat.ToString(jscompat.Get(entity, "id"))
		if jscompat.Truthy(state.Value(id)) {
			known = append(known, id)
		}
	}
	sort.SliceStable(known, func(i, j int) bool { return known[i] == cast.WorldID && known[j] != cast.WorldID })
	var others []string
	for _, id := range state.Keys() {
		if !namesHas(id) {
			others = append(others, id)
		}
	}
	sortUTF16(others)
	order := append(known, others...)

	labels := jscompat.NewObject()
	for _, entity := range state.Keys() {
		props := propsOf(entity)
		for _, key := range state.Value(entity).(*jscompat.Object).Keys() {
			item, ok := lookup(props, key)
			if ok && jscompat.Truthy(item.label) {
				group, exists := labels.Get(entity)
				if !exists {
					group = jscompat.NewObject()
					labels.Set(entity, group)
				}
				group.(*jscompat.Object).Set(key, item.label)
			}
		}
	}
	description := []string{}
	checklist := []string{}
	for _, eid := range order {
		entityInfo, hasInfo := names[eid]
		props := propsOf(eid)
		displayName := eid
		if hasInfo && !jscompat.IsNullish(entityInfo.name) {
			displayName = jscompat.ToString(entityInfo.name)
		}
		attributes := state.Value(eid).(*jscompat.Object)
		var parts []string
		for _, key := range attributes.Keys() {
			value := jscompat.ToString(attributes.Value(key))
			item, ok := lookup(props, key)
			label := strings.ReplaceAll(key, "_", " ")
			if ok && !jscompat.IsNullish(item.label) {
				label = jscompat.ToString(item.label)
			}
			parts = append(parts, strings.ToLower(label)+": "+value)
			if ok && jscompat.Truthy(item.checklist) {
				checklist = append(checklist, displayName+": "+replaceFirst(jscompat.ToString(item.checklist), "{value}", value))
			}
		}
		description = append(description, displayName+": "+strings.Join(parts, "; ")+".")
	}
	title := textBriefTitleAfter
	if phase == "before" {
		title = textBriefTitleBefore
	}
	paragraph := title + " " + sid + ": состояние не задано."
	if len(description) > 0 {
		paragraph = title + " " + sid + ". " + strings.Join(description, " ")
	}
	action, err := jscompat.Prop(scene, "action")
	if err != nil {
		return Brief{}, err
	}
	actionText, ok := action.(string)
	if !ok {
		return Brief{}, &jscompat.TypeError{Message: "scene.action.slice is not a function"}
	}
	short, cut := sliceUTF16(actionText, 80)
	if cut {
		short += "…"
	}
	text := []string{title + " " + sid + " (" + short + ")", ""}
	if len(description) > 0 {
		text = append(text, description...)
	} else {
		text = append(text, textBriefStateUnsetPrefix+textBriefStateUnsetSentence)
	}
	if len(checklist) > 0 {
		text = append(text, "", textBriefChecklistTitle)
		for _, question := range checklist {
			text = append(text, "- [ ] "+question)
		}
	}
	if sources == nil {
		sources = jscompat.NewObject()
	}
	if inherited == nil {
		inherited = jscompat.NewObject()
	}
	return Brief{
		Shot: sid, Phase: phase,
		State: jscompat.Raw(state), Sources: jscompat.Raw(sources), Labels: jscompat.Raw(labels), Inherited: jscompat.Raw(inherited),
		Paragraph: paragraph, Checklist: checklist, Text: strings.Join(text, "\n"),
	}, nil
}

// errorText — ошибка с текстом для пользователя.
type errorText string

func (e errorText) Error() string { return string(e) }

// ProjectBrief — scenario.brief: врезка по черновику реестра со страницы и кастингу проекта
// (`readCast(project) || null`). Агент и провайдеры не нужны; ничего не пишет.
func ProjectBrief(project string, data any, sid, phase string) (Brief, error) {
	return BuildBrief(data, readCastValue(project), sid, phase)
}
