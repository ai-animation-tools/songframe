package scenarioworkflow

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"songframe/internal/agents"
	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/projectfile"
	"songframe/internal/projectfs"
	"songframe/internal/scenario"
	"songframe/internal/tools"
	"songframe/resources"
)

// Проверка сценария до производства: агент читает трактовку, реестр, кастинг с изображениями и
// вычисленное состояние планов и возвращает отчёт о противоречиях для человека. Проект она не
// меняет: отчёт хранится рядом с записью прохода, в plan/scenario-check.json, вместе с отпечатками
// проверенных файлов, поэтому страница видит, что сценарий изменился после проверки. Исправления
// выбирает пользователь: правки состояния из отчёта вносит приложение (check_fixes.go), остальное —
// обычная доработка планов (revise).
//
// Владение: запись проверки принадлежит Workflow и меняется под mu, как запись прохода; задание —
// менеджеру агентов. Проверка и сценарный проход не идут одновременно: оба запускаются, только
// когда у проекта нет работающего задания (busy).

// CheckPath — запись проверки сценария относительно папки проекта.
const CheckPath = "plan/scenario-check.json"

// Состояния проверки (ScenarioCheckView.status). CheckNone — проверки ещё не было.
const (
	CheckNone        = "none"
	CheckRunning     = "running"
	CheckReady       = "ready"
	CheckInvalid     = "invalid"
	CheckFailed      = "failed"
	CheckCancelled   = "cancelled"
	CheckInterrupted = "interrupted"
)

// checkStatuses — состояния, которые хранит запись.
var checkStatuses = []string{CheckRunning, CheckReady, CheckInvalid, CheckFailed, CheckCancelled, CheckInterrupted}

// checkTask — имя задания агента проверки: тот же вид «ai-clip-scenario:<проход>», что у проходов, —
// по нему интерфейс относит задание к странице «Сценарий» (уведомления, журнал отправок).
const checkTask = "ai-clip-scenario:check"

// CheckView — ScenarioCheckView: последняя проверка проекта и доступность новой.
type CheckView struct {
	Status   string `json:"status"`
	CanStart bool   `json:"canStart"`
	// Reason — почему новую проверку запустить нельзя; nil, если можно.
	Reason *string `json:"reason"`
	// Stale — трактовка, реестр, кастинг или исходники изменились после проверки.
	Stale   bool         `json:"stale"`
	Report  *CheckReport `json:"report"`
	Message *string      `json:"message"`
	Job     *AgentJob    `json:"job"`
}

// checkRecord — запись plan/scenario-check.json (schemaVersion 1): status, jobId, shots, entities и
// properties (ID проверенного сценария и свойства состояния каждой сущности — по ним проверяется
// ответ), hashes (отпечатки входов), report, message, fixed (номера проблем отчёта с 0, чьи правки
// внесены) и resolved (номера проблем, отмеченных решёнными вручную; пустой список можно не писать).
// Повреждённая запись читается как отсутствующая.
type checkRecord struct{ doc *dynvalue.Object }

func checkRecordPath(project string) string {
	return filepath.Join(project, filepath.FromSlash(CheckPath))
}

// readCheck — проверенная запись или nil.
func readCheck(project string) *checkRecord {
	data, err := os.ReadFile(checkRecordPath(project))
	if err != nil {
		return nil
	}
	value, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
	doc, ok := dynvalue.AsObject(value)
	if err != nil || !ok || !dynvalue.StrictEqual(doc.Value("schemaVersion"), 1.0) {
		return nil
	}
	status, _ := doc.Value("status").(string)
	if !slices.Contains(checkStatuses, status) || !validHashes(doc.Value("hashes")) {
		return nil
	}
	for _, key := range []string{"shots", "entities", "fixed"} {
		if _, ok := dynvalue.AsArray(doc.Value(key)); !ok {
			return nil
		}
	}
	properties, ok := dynvalue.AsObject(doc.Value("properties"))
	if !ok {
		return nil
	}
	if resolved := doc.Value("resolved"); resolved != dynvalue.Undefined {
		if _, ok := dynvalue.AsArray(resolved); !ok {
			return nil
		}
	}
	for _, entity := range properties.Keys() {
		if _, ok := dynvalue.AsArray(properties.Value(entity)); !ok {
			return nil
		}
	}
	return &checkRecord{doc: doc}
}

// writeCheck — атомарная запись через шлюз записи проекта, как writeState.
func writeCheck(project string, record *checkRecord) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return projectfs.WriteFile(checkRecordPath(project), []byte(dynvalue.StringifyIndent(record.doc, "  ")+"\n"), 0o666)
}

func (r *checkRecord) status() string { text, _ := r.doc.Value("status").(string); return text }

// known — ID проверенного сценария, по которым принимается ответ агента.
func (r *checkRecord) known() checkKnown {
	known := checkKnown{shots: stringItems(r.doc.Value("shots")), entities: stringItems(r.doc.Value("entities")), properties: map[string][]string{}}
	properties, _ := dynvalue.AsObject(r.doc.Value("properties"))
	for _, entity := range properties.Keys() {
		known.properties[entity] = stringItems(properties.Value(entity))
	}
	return known
}

// fixed — номера проблем отчёта, чьи правки уже внесены.
func (r *checkRecord) fixed() []int { return r.numbers("fixed") }

// resolved — номера проблем отчёта, отмеченных решёнными вручную.
func (r *checkRecord) resolved() []int { return r.numbers("resolved") }

// numbers — список номеров проблем записи по ключу; отсутствующий ключ — пустой список.
func (r *checkRecord) numbers(key string) []int {
	result := []int{}
	for _, item := range arrayItems(r.doc.Value(key)) {
		if number, ok := item.(float64); ok {
			result = append(result, int(number))
		}
	}
	return result
}

// setNumbers — отсортированный список номеров проблем под ключом key.
func (r *checkRecord) setNumbers(key string, numbers []int) {
	slices.Sort(numbers)
	items := make([]any, len(numbers))
	for index, number := range numbers {
		items[index] = float64(number)
	}
	r.doc.Set(key, &dynvalue.Array{Items: items})
}

// report — сохранённый отчёт с отметками внесённых правок; nil, если его нет или он не читается.
func (r *checkRecord) report() *CheckReport {
	if !dynvalue.Truthy(r.doc.Value("report")) {
		return nil
	}
	report, err := parseCheckReport(dynvalue.Stringify(r.doc.Value("report")), r.known())
	if err != nil {
		return nil
	}
	for _, index := range r.fixed() {
		if index >= 0 && index < len(report.Issues) {
			report.Issues[index].Fixed = true
		}
	}
	for _, index := range r.resolved() {
		if index >= 0 && index < len(report.Issues) {
			report.Issues[index].Resolved = true
		}
	}
	return &report
}

// checkHashes — отпечатки входов проверки: исходники, разметка, кастинг с изображениями, трактовка
// и реестр. Производные виды и статус производства в них не входят: их смена не меняет сценарий.
func checkHashes(input *inputs) *hashes {
	result := newHashes()
	for _, key := range input.approval.keys {
		result.set(key, input.approval.values[key])
	}
	value, _ := input.hashes.get("plan/scenes.json")
	result.set("plan/scenes.json", value)
	return result
}

// CheckView — scenarioWorkflow.checkView: последняя проверка с учётом итога задания агента.
func (w *Workflow) CheckView(project string) (CheckView, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, _, err := w.checkView(project)
	return view, err
}

// checkView — вид под mu: итог завершившегося задания записывается, затем считается доступность.
func (w *Workflow) checkView(project string) (CheckView, *inputs, error) {
	input, err := readInputs(project)
	if err != nil {
		return CheckView{}, nil, err
	}
	view := CheckView{Status: CheckNone}
	if record := readCheck(input.project); record != nil {
		job, err := w.refreshCheck(input.project, record)
		if err != nil {
			return CheckView{}, nil, err
		}
		view.Status = record.status()
		view.Job = job
		view.Report = record.report()
		if text, ok := record.doc.Value("message").(string); ok && text != "" {
			view.Message = &text
		}
		view.Stale = !hashesFrom(record.doc.Value("hashes")).matches(checkHashes(input))
	}
	reason := ""
	switch {
	case w.busy(input.project):
		reason = textCheckBusy
	case input.documents.Scenes == nil || input.documents.Cast == nil || input.documents.Treatment == nil:
		reason = textCheckNoScenario
	case len(input.problems) > 0 || !input.scenesValid:
		reason = textCheckScenarioInvalid
	}
	view.CanStart = reason == ""
	if reason != "" {
		view.Reason = &reason
	}
	return view, input, nil
}

// refreshCheck — итог задания работающей проверки: запись обновляется один раз, когда задание
// завершилось. Возвращает снимок задания, если менеджер его знает.
func (w *Workflow) refreshCheck(project string, record *checkRecord) (*AgentJob, error) {
	found, known := w.options.Agents.Get(dynvalue.ToString(record.doc.Value("jobId")))
	var job *AgentJob
	if known {
		job = &found
	}
	if record.status() != CheckRunning {
		return job, nil
	}
	message := ""
	switch {
	case job == nil || job.Project != project || job.Status == "interrupted":
		record.doc.Set("status", CheckInterrupted)
		message = textCheckInterrupted
	case job.Status == "running":
		return job, nil
	case job.Status == "cancelled":
		record.doc.Set("status", CheckCancelled)
		message = textCheckCancelled
	case job.Status != "completed" || job.ExitCode == nil || *job.ExitCode != 0:
		record.doc.Set("status", CheckFailed)
		message = job.Message
		if message == "" {
			message = textCheckAgentFailed
		}
	default:
		report, err := parseCheckReport(job.Result, record.known())
		if err != nil {
			record.doc.Set("status", CheckInvalid)
			message = err.Error()
		} else {
			record.doc.Set("status", CheckReady)
			record.doc.Set("report", reportTree(report))
		}
	}
	if message != "" {
		record.doc.Set("message", message)
	} else {
		record.doc.Set("message", nil)
	}
	return job, writeCheck(project, record)
}

// reportTree — отчёт в форме ответа агента (schemaVersion, summary, issues) для записи.
func reportTree(report CheckReport) *dynvalue.Object {
	tree := dynvalue.NewObject()
	tree.Set("schemaVersion", 1.0)
	tree.Set("summary", report.Summary)
	issues := make([]any, len(report.Issues))
	for index, issue := range report.Issues {
		item := dynvalue.NewObject()
		item.Set("group", issue.Group)
		item.Set("severity", issue.Severity)
		item.Set("shots", stringArray(issue.Shots))
		item.Set("entities", stringArray(issue.Entities))
		item.Set("title", issue.Title)
		item.Set("problem", issue.Problem)
		item.Set("why", issue.Why)
		item.Set("fix", issue.Fix)
		changes := make([]any, len(issue.Changes))
		for position, change := range issue.Changes {
			entry := dynvalue.NewObject()
			entry.Set("shot", change.Shot)
			entry.Set("phase", change.Phase)
			entry.Set("entity", change.Entity)
			entry.Set("property", change.Property)
			if change.Value != nil {
				entry.Set("value", *change.Value)
			} else {
				entry.Set("value", nil)
			}
			changes[position] = entry
		}
		item.Set("changes", &dynvalue.Array{Items: changes})
		issues[index] = item
	}
	tree.Set("issues", &dynvalue.Array{Items: issues})
	return tree
}

// StartCheck — scenarioWorkflow.startCheck: подготовка изображений и контекста, запуск задания
// агента и запись проверки в состоянии running. Сценарий не меняется.
func (w *Workflow) StartCheck(project string) (CheckView, error) {
	resolved, err := w.startCheck(project)
	if err != nil {
		return CheckView{}, err
	}
	return w.CheckView(resolved)
}

func (w *Workflow) startCheck(project string) (string, error) {
	if w.options.RequireAgentAccess != nil {
		if err := w.options.RequireAgentAccess(project); err != nil {
			return "", err
		}
	}
	w.mu.Lock()
	view, initial, err := w.checkView(project)
	if err != nil {
		w.mu.Unlock()
		return "", err
	}
	if !view.CanStart {
		w.mu.Unlock()
		return "", errors.New(*view.Reason)
	}
	w.preparing[initial.project] = true
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		delete(w.preparing, initial.project)
		w.mu.Unlock()
	}()

	skill, err := resources.Skill(resources.SkillScenarioCheck)
	if err != nil {
		return "", err
	}
	budget := DefaultCheckImageBudget
	if w.options.CheckImageBudget != nil {
		budget = w.options.CheckImageBudget()
	}
	images, imagesProblem, err := w.prepareCheckImages(initial.project, castImageList(initial.documents.Cast), budget)
	if err != nil {
		return "", err
	}
	context, known, err := checkContext(initial, images, imagesProblem, acceptedShots(initial.project, initial.documents.Scenes))
	if err != nil {
		return "", err
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	current, err := readInputs(initial.project)
	if err != nil {
		return "", err
	}
	if !initial.hashes.matches(current.hashes) {
		return "", errors.New(textInputsChanged)
	}
	if len(context) > agents.TextLimit {
		return "", errors.New(textCheckTooLarge(len(context), agents.TextLimit))
	}
	attachments := []string{}
	for _, image := range images {
		if image.file != "" {
			attachments = append(attachments, image.file)
		}
	}
	job, err := w.options.Agents.Start(AgentStartInput{
		Project: initial.project,
		Task:    checkTask,
		Prompt:  checkPrompt(skill),
		Context: context,
		Images:  attachments,
		Place:   &AgentPlace{Page: "scenario"},
	})
	if err != nil {
		return "", err
	}
	doc := dynvalue.NewObject()
	doc.Set("schemaVersion", 1.0)
	doc.Set("status", CheckRunning)
	doc.Set("jobId", job.ID)
	doc.Set("shots", stringArray(known.shots))
	doc.Set("entities", stringArray(known.entities))
	properties := dynvalue.NewObject()
	for _, entity := range known.entities {
		properties.Set(entity, stringArray(known.properties[entity]))
	}
	doc.Set("properties", properties)
	doc.Set("hashes", checkHashes(initial).object())
	doc.Set("report", nil)
	doc.Set("message", nil)
	doc.Set("fixed", &dynvalue.Array{Items: []any{}})
	doc.Set("resolved", &dynvalue.Array{Items: []any{}})
	return initial.project, writeCheck(initial.project, &checkRecord{doc: doc})
}

// checkPrompt — скилл проверки с пределами отчёта, которые проверяет parseCheckReport.
func checkPrompt(skill string) string {
	return strings.NewReplacer(
		"{{summaryMaxLength}}", strconv.Itoa(checkSummaryMaxLength),
		"{{issuesMax}}", strconv.Itoa(checkIssuesMax),
		"{{titleMaxLength}}", strconv.Itoa(checkTitleMaxLength),
		"{{textMaxLength}}", strconv.Itoa(checkTextMaxLength),
		"{{changesMax}}", strconv.Itoa(checkChangesMax),
		"{{valueMaxLength}}", strconv.Itoa(checkValueMaxLength),
	).Replace(skill)
}

// checkContext — контекст задания проверки (JSON без отступов) и ID планов, сущностей и свойств, на
// которые может ссылаться ответ. Состояние — только первого кадра и только сущностей плана (мир, «В кадре» и
// изменения состояния плана), как во врезке непрерывности, и записано цепочками (addStateRun):
// значение повторяется от плана к плану, и таблица по планам на клипе в 60 планов не помещалась в
// предел текста задания. Цепочка к тому же сразу показывает агенту, через какие планы тянется
// значение, — ровно то, что нужно для поиска застрявшего состояния. Трактовка передаётся только
// логлайном: её части после появления реестра живут в scenes.sequences.
func checkContext(initial *inputs, images []checkImage, imagesProblem string, accepted []string) (string, checkKnown, error) {
	fps, err := projectfile.FrameRate(initial.project)
	if err != nil {
		return "", checkKnown{}, err
	}
	idea, err := readText(initial.project, "source", dynvalue.ToString(dynvalue.GetPath(initial.manifest, "idea", "path")))
	if err != nil {
		return "", checkKnown{}, err
	}
	lyrics, err := readText(initial.project, "source/text.md")
	if err != nil {
		return "", checkKnown{}, err
	}
	castValue := initial.documents.Cast
	scenes := initial.documents.Scenes
	initialStates, err := cast.InitialStates(castValue)
	if err != nil {
		return "", checkKnown{}, err
	}
	details, err := scenario.ResolveDetailed(scenes, initialStates)
	if err != nil {
		return "", checkKnown{}, err
	}
	shots := []string{}
	states := dynvalue.NewObject()
	for _, scene := range arrayItems(dynvalue.Get(scenes, "scenes")) {
		id := dynvalue.ToString(dynvalue.Get(scene, "id"))
		shots = append(shots, id)
		detail, ok := details[id]
		if !ok || detail.State.Before == nil {
			continue
		}
		scope := scenario.PlanEntities(scene)
		for _, entity := range detail.State.Before.Keys() {
			values, _ := dynvalue.AsObject(detail.State.Before.Value(entity))
			if !scope[entity] || values == nil {
				continue
			}
			bySource, _ := dynvalue.AsObject(detail.Sources["before"].Value(entity))
			for _, property := range values.Keys() {
				from := "cast"
				if bySource != nil {
					from = scenario.SourceLabel(bySource.Value(property))
				}
				addStateRun(states, entity, property, values.Value(property), from, id)
			}
		}
	}
	properties, err := castProperties(castValue)
	if err != nil {
		return "", checkKnown{}, err
	}
	entities := []string{}
	for _, entity := range arrayItems(dynvalue.Get(castValue, "entities")) {
		entities = append(entities, dynvalue.ToString(dynvalue.Get(entity, "id")))
	}
	imageList := make([]any, len(images))
	for index, image := range images {
		item := dynvalue.NewObject()
		item.Set("id", image.id)
		item.Set("entity", image.entity)
		item.Set("name", image.name)
		item.Set("path", image.path)
		item.Set("attached", image.file != "")
		imageList[index] = item
	}
	context := dynvalue.NewObject()
	context.Set("mode", "report")
	context.Set("idea", idea)
	context.Set("lyrics", lyrics)
	context.Set("fps", float64(fps))
	context.Set("timing", initial.timing)
	context.Set("cast", castValue)
	treatment := dynvalue.NewObject()
	treatment.Set("logline", dynvalue.Get(initial.documents.Treatment, "logline"))
	context.Set("treatment", treatment)
	context.Set("scenes", scenes)
	context.Set("states", states)
	context.Set("registryWarnings", stringArray(registryWarnings(initial.project)))
	context.Set("acceptedShots", stringArray(accepted))
	context.Set("castImages", &dynvalue.Array{Items: imageList})
	context.Set("castImagesProblem", imagesProblem)
	return dynvalue.Stringify(context), checkKnown{shots: shots, entities: entities, properties: properties}, nil
}

// addStateRun — значение свойства на первом кадре плана shot в цепочки states: сущность → свойство →
// [{value, from, shots}]. Если последняя цепочка свойства держит то же значение из того же источника,
// план добавляется к ней, иначе начинается новая. Планы без сущности в кадре цепочку не прерывают.
func addStateRun(states *dynvalue.Object, entity, property string, value any, from, shot string) {
	byProperty, _ := dynvalue.AsObject(states.Value(entity))
	if byProperty == nil {
		byProperty = dynvalue.NewObject()
		states.Set(entity, byProperty)
	}
	runs, _ := dynvalue.AsArray(byProperty.Value(property))
	if count := len(runs); count > 0 {
		last, _ := dynvalue.AsObject(runs[count-1])
		if dynvalue.StrictEqual(last.Value("value"), value) && dynvalue.StrictEqual(last.Value("from"), from) {
			list, _ := last.Value("shots").(*dynvalue.Array)
			list.Items = append(list.Items, shot)
			return
		}
	}
	run := dynvalue.NewObject()
	run.Set("value", value)
	run.Set("from", from)
	run.Set("shots", &dynvalue.Array{Items: []any{shot}})
	byProperty.Set(property, &dynvalue.Array{Items: append(runs, run)})
}

// registryWarnings — предупреждения проверки реестра («место: текст»): механические подсказки,
// которые агент проверяет по смыслу. Сбой инструмента даёт пустой список — проверка сценария от
// него не зависит.
func registryWarnings(project string) []string {
	result := []string{}
	output, err := tools.Run(project, "lint_registry", []string{"--json"})
	if err != nil {
		return result
	}
	parsed, err := dynvalue.Parse([]byte(output.Stdout))
	if err != nil {
		return result
	}
	for _, item := range arrayItems(dynvalue.Get(parsed, "warnings")) {
		result = append(result, dynvalue.ToString(dynvalue.Get(item, "where"))+": "+dynvalue.ToString(dynvalue.Get(item, "message")))
	}
	return result
}
