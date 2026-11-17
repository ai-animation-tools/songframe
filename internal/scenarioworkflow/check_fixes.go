package scenarioworkflow

import (
	"errors"
	"slices"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/production"
	"songframe/internal/scenario"
	"songframe/internal/scenesave"
)

// Исправление проблем проверки сценария силами приложения. Проблема состояния несёт структурные
// правки (CheckChange): приложение записывает их в state_changes названных планов тем же
// сохранением, что страница «Сценарий», без второго задания агента. Правка раннего плана по
// наследованию меняет и следующие, в том числе принятые: перед записью пользователь видит их
// (CheckFixPreview) и по каждому решает, переснять его или оставить принятым, потому что его видео
// уже соответствует исправленным записям (Keep — выборочный режим keep в scenesave). Правки других
// проблем выполняет обычная доработка плана агентом: интерфейс открывает её с текстом проблемы.

// CheckFixInput — ScenarioCheckFixInput: проблемы отчёта по номерам с 0 в порядке отчёта и
// принятые планы, которые остаются принятыми после правки.
type CheckFixInput struct {
	Project string   `json:"project"`
	Issues  []int    `json:"issues"`
	Keep    []string `json:"keep"`
}

// CheckFixChange — правка в предпросмотре: где, текущее значение вычисленного состояния и новое.
// Current и Value равны nil, если значения нет или правка его убирает.
type CheckFixChange struct {
	Issue         int     `json:"issue"`
	Shot          string  `json:"shot"`
	Phase         string  `json:"phase"`
	Entity        string  `json:"entity"`
	EntityName    string  `json:"entityName"`
	Property      string  `json:"property"`
	PropertyLabel string  `json:"propertyLabel"`
	Current       *string `json:"current"`
	Value         *string `json:"value"`
}

// CheckFixShot — принятый план, который правки задевают; Direct — правка в самом плане, иначе он
// меняется через наследование состояния.
type CheckFixShot struct {
	ID     string `json:"id"`
	Direct bool   `json:"direct"`
}

// CheckFixPreview — ScenarioCheckFixPreview: правки выбранных проблем, задетые принятые планы
// (выбор «переснять» или «оставить принятым») и прочие планы с начатым производством, которые
// станут устаревшими.
type CheckFixPreview struct {
	Changes  []CheckFixChange `json:"changes"`
	Accepted []CheckFixShot   `json:"accepted"`
	Stale    []string         `json:"stale"`
}

// castProperties — свойства состояния каждой сущности кастинга: словарь её типа (без своего — общий
// набор) и ключи начального состояния, в порядке словаря.
func castProperties(castValue any) (map[string][]string, error) {
	normalized, err := cast.EnsureProperties(castValue, cast.LoadDefaults())
	if err != nil {
		return nil, err
	}
	kinds, _ := dynvalue.AsObject(normalized.Value("properties"))
	result := map[string][]string{}
	for _, entity := range arrayItems(normalized.Value("entities")) {
		id := dynvalue.ToString(dynvalue.Get(entity, "id"))
		keys := []string{}
		for _, item := range arrayItems(kinds.Value(dynvalue.ToString(dynvalue.Get(entity, "kind")))) {
			if key, ok := dynvalue.Get(item, "key").(string); ok && !slices.Contains(keys, key) {
				keys = append(keys, key)
			}
		}
		if state, ok := dynvalue.AsObject(dynvalue.Get(entity, "initial_state")); ok {
			for _, key := range state.Keys() {
				if !slices.Contains(keys, key) {
					keys = append(keys, key)
				}
			}
		}
		result[id] = keys
	}
	return result, nil
}

// castNames — имя сущности и подписи её свойств по текущему кастингу для предпросмотра.
func castNames(castValue any) (map[string]string, map[string]map[string]string) {
	names := map[string]string{}
	labels := map[string]map[string]string{}
	normalized, err := cast.EnsureProperties(castValue, cast.LoadDefaults())
	if err != nil {
		return names, labels
	}
	kinds, _ := dynvalue.AsObject(normalized.Value("properties"))
	for _, entity := range arrayItems(normalized.Value("entities")) {
		id := dynvalue.ToString(dynvalue.Get(entity, "id"))
		names[id], _ = dynvalue.Get(entity, "name").(string)
		labels[id] = map[string]string{}
		for _, item := range arrayItems(kinds.Value(dynvalue.ToString(dynvalue.Get(entity, "kind")))) {
			key, _ := dynvalue.Get(item, "key").(string)
			labels[id][key], _ = dynvalue.Get(item, "label").(string)
		}
	}
	return names, labels
}

// fixPlan — подготовленное исправление: черновик реестра с правками и их список для предпросмотра.
type fixPlan struct {
	record  *checkRecord
	input   *inputs
	draft   *dynvalue.Object
	changes []CheckFixChange
	impact  scenesave.Impact
}

// prepareFix — черновик реестра с правками выбранных проблем и влияние его сохранения. Под mu.
// Проблема без правок, уже исправленная или вне отчёта отклоняет весь выбор; два разных значения
// одному месту — тоже: какое из них верное, решает человек.
func (w *Workflow) prepareFix(project string, issues []int) (*fixPlan, error) {
	if len(issues) == 0 {
		return nil, errors.New(textCheckFixNone)
	}
	view, input, err := w.checkView(project)
	if err != nil {
		return nil, err
	}
	if view.Status != CheckReady || view.Report == nil {
		return nil, errors.New(textCheckFixNoReport)
	}
	if w.busy(input.project) {
		return nil, errors.New(textCheckBusy)
	}
	if input.documents.Scenes == nil || len(input.problems) > 0 || !input.scenesValid {
		return nil, errors.New(textCheckScenarioInvalid)
	}
	draft, ok := dynvalue.DeepClone(input.documents.Scenes).(*dynvalue.Object)
	if !ok {
		return nil, errors.New(textCheckScenarioInvalid)
	}
	scenes := map[string]*dynvalue.Object{}
	for _, item := range arrayItems(draft.Value("scenes")) {
		if object, isObject := item.(*dynvalue.Object); isObject {
			scenes[dynvalue.ToString(object.Value("id"))] = object
		}
	}
	properties, err := castProperties(input.documents.Cast)
	if err != nil {
		return nil, err
	}
	initial, err := cast.InitialStates(input.documents.Cast)
	if err != nil {
		return nil, err
	}
	details, err := scenario.ResolveDetailed(input.documents.Scenes, initial)
	if err != nil {
		return nil, err
	}
	names, labels := castNames(input.documents.Cast)
	plan := &fixPlan{record: readCheck(input.project), input: input, draft: draft, changes: []CheckFixChange{}}
	chosen := []int{}
	for _, index := range issues {
		if index < 0 || index >= len(view.Report.Issues) {
			return nil, errors.New(textCheckFixUnknown(index + 1))
		}
		if slices.Contains(chosen, index) {
			continue
		}
		chosen = append(chosen, index)
		issue := view.Report.Issues[index]
		switch {
		case issue.Fixed || issue.Resolved:
			return nil, errors.New(textCheckFixDone(issue.Title))
		case len(issue.Changes) == 0:
			return nil, errors.New(textCheckFixNoChanges(issue.Title))
		}
		for _, change := range issue.Changes {
			scene := scenes[change.Shot]
			if scene == nil || !slices.Contains(properties[change.Entity], change.Property) {
				return nil, errors.New(textCheckFixMissing(change.Shot, change.Entity))
			}
			for _, other := range plan.changes {
				if other.Shot == change.Shot && other.Phase == change.Phase && other.Entity == change.Entity && other.Property == change.Property && !equalText(other.Value, change.Value) {
					return nil, errors.New(textCheckFixConflict(change.Shot, names[change.Entity], labelOr(labels[change.Entity][change.Property], change.Property)))
				}
			}
			setStateChange(scene, change)
			detail := details[change.Shot]
			state := detail.State.Before
			if change.Phase == "after" {
				state = detail.State.After
			}
			var current *string
			if text, isText := dynvalue.Get(dynvalue.Get(state, change.Entity), change.Property).(string); isText {
				current = &text
			}
			plan.changes = append(plan.changes, CheckFixChange{
				Issue: index, Shot: change.Shot, Phase: change.Phase,
				Entity: change.Entity, EntityName: labelOr(names[change.Entity], change.Entity),
				Property: change.Property, PropertyLabel: labelOr(labels[change.Entity][change.Property], change.Property),
				Current: current, Value: change.Value,
			})
		}
	}
	if plan.impact, err = scenesave.SaveImpact(input.project, draft); err != nil {
		return nil, err
	}
	return plan, nil
}

// setStateChange — запись правки в state_changes плана: фаза → сущность → свойство; первый кадр
// задаётся раньше последнего, как в остальном реестре.
func setStateChange(scene *dynvalue.Object, change CheckChange) {
	changes, _ := scene.Value("state_changes").(*dynvalue.Object)
	if changes == nil {
		changes = dynvalue.NewObject()
		scene.Set("state_changes", changes)
	}
	phase, _ := changes.Value(change.Phase).(*dynvalue.Object)
	if phase == nil {
		phase = dynvalue.NewObject()
		changes.Set(change.Phase, phase)
	}
	entity, _ := phase.Value(change.Entity).(*dynvalue.Object)
	if entity == nil {
		entity = dynvalue.NewObject()
		phase.Set(change.Entity, entity)
	}
	if change.Value != nil {
		entity.Set(change.Property, *change.Value)
	} else {
		entity.Set(change.Property, nil)
	}
	if changes.Has("before") && changes.Has("after") && slices.Index(changes.Keys(), "after") < slices.Index(changes.Keys(), "before") {
		after := changes.Value("after")
		changes.Delete("after")
		changes.Set("after", after)
	}
}

// preview — задетые принятые планы и прочие планы с начатым производством.
func (p *fixPlan) preview() CheckFixPreview {
	result := CheckFixPreview{Changes: p.changes, Accepted: []CheckFixShot{}, Stale: []string{}}
	for _, shot := range p.impact.Shots {
		direct := slices.ContainsFunc(p.changes, func(change CheckFixChange) bool { return change.Shot == shot.ID })
		switch {
		case shot.State == production.StateCompleted:
			result.Accepted = append(result.Accepted, CheckFixShot{ID: shot.ID, Direct: direct})
		case shot.Produced || shot.State == production.StateStale || shot.State == production.StateProgress:
			result.Stale = append(result.Stale, shot.ID)
		}
	}
	return result
}

// CheckFixPreview — scenarioWorkflow.checkFixPreview: что изменят правки выбранных проблем, без записи.
func (w *Workflow) CheckFixPreview(project string, issues []int) (CheckFixPreview, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	plan, err := w.prepareFix(project, issues)
	if err != nil {
		return CheckFixPreview{}, err
	}
	return plan.preview(), nil
}

// ApplyCheckFixes — scenarioWorkflow.applyCheckFixes: запись правок выбранных проблем в реестр.
// Принятые планы из Keep остаются принятыми, остальные задетые устаревают, как при обычном
// сохранении. Проблемы отмечаются исправленными; если отчёт не был устаревшим, его отпечатки
// переносятся на исправленный сценарий: правки взяты из самого отчёта, остальные проблемы в силе.
func (w *Workflow) ApplyCheckFixes(input CheckFixInput) (CheckView, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	plan, err := w.prepareFix(input.Project, input.Issues)
	if err != nil {
		return CheckView{}, err
	}
	preview := plan.preview()
	for _, shot := range input.Keep {
		if !slices.ContainsFunc(preview.Accepted, func(item CheckFixShot) bool { return item.ID == shot }) {
			return CheckView{}, errors.New(textCheckFixKeepInvalid(shot))
		}
	}
	project := plan.input.project
	wasFresh := hashesFrom(plan.record.doc.Value("hashes")).matches(checkHashes(plan.input))
	if _, err := scenesave.SaveScenesKeeping(project, plan.draft, input.Keep); err != nil {
		return CheckView{}, err
	}
	fixed := plan.record.fixed()
	for _, change := range plan.changes {
		if !slices.Contains(fixed, change.Issue) {
			fixed = append(fixed, change.Issue)
		}
	}
	plan.record.setNumbers("fixed", fixed)
	if wasFresh {
		current, err := readInputs(project)
		if err != nil {
			return CheckView{}, err
		}
		plan.record.doc.Set("hashes", checkHashes(current).object())
	}
	if err := writeCheck(project, plan.record); err != nil {
		return CheckView{}, err
	}
	view, _, err := w.checkView(project)
	return view, err
}

// equalText — два необязательных значения правки равны.
func equalText(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// labelOr — подпись или код, если подписи нет.
func labelOr(label, fallback string) string {
	if label == "" {
		return fallback
	}
	return label
}

// CheckResolveInput — ScenarioCheckResolveInput: проблема отчёта по номеру с 0 и отметка «решено
// вручную» (Resolved=false снимает её).
type CheckResolveInput struct {
	Project  string `json:"project"`
	Issue    int    `json:"issue"`
	Resolved bool   `json:"resolved"`
}

// ResolveCheckIssue — scenarioWorkflow.resolveCheckIssue: отметка проблемы решённой вручную или её
// снятие. Сценарий не меняется, поэтому отметка доступна и для устаревшего отчёта: так закрываются
// исправленные руками, ложные и сознательно пропущенные проблемы. Исправленную приложением проблему
// отметка не меняет.
func (w *Workflow) ResolveCheckIssue(input CheckResolveInput) (CheckView, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, inputs, err := w.checkView(input.Project)
	if err != nil {
		return CheckView{}, err
	}
	if view.Status != CheckReady || view.Report == nil {
		return CheckView{}, errors.New(textCheckFixNoReport)
	}
	if input.Issue < 0 || input.Issue >= len(view.Report.Issues) {
		return CheckView{}, errors.New(textCheckFixUnknown(input.Issue + 1))
	}
	if view.Report.Issues[input.Issue].Fixed {
		return CheckView{}, errors.New(textCheckFixDone(view.Report.Issues[input.Issue].Title))
	}
	record := readCheck(inputs.project)
	resolved := slices.DeleteFunc(record.resolved(), func(index int) bool { return index == input.Issue })
	if input.Resolved {
		resolved = append(resolved, input.Issue)
	}
	record.setNumbers("resolved", resolved)
	if err := writeCheck(inputs.project, record); err != nil {
		return CheckView{}, err
	}
	view, _, err = w.checkView(inputs.project)
	return view, err
}

// checkIssueLink — связь доработки с проблемой отчёта, запустившей её: задание проверки и номер
// проблемы. nil, если проблема не из готового отчёта или уже закрыта.
func checkIssueLink(project string, issue *int) *dynvalue.Object {
	if issue == nil {
		return nil
	}
	record := readCheck(project)
	if record == nil || record.status() != CheckReady {
		return nil
	}
	report := record.report()
	if report == nil || *issue < 0 || *issue >= len(report.Issues) || report.Issues[*issue].Fixed || report.Issues[*issue].Resolved {
		return nil
	}
	link := dynvalue.NewObject()
	link.Set("job", record.doc.Value("jobId"))
	link.Set("index", float64(*issue))
	return link
}

// markCheckIssueFixed — применённая доработка, запущенная из проблемы отчёта, отмечает её
// исправленной, если отчёт тот же (то же задание проверки). Отпечатки отчёта не переносятся:
// агент мог изменить и другое, поэтому отчёт честно становится устаревшим. Сбой записи отметки не
// отменяет уже опубликованный сценарий.
func markCheckIssueFixed(project string, link any) {
	index, ok := dynvalue.Get(link, "index").(float64)
	record := readCheck(project)
	if !ok || record == nil || !dynvalue.StrictEqual(record.doc.Value("jobId"), dynvalue.Get(link, "job")) {
		return
	}
	fixed := record.fixed()
	if slices.Contains(fixed, int(index)) {
		return
	}
	record.setNumbers("fixed", append(fixed, int(index)))
	_ = writeCheck(project, record)
}
