package scenarioworkflow

import (
	"errors"
	"math"
	"regexp"
	"slices"
	"strings"

	"songframe-go/internal/cast"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/scenario"
)

// Проверка недоверенного JSON агента (перенос src/main/scenario-proposal.ts): ответ агента
// разбирается в дерево jscompat и проверяется до любых доменных функций, которые ожидают уже
// типизированный документ. Тексты отказов — scenarioTexts.main оригинала.

// fps — кадровая сетка реестра (FPS из src/shared/video.ts).
const fps = 30.0

// stagingFields — STAGING_FIELDS: поля постановки, которые патч прохода revise может заменить.
var stagingFields = []string{"title", "camera", "action", "continuity", "notes", "references", "lipsync", "card", "state_from", "state_changes", "derived_from"}

// placeholder — /ЗАПОЛНИТЬ/iu: незаполненное место шаблона в любом регистре.
var placeholder = regexp.MustCompile(`(?i)ЗАПОЛНИТЬ`)

// Documents — ScenarioDocuments: кастинг, трактовка и реестр как деревья jscompat; nil — null
// (документа нет). Значения после проверок не изменяются: при подстановке строится новый документ.
type Documents struct {
	Cast      any
	Treatment any
	Scenes    any
}

// object — документы как объект { cast, treatment, scenes } для локальной записи и ответа renderer.
func (d Documents) object() *jscompat.Object {
	result := jscompat.NewObject()
	result.Set("cast", d.Cast)
	result.Set("treatment", d.Treatment)
	result.Set("scenes", d.Scenes)
	return result
}

// documentsFrom — обратное object(): поля объекта как есть (Undefined записи не бывает: снимок
// уже прошёл checkDocuments).
func documentsFrom(value any) Documents {
	get := func(key string) any {
		item := jscompat.Get(value, key)
		if item == jscompat.Undefined {
			return nil
		}
		return item
	}
	return Documents{Cast: get("cast"), Treatment: get("treatment"), Scenes: get("scenes")}
}

// isString — typeof value === 'string'.
func isString(value any) bool {
	_, ok := value.(string)
	return ok
}

// stringList — Array.isArray(value) && value.every((item) => typeof item === 'string').
func stringList(value any) bool {
	items, ok := jscompat.AsArray(value)
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
	items, _ := jscompat.AsArray(value)
	result := make([]string, 0, len(items))
	for _, item := range items {
		result = append(result, item.(string))
	}
	return result
}

// sameValue — Object.is для примитивов JSON: NaN равен NaN, +0 и -0 различаются.
func sameValue(left, right float64) bool {
	if math.IsNaN(left) && math.IsNaN(right) {
		return true
	}
	if left == 0 && right == 0 {
		return math.Signbit(left) == math.Signbit(right)
	}
	return left == right
}

// deepEqual — util.isDeepStrictEqual для значений JSON: объекты равны при одинаковом наборе
// собственных ключей (порядок не важен) и равных значениях, массивы — поэлементно, примитивы — по
// Object.is.
func deepEqual(left, right any) bool {
	switch a := left.(type) {
	case *jscompat.Object:
		b, ok := right.(*jscompat.Object)
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
	case *jscompat.Array:
		b, ok := right.(*jscompat.Array)
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
		// Состояние плана из resolveStates — объект { before, after } оригинала.
		b, ok := right.(scenario.ResolvedState)
		return ok && deepEqual(a.Object(), b.Object())
	}
	return left == right
}

// checkScenesShape — checkScenesShape оригинала: полная проверка вложенных полей реестра до
// validateScenes, который ожидает уже типизированный документ. Первая найденная ошибка — отказ.
func checkScenesShape(value any) error {
	document, ok := jscompat.AsObject(value)
	audio, audioOK := jscompat.AsObject(jscompat.Get(value, "audio"))
	if !ok || !jscompat.StrictEqual(document.Value("schema_version"), 1.0) || !jscompat.StrictEqual(document.Value("fps"), fps) ||
		!isString(document.Value("visual_direction")) || !audioOK || !isString(audio.Value("path")) || !isString(audio.Value("end_seconds")) ||
		!jscompat.IsRecord(document.Value("references")) || !jscompat.IsArray(document.Value("sequences")) || !jscompat.IsArray(document.Value("scenes")) {
		return errors.New(textRegistryInvalidDocument)
	}
	references := document.Value("references").(*jscompat.Object)
	for _, key := range references.Keys() {
		ref, ok := jscompat.AsObject(references.Value(key))
		if !ok || !isString(ref.Value("name")) || !isString(ref.Value("path")) || (ref.Value("short_name") != jscompat.Undefined && !isString(ref.Value("short_name"))) {
			return errors.New(textRegistryInvalidReferences)
		}
	}
	parts, _ := jscompat.AsArray(document.Value("sequences"))
	for _, item := range parts {
		part, ok := jscompat.AsObject(item)
		if !ok || !isString(part.Value("id")) || !isString(part.Value("title")) || !isString(part.Value("direction")) {
			return errors.New(textRegistryInvalidParts)
		}
	}
	scenes, _ := jscompat.AsArray(document.Value("scenes"))
	for _, item := range scenes {
		scene, ok := jscompat.AsObject(item)
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
			record, isRecord := jscompat.AsObject(from)
			phase, phaseOK := jscompat.Get(from, "phase").(string)
			if !isRecord || !isString(record.Value("scene")) || !phaseOK || !slices.Contains([]string{"before", "after", "same"}, phase) {
				return errors.New(textRegistryInvalidStateFrom(id))
			}
		}
		changes, changesOK := jscompat.AsObject(scene.Value("state_changes"))
		if !changesOK || slices.ContainsFunc(changes.Keys(), func(key string) bool { return key != "before" && key != "after" }) {
			var phases []string
			if changesOK {
				phases = changes.Keys()
			}
			return errors.New(textRegistryInvalidStatePhases(id, phases))
		}
		for _, phase := range changes.Keys() {
			delta, ok := jscompat.AsObject(changes.Value(phase))
			if !ok {
				return errors.New(textRegistryInvalidStateChanges(id))
			}
			for _, entity := range delta.Keys() {
				attributes, ok := jscompat.AsObject(delta.Value(entity))
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
func shotShape(scene *jscompat.Object) bool {
	for _, key := range []string{"id", "original", "sequence", "camera", "action", "continuity"} {
		if !isString(scene.Value(key)) {
			return false
		}
	}
	card, cardOK := jscompat.AsObject(scene.Value("card"))
	_, lipsync := scene.Value("lipsync").(bool)
	if !jscompat.IsInteger(scene.Value("start_frame")) || !jscompat.IsInteger(scene.Value("end_frame_exclusive")) ||
		!stringList(scene.Value("references")) || !lipsync || !cardOK || !isString(card.Value("primary_reference")) {
		return false
	}
	for _, key := range []string{"title", "notes"} {
		if value := scene.Value(key); value != jscompat.Undefined && !isString(value) {
			return false
		}
	}
	if derived := scene.Value("derived_from"); derived != jscompat.Undefined {
		record, ok := jscompat.AsObject(derived)
		if !ok || strings.Join(record.Keys(), ",") != "shot" || !isString(record.Value("shot")) {
			return false
		}
	}
	return true
}

// filled — непустой после trim текст без «ЗАПОЛНИТЬ».
func filled(text string) bool { return jscompat.Trim(text) != "" && !placeholder.MatchString(text) }

// checkTreatmentCast — checkTreatmentCast оригинала: логлайн и постановка частей заполнены, части
// ссылаются только на сущности кастинга. Документы уже нормализованы (cast.Normalize, трактовка).
func checkTreatmentCast(castValue, treatment any) error {
	entities := map[string]bool{}
	for _, entity := range arrayItems(jscompat.Get(castValue, "entities")) {
		if id, ok := jscompat.Get(entity, "id").(string); ok {
			entities[id] = true
		}
	}
	logline, _ := jscompat.Get(treatment, "logline").(string)
	if !filled(logline) {
		return errors.New(textTreatmentLoglineMissing)
	}
	for _, part := range arrayItems(jscompat.Get(treatment, "sequences")) {
		id, _ := jscompat.Get(part, "id").(string)
		direction, _ := jscompat.Get(part, "direction").(string)
		if !filled(direction) {
			return errors.New(textPartDirectionMissing(id))
		}
		for _, entity := range arrayItems(jscompat.Get(part, "entities")) {
			if name, _ := entity.(string); !entities[name] {
				return errors.New(textPartUnknownEntity(id, jscompat.ToString(entity)))
			}
		}
	}
	return nil
}

// arrayItems — элементы массива или пусто для не-массива.
func arrayItems(value any) []any {
	items, _ := jscompat.AsArray(value)
	return items
}

// checkReadyScenes — checkReadyScenes оригинала: строгая готовность реестра из предложения агента
// (ручной черновик может быть неполным). Все проблемы — одной ошибкой, по строке на проблему:
// интерфейс показывает их списком; незаполненные планы сводятся в один первый пункт.
func checkReadyScenes(scenes, castValue any, duration float64) error {
	problems, err := scenario.ValidateScenes(scenes, castValue)
	if err != nil {
		return err
	}
	if math.Abs(jscompat.ToNumber(jscompat.GetPath(scenes, "audio", "end_seconds"))-duration) >= 1/fps {
		problems = append(problems, textRegistryDecodedDuration)
	}
	references, err := cast.References(castValue)
	if err != nil {
		return err
	}
	if !deepEqual(jscompat.Get(scenes, "references"), references) {
		problems = append(problems, textRegistryReferencesMismatch)
	}
	if direction, _ := jscompat.Get(scenes, "visual_direction").(string); !filled(direction) {
		problems = append(problems, textRegistryDirectionMissing)
	}
	entities := map[string]*jscompat.Object{}
	for _, item := range arrayItems(jscompat.Get(castValue, "entities")) {
		if entity, ok := jscompat.AsObject(item); ok {
			if id, ok := entity.Value("id").(string); ok {
				entities[id] = entity
			}
		}
	}
	unfilled := []string{}
	for _, item := range arrayItems(jscompat.Get(scenes, "scenes")) {
		shot := item.(*jscompat.Object)
		id := shot.Value("id").(string)
		empty := false
		for _, key := range []string{"camera", "action", "continuity"} {
			if jscompat.Trim(jscompat.ToString(shot.Value(key))) == "" {
				empty = true
			}
		}
		if empty || placeholder.MatchString(jscompat.Stringify(shot)) {
			unfilled = append(unfilled, id)
		}
		changes := shot.Value("state_changes").(*jscompat.Object)
		for _, phase := range changes.Keys() {
			delta := changes.Value(phase).(*jscompat.Object)
			for _, entityID := range delta.Keys() {
				entity, known := entities[entityID]
				if !known {
					problems = append(problems, textStateUnknownEntity(id, entityID))
					continue
				}
				properties := map[string]bool{}
				kind := jscompat.ToString(entity.Value("kind"))
				for _, property := range arrayItems(jscompat.GetPath(castValue, "properties", kind)) {
					properties[jscompat.ToString(jscompat.Get(property, "key"))] = true
				}
				if initial, ok := jscompat.AsObject(entity.Value("initial_state")); ok {
					for _, key := range initial.Keys() {
						properties[key] = true
					}
				}
				for _, key := range delta.Value(entityID).(*jscompat.Object).Keys() {
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

// proposalDocuments — proposalDocuments оригинала: разбор и проверка ответа агента для прохода
// pass. treatment заменяет пару кастинга и трактовки; scenes принимает заполненный каркас без
// изменения окон; revise применяет патчи постановки выбранных планов. Результат — новые документы;
// before не изменяется.
//
// Отличие от 634fd94: ответ, который не разбирается как JSON, отклоняется текстом
// proposalInvalidDocument; оригинал показывал англоязычное сообщение SyntaxError движка V8,
// которое Go воспроизвести не может.
func proposalDocuments(raw, pass string, before Documents, scaffold any, selected []string, duration float64) (Documents, error) {
	parsed, err := jscompat.Parse([]byte(raw))
	if err != nil {
		return Documents{}, errors.New(textProposalInvalidDocument)
	}
	value, ok := jscompat.AsObject(parsed)
	if !ok || !jscompat.StrictEqual(value.Value("schemaVersion"), 1.0) || !jscompat.StrictEqual(value.Value("pass"), pass) {
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
		shots := arrayItems(jscompat.Get(scenes, "scenes"))
		base := arrayItems(jscompat.Get(scaffold, "scenes"))
		if scaffold == nil || !deepEqual(jscompat.Get(scenes, "audio"), jscompat.Get(scaffold, "audio")) ||
			!deepEqual(jscompat.Get(scenes, "sequences"), jscompat.Get(scaffold, "sequences")) || len(shots) != len(base) {
			return Documents{}, errors.New(textProposalScaffoldChanged)
		}
		for index, shot := range shots {
			for _, key := range []string{"id", "original", "sequence", "start_frame", "end_frame_exclusive"} {
				if !jscompat.StrictEqual(jscompat.Get(shot, key), jscompat.Get(base[index], key)) {
					return Documents{}, errors.New(textProposalShotWindowChanged(jscompat.ToString(jscompat.Get(shot, "id"))))
				}
			}
		}
	} else {
		patchList, isList := jscompat.AsArray(value.Value("patches"))
		if before.Scenes == nil || !isList || len(patchList) == 0 {
			return Documents{}, errors.New(textProposalPatchesMissing)
		}
		patches := map[string]*jscompat.Object{}
		for _, item := range patchList {
			patch, ok := jscompat.AsObject(item)
			id, idOK := jscompat.Get(item, "id").(string)
			if !ok || !idOK || !slices.Contains(selected, id) || patches[id] != nil || patch.Len() < 2 ||
				slices.ContainsFunc(patch.Keys(), func(key string) bool { return key != "id" && !slices.Contains(stagingFields, key) }) {
				return Documents{}, errors.New(textProposalPatchesInvalid)
			}
			patches[id] = patch
		}
		// derived_from: null в патче снимает признак производного плана; остальные поля заменяются целиком.
		shots := []any{}
		for _, item := range arrayItems(jscompat.Get(before.Scenes, "scenes")) {
			next := jscompat.Spread(item)
			if patch := patches[jscompat.ToString(jscompat.Get(item, "id"))]; patch != nil {
				for _, key := range patch.Keys() {
					next.Set(key, patch.Value(key))
				}
			}
			if next.Value("derived_from") == nil {
				next.Delete("derived_from")
			}
			shots = append(shots, next)
		}
		candidate := jscompat.Spread(before.Scenes)
		candidate.Set("scenes", &jscompat.Array{Items: shots})
		if err := checkScenesShape(candidate); err != nil {
			return Documents{}, err
		}
		scenes = candidate
	}
	if err := checkReadyScenes(scenes, before.Cast, duration); err != nil {
		return Documents{}, err
	}
	return Documents{Cast: before.Cast, Treatment: before.Treatment, Scenes: scenes}, nil
}

// initialFrom — Object.fromEntries(cast.entities.map((e) => [e.id, e.initial_state])): начальное
// состояние сущностей для resolveStates; без кастинга — пустой объект.
func initialFrom(castValue any) *jscompat.Object {
	result := jscompat.NewObject()
	for _, entity := range arrayItems(jscompat.Get(castValue, "entities")) {
		result.Set(jscompat.ToString(jscompat.Get(entity, "id")), jscompat.Get(entity, "initial_state"))
	}
	return result
}

// changedSceneIds — changedSceneIds оригинала: планы предложения, чья постановка или вычисленное
// состояние отличается от прежнего реестра (в том числе унаследованное от изменённого плана).
// Некорректный прежний реестр не мешает: его состояния считаются пустыми.
func changedSceneIds(before, after Documents) ([]string, error) {
	if after.Scenes == nil {
		return []string{}, nil
	}
	previous := map[string]any{}
	for _, scene := range arrayItems(jscompat.Get(before.Scenes, "scenes")) {
		// new Map(entries): при повторе кода остаётся последний план.
		previous[jscompat.ToString(jscompat.Get(scene, "id"))] = scene
	}
	var beforeStates any = jscompat.NewObject()
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
	for _, scene := range arrayItems(jscompat.Get(after.Scenes, "scenes")) {
		id := jscompat.ToString(jscompat.Get(scene, "id"))
		old, known := previous[id]
		if !known {
			old = jscompat.Undefined
		}
		if !deepEqual(old, scene) || !deepEqual(jscompat.Get(beforeStates, id), afterStates.Value(id)) {
			changed = append(changed, id)
		}
	}
	return changed, nil
}
