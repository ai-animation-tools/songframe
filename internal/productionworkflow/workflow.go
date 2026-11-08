// Package productionworkflow ведёт проход агента производства: один план и один пакет проходят
// подготовку предложений описания, видеопромпта и запроса; проект меняется только отдельным Apply.
//
// Проход даёт вид плана (View), запуск подготовки (Start), отклонение (Discard), применение
// предложения к пакету (Apply, apply.go) под журналом замены пакета с восстановлением прерванного
// применения при старте (journal.go), создание и импорт опор (frames.go: задание
// провайдера-агента — keyframes.go, платный запрос одной опоры — frame_request.go), сводка
// непринятых предложений для списка «Производства» (PendingProposals) и занятость плана (Busy).
// Общие части: чтение контекста плана (context.go), записи предложений (store.go), снимок входов
// (snapshot.go), проверка ответа (proposal.go) и распознавание оплаты пакета (paid.go).
//
// Владение: локальные записи предложений и множество «готовится» принадлежат Workflow; задания
// агента — менеджеру агентов (Agents), рабочие папки заданий опор — KeyframeImages. Файлы
// проекта пишет Apply; исключение — платная опора: папку запроса пакета создаёт
// media_request prepare, вопрос согласования в workflow.json — shot_workflow set-image-request.
package productionworkflow

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"songframe/internal/agents"
	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
	"songframe/internal/tools"
)

// Agents — узкая часть менеджера внешних агентов (Pick<AgentManager, 'start' | 'get' | 'list'>).
// Реализация — internal/agents.Manager; методы безопасны для конкурентного вызова.
type Agents interface {
	// Start запускает задание и возвращает его снимок в состоянии running.
	Start(input agents.StartInput) (agents.Job, error)
	// Get — копия задания по ID; false — задания нет (в том числе после перезапуска без истории).
	Get(id string) (agents.Job, bool)
	// List — копии заданий проекта (реальный путь).
	List(project string) []agents.Job
}

// Runner — запуск инструмента комплекса (tools.RunContext); тесты подменяют его.
type Runner func(ctx context.Context, project, name string, args []string) (tools.Result, error)

// CatalogReader — свежий каталог моделей платного провайдера (providers.Catalogs): производство
// читает тот же снимок, что настройки, без отдельных запросов для каждой команды.
type CatalogReader interface {
	Read(ctx context.Context, project, provider, kind string) (providers.Catalog, error)
}

// Options — зависимости Workflow.
type Options struct {
	// LocalDir — каталог состояния приложения (записи production-workflow).
	LocalDir string
	// Agents — менеджер агентов; nil — заданий нет, запуск отклоняется.
	Agents Agents
	// Run — инструменты комплекса (continuity_brief); nil — tools.RunContext.
	Run Runner
	// Catalog — каталог моделей провайдера видео; nil — собственный providers.Catalogs.
	Catalog CatalogReader
	// IsScenarioApproved — сценарий утверждён: трактовка утверждена и сцены не требуют проверки.
	IsScenarioApproved func(project string) bool
	// IsPackageBusy — над пакетом идёт производственная операция (production.Service.IsBusy).
	IsPackageBusy func(project, packageDir string) bool
	// Media — слой провайдеров медиа для опор: исполнитель провайдера-агента и платный адаптер
	// изображений. nil — опоры не создаются и задания опор не разбираются.
	Media MediaLayer
	// ValidateImage — проверка изображения декодированием для референсов
	// платной опоры и импортируемых файлов; nil — mediafile.Decodes.
	ValidateImage func(path string) bool
	// VideoMedia — платный адаптер видео провайдера проекта для подготовки request-NN при Apply
	// запроса; nil — подготовка невозможна (textChooseVideoProvider).
	VideoMedia VideoMedia
	// RequireVideoAccess — проверка доступа вида video (agents.AccessChecker.RequireAccess) перед
	// подготовкой запроса: выбранный
	// провайдер и вход в него; nil — без проверки (тесты).
	RequireVideoAccess func(ctx context.Context, project string) error
}

// Workflow — проход агента производства. Методы безопасны для конкурентного вызова из сервисов
// Wails: mu защищает записи предложений и множество busy. Врезки непрерывности и каталог моделей
// Start получает без блокировки, а вид плана в это время сообщает busy.
type Workflow struct {
	options Options
	store   Store
	mu      sync.Mutex
	busy    map[string]bool
}

// New создаёт проход с зависимостями по умолчанию для пустых полей.
func New(options Options) *Workflow {
	if options.Agents == nil {
		options.Agents = noAgents{}
	}
	if options.Run == nil {
		options.Run = tools.RunContext
	}
	if options.Catalog == nil {
		options.Catalog = &providers.Catalogs{}
	}
	if options.IsScenarioApproved == nil {
		options.IsScenarioApproved = func(string) bool { return false }
	}
	if options.ValidateImage == nil {
		options.ValidateImage = mediafile.Decodes
	}
	return &Workflow{options: options, store: Store{LocalDir: options.LocalDir}, busy: map[string]bool{}}
}

// Store — записи предложений этого прохода (для Apply и восстановления после перезапуска).
func (w *Workflow) Store() Store { return w.store }

// textAgentsUnavailable — запуск без менеджера агентов.
const textAgentsUnavailable = "Менеджер агентов недоступен."

// noAgents — заглушка до подключения менеджера агентов.
type noAgents struct{}

func (noAgents) Start(agents.StartInput) (agents.Job, error) {
	return agents.Job{}, errors.New(textAgentsUnavailable)
}
func (noAgents) Get(string) (agents.Job, bool) { return agents.Job{}, false }
func (noAgents) List(string) []agents.Job      { return []agents.Job{} }

// key — ключ плана в множестве busy.
func key(project, shot string) string { return project + "\x00" + shot }

// randomUUID — случайный UUID версии 4 (RFC 4122) для ID предложения.
func randomUUID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

// Reasons — почему действие подготовки недоступно; nil — доступно.
type Reasons struct {
	Prepare  *string `json:"prepare"`
	Continue *string `json:"continue"`
	Frames   *string `json:"frames"`
}

// View — ProductionWorkflowView: состояние прохода плана и доступность действий панели
// подготовки. Документы проекта (план опор, ID опор, предложение) отдаются JSON как есть.
type View struct {
	Project string `json:"project"`
	Shot    string `json:"shot"`
	// PackageDir — абсолютный путь выбранного пакета; nil — новая подготовка.
	PackageDir *string `json:"packageDir"`
	Busy       bool    `json:"busy"`
	// Stage — этап workflow.json пакета; nil — пакета нет.
	Stage   *string `json:"stage"`
	Reasons Reasons `json:"reasons"`
	// DerivedFrom — план-источник производного плана: подготовка и генерация заблокированы.
	DerivedFrom *string `json:"derivedFrom"`
	// NextStage — следующий проход агента по пакету ("" → null): им интерфейс называет следующее
	// действие. ReplaceFrame — опора открытого вопроса, кандидата которой можно заменить файлом.
	NextStage         *string `json:"nextStage,omitempty"`
	ReplaceFrame      *string `json:"replaceFrame,omitempty"`
	CanPrepare        bool    `json:"canPrepare"`
	CanContinue       bool    `json:"canContinue"`
	CanRevise         bool    `json:"canRevise"`
	CanGenerateFrames bool    `json:"canGenerateFrames"`
	// Paid — попытка пакета уже оплачена: дальше только новая попытка или возврат с замечанием.
	Paid bool `json:"paid"`
	// ImageProvider и VideoProvider — generation.image.provider и generation.video.provider
	// проекта как есть; поле опускается, если значения нет.
	ImageProvider json.RawMessage `json:"imageProvider,omitempty"`
	VideoProvider json.RawMessage `json:"videoProvider,omitempty"`
	// FramePrompts — keyframe-prompts.json пакета (ProductionFramePrompt[]).
	FramePrompts json.RawMessage `json:"framePrompts"`
	// NextFrame — опора, которую создаст следующее задание; null — нет.
	NextFrame json.RawMessage `json:"nextFrame"`
	// ApprovedFrameIDs — утверждённые опоры пакета.
	ApprovedFrameIDs json.RawMessage `json:"approvedFrameIds"`
	Problems         []string        `json:"problems"`
	// Proposal — ProductionProposal записи; null — предложения нет.
	Proposal json.RawMessage `json:"proposal"`
	Job      *agents.Job     `json:"job"`
}

// optional — строка или nil для "".
func optional(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// View возвращает вид плана shot и пакета packageDir ("" — без пакета). Завершённое
// задание агента переводит предложение в итоговый статус и пишет запись.
func (w *Workflow) View(project, shot, packageDir string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.view(project, shot, packageDir)
}

// view — View под мьютексом.
func (w *Workflow) view(project, shot, packageDir string) (View, error) {
	canonical, err := dynvalue.Realpath(project)
	if err != nil {
		return View{}, err
	}
	stored := w.store.Read(canonical, shot)
	// Отсутствующий выбор означает новую подготовку; созданный пакет Apply возвращает явно.
	c, err := ReadContext(canonical, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	// Производный план не готовится агентом: предложение, оставшееся до отметки derived_from,
	// больше не показывается. Применённое предложение относится к своему целевому пакету.
	var relevant *Stored
	if stored != nil && (c.DerivedFrom == "" || stored.Status() == "running") {
		if (stored.Status() == "applied" && stored.Target() == c.PackageDir) || (stored.Status() != "applied" && stored.PackageDir() == c.PackageDir) {
			relevant = stored
		}
	}
	job, err := w.refresh(c, relevant)
	if err != nil {
		return View{}, err
	}
	busy := w.busy[key(canonical, shot)] || slices.ContainsFunc(w.options.Agents.List(canonical), func(job agents.Job) bool { return job.Status == "running" }) ||
		(c.PackageDir != "" && w.options.IsPackageBusy != nil && w.options.IsPackageBusy(canonical, c.PackageDir))
	pending := dynvalue.Truthy(c.workflowValue("pending_decision"))
	descriptionApproved := c.workflowValue("description_approved") == true
	decision := c.workflowValue("decision")
	frameRevision := dynvalue.Get(decision, "stage") == "keyframes_review" && dynvalue.Get(decision, "verdict") == "revise"
	proposalPending := relevant.active()
	enabled := !busy && !proposalPending && len(c.Problems) == 0 && !pending && !c.Paid
	stage, _ := c.workflowValue("stage").(string)
	imagePhase := strings.HasPrefix(stage, "image_")
	// Неприменённое предложение блокирует опоры сразу, а не отказом после выбора файла; причину
	// reasons.frames уже называет.
	imageEnabled := !busy && !proposalPending && !slices.ContainsFunc(c.Problems, func(problem string) bool { return !strings.HasPrefix(problem, textVideoSettingsIncomplete) }) &&
		!pending && !c.Paid && !imagePhase
	scenarioApproved := w.options.IsScenarioApproved(canonical)
	framesApproved, err := c.FramesApproved()
	if err != nil {
		return View{}, err
	}
	nextStage, err := c.StageFor()
	if err != nil {
		return View{}, err
	}
	common := ""
	switch {
	case busy:
		common = textOperationBusy
	case proposalPending:
		common = textResolveProposalFirst
	case pending:
		common = textResolvePackageQuestionFirst
	}
	// Срез должен уложиться в допустимую длину звукового входа провайдера, иначе сервис отклонит
	// запрос.
	speechMismatch := ""
	if provider, ok := videoProvider(c.Settings); ok && c.Scene.Value("lipsync") == true && provider.LipSync != nil && c.Speech != nil {
		length := c.Speech.length()
		if length < provider.LipSync.Min-1e-6 || length > provider.LipSync.Max+1e-6 {
			speechMismatch = textSpeechLengthOutOfRange(dynvalue.ToFixed(length, 2), provider.LipSync.Min, provider.LipSync.Max)
		}
	}
	// Производный план собирается из чужого материала: эта причина постоянна и важнее временной
	// занятости.
	derived := ""
	if c.DerivedFrom != "" {
		derived = derivedshot.Reason(c.DerivedFrom)
	}
	undecided := c.UndecidedFrame()
	nextFrame := c.NextFrame()
	// Кандидата опоры на открытом вопросе можно заменить своим файлом без замечания: остальные
	// условия те же, что у импорта опор.
	replaceFrame := ""
	if frame, ok := dynvalue.Get(c.workflowValue("pending_decision"), "frame").(string); ok && derived == "" && !c.SceneChanged && !busy && !proposalPending && !c.Paid && !imagePhase {
		replaceFrame = frame
	}
	view := View{
		Project: canonical, Shot: shot, PackageDir: optional(c.PackageDir), Busy: busy, Stage: optional(stage), DerivedFrom: optional(c.DerivedFrom),
		NextStage: optional(nextStage), ReplaceFrame: optional(replaceFrame),
		Reasons: Reasons{
			Prepare:  optional(prepareReason(derived, busy, imagePhase, scenarioApproved, c.Problems)),
			Continue: optional(continueReason(c, derived, common, imagePhase, nextStage, speechMismatch, framesApproved, descriptionApproved)),
			Frames:   optional(framesReason(c, derived, common, imagePhase, framesApproved, descriptionApproved || frameRevision, undecided)),
		},
		CanPrepare: derived == "" && !busy && !imagePhase && scenarioApproved && len(c.Problems) == 0,
		CanContinue: derived == "" && !c.SceneChanged && enabled && !imagePhase && nextStage != "" && nextStage != "description" &&
			!(nextStage == "request" && speechMismatch != ""),
		// Пока у пакета есть вопрос, замечание вводится в его карточке; панель подхватывает
		// сохранённый ответ «вернуть».
		CanRevise: derived == "" && !busy && !proposalPending && !imagePhase && c.PackageDir != "" && len(c.Problems) == 0 && !pending,
		CanGenerateFrames: derived == "" && !c.SceneChanged && imageEnabled && c.PackageDir != "" && !framesApproved && dynvalue.Truthy(nextFrame) &&
			(descriptionApproved || frameRevision),
		Paid: c.Paid, FramePrompts: dynvalue.Raw(c.FramePrompts), NextFrame: dynvalue.Raw(nextFrame),
		ApprovedFrameIDs: dynvalue.Raw(&dynvalue.Array{Items: c.ApprovedFrameIDs()}), Problems: c.Problems, Proposal: json.RawMessage("null"), Job: job,
	}
	generation, err := projectGeneration(canonical)
	if err != nil {
		return View{}, err
	}
	if value := dynvalue.Get(dynvalue.Get(generation, "image"), "provider"); value != dynvalue.Undefined {
		view.ImageProvider = dynvalue.Raw(value)
	}
	if value := dynvalue.Get(dynvalue.Get(generation, "video"), "provider"); value != dynvalue.Undefined {
		view.VideoProvider = dynvalue.Raw(value)
	}
	if relevant != nil {
		view.Proposal = dynvalue.Raw(relevant.Proposal())
	}
	return view, nil
}

// prepareReason — reasons.prepare: занятость, этап изображения, сценарий, первая проблема.
func prepareReason(derived string, busy, imagePhase, scenarioApproved bool, problems []string) string {
	switch {
	case derived != "":
		return derived
	case busy:
		return textOperationBusy
	case imagePhase:
		return textResolveImageFirst
	case !scenarioApproved:
		return textApproveScenarioFirst
	case len(problems) > 0:
		return problems[0]
	}
	return ""
}

// continueReason — reasons.continue: почему пакет нельзя продолжить следующим этапом.
func continueReason(c *Context, derived, common string, imagePhase bool, nextStage, speechMismatch string, framesApproved, descriptionApproved bool) string {
	switch {
	case derived != "":
		return derived
	case c.PackageDir == "":
		return textAcceptedDescriptionFrames
	case c.SceneChanged:
		return textSceneChangedReason
	case common != "":
		return common
	case c.Paid:
		return textSentAttemptNeedsRetry
	case len(c.Problems) > 0:
		return strings.Join(c.Problems, " ")
	case imagePhase:
		return textResolveImageFirst
	case nextStage == "request" && c.Scene.Value("lipsync") == true && c.Speech == nil:
		return textSpeechRequiredHint
	case nextStage == "request" && speechMismatch != "":
		return speechMismatch
	case nextStage == "" || nextStage == "description":
		if framesApproved {
			return textFramesAcceptedPromptNext
		}
		if descriptionApproved {
			return textCreateAndAcceptFramesFirst
		}
		return textApplyAndAcceptDescription
	}
	return ""
}

// framesReason — reasons.frames: почему следующую опору нельзя создать.
func framesReason(c *Context, derived, common string, imagePhase, framesApproved, descriptionReady bool, undecided any) string {
	switch {
	case derived != "":
		return derived
	case c.PackageDir == "":
		return textAcceptedDescriptionRequired
	case c.SceneChanged:
		return textSceneChangedReason
	case common != "":
		return common
	case c.Paid:
		return textAttemptAlreadySent
	case framesApproved:
		return textFramesAlreadyAccepted
	case dynvalue.Truthy(undecided):
		return textAcceptFrameFirstHint(dynvalue.ToString(undecided))
	case len(c.FramePrompts.Items) == 0:
		return textFramePlanMissing
	case !descriptionReady:
		return textAcceptDescriptionFirst
	case imagePhase:
		return textResolveImageFirst
	}
	return ""
}

// refresh пересчитывает устаревание записи и переводит предложение
// выполнявшегося задания в итоговый статус (interrupted, cancelled, failed, ready, invalid).
// Запись пишется только при смене статуса running. Возвращает задание агента записи или nil.
func (w *Workflow) refresh(c *Context, stored *Stored) (*agents.Job, error) {
	if stored == nil {
		return nil, nil
	}
	proposal := stored.Proposal()
	found, ok := w.options.Agents.Get(stored.JobID())
	var job *agents.Job
	if ok {
		job = &found
	}
	stale := false
	if stored.Status() != "applied" {
		same, err := SameSnapshot(c.Project, stored)
		stale = err != nil || !same || imagesChanged(stored)
	}
	proposal.Set("stale", stale)
	if stored.Status() != "running" {
		return job, nil
	}
	switch {
	case job == nil || job.Project != c.Project || job.Status == "interrupted":
		proposal.Set("status", "interrupted")
		proposal.Set("message", textJobInterrupted)
	case job.Status == "running":
		return job, nil
	// Остановка по кнопке — решение пользователя, а не сбой агента.
	case job.Status == "cancelled":
		proposal.Set("status", "cancelled")
		proposal.Set("message", textJobCancelled)
	case job.Status != "completed" || job.ExitCode == nil || *job.ExitCode != 0:
		proposal.Set("status", "failed")
		message := job.Message
		if message == "" {
			message = textProposalIncomplete
		}
		proposal.Set("message", message)
	default:
		if err := w.accept(c, stored, *job); err != nil {
			proposal.Set("status", "invalid")
			proposal.Set("message", err.Error())
			// Ответ агента сохраняется для показа: он часто объясняет, почему предложение не
			// подготовлено. Текст вместо JSON — штатный отказ, ошибка разбора ничего не объясняет.
			if !stored.ImageJob() {
				if answer := AgentResponseText(job.Result, stored.Stage()); answer != "" {
					proposal.Set("agentText", answer)
					if IsAgentRefusal(job.Result) {
						proposal.Set("refused", true)
						proposal.Set("message", textAgentRefused)
					}
				}
			}
		} else {
			proposal.Set("status", "ready")
		}
	}
	return job, w.store.Write(c.Project, c.Shot, stored)
}

// accept разбирает результат завершённого задания: предложение записывается в after до
// проверки возможностей (неподходящий запрос остаётся виден вместе с причиной), у опор
// запоминаются SHA-256 изображений.
func (w *Workflow) accept(c *Context, stored *Stored, job agents.Job) error {
	raw := job.Result
	if stored.ImageJob() {
		images, err := w.collectImages(job)
		if err != nil {
			return err
		}
		document := dynvalue.NewObject()
		document.Set("schemaVersion", float64(1))
		document.Set("stage", "frames")
		document.Set("images", candidatesTree(images))
		raw = dynvalue.Stringify(document)
	}
	rules := stored.Rules()
	after, err := ParseProposal(raw, rules)
	if err != nil {
		return err
	}
	stored.Proposal().Set("after", after)
	if err := CheckCapabilities(after, rules, stored.Capabilities(), c.Settings); err != nil {
		return err
	}
	if after.Value("stage") == "frames" {
		hashes := dynvalue.NewObject()
		images, _ := dynvalue.AsArray(after.Value("images"))
		for _, image := range images {
			path, _ := dynvalue.Get(image, "path").(string)
			hash, err := requiredFileDigest(path)
			if err != nil {
				return err
			}
			hashes.Set(path, hash)
		}
		stored.Tree.Set("imageHashes", hashes)
	}
	return nil
}

// StartInput — ProductionWorkflowStart: действие prepare (новый пакет), revise (доработка с
// замечанием) или continue (следующий этап пакета); Stage — явный этап, nil — по пакету.
type StartInput struct {
	Project    string  `json:"project"`
	Shot       string  `json:"shot"`
	PackageDir string  `json:"packageDir,omitempty"`
	Action     string  `json:"action"`
	Note       *string `json:"note,omitempty"`
	Stage      *string `json:"stage,omitempty"`
}

// Start проверяет доступность этапа, снимает входы, получает врезки
// непрерывности и каталог моделей, запускает задание агента и записывает предложение running.
// Доступ к агенту (выбор, программа, вход) проверяет сервис приложения до вызова.
func (w *Workflow) Start(ctx context.Context, input StartInput) (View, error) {
	if !slices.Contains([]string{"prepare", "revise", "continue"}, input.Action) ||
		(input.Stage != nil && !slices.Contains([]string{"description", "prompt", "request"}, *input.Stage)) {
		return View{}, errors.New(textStartParametersInvalid)
	}
	w.mu.Lock()
	prepared, err := w.prepare(input)
	if err != nil {
		w.mu.Unlock()
		return View{}, err
	}
	planKey := key(prepared.context.Project, input.Shot)
	w.busy[planKey] = true
	w.mu.Unlock()
	err = w.launch(ctx, input, prepared)
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.busy, planKey)
	if err != nil {
		return View{}, err
	}
	return w.view(prepared.context.Project, input.Shot, input.PackageDir)
}

// preparedStart — проверенный запуск: контекст, этап, целевой пакет и снимок входов.
type preparedStart struct {
	context    *Context
	stage      string
	newPackage bool
	target     string
	hashes     *dynvalue.Object
}

// prepare — синхронная часть start до первого ожидания: проверки этапа и снимок входов.
func (w *Workflow) prepare(input StartInput) (*preparedStart, error) {
	c, err := ReadContext(input.Project, input.Shot, input.PackageDir)
	if err != nil {
		return nil, err
	}
	if c.DerivedFrom != "" {
		return nil, errors.New(derivedshot.Reason(c.DerivedFrom))
	}
	view, err := w.view(c.Project, input.Shot, input.PackageDir)
	if err != nil {
		return nil, err
	}
	if stage, _ := c.workflowValue("stage").(string); strings.HasPrefix(stage, "image_") {
		return nil, errors.New(textCurrentImageUnresolved)
	}
	if view.Busy {
		return nil, errors.New(textWaitForJob)
	}
	if w.store.Read(c.Project, input.Shot).active() {
		return nil, errors.New(textResolveProposalFirstError)
	}
	prepared := &preparedStart{context: c, newPackage: input.Action == "prepare" || (c.Paid && input.Action == "revise")}
	if prepared.newPackage {
		if !view.CanPrepare {
			return nil, errors.New(textScenarioAndSettingsRequired)
		}
		prepared.stage = "description"
		prepared.target = nextPackage(c.Project, input.Shot)
	} else {
		if prepared.stage, err = w.continuedStage(c, input); err != nil {
			return nil, err
		}
		prepared.target = c.PackageDir
	}
	if prepared.hashes, err = Snapshot(c.Project, c.PackageDir, prepared.target, c.AllowedPaths); err != nil {
		return nil, err
	}
	return prepared, nil
}

// continuedStage — этап доработки или продолжения пакета: явный, следующий по пакету или, для
// доработки, ближайший доступный.
func (w *Workflow) continuedStage(c *Context, input StartInput) (string, error) {
	if c.PackageDir == "" || c.Paid || len(c.Problems) > 0 {
		if len(c.Problems) > 0 {
			return "", errors.New(strings.Join(c.Problems, " "))
		}
		return "", errors.New(textPackageUnavailable)
	}
	if dynvalue.Truthy(c.workflowValue("pending_decision")) {
		return "", errors.New(textResolveQuestionFirst)
	}
	next, err := c.StageFor()
	if err != nil {
		return "", err
	}
	stage := next
	if input.Stage != nil {
		stage = *input.Stage
	}
	if stage == "" && input.Action == "revise" {
		prompt, err := c.PromptApproved()
		if err != nil {
			return "", err
		}
		frames, err := c.FramesApproved()
		if err != nil {
			return "", err
		}
		switch {
		case prompt:
			stage = "request"
		case frames:
			stage = "prompt"
		default:
			stage = "description"
		}
	}
	if stage == "" {
		return "", errors.New(textDescriptionOrFramesReview)
	}
	appropriate := true
	switch stage {
	case "prompt":
		if appropriate, err = c.FramesApproved(); err != nil {
			return "", err
		}
	case "request":
		if appropriate, err = c.PromptApproved(); err != nil {
			return "", err
		}
	}
	if !appropriate || (input.Action == "continue" && stage != next) {
		return "", errors.New(textStageUnavailable)
	}
	// Устаревший пакет продолжается только новым описанием: оно строится по текущей постановке.
	if c.SceneChanged && stage != "description" {
		return "", errors.New(textResolveSceneChangedPackageFirst(textSceneChangedReason))
	}
	return stage, nil
}

// launch — асинхронная часть start: врезки, каталог, промпт, повторная сверка входов, запуск
// задания и запись предложения. Вызывается без мьютекса; запись предложения — под ним.
func (w *Workflow) launch(ctx context.Context, input StartInput, prepared *preparedStart) error {
	c, stage := prepared.context, prepared.stage
	briefs := dynvalue.NewObject()
	for _, phase := range []string{"before", "after"} {
		result, err := w.options.Run(ctx, c.Project, "continuity_brief", []string{input.Shot, "--phase", phase, "--json"})
		if err != nil {
			return err
		}
		if result.Code == nil || *result.Code != 0 {
			details := result.Stderr
			if details == "" {
				details = result.Stdout
			}
			if details = dynvalue.Trim(details); details == "" {
				details = textContinuityFailed
			}
			return errors.New(details)
		}
		brief, err := dynvalue.Parse([]byte(result.Stdout))
		if err != nil {
			return err
		}
		briefs.Set(phase, brief)
	}
	reports, capabilitiesProblem := w.capabilities(ctx, c, stage)
	title := ""
	if provider, ok := videoProvider(c.Settings); ok {
		title = provider.Title
	}
	if stage == "request" && len(reports) == 0 {
		return errors.New(textProviderModelsFailed(title, capabilitiesProblem))
	}
	// Речевому плану нужен режим со звуковым входом; без него точный липсинк невозможен, и агент
	// всё равно вернул бы ошибку.
	if c.Scene.Value("lipsync") == true {
		if stage == "request" && c.Speech == nil {
			return errors.New(textSpeechRequired)
		}
		if len(reports) > 0 && !providers.AcceptsAudioInput(reports) {
			return errors.New(textProviderAudioUnsupported(title))
		}
	}
	capabilities := &dynvalue.Array{Items: []any{}}
	for _, report := range reports {
		object := dynvalue.NewObject()
		object.Set("command", report.Command)
		object.Set("models", report.Models)
		capabilities.Items = append(capabilities.Items, object)
	}
	rules := c.RulesFor(stage)
	generation, err := projectGeneration(c.Project)
	if err != nil {
		return err
	}
	prompt := agentPrompt(stage, c.Settings.Value("provider"), dynvalue.Get(dynvalue.Get(generation, "image"), "provider"))
	contextInput := contextInput{stage: stage, briefs: briefs, description: nil, prompt: nil, lipSync: rules.LipSync, capabilities: capabilities,
		capabilitiesProblem: capabilitiesProblem, inputFlags: []string{}}
	before := ""
	if c.PackageDir != "" {
		description, err := readText(filepath.Join(c.PackageDir, "description.md"))
		if err != nil {
			return err
		}
		videoPrompt, err := readText(filepath.Join(c.PackageDir, "video-prompt.txt"))
		if err != nil {
			return err
		}
		contextInput.description, contextInput.prompt = description, videoPrompt
		switch stage {
		case "description":
			before = description
		case "prompt":
			before = videoPrompt
		}
	}
	if stage == "request" {
		before = dynvalue.Stringify(c.Workflow)
	}
	if adapter, ok := providers.PaidAdapter(c.Settings.Value("provider")); ok {
		for _, flag := range adapter.Rules.InputFlags {
			contextInput.inputFlags = append(contextInput.inputFlags, flag.Flag)
		}
	}
	contextInput.note = noteFor(c, input.Note)
	task := agents.StartInput{Project: c.Project, Task: "ai-clip-scene:" + input.Shot + ":" + stage, Prompt: prompt, Context: agentContext(c, contextInput)}
	stored := &Stored{Tree: dynvalue.NewObject()}
	stored.Tree.Set("proposal", proposalTree("", "", stage, ""))
	if c.PackageDir == "" {
		stored.Tree.Set("packageDir", nil)
	} else {
		stored.Tree.Set("packageDir", c.PackageDir)
	}
	stored.Tree.Set("target", prepared.target)
	stored.Tree.Set("hashes", prepared.hashes)
	stored.Tree.Set("rules", rules.Tree())
	stored.Tree.Set("capabilities", capabilities)
	w.mu.Lock()
	defer w.mu.Unlock()
	same, err := SameSnapshot(c.Project, stored)
	if err != nil {
		return err
	}
	if !same {
		return errors.New(textInputsChangedDuringPrep)
	}
	job, err := w.options.Agents.Start(task)
	if err != nil {
		return err
	}
	stored.Tree.Set("proposal", proposalTree(randomUUID(), job.ID, stage, before))
	return w.store.Write(c.Project, input.Shot, stored)
}

// capabilities — объявления моделей провайдера видео для задания и текст проблем каталога.
// До этапа запроса план без липсинка видит только черновые команды адаптера; речевому плану
// нужны все режимы со звуковым входом уже при описании.
func (w *Workflow) capabilities(ctx context.Context, c *Context, stage string) ([]providers.CatalogReport, string) {
	reports := []providers.CatalogReport{}
	problems := []string{}
	adapter, ok := providers.PaidAdapter(c.Settings.Value("provider"))
	if !ok {
		return reports, textProviderCapabilitiesMissing
	}
	var draft []string
	if stage != "request" && c.Scene.Value("lipsync") != true {
		draft = adapter.Rules.DraftVideoCommands
	}
	visible := func(command string) bool { return draft == nil || slices.Contains(draft, command) }
	catalog, err := w.options.Catalog.Read(ctx, c.Project, adapter.ID, mediaproviders.Video)
	if err != nil {
		return reports, err.Error()
	}
	for _, report := range catalog.Reports {
		if visible(report.Command) {
			reports = append(reports, report)
		}
	}
	for _, problem := range catalog.Problems {
		if visible(problem.Command) {
			problems = append(problems, problem.Command+": "+problem.Message)
		}
	}
	return reports, strings.Join(problems, " ")
}

// noteFor — note контекста: замечание запуска без крайних пробелов или замечание решения пакета.
func noteFor(c *Context, note *string) any {
	if note != nil {
		if text := dynvalue.Trim(*note); text != "" {
			return text
		}
	}
	if value := dynvalue.Get(c.workflowValue("decision"), "note"); dynvalue.Truthy(value) {
		return value
	}
	return ""
}

// proposalTree — proposal новой записи: running, не устаревшее, after ещё нет.
func proposalTree(id, jobID, stage, before string) *dynvalue.Object {
	proposal := dynvalue.NewObject()
	proposal.Set("id", id)
	proposal.Set("jobId", jobID)
	proposal.Set("stage", stage)
	proposal.Set("status", "running")
	proposal.Set("stale", false)
	proposal.Set("before", before)
	proposal.Set("after", nil)
	return proposal
}

// Discard отклоняет готовое, недопустимое или завершённое ошибкой
// предложение плана. Запись заменяется отметкой discarded; история задания агента сохраняется.
// Выполняющееся и применённое предложение не отклоняются. Задание могло завершиться после
// последнего показа плана, пока запись ещё хранит running, поэтому перед проверкой статус
// обновляется (refresh).
func (w *Workflow) Discard(project, shot, packageDir, id string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, err := ReadContext(project, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	stored := w.store.Read(c.Project, shot)
	if stored != nil && stored.ID() == id && stored.PackageDir() == c.PackageDir {
		if _, err := w.refresh(c, stored); err != nil {
			return View{}, err
		}
	}
	if stored == nil || stored.ID() != id || stored.PackageDir() != c.PackageDir || stored.Status() == "running" || stored.Status() == "applied" {
		return View{}, errors.New(textDiscardUnavailable)
	}
	// Запись сразу заменяется отметкой отклонения, без промежуточного статуса: читатели видят
	// только итоговый файл.
	if err := w.store.WriteDiscarded(c.Project, shot, id); err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, packageDir)
}

// Summary — непринятое предложение плана для списка «Производства» (ProductionProposalSummary
// JSON { stage, status, stale, packageDir }) и подпись, по которой план попадает в «Ждут вашего
// действия».
type Summary struct {
	Value     json.RawMessage
	Attention string
}

// attention — признак внимания к предложению в сводке: по статусу и устареванию.
func attention(status string, stale bool) string {
	switch {
	case stale:
		return textAttentionStale
	case status == "ready":
		return textAttentionReady
	case status == "invalid":
		return textAttentionInvalid
	}
	return textAttentionFailed
}

// PendingProposals возвращает непринятые предложения (ready, invalid, failed)
// по планам проекта path. Записи выполнявшихся заданий сначала обновляются видом плана; записи,
// которые уже нельзя показать (план убран из реестра или стал производным, пакет удалён,
// применённый пакет пропал), удаляются. Записи других проектов не трогаются. Ошибки чтения —
// пустая сводка.
func (w *Workflow) PendingProposals(path string) map[string]Summary {
	w.mu.Lock()
	defer w.mu.Unlock()
	result := map[string]Summary{}
	project, err := dynvalue.Realpath(path)
	if err != nil {
		return result
	}
	registry, err := readJSON(filepath.Join(project, "plan", "scenes.json"))
	scenes, ok := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	if err != nil || !dynvalue.IsRecord(registry) || !ok {
		return result
	}
	byFile := map[string]*dynvalue.Object{}
	for _, item := range scenes {
		if scene, isObject := item.(*dynvalue.Object); isObject {
			if id, isString := scene.Value("id").(string); isString {
				byFile[FileName(project, id)] = scene
			}
		}
	}
	folder := w.store.Folder()
	entries, _ := os.ReadDir(folder)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, "-request.json") {
			continue
		}
		file := filepath.Join(folder, name)
		value, err := readJSON(file)
		if err != nil {
			continue
		}
		// Записи других проектов не трогаем: проект указан в правилах предложения.
		if !dynvalue.IsRecord(value) || !dynvalue.IsRecord(dynvalue.Get(value, "rules")) || dynvalue.GetPath(value, "rules", "project") != project ||
			!dynvalue.IsRecord(dynvalue.Get(value, "proposal")) {
			continue
		}
		scene := byFile[name]
		// Завершённое задание переводит предложение в итоговый статус только при чтении вида плана:
		// иначе ответ агента по плану, на который пользователь не возвращался, не попал бы в сводку.
		if scene != nil && dynvalue.GetPath(value, "proposal", "status") == "running" {
			packageDir, _ := dynvalue.Get(value, "packageDir").(string)
			if _, err := w.view(project, scene.Value("id").(string), packageDir); err == nil {
				// Ошибка повторного чтения оставляет прежнее значение.
				if updated, err := readJSON(file); err == nil {
					value = updated
				}
			}
			if !dynvalue.IsRecord(value) || !dynvalue.IsRecord(dynvalue.Get(value, "proposal")) {
				continue
			}
		}
		proposal := dynvalue.Get(value, "proposal")
		status := dynvalue.ToString(dynvalue.Get(proposal, "status"))
		packageDir, hasPackage := dynvalue.Get(value, "packageDir").(string)
		target, _ := dynvalue.Get(value, "target").(string)
		orphan := scene == nil || derivedshot.Source(scene) != "" || (hasPackage && !dynvalue.Exists(packageDir)) ||
			(status == "applied" && (target == "" || !dynvalue.Exists(target)))
		if orphan {
			if status != "running" {
				_ = os.Remove(file)
			}
			continue
		}
		if status == "ready" || status == "invalid" || status == "failed" {
			stale := dynvalue.Get(proposal, "stale") == true
			summary := dynvalue.NewObject()
			summary.Set("stage", dynvalue.Get(proposal, "stage"))
			summary.Set("status", status)
			summary.Set("stale", stale)
			if hasPackage {
				summary.Set("packageDir", packageDir)
			} else {
				summary.Set("packageDir", nil)
			}
			result[scene.Value("id").(string)] = Summary{Value: dynvalue.Raw(summary), Attention: attention(status, stale)}
		}
	}
	return result
}

// Busy — занятость плана (поле busy вида) для действий производства, которые не должны
// пересекаться с проходом.
// Вид, который не читается (нет плана, неверный пакет), занятостью не считается: маршрут
// сообщит свою ошибку сам.
func (w *Workflow) Busy(project, shot, packageDir string) bool {
	view, err := w.View(project, shot, packageDir)
	return err == nil && view.Busy
}
