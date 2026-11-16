package productionworkflow

import (
	"errors"
	"path/filepath"
	"slices"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/production"
	"songframe/internal/scenario"
	"songframe/internal/scenesave"
)

// Отказ описания со списком противоречий. Агент, нашедший противоречие сценария, которое не даёт
// подготовить непротиворечивые опоры, отвечает документом stage=blocked: краткая причина и по
// каждому противоречию — где оно (поле состояния на первом или последнем кадре плана либо поле
// постановки), в чём оно и, для поля состояния, какое значение его снимает. Чтобы агент видел,
// откуда пришло каждое значение врезки, контекст описания получает stateSources (stateSourcesTree).
// Приложение дополняет противоречия текущим значением, источником и подписями (parseBlocked) и
// показывает их таблицей; «Исправить сценарий» (FixScenario) записывает предложенные значения в
// state_changes этого плана тем же сохранением, что страница «Сценарий». Правка только в своём
// плане и не затрагивает принятые планы: кастинг и другие планы агент не правит.

// blockedStage — значение stage отказа со списком противоречий.
const blockedStage = "blocked"

// planFields — поля постановки, которые может назвать противоречие без исправления.
var planFields = []string{"action", "camera", "continuity", "references"}

// refusalError — отказ агента со списком противоречий: text — итог агента (reason) для agentText,
// problems — противоречия для таблицы.
type refusalError struct {
	text     string
	problems *dynvalue.Array
}

func (e *refusalError) Error() string { return textAgentRefused }

// sourceLabel — источник значения состояния для контекста агента: cast — начальное состояние
// кастинга, Mxx.before / Mxx.after — изменение плана Mxx на его первом или последнем кадре.
func sourceLabel(source any) string {
	if dynvalue.Get(source, "kind") == "plan" {
		return dynvalue.ToString(dynvalue.Get(source, "shot")) + "." + dynvalue.ToString(dynvalue.Get(source, "phase"))
	}
	return "cast"
}

// resolvedPlan — вычисленное состояние плана shot по сохранённому реестру и кастингу проекта.
func resolvedPlan(project, shot string) (scenario.Detailed, bool) {
	registry, err := readJSON(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		return scenario.Detailed{}, false
	}
	read := cast.Read(project)
	var castValue any
	if dynvalue.Truthy(read.Value) {
		castValue = read.Value
	}
	initial, err := cast.InitialStates(castValue)
	if err != nil {
		return scenario.Detailed{}, false
	}
	details, err := scenario.ResolveDetailed(registry, initial)
	if err != nil {
		return scenario.Detailed{}, false
	}
	detail, ok := details[shot]
	return detail, ok
}

// stateSourcesTree — источники значений врезок плана shot: фаза → сущность → свойство → метка
// sourceLabel, только по сущностям самих врезок (briefs[phase].state). nil, если состояние не
// вычисляется: тогда ключ в контекст не пишется.
func stateSourcesTree(project, shot string, briefs *dynvalue.Object) *dynvalue.Object {
	detail, ok := resolvedPlan(project, shot)
	if !ok {
		return nil
	}
	result := dynvalue.NewObject()
	for _, phase := range []string{"before", "after"} {
		phaseSources := dynvalue.NewObject()
		state, _ := dynvalue.AsObject(dynvalue.Get(briefs.Value(phase), "state"))
		sources := detail.Sources[phase]
		if state != nil && sources != nil {
			for _, entity := range state.Keys() {
				entitySources, _ := dynvalue.AsObject(sources.Value(entity))
				if entitySources == nil {
					continue
				}
				labels := dynvalue.NewObject()
				for _, property := range entitySources.Keys() {
					labels.Set(property, sourceLabel(entitySources.Value(property)))
				}
				phaseSources.Set(entity, labels)
			}
		}
		result.Set(phase, phaseSources)
	}
	return result
}

// castLabels — имя сущности и подписи её свойств по кастингу проекта (словарь свойств по типу,
// без своего словаря — общий набор).
type castLabels struct {
	names      map[string]string
	properties map[string]map[string]string
}

// readCastLabels — подписи кастинга проекта; без кастинга — пустые словари.
func readCastLabels(project string) castLabels {
	labels := castLabels{names: map[string]string{}, properties: map[string]map[string]string{}}
	read := cast.Read(project)
	if !dynvalue.Truthy(read.Value) {
		return labels
	}
	normalized, err := cast.EnsureProperties(read.Value, cast.LoadDefaults())
	if err != nil {
		return labels
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
		labels.names[id] = name
		properties := map[string]string{}
		var list any
		if kinds != nil {
			list = kinds.Value(kind)
		}
		items, _ := dynvalue.AsArray(list)
		if items == nil {
			generic, _ := dynvalue.AsArray(cast.LoadDefaults().Generic)
			items = generic
		}
		for _, item := range items {
			if key, ok := dynvalue.Get(item, "key").(string); ok {
				label, _ := dynvalue.Get(item, "label").(string)
				properties[key] = label
			}
		}
		labels.properties[id] = properties
	}
	return labels
}

// text — непустая после обрезки строка поля key объекта value.
func text(value any, key string) (string, bool) {
	field, ok := dynvalue.Get(value, key).(string)
	if !ok || dynvalue.Trim(field) == "" {
		return "", false
	}
	return dynvalue.Trim(field), true
}

// parseBlocked разбирает отказ описания со списком противоречий. ok=false — ответ не такого вида
// (обычный разбор продолжается); ошибка — документ stage=blocked нарушает контракт.
func parseBlocked(project, shot, raw string) (*refusalError, bool, error) {
	parsed, err := dynvalue.Parse([]byte(raw))
	if err != nil {
		return nil, false, nil
	}
	document, ok := parsed.(*dynvalue.Object)
	if !ok || document.Value("stage") != blockedStage {
		return nil, false, nil
	}
	invalid := errors.New(textBlockedInvalid)
	for _, key := range document.Keys() {
		if !slices.Contains([]string{"schemaVersion", "stage", "reason", "problems"}, key) {
			return nil, true, invalid
		}
	}
	reason, hasReason := text(document, "reason")
	items, _ := dynvalue.AsArray(document.Value("problems"))
	if document.Value("schemaVersion") != float64(1) || !hasReason || len(items) == 0 {
		return nil, true, invalid
	}
	labels := readCastLabels(project)
	detail, resolved := resolvedPlan(project, shot)
	problems := &dynvalue.Array{Items: []any{}}
	for _, item := range items {
		problem, ok := item.(*dynvalue.Object)
		if !ok {
			return nil, true, invalid
		}
		for _, key := range problem.Keys() {
			if !slices.Contains([]string{"phase", "entity", "property", "field", "conflict", "fix"}, key) {
				return nil, true, invalid
			}
		}
		conflict, hasConflict := text(problem, "conflict")
		fixValue := problem.Value("fix")
		fix, hasFix := text(problem, "fix")
		if !hasConflict || (fixValue != nil && fixValue != dynvalue.Undefined && !hasFix) {
			return nil, true, invalid
		}
		tree := dynvalue.NewObject()
		if field, isField := problem.Value("field").(string); isField {
			// Противоречие в постановке: приложение его не исправляет, только показывает.
			if !slices.Contains(planFields, field) || hasFix || problem.Has("phase") || problem.Has("entity") || problem.Has("property") {
				return nil, true, invalid
			}
			tree.Set("field", field)
			tree.Set("conflict", conflict)
			problems.Items = append(problems.Items, tree)
			continue
		}
		phase, _ := problem.Value("phase").(string)
		entity, _ := problem.Value("entity").(string)
		property, _ := problem.Value("property").(string)
		properties, known := labels.properties[entity]
		_, knownProperty := properties[property]
		if (phase != "before" && phase != "after") || !known || !knownProperty {
			return nil, true, invalid
		}
		tree.Set("phase", phase)
		tree.Set("entity", entity)
		tree.Set("entityName", labels.names[entity])
		tree.Set("property", property)
		tree.Set("propertyLabel", properties[property])
		// Текущее значение и его источник берутся из вычисленного состояния, а не со слов агента.
		var current, source any
		if resolved {
			state := detail.State.Before
			if phase == "after" {
				state = detail.State.After
			}
			current = dynvalue.Get(dynvalue.Get(state, entity), property)
			if origin := dynvalue.Get(dynvalue.Get(detail.Sources[phase], entity), property); origin != nil && origin != dynvalue.Undefined {
				object := dynvalue.NewObject()
				if dynvalue.Get(origin, "kind") == "plan" {
					object.Set("shot", dynvalue.ToString(dynvalue.Get(origin, "shot")))
					object.Set("phase", dynvalue.Get(origin, "phase"))
				} else {
					object.Set("shot", nil)
					object.Set("phase", nil)
				}
				source = object
			}
		}
		if current == dynvalue.Undefined {
			current = nil
		}
		tree.Set("current", current)
		tree.Set("source", source)
		tree.Set("conflict", conflict)
		if hasFix {
			tree.Set("fix", fix)
		} else {
			tree.Set("fix", nil)
		}
		problems.Items = append(problems.Items, tree)
	}
	return &refusalError{text: reason, problems: problems}, true, nil
}

// fixesOf — исправления предложения: противоречия состояния с предложенным значением.
func fixesOf(proposal *dynvalue.Object) []*dynvalue.Object {
	items, _ := dynvalue.AsArray(proposal.Value("problems"))
	fixes := []*dynvalue.Object{}
	for _, item := range items {
		if problem, ok := item.(*dynvalue.Object); ok {
			if _, isText := problem.Value("fix").(string); isText {
				fixes = append(fixes, problem)
			}
		}
	}
	return fixes
}

// FixScenario — productionWorkflow.fixScenario: исправления отказа id записываются в state_changes
// плана shot и сохраняются, как правка постановки на странице «Сценарий» (режим production), а
// отказ отклоняется. Исправление, которое изменило бы постановку принятого плана (через
// наследование состояния), не вносится: такую правку пользователь делает на странице «Сценарий».
// Новое задание описания интерфейс запускает обычной подготовкой.
func (w *Workflow) FixScenario(project, shot, packageDir, id string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, err := ReadContext(project, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	stored := w.store.Read(c.Project, shot)
	if stored == nil || stored.ID() != id || stored.PackageDir() != c.PackageDir || stored.Status() != "invalid" {
		return View{}, errors.New(textFixUnavailable)
	}
	fixes := fixesOf(stored.Proposal())
	if len(fixes) == 0 {
		return View{}, errors.New(textFixUnavailable)
	}
	registry, err := readJSON(filepath.Join(c.Project, "plan", "scenes.json"))
	if err != nil {
		return View{}, err
	}
	draft, ok := dynvalue.DeepClone(registry).(*dynvalue.Object)
	if !ok {
		return View{}, errors.New(textFixUnavailable)
	}
	scenes, _ := dynvalue.AsArray(draft.Value("scenes"))
	var scene *dynvalue.Object
	for _, item := range scenes {
		if object, isObject := item.(*dynvalue.Object); isObject && dynvalue.ToString(object.Value("id")) == shot {
			scene = object
		}
	}
	if scene == nil {
		return View{}, errors.New(textFixUnavailable)
	}
	changes, _ := scene.Value("state_changes").(*dynvalue.Object)
	if changes == nil {
		changes = dynvalue.NewObject()
		scene.Set("state_changes", changes)
	}
	for _, fix := range fixes {
		phase, entity, property := fix.Value("phase").(string), fix.Value("entity").(string), fix.Value("property").(string)
		phaseChanges, _ := changes.Value(phase).(*dynvalue.Object)
		if phaseChanges == nil {
			phaseChanges = dynvalue.NewObject()
			changes.Set(phase, phaseChanges)
		}
		entityChanges, _ := phaseChanges.Value(entity).(*dynvalue.Object)
		if entityChanges == nil {
			entityChanges = dynvalue.NewObject()
			phaseChanges.Set(entity, entityChanges)
		}
		entityChanges.Set(property, fix.Value("fix"))
	}
	// Первый кадр задаётся раньше последнего: порядок фаз как в остальном реестре.
	if changes.Has("before") && changes.Has("after") && slices.Index(changes.Keys(), "after") < slices.Index(changes.Keys(), "before") {
		after := changes.Value("after")
		changes.Delete("after")
		changes.Set("after", after)
	}
	impact, err := scenesave.SaveImpact(c.Project, draft)
	if err != nil {
		return View{}, err
	}
	accepted := []string{}
	for _, item := range impact.Shots {
		if item.ID != shot && (item.State == production.StateCompleted || item.State == production.StateStale) {
			accepted = append(accepted, item.ID)
		}
	}
	if len(accepted) > 0 {
		return View{}, errors.New(textFixTouchesAccepted(accepted))
	}
	if _, err := scenesave.SaveScenesWithMode(c.Project, draft, scenesave.ModeProduction); err != nil {
		return View{}, err
	}
	if err := w.store.WriteDiscarded(c.Project, shot, id); err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, packageDir)
}
