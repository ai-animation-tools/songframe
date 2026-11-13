package scenarioworkflow

import (
	"errors"
	"math"
	"regexp"
	"slices"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/projectfile"
	"songframe/internal/scenario"
)

// Проверка недоверенного JSON агента: ответ агента разбирается в дерево dynvalue и проверяется
// до любых доменных функций, которые ожидают уже типизированный документ. Тексты отказов —
// scenarioTexts.main (frontend/src/shared/texts/scenario.ts).

// stagingFields — поля постановки, которые патч прохода revise может заменить.
var stagingFields = []string{"title", "camera", "action", "continuity", "notes", "references", "lipsync", "card", "state_from", "state_changes", "derived_from"}

// placeholder — /ЗАПОЛНИТЬ/iu: незаполненное место шаблона в любом регистре.
var placeholder = regexp.MustCompile(`(?i)ЗАПОЛНИТЬ`)

// Documents — ScenarioDocuments: кастинг, трактовка и реестр как деревья dynvalue; nil — null
// (документа нет). Значения после проверок не изменяются: при подстановке строится новый документ.
type Documents struct {
	Cast      any
	Treatment any
	Scenes    any
}

// object — документы как объект { cast, treatment, scenes } для записи прохода и ответа renderer.
func (d Documents) object() *dynvalue.Object {
	result := dynvalue.NewObject()
	result.Set("cast", d.Cast)
	result.Set("treatment", d.Treatment)
	result.Set("scenes", d.Scenes)
	return result
}

// documentsFrom — обратное object(): поля объекта как есть (Undefined записи не бывает: снимок
// уже прошёл checkDocuments).
func documentsFrom(value any) Documents {
	get := func(key string) any {
		item := dynvalue.Get(value, key)
		if item == dynvalue.Undefined {
			return nil
		}
		return item
	}
	return Documents{Cast: get("cast"), Treatment: get("treatment"), Scenes: get("scenes")}
}

// isString — значение — строка.
func isString(value any) bool {
	_, ok := value.(string)
	return ok
}

// stringList — значение — массив, все элементы которого строки.
func stringList(value any) bool {
	items, ok := dynvalue.AsArray(value)
	if !ok {
		return false
	}
	for _, item := range items {
		if !isString(item) {
			return false
		}
	}
	return true
}

// texts — строки массива, уже проверенного stringList.
func texts(value any) []string {
	items, _ := dynvalue.AsArray(value)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, item.(string))
	}
	return result
}

// sameValue — равенство чисел JSON по значению: NaN равен NaN, +0 и -0 различаются.
func sameValue(left, right float64) bool {
	if math.IsNaN(left) && math.IsNaN(right) {
		return true
	}
	if left == 0 && right == 0 {
		return math.Signbit(left) == math.Signbit(right)
	}
	return left == right
}

// deepEqual — глубокое строгое равенство значений JSON: объекты равны при одинаковом наборе
// собственных ключей (порядок не важен) и равных значениях, массивы — поэлементно, примитивы — по
// sameValue.
func deepEqual(left, right any) bool {
	switch a := left.(type) {
	case *dynvalue.Object:
		b, ok := right.(*dynvalue.Object)
		if !ok || a.Len() != b.Len() {
			return false
		}
		for _, key := range a.Keys() {
			other, has := b.Get(key)
			if !has || !deepEqual(a.Value(key), other) {
				return false
			}
		}
		return true
	case *dynvalue.Array:
		b, ok := right.(*dynvalue.Array)
		if !ok || len(a.Items) != len(b.Items) {
			return false
		}
		for index := range a.Items {
			if !deepEqual(a.Items[index], b.Items[index]) {
				return false
			}
		}
		return true
	case float64:
		b, ok := right.(float64)
		return ok && sameValue(a, b)
	case scenario.ResolvedState:
		// Состояние плана из scenario.ResolveStates — объект { before, after }.
		b, ok := right.(scenario.ResolvedState)
		return ok && deepEqual(a.Object(), b.Object())
	}
	return left == right
}

// isFrameRate — число dynvalue — одна из допустимых частот кадров проекта.
func isFrameRate(value any) bool {
	number, ok := value.(float64)
	return ok && number == math.Trunc(number) && number < 1000 && projectfile.ValidFrameRate(int(number))
}

// checkScenesShape — полная проверка вложенных полей реестра до scenario.ValidateScenes, который
// ожидает уже типизированный документ. Первая найденная ошибка — отказ.
func checkScenesShape(value any) error {
	document, ok := dynvalue.AsObject(value)
	audio, audioOK := dynvalue.AsObject(dynvalue.Get(value, "audio"))
	if !ok || !dynvalue.StrictEqual(document.Value("schema_version"), 1.0) || !isFrameRate(document.Value("fps")) ||
		!isString(document.Value("visual_direction")) || !audioOK || !isString(audio.Value("path")) || !isString(audio.Value("end_seconds")) ||
		!dynvalue.IsRecord(document.Value("references")) || !dynvalue.IsArray(document.Value("sequences")) || !dynvalue.IsArray(document.Value("scenes")) {
		return errors.New(textRegistryInvalidDocument)
	}
	references := document.Value("references").(*dynvalue.Object)
	for _, key := range references.Keys() {
		ref, ok := dynvalue.AsObject(references.Value(key))
		if !ok || !isString(ref.Value("name")) || !isString(ref.Value("path")) || (ref.Value("short_name") != dynvalue.Undefined && !isString(ref.Value("short_name"))) {
			return errors.New(textRegistryInvalidReferences)
		}
	}
	parts, _ := dynvalue.AsArray(document.Value("sequences"))
	for _, item := range parts {
		part, ok := dynvalue.AsObject(item)
		if !ok || !isString(part.Value("id")) || !isString(part.Value("title")) || !isString(part.Value("direction")) {
			return errors.New(textRegistryInvalidParts)
		}
	}
	scenes, _ := dynvalue.AsArray(document.Value("scenes"))
	for _, item := range scenes {
		scene, ok := dynvalue.AsObject(item)
		if !ok || !shotShape(scene) {
			var id *string
			if ok {
				if text, isText := scene.Value("id").(string); isText {
					id = &text
				}
			}
			return errors.New(textRegistryInvalidShot(id))
		}
		id := scene.Value("id").(string)
		from := scene.Value("state_from")
		if from != nil && !isString(from) {
			record, isRecord := dynvalue.AsObject(from)
			phase, phaseOK := dynvalue.Get(from, "phase").(string)
			if !isRecord || !isString(record.Value("scene")) || !phaseOK || !slices.Contains([]string{"before", "after", "same"}, phase) {
				return errors.New(textRegistryInvalidStateFrom(id))
			}
		}
		changes, changesOK := dynvalue.AsObject(scene.Value("state_changes"))
		if !changesOK || slices.ContainsFunc(changes.Keys(), func(key string) bool { return key != "before" && key != "after" }) {
			var phases []string
			if changesOK {
				phases = changes.Keys()
			}
			return errors.New(textRegistryInvalidStatePhases(id, phases))
		}
		for _, phase := range changes.Keys() {
			delta, ok := dynvalue.AsObject(changes.Value(phase))
			if !ok {
				return errors.New(textRegistryInvalidStateChanges(id))
			}
			for _, entity := range delta.Keys() {
				attributes, ok := dynvalue.AsObject(delta.Value(entity))
				if !ok {
					return errors.New(textRegistryInvalidStateProperties(id))
				}
				for _, key := range attributes.Keys() {
					if value := attributes.Value(key); value != nil && !isString(value) {
						return errors.New(textRegistryInvalidStateProperties(id))
					}
				}
			}
		}
	}
	return nil
}

// shotShape — общая форма плана: строки, целые кадры, список референсов, флаг липсинка, карточка
// и необязательные title, notes и derived_from вида {"shot": "Mxx"}.
func shotShape(scene *dynvalue.Object) bool {
	for _, key := range []string{"id", "original", "sequence", "camera", "action", "continuity"} {
		if !isString(scene.Value(key)) {
			return false
		}
	}
	card, cardOK := dynvalue.AsObject(scene.Value("card"))
	_, lipsync := scene.Value("lipsync").(bool)
	if !dynvalue.IsInteger(scene.Value("start_frame")) || !dynvalue.IsInteger(scene.Value("end_frame_exclusive")) ||
		!stringList(scene.Value("references")) || !lipsync || !cardOK || !isString(card.Value("primary_reference")) {
		return false
	}
	for _, key := range []string{"title", "notes"} {
		if value := scene.Value(key); value != dynvalue.Undefined && !isString(value) {
			return false
		}
	}
	if derived := scene.Value("derived_from"); derived != dynvalue.Undefined {
		record, ok := dynvalue.AsObject(derived)
		if !ok || strings.Join(record.Keys(), ",") != "shot" || !isString(record.Value("shot")) {
			return false
		}
	}
	return true
}

// filled — непустой после trim текст без «ЗАПОЛНИТЬ».
func filled(text string) bool { return dynvalue.Trim(text) != "" && !placeholder.MatchString(text) }

// checkTreatmentCast — логлайн и постановка частей заполнены, части
// ссылаются только на сущности кастинга. Документы уже нормализованы (cast.Normalize, трактовка).
func checkTreatmentCast(castValue, treatment any) error {
	entities := map[string]bool{}
	for _, entity := range arrayItems(dynvalue.Get(castValue, "entities")) {
		if id, ok := dynvalue.Get(entity, "id").(string); ok {
			entities[id] = true
		}
	}
	logline, _ := dynvalue.Get(treatment, "logline").(string)
	if !filled(logline) {
		return errors.New(textTreatmentLoglineMissing)
	}
	for _, part := range arrayItems(dynvalue.Get(treatment, "sequences")) {
		id, _ := dynvalue.Get(part, "id").(string)
		direction, _ := dynvalue.Get(part, "direction").(string)
		if !filled(direction) {
			return errors.New(textPartDirectionMissing(id))
		}
		for _, entity := range arrayItems(dynvalue.Get(part, "entities")) {
			if name, _ := entity.(string); !entities[name] {
				return errors.New(textPartUnknownEntity(id, dynvalue.ToString(entity)))
			}
		}
	}
	return nil
}

// arrayItems — элементы массива или пусто для не-массива.
func arrayItems(value any) []any {
	items, _ := dynvalue.AsArray(value)
	return items
}

// checkReadyScenes — строгая готовность реестра из предложения агента
// (ручной черновик может быть неполным). Все проблемы — одной ошибкой, по строке на проблему:
// интерфейс показывает их списком; незаполненные планы сводятся в один первый пункт.
func checkReadyScenes(scenes, castValue any, duration, fps float64) error {
	problems, err := scenario.ValidateScenes(scenes, castValue, fps)
	if err != nil {
		return err
	}
	if math.Abs(dynvalue.ToNumber(dynvalue.GetPath(scenes, "audio", "end_seconds"))-duration) >= 1/fps {
		problems = append(problems, textRegistryDecodedDuration)
	}
	references, err := cast.References(castValue)
	if err != nil {
		return err
	}
	if !deepEqual(dynvalue.Get(scenes, "references"), references) {
		problems = append(problems, textRegistryReferencesMismatch)
	}
	if direction, _ := dynvalue.Get(scenes, "visual_direction").(string); !filled(direction) {
		problems = append(problems, textRegistryDirectionMissing)
	}
	entities := map[string]*dynvalue.Object{}
	for _, item := range arrayItems(dynvalue.Get(castValue, "entities")) {
		if entity, ok := dynvalue.AsObject(item); ok {
			if id, ok := entity.Value("id").(string); ok {
				entities[id] = entity
			}
		}
	}
	unfilled := []string{}
	for _, item := range arrayItems(dynvalue.Get(scenes, "scenes")) {
		shot := item.(*dynvalue.Object)
		id := shot.Value("id").(string)
		empty := false
		for _, key := range []string{"camera", "action", "continuity"} {
			if dynvalue.Trim(dynvalue.ToString(shot.Value(key))) == "" {
				empty = true
			}
		}
		if empty || placeholder.MatchString(dynvalue.Stringify(shot)) {
			unfilled = append(unfilled, id)
		}
		changes := shot.Value("state_changes").(*dynvalue.Object)
		for _, phase := range changes.Keys() {
			delta := changes.Value(phase).(*dynvalue.Object)
			for _, entityID := range delta.Keys() {
				entity, known := entities[entityID]
				if !known {
					problems = append(problems, textStateUnknownEntity(id, entityID))
					continue
				}
				properties := map[string]bool{}
				kind := dynvalue.ToString(entity.Value("kind"))
				for _, property := range arrayItems(dynvalue.GetPath(castValue, "properties", kind)) {
					properties[dynvalue.ToString(dynvalue.Get(property, "key"))] = true
				}
				if initial, ok := dynvalue.AsObject(entity.Value("initial_state")); ok {
					for _, key := range initial.Keys() {
						properties[key] = true
					}
				}
				for _, key := range delta.Value(entityID).(*dynvalue.Object).Keys() {
					if !properties[key] {
						problems = append(problems, textStateUnknownProperty(id, entityID, key))
					}
				}
			}
		}
	}
	if len(unfilled) > 0 {
		problems = append([]string{textUnfilledShots(unfilled)}, problems...)
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "\n"))
	}
	return nil
}

// proposalDocuments — разбор и проверка ответа агента для прохода
// pass. treatment заменяет пару кастинга и трактовки; scenes принимает заполненный каркас без
// изменения окон; revise применяет патчи постановки выбранных планов. Результат — новые документы;
// before не изменяется.
//
// Ответ, который не разбирается как JSON, отклоняется понятным пользователю текстом
// proposalInvalidDocument, а не сообщением разборщика.
func proposalDocuments(raw, pass string, before Documents, scaffold any, selected []string, duration, fps float64) (Documents, error) {
	parsed, err := dynvalue.Parse([]byte(raw))
	if err != nil {
		return Documents{}, errors.New(textProposalInvalidDocument)
	}
	value, ok := dynvalue.AsObject(parsed)
	if !ok || !dynvalue.StrictEqual(value.Value("schemaVersion"), 1.0) || !dynvalue.StrictEqual(value.Value("pass"), pass) {
		return Documents{}, errors.New(textProposalInvalidDocument)
	}
	expected := map[string][]string{"treatment": {"cast", "treatment"}, "scenes": {"scenes"}, "revise": {"patches"}}[pass]
	for _, key := range value.Keys() {
		if key != "schemaVersion" && key != "pass" && !slices.Contains(expected, key) {
			return Documents{}, errors.New(textProposalUnknownFields)
		}
	}
	if pass == "treatment" {
		normalized, err := cast.Normalize(value.Value("cast"), cast.LoadDefaults())
		if err != nil {
			return Documents{}, err
		}
		treatment, err := scenario.NormalizeTreatment(value.Value("treatment"), duration)
		if err != nil {
			return Documents{}, err
		}
		if err := checkTreatmentCast(normalized, treatment); err != nil {
			return Documents{}, err
		}
		return Documents{Cast: normalized, Treatment: treatment, Scenes: before.Scenes}, nil
	}
	if before.Cast == nil {
		return Documents{}, errors.New(textProposalCastMissing)
	}
	var scenes any
	if pass == "scenes" {
		scenes = value.Value("scenes")
		if err := checkScenesShape(scenes); err != nil {
			return Documents{}, err
		}
		shots := arrayItems(dynvalue.Get(scenes, "scenes"))
		base := arrayItems(dynvalue.Get(scaffold, "scenes"))
		if scaffold == nil || !deepEqual(dynvalue.Get(scenes, "audio"), dynvalue.Get(scaffold, "audio")) ||
			!deepEqual(dynvalue.Get(scenes, "sequences"), dynvalue.Get(scaffold, "sequences")) || len(shots) != len(base) {
			return Documents{}, errors.New(textProposalScaffoldChanged)
		}
		for index, shot := range shots {
			for _, key := range []string{"id", "original", "sequence", "start_frame", "end_frame_exclusive"} {
				if !dynvalue.StrictEqual(dynvalue.Get(shot, key), dynvalue.Get(base[index], key)) {
					return Documents{}, errors.New(textProposalShotWindowChanged(dynvalue.ToString(dynvalue.Get(shot, "id"))))
				}
			}
		}
	} else {
		patchList, isList := dynvalue.AsArray(value.Value("patches"))
		if before.Scenes == nil || !isList || len(patchList) == 0 {
			return Documents{}, errors.New(textProposalPatchesMissing)
		}
		patches := map[string]*dynvalue.Object{}
		for _, item := range patchList {
			patch, ok := dynvalue.AsObject(item)
			id, idOK := dynvalue.Get(item, "id").(string)
			if !ok || !idOK || !slices.Contains(selected, id) || patches[id] != nil || patch.Len() < 2 ||
				slices.ContainsFunc(patch.Keys(), func(key string) bool { return key != "id" && !slices.Contains(stagingFields, key) }) {
				return Documents{}, errors.New(textProposalPatchesInvalid)
			}
			patches[id] = patch
		}
		// derived_from: null в патче снимает признак производного плана; остальные поля заменяются целиком.
		shots := []any{}
		for _, item := range arrayItems(dynvalue.Get(before.Scenes, "scenes")) {
			next := dynvalue.Spread(item)
			if patch := patches[dynvalue.ToString(dynvalue.Get(item, "id"))]; patch != nil {
				for _, key := range patch.Keys() {
					next.Set(key, patch.Value(key))
				}
			}
			if next.Value("derived_from") == nil {
				next.Delete("derived_from")
			}
			shots = append(shots, next)
		}
		candidate := dynvalue.Spread(before.Scenes)
		candidate.Set("scenes", &dynvalue.Array{Items: shots})
		if err := checkScenesShape(candidate); err != nil {
			return Documents{}, err
		}
		scenes = candidate
	}
	if err := checkReadyScenes(scenes, before.Cast, duration, fps); err != nil {
		return Documents{}, err
	}
	return Documents{Cast: before.Cast, Treatment: before.Treatment, Scenes: scenes}, nil
}

// initialFrom — объект «id сущности → initial_state» из cast.entities: начальное состояние
// сущностей для scenario.ResolveStates; без кастинга — пустой объект.
func initialFrom(castValue any) *dynvalue.Object {
	result := dynvalue.NewObject()
	for _, entity := range arrayItems(dynvalue.Get(castValue, "entities")) {
		result.Set(dynvalue.ToString(dynvalue.Get(entity, "id")), dynvalue.Get(entity, "initial_state"))
	}
	return result
}

// changedSceneIds — планы предложения, чья постановка или вычисленное
// состояние отличается от прежнего реестра (в том числе унаследованное от изменённого плана).
// Некорректный прежний реестр не мешает: его состояния считаются пустыми.
func changedSceneIds(before, after Documents) ([]string, error) {
	if after.Scenes == nil {
		return []string{}, nil
	}
	previous := map[string]any{}
	for _, scene := range arrayItems(dynvalue.Get(before.Scenes, "scenes")) {
		// При повторе кода остаётся последний план.
		previous[dynvalue.ToString(dynvalue.Get(scene, "id"))] = scene
	}
	var beforeStates any = dynvalue.NewObject()
	if before.Scenes != nil {
		if states, err := scenario.ResolveStates(before.Scenes, initialFrom(before.Cast)); err == nil {
			beforeStates = states
		}
	}
	afterStates, err := scenario.ResolveStates(after.Scenes, initialFrom(after.Cast))
	if err != nil {
		return nil, err
	}
	changed := []string{}
	for _, scene := range arrayItems(dynvalue.Get(after.Scenes, "scenes")) {
		id := dynvalue.ToString(dynvalue.Get(scene, "id"))
		old, known := previous[id]
		if !known {
			old = dynvalue.Undefined
		}
		if !deepEqual(old, scene) || !deepEqual(dynvalue.Get(beforeStates, id), afterStates.Value(id)) {
			changed = append(changed, id)
		}
	}
	return changed, nil
}
