package lintregistry

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/scenario"
	"songframe/internal/sceneregistry"
)

// Застрявшее состояние. Состояние сущности наследуется по цепочке планов, пока его не изменят. Значения
// обстановки — где персонаж, на чём стоит или сидит, поза, взгляд, что в руках — после смены места
// почти всегда должны поменяться, но в большой форме сценария это легко пропустить: так «смотрит на
// часы» из начального состояния кастинга доходит до планов на улице, и опоры с видео показывают
// чужую позу. Человек этого не видит, потому что значение записано один раз далеко от плана.
//
// Проверка вычисляет состояние первого кадра каждого плана (scenario.ResolveDetailed) и для сущностей
// «В кадре (референсы)» сравнивает локации плана с локациями, где значение было задано: в плане-
// источнике, а для начального состояния кастинга — в первом плане, где сущность появилась. Если общих
// локаций нет, значение, вероятно, застряло. Это предупреждение, а не ошибка: персонажа могли
// перенести без смены позы. Одно значение, которое тянется через несколько планов, даёт одно
// предупреждение на первом из них с перечнем остальных.

// situationalProperties — свойства обстановки, которые после смены места надо пересмотреть. Одежда,
// лицо, метки, эмоция и усталость переносятся между местами и не проверяются, как и «В руках»:
// предмет в руке переходит вместе с персонажем.
var situationalProperties = []string{"position", "contact", "posture", "facing", "orientation"}

// staleValueChars — сколько символов значения цитируется в предупреждении.
const staleValueChars = 90

// staleEntity — сущность кастинга для текста предупреждения: имя, вид и подписи свойств.
type staleEntity struct {
	name, kind string
	labels     map[string]string
}

// staleFinding — одно застрявшее свойство: где впервые обнаружено, откуда значение и какие планы его
// наследуют дальше.
type staleFinding struct {
	entity, property, source, first string
	value                           string
	more                            []string
}

// lintStaleState — предупреждения о значениях обстановки, унаследованных через смену места. Реестр
// или кастинг неожиданной формы пропускаются молча: их ошибки сообщают другие проверки.
func lintStaleState(root string, r *Report) {
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(sceneregistry.ScenesPath)))
	if err != nil {
		return
	}
	registry, err := dynvalue.Parse(raw)
	if err != nil {
		return
	}
	read := cast.Read(root)
	if !dynvalue.Truthy(read.Value) {
		return
	}
	entities := staleEntities(read.Value)
	initial, err := cast.InitialStates(read.Value)
	if err != nil {
		return
	}
	details, err := scenario.ResolveDetailed(registry, initial)
	if err != nil {
		return
	}
	scenes, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	locations := map[string][]string{}
	order := []string{}
	firstSeen := map[string]string{}
	references := map[string][]string{}
	for _, scene := range scenes {
		id, _ := dynvalue.Get(scene, "id").(string)
		if id == "" || dynvalue.Truthy(dynvalue.Get(scene, "derived_from")) {
			continue
		}
		order = append(order, id)
		refs, _ := dynvalue.AsArray(dynvalue.Get(scene, "references"))
		for _, ref := range refs {
			key, _ := ref.(string)
			if key == "" {
				continue
			}
			references[id] = append(references[id], key)
			if entities[key].kind == "location" {
				locations[id] = append(locations[id], key)
			} else if _, seen := firstSeen[key]; !seen && entities[key].kind != "" {
				firstSeen[key] = id
			}
		}
	}
	findings := []*staleFinding{}
	index := map[string]*staleFinding{}
	for _, shot := range order {
		here := locations[shot]
		detail, ok := details[shot]
		if len(here) == 0 || !ok {
			continue
		}
		sources := detail.Sources["before"]
		for _, entityID := range references[shot] {
			entity := entities[entityID]
			if entity.kind == "" || entity.kind == "location" || entity.kind == "world" || sources == nil {
				continue
			}
			bySource, _ := sources.Value(entityID).(*dynvalue.Object)
			if bySource == nil {
				continue
			}
			for _, property := range situationalProperties {
				source := bySource.Value(property)
				origin, label := staleOrigin(source, firstSeen[entityID])
				if origin == "" || origin == shot || !disjoint(here, locations[origin]) {
					continue
				}
				value, _ := dynvalue.Get(dynvalue.Get(detail.State.Before, entityID), property).(string)
				// Предмет или транспорт, чьё положение задано персонажем плана («в правой руке Артёма»),
				// переходит вместе с ним.
				if entity.kind != "character" && mentionsCharacter(value, references[shot], entities) {
					continue
				}
				key := entityID + "\x00" + property + "\x00" + label
				if found := index[key]; found != nil {
					found.more = append(found.more, shot)
					continue
				}
				finding := &staleFinding{entity: entityID, property: property, source: label, first: shot, value: value}
				index[key] = finding
				findings = append(findings, finding)
			}
		}
	}
	// Свойства одной сущности из одного источника, впервые застрявшие в одном плане, — одно предупреждение.
	type group struct {
		entity, source, first string
		items                 []*staleFinding
	}
	groups := []*group{}
	for _, finding := range findings {
		at := slices.IndexFunc(groups, func(item *group) bool {
			return item.entity == finding.entity && item.source == finding.source && item.first == finding.first
		})
		if at < 0 {
			groups = append(groups, &group{entity: finding.entity, source: finding.source, first: finding.first})
			at = len(groups) - 1
		}
		groups[at].items = append(groups[at].items, finding)
	}
	for _, item := range groups {
		entity := entities[item.entity]
		values := make([]string, len(item.items))
		more := []string{}
		for position, finding := range item.items {
			label := entity.labels[finding.property]
			if label == "" {
				label = finding.property
			}
			values[position] = "«" + label + "» — «" + clip(finding.value) + "»"
			for _, shot := range finding.more {
				if !slices.Contains(more, shot) {
					more = append(more, shot)
				}
			}
		}
		origin := item.source
		originShot := origin
		if origin == "cast" {
			originShot = firstSeen[item.entity]
		}
		r.warning(sceneregistry.ScenesPath, item.first+" · "+entity.name, textStaleState(staleText{
			entity: entity.name, shot: item.first, here: locationNames(entities, locations[item.first]),
			fromCast: origin == "cast", origin: originShot, there: locationNames(entities, locations[originShot]),
			values: values, more: more,
		}))
	}
}

// staleOrigin — план, где было задано значение, и метка источника для группировки: «cast» для
// начального состояния (тогда план — первое появление сущности) или ID плана. Пусто — источник
// неизвестен.
func staleOrigin(source any, firstSeen string) (shot, label string) {
	switch dynvalue.Get(source, "kind") {
	case "cast":
		return firstSeen, "cast"
	case "plan":
		id, _ := dynvalue.Get(source, "shot").(string)
		return id, id
	}
	return "", ""
}

// disjoint — у двух непустых наборов локаций нет общих.
func disjoint(left, right []string) bool {
	if len(left) == 0 || len(right) == 0 {
		return false
	}
	return !slices.ContainsFunc(left, func(item string) bool { return slices.Contains(right, item) })
}

// staleEntities — сущности кастинга с подписями свойств их вида (как в форме кастинга).
func staleEntities(value any) map[string]staleEntity {
	result := map[string]staleEntity{}
	defaults := cast.LoadDefaults()
	normalized, err := cast.EnsureProperties(value, defaults)
	if err != nil {
		return result
	}
	kinds, _ := dynvalue.AsObject(normalized.Value("properties"))
	entities, _ := dynvalue.AsArray(normalized.Value("entities"))
	for _, entity := range entities {
		id, _ := dynvalue.Get(entity, "id").(string)
		name, _ := dynvalue.Get(entity, "name").(string)
		kind, _ := dynvalue.Get(entity, "kind").(string)
		if id == "" {
			continue
		}
		if name == "" {
			name = id
		}
		var list any
		if kinds != nil {
			list = kinds.Value(kind)
		}
		items, _ := dynvalue.AsArray(list)
		if items == nil {
			items, _ = dynvalue.AsArray(defaults.Generic)
		}
		labels := map[string]string{}
		for _, item := range items {
			if key, ok := dynvalue.Get(item, "key").(string); ok {
				labels[key], _ = dynvalue.Get(item, "label").(string)
			}
		}
		result[id] = staleEntity{name: name, kind: kind, labels: labels}
	}
	return result
}

// locationNames — имена локаций через запятую в кавычках.
func locationNames(entities map[string]staleEntity, ids []string) string {
	names := make([]string, len(ids))
	for index, id := range ids {
		names[index] = "«" + entities[id].name + "»"
	}
	return strings.Join(names, ", ")
}

// clip — значение для цитаты: не длиннее staleValueChars символов, без точки в конце.
func clip(value string) string {
	value = strings.TrimRight(strings.TrimSpace(value), ".")
	if utf8.RuneCountInString(value) <= staleValueChars {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:staleValueChars])) + "…"
}

// staleText — данные предупреждения о застрявшем состоянии.
type staleText struct {
	entity, shot, here string
	fromCast           bool
	origin, there      string
	values, more       []string
}

// textStaleState — предупреждение для человека: что унаследовано, откуда, чем это грозит и где
// исправить (названия блоков страницы «Сценарий», без путей и ключей файла).
func textStaleState(t staleText) string {
	source := "из плана " + t.origin + " (место: " + t.there + ")"
	if t.fromCast {
		source = "из начального состояния в кастинге — его задумывали для первого появления в " + t.origin + " (место: " + t.there + ")"
	}
	text := t.entity + " в " + t.shot + " (место: " + t.here + ") всё ещё в прежней обстановке " + source + ": " +
		strings.Join(t.values, "; ") + ". Место сменилось, а эти значения никто не обновил, поэтому опоры и видео покажут прежние положение, позу или взгляд. " +
		"Если это ошибка, задайте новые значения у " + t.shot + " в блоке «Состояние героев и мира», «Первый кадр (before)»; если персонаж действительно перенёсся без изменений, оставьте как есть."
	if len(t.more) > 0 {
		text += " Это же значение дальше получают: " + strings.Join(t.more, ", ") + "."
	}
	return text
}

// mentionsCharacter — значение называет персонажа из refs по основе первого слова имени (без
// последней буквы, чтобы совпали падежи: «Артём» — «Артёма»).
func mentionsCharacter(value string, refs []string, entities map[string]staleEntity) bool {
	text := foldMention(value)
	for _, id := range refs {
		entity := entities[id]
		words := strings.Fields(entity.name)
		if entity.kind != "character" || len(words) == 0 {
			continue
		}
		stem := []rune(foldMention(words[0]))
		if len(stem) > 3 {
			stem = stem[:len(stem)-1]
		}
		if strings.Contains(text, string(stem)) {
			return true
		}
	}
	return false
}
