package sceneregistry

import (
	"crypto/sha256"
	"encoding/hex"

	"songframe-go/internal/pycompat"
)

// apply — изменения состояния delta поверх state (копия): null удаляет факт, который больше не
// установлен (а не делает героя «чистым»), строка задаёт значение; сущность без фактов исчезает.
func apply(state any, delta any, sid any) (*pycompat.Dict, error) {
	result := pycompat.DeepCopy(state).(*pycompat.Dict)
	changes, ok := delta.(*pycompat.Dict)
	if !ok {
		return nil, valueError("%s: изменения состояния должны быть объектом.", pycompat.Str(sid))
	}
	for _, entity := range changes.Keys() {
		attributes, ok := changes.Value(entity).(*pycompat.Dict)
		if !slug.MatchString(entity) || !ok {
			return nil, valueError("%s: неверный объект состояния.", pycompat.Str(sid))
		}
		for _, key := range attributes.Keys() {
			value := attributes.Value(key)
			text, isString := value.(string)
			if !slug.MatchString(key) || value != nil && (!isString || pycompat.Strip(text) == "") {
				return nil, valueError("%s: неверное свойство состояния.", pycompat.Str(sid))
			}
			if value == nil {
				if facts, ok := result.Value(entity).(*pycompat.Dict); ok {
					facts.Delete(key)
				}
			} else {
				facts, ok := result.Value(entity).(*pycompat.Dict)
				if !ok {
					facts = pycompat.NewDict()
					result.Set(entity, facts)
				}
				facts.Set(key, value)
			}
		}
		if facts, ok := result.Get(entity); ok && !pycompat.Truthy(facts) {
			result.Delete(entity)
		}
	}
	return result, nil
}

// resolver — состояние обхода _resolve_states: разрешённые планы и текущая цепочка state_from.
type resolver struct {
	base     *pycompat.Dict
	scenes   *keyed
	resolved *keyed
	visiting []any
}

// phases — допустимые фазы ссылки state_from.
var phases = []any{"before", "after", "same"}

// visit — состояние {before, after} плана sid с разворачиванием источника (рекурсивно, включая
// будущие планы вступления); цикл, неизвестный источник и неверная форма — ValueError.
func (r *resolver) visit(sid any) (*pycompat.Dict, error) {
	if value, ok, err := r.resolved.get(sid); err != nil || ok {
		if err != nil {
			return nil, err
		}
		return value.(*pycompat.Dict), nil
	}
	for _, item := range r.visiting {
		if pycompat.Equal(item, sid) {
			return nil, valueError("Цикл state_from: %s", joinShots(append(append([]any{}, r.visiting...), sid)))
		}
	}
	found, ok, err := r.scenes.get(sid)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, valueError("%s: неизвестный источник state_from.", pycompat.Str(sid))
	}
	r.visiting = append(r.visiting, sid)
	scene, isDict := found.(*pycompat.Dict)
	if !isDict {
		return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'keys'", pycompat.TypeName(found))
	}
	if !scene.Has("state_from") || !scene.Has("state_changes") {
		return nil, valueError("%s: нужны state_from и state_changes.", pycompat.Str(sid))
	}
	source := scene.Value("state_from")
	var phase any = "after"
	if link, ok := source.(*pycompat.Dict); ok {
		if link.Len() != 2 || !link.Has("scene") || !link.Has("phase") {
			return nil, valueError("%s: неверная ссылка state_from.", pycompat.Str(sid))
		}
		source, phase = link.Value("scene"), link.Value("phase")
	}
	_, sourceIsString := source.(string)
	knownPhase := false
	for _, item := range phases {
		knownPhase = knownPhase || pycompat.Equal(phase, item)
	}
	if source != nil && !sourceIsString || !knownPhase || source == nil && !pycompat.Equal(phase, "after") {
		return nil, valueError("%s: неверный источник или фаза state_from.", pycompat.Str(sid))
	}
	changeValue, _ := pycompat.DictGet(scene, "state_changes", pycompat.NewDict())
	changes, ok := changeValue.(*pycompat.Dict)
	if ok {
		for _, key := range changes.Keys() {
			if key != "before" && key != "after" {
				ok = false
			}
		}
	}
	if !ok {
		return nil, valueError("%s: state_changes допускает только before и after.", pycompat.Str(sid))
	}
	var incoming *pycompat.Dict
	if source != nil {
		if incoming, err = r.visit(source); err != nil {
			return nil, err
		}
	} else {
		incoming = pycompat.NewDict()
		incoming.Set("before", pycompat.DeepCopy(r.base))
		incoming.Set("after", pycompat.DeepCopy(r.base))
	}
	var value *pycompat.Dict
	if pycompat.Equal(phase, "same") {
		// Повтор во вступлении использует обе границы исходного события, не копируя его изменения
		// и не создавая второго события в сюжете.
		if changes.Len() > 0 {
			return nil, valueError("%s: повтор same не допускает своих state_changes.", pycompat.Str(sid))
		}
		value = pycompat.DeepCopy(incoming).(*pycompat.Dict)
	} else {
		beforeDelta, _ := pycompat.DictGet(changes, "before", pycompat.NewDict())
		before, err := apply(incoming.Value(phase.(string)), beforeDelta, sid)
		if err != nil {
			return nil, err
		}
		afterDelta, _ := pycompat.DictGet(changes, "after", pycompat.NewDict())
		after, err := apply(before, afterDelta, sid)
		if err != nil {
			return nil, err
		}
		value = pycompat.NewDict()
		value.Set("before", before)
		value.Set("after", after)
	}
	r.visiting = r.visiting[:len(r.visiting)-1]
	if err := r.resolved.set(sid, value); err != nil {
		return nil, err
	}
	return value, nil
}

// ResolveStates — сводка {before, after} каждого плана по
// сюжетным зависимостям state_from/state_changes, ключ — код плана. initial — состояние сущностей
// до первого события (начальное состояние кастинга, nil — пустое): источник `state_from: null`
// стартует с него. Каждый план обязан иметь state_from и state_changes. Реестр не меняется;
// data — значение Python (не-объект и отсутствие scenes дают исключения).
func ResolveStates(data any, initial *pycompat.Dict) (*pycompat.Dict, error) {
	if initial == nil {
		initial = pycompat.NewDict()
	}
	r := &resolver{base: pycompat.DeepCopy(initial).(*pycompat.Dict), scenes: newKeyed(), resolved: newKeyed()}
	list, err := pycompat.Item(data, "scenes")
	if err != nil {
		return nil, err
	}
	scenes, err := pycompat.Iter(list)
	if err != nil {
		return nil, err
	}
	for _, scene := range scenes {
		id, err := pycompat.GetItem(scene, "id")
		if err != nil {
			return nil, err
		}
		if err := r.scenes.set(id, scene); err != nil {
			return nil, err
		}
	}
	for _, sid := range r.scenes.order {
		if _, err := r.visit(sid); err != nil {
			return nil, err
		}
	}
	// Порядок результата — порядок завершения обхода: план, от которого
	// зависит более ранний (вступление по будущему плану), оказывается раньше него.
	result := pycompat.NewDict()
	for index, sid := range r.resolved.order {
		result.Set(pycompat.Str(sid), r.resolved.values[index])
	}
	return result, nil
}

// SceneState — независимая копия сводки до/после плана без
// записи в реестр; реестр предварительно проверяется Validate.
func SceneState(data any, sid string, initial *pycompat.Dict) (*pycompat.Dict, error) {
	document, err := Validate(data, initial)
	if err != nil {
		return nil, err
	}
	states, err := ResolveStates(document, initial)
	if err != nil {
		return nil, err
	}
	state, ok := states.Get(sid)
	if !ok {
		return nil, valueError("%s: сцена отсутствует в реестре.", sid)
	}
	return pycompat.DeepCopy(state).(*pycompat.Dict), nil
}

// fingerprint — SHA-256 канонического JSON контекста плана: json.dumps(sort_keys=True,
// ensure_ascii=False, separators=(",", ":")).encode().
func fingerprint(scene, direction, visual, state any) (string, error) {
	context := pycompat.NewDict()
	context.Set("scene", scene)
	context.Set("sequence_direction", direction)
	context.Set("visual_direction", visual)
	context.Set("state", state)
	text, err := pycompat.DumpsJSON(context, pycompat.DumpOptions{SortKeys: true, Compact: true})
	if err != nil {
		return "", err
	}
	data, err := pycompat.EncodeUTF8(text)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}

// SceneFingerprint — отпечаток постановки плана. Отложенный
// запрос зависит и от унаследованных условий, не только от самого плана: в контекст входят план,
// направление его части (первой с таким id), общее визуальное направление и вычисленное состояние.
func SceneFingerprint(data any, sid string, initial *pycompat.Dict) (string, error) {
	state, err := SceneState(data, sid, initial)
	if err != nil {
		return "", err
	}
	document := data.(*pycompat.Dict)
	scenes, _ := pycompat.Iter(document.Value("scenes"))
	var scene any
	for _, item := range scenes {
		if id, _ := pycompat.GetItem(item, "id"); pycompat.Equal(id, sid) {
			scene = item
			break
		}
	}
	sequences, err := pycompat.Iter(document.Value("sequences"))
	if err != nil {
		return "", err
	}
	var direction any
	for _, item := range sequences {
		id, err := pycompat.GetItem(item, "id")
		if err != nil {
			return "", err
		}
		if pycompat.Equal(id, scene.(*pycompat.Dict).Value("sequence")) {
			if direction, err = pycompat.DictGet(item, "direction", ""); err != nil {
				return "", err
			}
			break
		}
	}
	visual, _ := pycompat.DictGet(document, "visual_direction", "")
	return fingerprint(scene, direction, visual, state)
}

// SceneFingerprints — отпечатки всех планов за одно вычисление
// состояния, в порядке планов (код → hex). Значения совпадают с SceneFingerprint, кроме повтора id
// части: здесь берётся направление последней такой части (словарь Python), там — первой.
func SceneFingerprints(data any, initial *pycompat.Dict) (*pycompat.Dict, error) {
	document, err := Validate(data, initial)
	if err != nil {
		return nil, err
	}
	states, err := ResolveStates(document, initial)
	if err != nil {
		return nil, err
	}
	sequences, err := pycompat.Iter(document.Value("sequences"))
	if err != nil {
		return nil, err
	}
	directions := newKeyed()
	for _, item := range sequences {
		id, err := pycompat.GetItem(item, "id")
		if err != nil {
			return nil, err
		}
		direction, err := pycompat.DictGet(item, "direction", "")
		if err != nil {
			return nil, err
		}
		if err := directions.set(id, direction); err != nil {
			return nil, err
		}
	}
	visual, _ := pycompat.DictGet(document, "visual_direction", "")
	scenes, _ := pycompat.Iter(document.Value("scenes"))
	result := pycompat.NewDict()
	for _, item := range scenes {
		scene := item.(*pycompat.Dict)
		direction, _, _ := directions.get(scene.Value("sequence"))
		id := scene.Value("id").(string)
		digest, err := fingerprint(scene, direction, visual, states.Value(id))
		if err != nil {
			return nil, err
		}
		result.Set(id, digest)
	}
	return result, nil
}
