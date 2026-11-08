// Package scenario переносит вычисления по реестру сцен plan/scenes.json: наследование состояния
// сущностей по state_from (resolveStates) и отпечаток постановки плана (sceneFingerprints).
//
// Отпечаток сравнивается с scene_sha256, записанным при приёмке комплекта; он должен совпадать
// байт в байт с оригиналом и с tools/scene_registry, иначе все принятые планы станут «устаревшими».
// Поэтому реестр обрабатывается как дерево jscompat по правилам JS, включая тексты исключений:
// ошибка вычисления состояния попадает в проблему статуса дословно.
package scenario

import (
	"errors"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
)

// slug — допустимый код сущности и свойства состояния.
var slug = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Сообщения scenarioTexts.main.state*: текст выводится пользователю в проблеме сверки планов.
func stateChangesInvalid(shot string) error {
	return errors.New(shot + ": изменения состояния должны быть объектом.")
}
func stateEntityInvalid(shot, entity string) error {
	return errors.New(shot + ": неверный объект состояния " + entity + ".")
}
func statePropertyInvalid(shot, entity, property string) error {
	return errors.New(shot + ": неверное свойство состояния " + entity + "." + property + ".")
}
func stateCycle(chain string) error { return errors.New("Цикл state_from: " + chain) }
func stateUnknownSource(shot string) error {
	return errors.New(shot + ": неизвестный источник state_from.")
}
func stateInvalidPhase(shot string) error {
	return errors.New(shot + ": неверная фаза state_from.")
}
func stateSameHasChanges(shot string) error {
	return errors.New(shot + ": повтор same не допускает своих state_changes.")
}

// tracked — состояние «сущность → свойство → значение» на одной фазе плана вместе с источником
// каждого значения (resolveStateSources): начальное состояние кастинга или изменение плана в его
// фазе. values и sources всегда одной формы; значения сериализуются в отпечаток, источники нужны
// только врезке непрерывности для перехода к месту правки.
type tracked struct {
	values  *jscompat.Object
	sources *jscompat.Object
}

// resolved — состояние плана: до правок первого кадра (incoming), на первом и на последнем кадре.
type resolved struct {
	before, after, incoming tracked
}

// phaseState выбирает состояние по фазе как `incoming[phase]`: ключ приводится к строке, а
// неизвестная фаза даёт undefined (ok=false) и TypeError при последующем копировании.
func (r resolved) phaseState(phase any) (tracked, bool) {
	switch jscompat.ToString(phase) {
	case "before":
		return r.before, true
	case "after":
		return r.after, true
	case "incoming":
		return r.incoming, true
	}
	return tracked{}, false
}

// orderedMap — Map JS с ключами-значениями jscompat и порядком первой вставки.
type orderedMap[V any] struct {
	keys   []any
	values map[any]V
}

func newOrderedMap[V any]() *orderedMap[V] { return &orderedMap[V]{values: map[any]V{}} }

func (m *orderedMap[V]) set(key any, value V) {
	if _, ok := m.values[key]; !ok {
		m.keys = append(m.keys, key)
	}
	m.values[key] = value
}

func (m *orderedMap[V]) get(key any) (V, bool) {
	value, ok := m.values[key]
	return value, ok
}

// copyLevels копирует объект «сущность → свойство → значение» на два уровня (порядок сохраняется).
func copyLevels(state *jscompat.Object) *jscompat.Object {
	result := jscompat.NewObject()
	for _, entity := range state.Keys() {
		result.Set(entity, state.Value(entity).(*jscompat.Object).Clone())
	}
	return result
}

// cloneState — clone() оригинала: независимая копия состояния; неизвестная фаза (ok=false) —
// TypeError Object.entries(undefined).
func cloneState(state tracked, ok bool) (tracked, error) {
	if !ok {
		return tracked{}, &jscompat.TypeError{Message: "Cannot convert undefined or null to object"}
	}
	return tracked{values: copyLevels(state.values), sources: copyLevels(state.sources)}, nil
}

// planSource — источник значения из изменения плана: { kind: 'plan', shot, phase }.
func planSource(shot any, phase string) *jscompat.Object {
	source := jscompat.NewObject()
	source.Set("kind", "plan")
	source.Set("shot", shot)
	source.Set("phase", phase)
	return source
}

// apply накладывает state_changes.before/after на состояние; null удаляет свойство, пустая
// сущность исчезает. Проверки и их порядок совпадают с _resolve_states. sid — код плана (как в
// исключениях), shot — исходное значение id для источника значения.
func apply(state tracked, delta any, sid string, shot any, phase string) (tracked, error) {
	result, _ := cloneState(state, true)
	if !jscompat.Truthy(delta) {
		return result, nil
	}
	changes, ok := jscompat.AsObject(delta)
	if !ok {
		return tracked{}, stateChangesInvalid(sid)
	}
	for _, entity := range changes.Keys() {
		attributes, ok := jscompat.AsObject(changes.Value(entity))
		if !slug.MatchString(entity) || !ok {
			return tracked{}, stateEntityInvalid(sid, entity)
		}
		for _, key := range attributes.Keys() {
			value := attributes.Value(key)
			text, isString := value.(string)
			if !slug.MatchString(key) || (value != nil && (!isString || jscompat.Trim(text) == "")) {
				return tracked{}, statePropertyInvalid(sid, entity, key)
			}
			current, exists := result.values.Get(entity)
			if value == nil {
				if exists {
					current.(*jscompat.Object).Delete(key)
					result.sources.Value(entity).(*jscompat.Object).Delete(key)
				}
				continue
			}
			if !exists {
				current = jscompat.NewObject()
				result.values.Set(entity, current)
				result.sources.Set(entity, jscompat.NewObject())
			}
			current.(*jscompat.Object).Set(key, text)
			result.sources.Value(entity).(*jscompat.Object).Set(key, planSource(shot, phase))
		}
		if current, exists := result.values.Get(entity); exists && current.(*jscompat.Object).Len() == 0 {
			result.values.Delete(entity)
			result.sources.Delete(entity)
		}
	}
	return result, nil
}

// ResolvedState — вычисленное состояние сущностей плана на первом и последнем кадре.
type ResolvedState struct {
	Before *jscompat.Object
	After  *jscompat.Object
}

// Object — `{ before, after }` для JSON.stringify: так оригинал сравнивает состояния планов.
func (s ResolvedState) Object() *jscompat.Object {
	object := jscompat.NewObject()
	object.Set("before", s.Before)
	object.Set("after", s.After)
	return object
}

// ResolveStates — resolveStates: состояние каждого плана с учётом state_from (по умолчанию —
// итог предыдущего плана, фаза same повторяет источник) и начального состояния кастинга.
// Ключ результата — String(id) плана. Ошибка — исключение оригинала (цикл, неизвестный источник,
// неверные изменения, TypeError на нестандартном реестре).
func ResolveStates(data any, initial *jscompat.Object) (*jscompat.Object, error) {
	states, err := resolveTracked(data, initial)
	if err != nil {
		return nil, err
	}
	result := jscompat.NewObject()
	for _, key := range states.Keys() {
		state := states.Value(key).(resolved)
		result.Set(key, ResolvedState{Before: state.before.values, After: state.after.values})
	}
	return result, nil
}

// Detailed — полное вычисление одного плана для врезки непрерывности: состояние (resolveStates),
// состояние до правок блока (resolveInherited: для первого кадра — пришедшее по state_from, для
// последнего — первый кадр) и источники значений (resolveStateSources) по фазам.
type Detailed struct {
	State     ResolvedState
	Inherited ResolvedState
	// Sources — фаза → сущность → свойство → источник ({kind:'cast'} или {kind:'plan', shot, phase}).
	Sources map[string]*jscompat.Object
}

// ResolveDetailed вычисляет Detailed для всех планов за один обход реестра; ключ — String(id).
func ResolveDetailed(data any, initial *jscompat.Object) (map[string]Detailed, error) {
	states, err := resolveTracked(data, initial)
	if err != nil {
		return nil, err
	}
	result := map[string]Detailed{}
	for _, key := range states.Keys() {
		state := states.Value(key).(resolved)
		result[key] = Detailed{
			State:     ResolvedState{Before: state.before.values, After: state.after.values},
			Inherited: ResolvedState{Before: state.incoming.values, After: state.before.values},
			Sources:   map[string]*jscompat.Object{"before": state.before.sources, "after": state.after.sources},
		}
	}
	return result, nil
}

// resolveTracked обходит планы в порядке реестра с мемоизацией и обнаружением циклов.
func resolveTracked(data any, initial *jscompat.Object) (*jscompat.Object, error) {
	list, err := jscompat.Iterate(jscompat.Get(data, "scenes"))
	if err != nil {
		return nil, err
	}
	scenes := newOrderedMap[any]()
	for _, scene := range list {
		id, err := jscompat.Prop(scene, "id")
		if err != nil {
			return nil, err
		}
		scenes.set(id, scene)
	}
	previous := newOrderedMap[any]()
	for index, scene := range list {
		id := jscompat.Get(scene, "id")
		if index == 0 {
			previous.set(id, nil)
		} else {
			previous.set(id, jscompat.Get(list[index-1], "id"))
		}
	}
	start := tracked{values: jscompat.NewObject(), sources: jscompat.NewObject()}
	castSource := jscompat.NewObject()
	castSource.Set("kind", "cast")
	for _, entity := range initial.Keys() {
		attributes, err := jscompat.Entries(initial.Value(entity))
		if err != nil {
			return nil, err
		}
		values := jscompat.NewObject()
		origins := jscompat.NewObject()
		for _, attribute := range attributes {
			values.Set(attribute.Key, attribute.Value)
			origins.Set(attribute.Key, castSource)
		}
		start.values.Set(entity, values)
		start.sources.Set(entity, origins)
	}
	done := newOrderedMap[resolved]()
	var visiting []any

	var visit func(sid any) (resolved, error)
	visit = func(sid any) (resolved, error) {
		if value, ok := done.get(sid); ok {
			return value, nil
		}
		for _, item := range visiting {
			if item == sid {
				chain := append(append([]any(nil), visiting...), sid)
				return resolved{}, stateCycle(jscompat.Join(chain, " → "))
			}
		}
		name := jscompat.ToString(sid)
		scene, ok := scenes.get(sid)
		if !ok || !jscompat.Truthy(scene) {
			return resolved{}, stateUnknownSource(name)
		}
		visiting = append(visiting, sid)
		from := jscompat.Get(scene, "state_from")
		var source any
		var phase any = "after"
		switch {
		case from == jscompat.Undefined:
			previousID, _ := previous.get(sid)
			source = jscompat.Coalesce(previousID, nil)
		case jscompat.TypeOf(from) == "object" && from != nil:
			source = jscompat.Get(from, "scene")
			phase = jscompat.Get(from, "phase")
		default:
			source = from
		}
		if source == nil && !jscompat.StrictEqual(phase, "after") {
			return resolved{}, stateInvalidPhase(name)
		}
		if _, isString := source.(string); source != nil && !isString {
			source = nil
			phase = "after"
		}
		changes := jscompat.Coalesce(jscompat.Get(scene, "state_changes"), jscompat.NewObject())
		var incoming resolved
		if source != nil {
			value, err := visit(source)
			if err != nil {
				return resolved{}, err
			}
			incoming = value
		} else {
			incoming.before, _ = cloneState(start, true)
			incoming.after, _ = cloneState(start, true)
			incoming.incoming, _ = cloneState(start, true)
		}
		var value resolved
		before := jscompat.Get(changes, "before")
		after := jscompat.Get(changes, "after")
		if jscompat.StrictEqual(phase, "same") {
			if jscompat.Truthy(before) || jscompat.Truthy(after) {
				return resolved{}, stateSameHasChanges(name)
			}
			value.before, _ = cloneState(incoming.before, true)
			value.after, _ = cloneState(incoming.after, true)
			value.incoming, _ = cloneState(incoming.before, true)
		} else {
			base, err := cloneState(incoming.phaseState(phase))
			if err != nil {
				return resolved{}, err
			}
			first, err := apply(base, before, name, sid, "before")
			if err != nil {
				return resolved{}, err
			}
			last, err := apply(first, after, name, sid, "after")
			if err != nil {
				return resolved{}, err
			}
			value = resolved{before: first, after: last, incoming: base}
		}
		visiting = visiting[:len(visiting)-1]
		done.set(sid, value)
		return value, nil
	}
	for _, sid := range scenes.keys {
		if _, err := visit(sid); err != nil {
			return nil, err
		}
	}
	result := jscompat.NewObject()
	for _, sid := range done.keys {
		value, _ := done.get(sid)
		result.Set(jscompat.ToString(sid), value)
	}
	return result, nil
}

// plain возвращает состояние как объект «сущность → свойство → значение» (уже в этой форме).
func plain(state *jscompat.Object) *jscompat.Object { return state }

// CanonicalJSON повторяет canonicalJson оригинала (= json.dumps(sort_keys=True, ensure_ascii=False,
// separators=(",", ":"))): ключи по кодовым единицам UTF-16, undefined пропускается, примитивы —
// как JSON.stringify.
func CanonicalJSON(value any) string {
	var builder strings.Builder
	canonical(&builder, value)
	return builder.String()
}

func canonical(builder *strings.Builder, value any) {
	switch item := value.(type) {
	case *jscompat.Array:
		builder.WriteByte('[')
		for index, element := range item.Items {
			if index > 0 {
				builder.WriteByte(',')
			}
			canonical(builder, element)
		}
		builder.WriteByte(']')
	case *jscompat.Object:
		keys := item.Keys()
		filtered := keys[:0:0]
		for _, key := range keys {
			if item.Value(key) != jscompat.Undefined {
				filtered = append(filtered, key)
			}
		}
		sortUTF16(filtered)
		builder.WriteByte('{')
		for index, key := range filtered {
			if index > 0 {
				builder.WriteByte(',')
			}
			builder.WriteString(jscompat.Quote(key))
			builder.WriteByte(':')
			canonical(builder, item.Value(key))
		}
		builder.WriteByte('}')
	case ResolvedState:
		object := jscompat.NewObject()
		object.Set("before", plain(item.Before))
		object.Set("after", plain(item.After))
		canonical(builder, object)
	default:
		builder.WriteString(jscompat.Stringify(jscompat.Coalesce(value, nil)))
	}
}
