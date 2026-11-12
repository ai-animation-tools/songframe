// Package scenarioworkflow ведёт сценарный проход агента: подготовка предложения кастинга
// и трактовки, реестра сцен или доработки выбранных планов, хранение предложения вне проекта,
// его разбор и проверка, утверждения пары и сцен и применение одной транзакцией.
//
// Владение: локальная запись (state.go) и множество «готовится» принадлежат Workflow; задания
// агента — менеджеру агентов (интерфейс Agents); файлы проекта меняются только публикацией
// (publish.go) через журнал scenarioapply.Store. Отказ агента, недопустимый ответ или отмена
// ничего не пишут в проект.
package scenarioworkflow

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/scenarioapply"
	"songframe/internal/tools"
	"songframe/resources"
)

// StartInput — ScenarioWorkflowStart: проход и, для revise, замечание и выбранные планы.
type StartInput struct {
	Project     string   `json:"project"`
	Pass        string   `json:"pass"`
	Note        *string  `json:"note,omitempty"`
	SelectedIDs []string `json:"selectedIds,omitempty"`
}

// Proposal — ScenarioProposal для renderer. Before и After — документы { cast, treatment, scenes }
// как JSON (порядок ключей и числа документов сохраняются).
type Proposal struct {
	ID          string   `json:"id"`
	JobID       string   `json:"jobId"`
	Pass        string   `json:"pass"`
	SelectedIDs []string `json:"selectedIds"`
	// Status — running, ready, invalid, failed, cancelled, interrupted или applied.
	Status     string          `json:"status"`
	Message    string          `json:"message,omitempty"`
	Warnings   []string        `json:"warnings"`
	Stale      bool            `json:"stale"`
	Before     json.RawMessage `json:"before"`
	After      json.RawMessage `json:"after"`
	ChangedIDs []string        `json:"changedIds"`
}

// View — ScenarioWorkflowView: состояние прохода и доступность действий страницы «Сценарий».
type View struct {
	Project           string `json:"project"`
	Busy              bool   `json:"busy"`
	CanStartTreatment bool   `json:"canStartTreatment"`
	CanStartScenes    bool   `json:"canStartScenes"`
	CanRevise         bool   `json:"canRevise"`
	CanApproveCurrent bool   `json:"canApproveCurrent"`
	CanApproveScenes  bool   `json:"canApproveScenes"`
	TreatmentApproved bool   `json:"treatmentApproved"`
	ScenesNeedReview  bool   `json:"scenesNeedReview"`
	// ChangedInputs — что изменилось после утверждения, из-за чего сценарий требует пересмотра:
	// "sources", "timing", "cast", "treatment" в этом порядке. Пусто, если сравнить не с чем:
	// пара до появления сценария не утверждалась.
	ChangedInputs []string  `json:"changedInputs"`
	Problems      []string  `json:"problems"`
	Proposal      *Proposal `json:"proposal"`
	Job           *AgentJob `json:"job"`
}

// Options — зависимости Workflow.
type Options struct {
	// LocalDir — каталог состояния приложения (локальные записи и журнал применения).
	LocalDir string
	// Agents — менеджер внешних агентов; обязателен: без него сценарный проход не создаётся.
	Agents Agents
	// RequireAgentAccess — проверка доступа к агенту перед запуском прохода: сохранённый агент,
	// найденная программа и вход. nil — проверка у менеджера агентов.
	RequireAgentAccess func(project string) error
	// Scaffold — каркас реестра для прохода сцен; nil — scene_scaffold --dry-run --json.
	Scaffold func(project string) (any, error)
	// Publish — публикация предложения; nil — штатная публикация (publish) через журнал LocalDir.
	Publish func(Publication) error
}

// Workflow — сценарный проход проектов. Методы безопасны для конкурентного вызова из сервиса
// Wails: mu защищает локальные записи и множество preparing; подготовка каркаса и публикация идут
// без блокировки, а вид в это время сообщает busy.
type Workflow struct {
	options   Options
	mu        sync.Mutex
	preparing map[string]bool
}

// New создаёт сценарный проход с зависимостями по умолчанию для пустых необязательных полей.
// Отсутствие Agents — ошибка сборки зависимостей приложения, поэтому New паникует, а не
// подставляет заглушку.
func New(options Options) *Workflow {
	if options.Agents == nil {
		panic("scenarioworkflow: менеджер агентов не передан")
	}
	if options.Scaffold == nil {
		options.Scaffold = defaultScaffold
	}
	if options.Publish == nil {
		store := scenarioapply.NewStore(options.LocalDir)
		options.Publish = publisher{store: store}.publish
	}
	return &Workflow{options: options, preparing: map[string]bool{}}
}

// defaultScaffold — каркас scene_scaffold без записи в проект.
func defaultScaffold(project string) (any, error) {
	result, err := tools.Run(project, "scene_scaffold", []string{"--dry-run", "--json"})
	if err != nil {
		return nil, err
	}
	if result.Code == nil || *result.Code != 0 {
		details := result.Stderr
		if details == "" {
			details = result.Stdout
		}
		return nil, errors.New(textScaffoldFailed(sliceTail(dynvalue.Trim(details), 2000)))
	}
	return dynvalue.Parse([]byte(result.Stdout))
}

// randomUUID — crypto.randomUUID: UUID версии 4 для ID предложения.
func randomUUID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

// pendingProposal — state.pending.proposal или nil.
func pendingProposal(state *dynvalue.Object) (*dynvalue.Object, *dynvalue.Object) {
	stored, ok := dynvalue.AsObject(state.Value("pending"))
	if !ok {
		return nil, nil
	}
	proposal, _ := dynvalue.AsObject(stored.Value("proposal"))
	return stored, proposal
}

// stringItems — массив строк записи (проверен checkStoredState).
func stringItems(value any) []string {
	result := []string{}
	for _, item := range arrayItems(value) {
		result = append(result, dynvalue.ToString(item))
	}
	return result
}

// stringArray — массив строк как значение JSON.
func stringArray(items []string) *dynvalue.Array {
	values := make([]any, len(items))
	for index, item := range items {
		values[index] = item
	}
	return &dynvalue.Array{Items: values}
}

// refresh — устаревание предложения и итог задания агента. Запись обновляется,
// только когда работавшее задание завершилось (ready, invalid, failed, cancelled, interrupted).
func (w *Workflow) refresh(input *inputs, state *dynvalue.Object) (*AgentJob, error) {
	stored, proposal := pendingProposal(state)
	if proposal == nil {
		return nil, nil
	}
	jobID := dynvalue.ToString(proposal.Value("jobId"))
	found, known := w.options.Agents.Get(jobID)
	var job *AgentJob
	if known {
		job = &found
	}
	expected := hashesFrom(stored.Value("expectedHashes"))
	matches, err := snapshotMatches(input.project, expected)
	if err != nil {
		return nil, err
	}
	status := dynvalue.ToString(proposal.Value("status"))
	proposal.Set("stale", status != "applied" && !matches)
	if status != "running" {
		return job, nil
	}
	switch {
	case job == nil || job.Project != input.project || job.Status == "interrupted":
		proposal.Set("status", "interrupted")
		proposal.Set("message", textProposalInterrupted)
	case job.Status == "running":
		return job, nil
	// Остановка по кнопке — решение пользователя, а не сбой агента.
	case job.Status == "cancelled":
		proposal.Set("status", "cancelled")
		proposal.Set("message", textProposalCancelled)
	case job.Status != "completed" || job.ExitCode == nil || *job.ExitCode != 0:
		proposal.Set("status", "failed")
		message := job.Message
		if message == "" {
			message = textProposalAgentFailed
		}
		proposal.Set("message", message)
	default:
		if err := w.acceptResult(input, stored, proposal, job.Result); err != nil {
			proposal.Set("status", "invalid")
			proposal.Set("message", err.Error())
		}
	}
	if err := writeState(w.options.LocalDir, input.project, state); err != nil {
		return nil, err
	}
	return job, nil
}

// acceptResult — ветка успешного задания в refresh: разбор ответа, проверка изображений
// кастинга, изменённые планы и предупреждение о сущностях без референса.
func (w *Workflow) acceptResult(input *inputs, stored, proposal *dynvalue.Object, result string) error {
	pass := dynvalue.ToString(proposal.Value("pass"))
	before := documentsFrom(proposal.Value("before"))
	duration, _ := stored.Value("duration").(float64)
	after, err := proposalDocuments(result, pass, before, nullable(stored.Value("scaffold")), stringItems(proposal.Value("selectedIds")), duration)
	if err != nil {
		return err
	}
	expected := hashesFrom(stored.Value("expectedHashes"))
	base := filepath.Join(input.project, "source")
	for _, entity := range arrayItems(dynvalue.Get(after.Cast, "entities")) {
		name := dynvalue.ToString(dynvalue.Get(entity, "name"))
		for _, item := range arrayItems(dynvalue.Get(entity, "images")) {
			image := dynvalue.ToString(item)
			full := dynvalue.Resolve(base, image)
			local := dynvalue.Relative(base, full)
			if dynvalue.IsAbs(image) || strings.HasPrefix(local, "..") || !dynvalue.Exists(full) {
				return errors.New(textProposalImageMissing(name, image))
			}
			// Новое изображение тоже становится входом применения, даже если его не было в исходной паре.
			if _, ok := expected.get("source/" + strings.ReplaceAll(local, "\\", "/")); !ok {
				return errors.New(textProposalImageOutsideContext(name))
			}
		}
	}
	proposal.Set("after", after.object())
	changed := []string{}
	if pass != "treatment" {
		if changed, err = changedSceneIds(before, after); err != nil {
			return err
		}
	}
	proposal.Set("changedIds", stringArray(changed))
	// Сущности без изображения допустимы (место действия, реквизит): одно предупреждение вместо списка одинаковых.
	without := []string{}
	for _, entity := range arrayItems(dynvalue.Get(after.Cast, "entities")) {
		if !dynvalue.StrictEqual(dynvalue.Get(entity, "kind"), "world") && len(arrayItems(dynvalue.Get(entity, "images"))) == 0 {
			without = append(without, dynvalue.ToString(dynvalue.Get(entity, "name")))
		}
	}
	warnings := []string{}
	if len(without) > 0 {
		warnings = append(warnings, textCastWithoutReferences(strings.Join(without, ", ")))
	}
	proposal.Set("warnings", stringArray(warnings))
	proposal.Set("status", "ready")
	return nil
}

// nullable — Undefined как nil.
func nullable(value any) any {
	if value == dynvalue.Undefined {
		return nil
	}
	return value
}

// busy — проект готовится или у него есть работающее задание агента.
func (w *Workflow) busy(project string) bool {
	if w.preparing[project] {
		return true
	}
	return slices.ContainsFunc(w.options.Agents.List(project), func(job AgentJob) bool { return job.Status == "running" })
}

// view — вид под блокировкой mu: входы, обновлённая запись и доступность действий.
func (w *Workflow) view(project string) (View, *inputs, error) {
	input, err := readInputs(project)
	if err != nil {
		return View{}, nil, err
	}
	state := readState(w.options.LocalDir, input.project)
	job, err := w.refresh(input, state)
	if err != nil {
		return View{}, nil, err
	}
	busy := w.busy(input.project)
	approval, hasApproval := dynvalue.AsObject(state.Value("approval"))
	treatmentApproved := input.pairValid && len(input.problems) == 0 && hasApproval && hashesFrom(approval).matches(input.approval)
	scenesNeedReview := false
	changedInputs := []string{}
	if input.documents.Scenes != nil {
		review, _ := state.Value("needsScenesReview").(bool)
		scenes, hasScenes := dynvalue.AsObject(state.Value("scenesApproval"))
		scenesNeedReview = review || (hasApproval && !treatmentApproved) ||
			(hasScenes && !hashesFrom(scenes.Value("hashes")).matches(input.approval))
		if scenesNeedReview {
			// Причины, записанные при новом утверждении пары, плюс текущие отличия от обоих утверждений.
			snapshots := []*hashes{}
			if hasScenes {
				snapshots = append(snapshots, hashesFrom(scenes.Value("hashes")))
			}
			if hasApproval {
				snapshots = append(snapshots, hashesFrom(approval))
			}
			changedInputs = mergeCategories(stringItems(state.Value("reviewInputs")), changedCategories(input.approval, snapshots...))
		}
	}
	noProblems := len(input.problems) == 0
	view := View{
		Project:           input.project,
		Busy:              busy,
		CanStartTreatment: !busy && noProblems,
		CanStartScenes:    !busy && treatmentApproved,
		CanRevise:         !busy && treatmentApproved && input.scenesValid,
		CanApproveScenes:  !busy && treatmentApproved && input.scenesReady && scenesNeedReview,
		CanApproveCurrent: !busy && noProblems && input.pairValid && !treatmentApproved,
		TreatmentApproved: treatmentApproved,
		ScenesNeedReview:  scenesNeedReview,
		ChangedInputs:     changedInputs,
		Problems:          append(append([]string{}, input.problems...), input.documentProblems...),
		Job:               job,
	}
	if _, proposal := pendingProposal(state); proposal != nil {
		view.Proposal = proposalView(proposal)
	}
	return view, input, nil
}

// proposalView — DTO предложения из локальной записи.
func proposalView(proposal *dynvalue.Object) *Proposal {
	message, _ := proposal.Value("message").(string)
	stale, _ := proposal.Value("stale").(bool)
	return &Proposal{
		ID:          dynvalue.ToString(proposal.Value("id")),
		JobID:       dynvalue.ToString(proposal.Value("jobId")),
		Pass:        dynvalue.ToString(proposal.Value("pass")),
		SelectedIDs: stringItems(proposal.Value("selectedIds")),
		Status:      dynvalue.ToString(proposal.Value("status")),
		Message:     message,
		Warnings:    stringItems(proposal.Value("warnings")),
		Stale:       stale,
		Before:      dynvalue.Raw(proposal.Value("before")),
		After:       dynvalue.Raw(proposal.Value("after")),
		ChangedIDs:  stringItems(proposal.Value("changedIds")),
	}
}

// View — scenarioWorkflow.view.
func (w *Workflow) View(project string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, _, err := w.view(project)
	return view, err
}

// blocked — отказ действия: проблемы вида через пробел или запасной текст.
func blocked(view View, fallback string) error {
	if text := strings.Join(view.Problems, " "); text != "" {
		return errors.New(text)
	}
	return errors.New(fallback)
}

// Start — scenarioWorkflow.start: подготовка контекста и промпта, запуск задания агента и запись
// ожидающего предложения. Проект не меняется.
func (w *Workflow) Start(input StartInput) (View, error) {
	// Доступ к агенту проверяется до разбора параметров прохода: порядок отказов зафиксирован эталонами.
	if w.options.RequireAgentAccess != nil {
		if err := w.options.RequireAgentAccess(input.Project); err != nil {
			return View{}, err
		}
	}
	if !slices.Contains(passes, input.Pass) {
		return View{}, errors.New(textWorkflowInvalidStart)
	}
	project, err := w.start(input)
	if err != nil {
		return View{}, err
	}
	return w.View(project)
}

// start — запуск прохода до финального view; preparing снимается до возврата.
func (w *Workflow) start(input StartInput) (string, error) {
	w.mu.Lock()
	initial, err := readInputs(input.Project)
	if err != nil {
		w.mu.Unlock()
		return "", err
	}
	view, _, err := w.view(initial.project)
	if err != nil {
		w.mu.Unlock()
		return "", err
	}
	allowed := map[string]bool{"treatment": view.CanStartTreatment, "scenes": view.CanStartScenes, "revise": view.CanRevise}[input.Pass]
	if !allowed {
		w.mu.Unlock()
		return "", blocked(view, textWorkflowStartBlocked)
	}
	selected := []string{}
	for _, id := range input.SelectedIDs {
		if !slices.Contains(selected, id) {
			selected = append(selected, id)
		}
	}
	note := ""
	if input.Note != nil {
		note = dynvalue.Trim(*input.Note)
	}
	if input.Pass == "revise" {
		known := func(id string) bool {
			return slices.ContainsFunc(arrayItems(dynvalue.Get(initial.documents.Scenes, "scenes")), func(scene any) bool {
				return dynvalue.StrictEqual(dynvalue.Get(scene, "id"), id)
			})
		}
		if note == "" || len(selected) == 0 || slices.ContainsFunc(selected, func(id string) bool { return !known(id) }) {
			w.mu.Unlock()
			return "", errors.New(textWorkflowReviseSelection)
		}
	}
	w.preparing[initial.project] = true
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		delete(w.preparing, initial.project)
		w.mu.Unlock()
	}()

	skill, err := resources.Skill(resources.SkillScenario)
	if err != nil {
		return "", err
	}
	var scaffold any
	if input.Pass == "scenes" {
		if scaffold, err = w.options.Scaffold(initial.project); err != nil {
			return "", err
		}
		if err := checkScenesShape(scaffold); err != nil {
			return "", err
		}
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
	context, err := agentContext(initial, input.Pass, selected, note, scaffold)
	if err != nil {
		return "", err
	}
	job, err := w.options.Agents.Start(AgentStartInput{
		Project: initial.project,
		Task:    "ai-clip-scenario:" + input.Pass,
		Prompt:  agentPrompt(skill, input.Pass),
		Context: context,
		Place:   &AgentPlace{Page: "scenario"},
	})
	if err != nil {
		return "", err
	}
	proposal := dynvalue.NewObject()
	proposal.Set("id", randomUUID())
	proposal.Set("jobId", job.ID)
	proposal.Set("pass", input.Pass)
	proposal.Set("selectedIds", stringArray(selected))
	proposal.Set("status", "running")
	proposal.Set("warnings", &dynvalue.Array{Items: []any{}})
	proposal.Set("stale", false)
	proposal.Set("before", initial.documents.object())
	proposal.Set("after", initial.documents.object())
	proposal.Set("changedIds", &dynvalue.Array{Items: []any{}})
	stored := dynvalue.NewObject()
	stored.Set("proposal", proposal)
	stored.Set("expectedHashes", initial.hashes.object())
	stored.Set("scaffold", scaffold)
	stored.Set("duration", *initial.duration)
	state := readState(w.options.LocalDir, initial.project)
	state.Set("pending", stored)
	return initial.project, writeState(w.options.LocalDir, initial.project, state)
}

// agentContext — контекст задания: JSON без отступов; байты входят в хеш задания и эталоны.
func agentContext(initial *inputs, pass string, selected []string, note string, scaffold any) (string, error) {
	idea, err := readText(initial.project, "source", dynvalue.ToString(dynvalue.GetPath(initial.manifest, "idea", "path")))
	if err != nil {
		return "", err
	}
	lyrics, err := readText(initial.project, "source/text.md")
	if err != nil {
		return "", err
	}
	var seed any
	if initial.manifest != nil {
		if seed, err = cast.FromSources(initial.manifest, initial.documents.Cast, cast.LoadDefaults()); err != nil {
			return "", err
		}
	}
	// Обложка оформляет проект и не передаётся агенту как возможный референс сцены.
	// Явный состав сохраняет только исходники сценария и зарегистрированные референсы.
	manifest := dynvalue.NewObject()
	for _, key := range []string{"schema_version", "kinds", "track", "lyrics", "idea", "references"} {
		if value := initial.manifest.Value(key); value != dynvalue.Undefined {
			manifest.Set(key, value)
		}
	}
	context := dynvalue.NewObject()
	context.Set("mode", "proposal")
	context.Set("pass", pass)
	context.Set("selectedIds", stringArray(selected))
	context.Set("idea", idea)
	context.Set("lyrics", lyrics)
	context.Set("manifest", manifest)
	context.Set("timing", initial.timing)
	if pass == "treatment" {
		context.Set("cast", seed)
	} else {
		context.Set("cast", initial.documents.Cast)
	}
	context.Set("treatment", initial.documents.Treatment)
	if pass == "revise" {
		context.Set("scenes", initial.documents.Scenes)
	} else {
		context.Set("scenes", scaffold)
	}
	context.Set("note", note)
	return dynvalue.Stringify(context), nil
}

// readText — содержимое файла проекта как текст UTF-8.
func readText(project string, parts ...string) (string, error) {
	path := filepath.Join(append([]string{project}, parts...)...)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", dynvalue.FsError("open", path, err)
	}
	return dynvalue.DecodeUTF8(data), nil
}

// agentPrompt — промпт задания: скилл ai-clip-scenario и правила режима предложения дословно.
func agentPrompt(skill, pass string) string {
	shape := `"patches":[{"id":"выбранный ID",...поля постановки}]`
	switch pass {
	case "treatment":
		shape = `"cast":{...},"treatment":{...}`
	case "scenes":
		shape = `"scenes":{...}`
	}
	return skill + "\n\nРежим приложения: output=proposal, pass=" + pass +
		". Верни ровно один JSON без Markdown, без записи файлов и вызовов инструментов производства. " +
		`Оболочка: {"schemaVersion":1,"pass":"` + pass + `",` + shape + ` }. ` +
		"Не меняй source, timing и assets. Конец песни равен timing.duration_decoded. Сохраняй ID, original, sequence и кадровые окна каркаса. " +
		"Для revise разрешены только " + strings.Join(stagingFields, ", ") +
		" выбранных ID; derived_from: null снимает признак производного плана. Не меняй глобальные поля и остальные сцены. Заполни постановку без ЗАПОЛНИТЬ; используй только объявленные изображения и свойства кастинга."
}

// Apply — scenarioWorkflow.apply: повторный разбор успешного ответа агента, проверка снимка и
// публикация; после неё — утверждение опубликованного и статус applied.
func (w *Workflow) Apply(project, id string) (View, error) {
	resolved, err := w.apply(project, id)
	if err != nil {
		return View{}, err
	}
	return w.View(resolved)
}

func (w *Workflow) apply(project, id string) (string, error) {
	w.mu.Lock()
	view, _, err := w.view(project)
	if err != nil {
		w.mu.Unlock()
		return "", err
	}
	state := readState(w.options.LocalDir, view.Project)
	stored, proposal := pendingProposal(state)
	if view.Busy || proposal == nil || !dynvalue.StrictEqual(proposal.Value("id"), id) || !dynvalue.StrictEqual(proposal.Value("status"), "ready") ||
		(view.Proposal != nil && view.Proposal.Stale) {
		w.mu.Unlock()
		return "", errors.New(textProposalNotApplicable)
	}
	initial, err := readInputs(view.Project)
	if err != nil {
		w.mu.Unlock()
		return "", err
	}
	pass := dynvalue.ToString(proposal.Value("pass"))
	if pass != "treatment" && !view.TreatmentApproved {
		w.mu.Unlock()
		return "", errors.New(textPairApprovalStale)
	}
	if len(initial.problems) > 0 {
		w.mu.Unlock()
		return "", errors.New(strings.Join(initial.problems, " "))
	}
	// Повторный разбор берёт успешный результат менеджера, а не доверяет сохранённому предпросмотру.
	job, known := w.options.Agents.Get(dynvalue.ToString(proposal.Value("jobId")))
	if !known || job.Status != "completed" || job.ExitCode == nil || *job.ExitCode != 0 {
		w.mu.Unlock()
		return "", errors.New(textAgentResultMissing)
	}
	before := documentsFrom(proposal.Value("before"))
	duration, _ := stored.Value("duration").(float64)
	after, err := proposalDocuments(job.Result, pass, before, nullable(stored.Value("scaffold")), stringItems(proposal.Value("selectedIds")), duration)
	if err != nil {
		w.mu.Unlock()
		return "", err
	}
	expected := hashesFrom(stored.Value("expectedHashes"))
	if matches, err := snapshotMatches(view.Project, expected); err != nil || !matches {
		w.mu.Unlock()
		if err != nil {
			return "", err
		}
		return "", errors.New(textStaleProjectFiles)
	}
	w.preparing[view.Project] = true
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		delete(w.preparing, view.Project)
		w.mu.Unlock()
	}()

	if err := w.options.Publish(Publication{Project: view.Project, Pass: pass, Before: before, After: after, ExpectedHashes: expected}); err != nil {
		return "", err
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	published, err := readInputs(view.Project)
	if err != nil {
		return "", err
	}
	if pass == "treatment" {
		previous, hasPrevious := dynvalue.AsObject(state.Value("approval"))
		state.Set("approval", published.approval.object())
		if published.documents.Scenes != nil {
			var before *hashes
			if hasPrevious {
				before = hashesFrom(previous)
			}
			markScenesReview(state, published.approval, before)
		} else {
			state.Set("needsScenesReview", false)
		}
	} else {
		state.Set("scenesApproval", scenesApproval(published))
		clearScenesReview(state)
	}
	proposal.Set("status", "applied")
	proposal.Set("after", after.object())
	return view.Project, writeState(w.options.LocalDir, view.Project, state)
}

// markScenesReview — новое утверждение пары при существующем сценарии: сцены требуют пересмотра,
// а виды входов, изменившиеся с прежнего утверждения пары, накапливаются в reviewInputs. Без них
// после утверждения пары причина пересмотра терялась бы: текущие хеши уже совпадают с новым
// утверждением. previous — прежнее утверждение пары (nil — его не было).
func markScenesReview(state *dynvalue.Object, current, previous *hashes) {
	reasons := stringItems(state.Value("reviewInputs"))
	if previous != nil {
		reasons = mergeCategories(reasons, changedCategories(current, previous))
	}
	state.Set("needsScenesReview", true)
	if len(reasons) > 0 {
		state.Set("reviewInputs", stringArray(reasons))
	} else {
		state.Delete("reviewInputs")
	}
}

// clearScenesReview — сцены утверждены заново: признак и причины пересмотра сбрасываются.
func clearScenesReview(state *dynvalue.Object) {
	state.Set("needsScenesReview", false)
	state.Delete("reviewInputs")
}

// scenesApproval — { hashes, sceneHash } утверждения сцен.
func scenesApproval(input *inputs) *dynvalue.Object {
	approval := dynvalue.NewObject()
	approval.Set("hashes", input.approval.object())
	hash, _ := input.hashes.get("plan/scenes.json")
	if hash != nil {
		approval.Set("sceneHash", *hash)
	} else {
		approval.Set("sceneHash", nil)
	}
	return approval
}

// ApproveCurrent — scenarioWorkflow.approveCurrent: утверждение сохранённой пары без агента.
func (w *Workflow) ApproveCurrent(project string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, _, err := w.view(project)
	if err != nil {
		return View{}, err
	}
	if !view.CanApproveCurrent {
		return View{}, blocked(view, textPairApprovalUnavailable)
	}
	input, err := readInputs(view.Project)
	if err != nil {
		return View{}, err
	}
	state := readState(w.options.LocalDir, view.Project)
	if approval, ok := dynvalue.AsObject(state.Value("approval")); input.documents.Scenes != nil && ok && !hashesFrom(approval).matches(input.approval) {
		markScenesReview(state, input.approval, hashesFrom(approval))
	}
	state.Set("approval", input.approval.object())
	if err := writeState(w.options.LocalDir, view.Project, state); err != nil {
		return View{}, err
	}
	view, _, err = w.view(view.Project)
	return view, err
}

// ApproveScenes — scenarioWorkflow.approveScenes: ручная постановка требует собственного явного
// утверждения после изменения трактовки.
func (w *Workflow) ApproveScenes(project string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, _, err := w.view(project)
	if err != nil {
		return View{}, err
	}
	if !view.CanApproveScenes {
		return View{}, blocked(view, textScenesApprovalUnavailable)
	}
	input, err := readInputs(view.Project)
	if err != nil {
		return View{}, err
	}
	state := readState(w.options.LocalDir, view.Project)
	state.Set("scenesApproval", scenesApproval(input))
	clearScenesReview(state)
	if err := writeState(w.options.LocalDir, view.Project, state); err != nil {
		return View{}, err
	}
	view, _, err = w.view(view.Project)
	return view, err
}

// Discard — scenarioWorkflow.discard: удаление ожидающего предложения из локальной записи.
func (w *Workflow) Discard(project, id string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	input, err := readInputs(project)
	if err != nil {
		return View{}, err
	}
	state := readState(w.options.LocalDir, input.project)
	if _, proposal := pendingProposal(state); proposal == nil || !dynvalue.StrictEqual(proposal.Value("id"), id) {
		return View{}, errors.New(textProposalMissing)
	}
	state.Delete("pending")
	if err := writeState(w.options.LocalDir, input.project, state); err != nil {
		return View{}, err
	}
	view, _, err := w.view(input.project)
	return view, err
}
