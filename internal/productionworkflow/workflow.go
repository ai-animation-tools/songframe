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
// Владение: записи предложений в папке проекта plan/batches/proposals (Store) и множество
// «готовится» принадлежат Workflow; задания агента — менеджеру агентов (Agents), рабочие папки
// заданий опор в каталоге состояния — KeyframeImages. Остальные файлы проекта пишет Apply;
// исключение — платная опора: папку запроса пакета создаёт media_request prepare, вопрос
// согласования в workflow.json — shot_workflow set-image-request.
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
	"songframe/internal/mediaapi"
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
	// LocalDir — каталог состояния приложения: журналы применения (production-apply) и процессы этой
	// машины. Записи предложений лежат в проекте (Store), а не здесь. Тот же каталог, что
	// KeyframeImages.LocalDir: проход удаляет из него рабочие папки завершённых заданий опор.
	LocalDir string
	// Agents — менеджер агентов; nil — заданий нет, запуск отклоняется.
	Agents Agents
	// Run — инструменты комплекса (continuity_brief); nil — tools.RunContext.
	Run Runner
	// Catalog — каталог моделей провайдера видео; nil — собственный providers.Catalogs.
	Catalog CatalogReader
	// IsScenarioApproved — сценарий утверждён: кастинг и части утверждены, планы не требуют проверки.
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
	// ExtractFrame — кадр position (first или last) видео video в файл target, при side > 0 —
	// уменьшенный до этой наибольшей стороны; nil — FFmpeg (extractFrame). Тесты подменяют его,
	// чтобы не зависеть от FFmpeg окружения.
	ExtractFrame func(ctx context.Context, video, position, target string, side int) error
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
	if options.ExtractFrame == nil {
		options.ExtractFrame = extractFrame
	}
	return &Workflow{options: options, store: Store{}, busy: map[string]bool{}}
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
	// Manual — почему нельзя собрать пакет ручной генерации; nil — можно или план не ручной.
	Manual *string `json:"manual,omitempty"`
	// References — почему референсы попытки по референсам сейчас не меняются; поле опускается,
	// когда можно или попытка по опорам.
	References *string `json:"references,omitempty"`
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
	NextStage    *string `json:"nextStage,omitempty"`
	ReplaceFrame *string `json:"replaceFrame,omitempty"`
	CanPrepare   bool    `json:"canPrepare"`
	CanContinue  bool    `json:"canContinue"`
	CanRevise    bool    `json:"canRevise"`
	// ReviseStage — этап, который переделает доработка без явного этапа, пока она доступна
	// (CanRevise): интерфейс показывает доработку в шаге этого этапа и называет её по нему.
	ReviseStage       *string `json:"reviseStage,omitempty"`
	CanGenerateFrames bool    `json:"canGenerateFrames"`
	// Manual — видео плана создаётся вне приложения по пакету ручной генерации (Context.Manual).
	// CanBuildManual — пакет можно собрать сейчас. SingleFrame — речевой план у провайдера без
	// липсинка: всегда вручную и по одной опоре. GenerationMethod — способ, выбранный для
	// попытки: "manual"; поле опускается, пока видео делает провайдер проекта.
	Manual           bool   `json:"manual,omitempty"`
	CanBuildManual   bool   `json:"canBuildManual,omitempty"`
	SingleFrame      bool   `json:"singleFrame,omitempty"`
	GenerationMethod string `json:"generationMethod,omitempty"`
	// ReferencesAvailable — новую попытку плана можно сделать по референсам (режим адаптера есть,
	// план не речевой, не из опор и не производный). CanEditReferences — референсы попытки по
	// референсам можно утвердить, убрать или заменить сейчас (иначе причина в Reasons.References).
	ReferencesAvailable bool `json:"referencesAvailable,omitempty"`
	CanEditReferences   bool `json:"canEditReferences,omitempty"`
	// StaticShot — план из опор (Context.StaticShot): опор от одной (K01 и необязательные
	// состояния), предел провайдера видео к выбору их числа не относится.
	StaticShot bool `json:"staticShot,omitempty"`
	// PromptMaxChars — предел длины видеопромпта провайдера (Context.PromptLimit): длиннее него
	// промпт не утверждается; 0 — предела нет.
	PromptMaxChars int `json:"promptMaxChars,omitempty"`
	// Paid — попытка пакета уже оплачена: дальше только новая попытка или возврат с замечанием.
	Paid bool `json:"paid"`
	// Composition — снимок вида из камеры для опор (composition.go); nil — у плана нет точки съёмки с камерой
	// и схемой, нет пакета или опоры создаёт не агент.
	Composition *CompositionView `json:"composition,omitempty"`
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
	manual, err := manualReason(c, derived, common, imagePhase)
	if err != nil {
		return View{}, err
	}
	view := View{
		Project: canonical, Shot: shot, PackageDir: optional(c.PackageDir), Busy: busy, Stage: optional(stage), DerivedFrom: optional(c.DerivedFrom),
		NextStage: optional(nextStage), ReplaceFrame: optional(replaceFrame),
		Reasons: Reasons{
			Prepare:  optional(prepareReason(derived, busy, imagePhase, scenarioApproved, c.Problems)),
			Continue: optional(continueReason(c, derived, common, imagePhase, nextStage, speechMismatch, framesApproved, descriptionApproved)),
			Frames:   optional(framesReason(c, derived, common, imagePhase, framesApproved, descriptionApproved || frameRevision, undecided)),
			Manual:   optional(manual),
		},
		Manual: c.Manual, SingleFrame: c.SingleFrame, StaticShot: c.StaticShot, GenerationMethod: generationMethod(c), CanBuildManual: c.Manual && manual == "" && !pending && !proposalPending && !busy, PromptMaxChars: c.PromptLimit(),
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
	view.ReferencesAvailable = w.referencesReason(c) == ""
	if c.ReferencesMethod {
		if reason := referencesEditReason(c, busy, proposalPending); reason != "" {
			view.Reasons.References = &reason
		} else {
			view.CanEditReferences = true
		}
	}
	if view.CanRevise {
		// Доработка оплаченной попытки начинается с описания в новой попытке (prepare).
		revise := "description"
		if !c.Paid {
			if revise, err = c.reviseStage(nextStage); err != nil {
				return View{}, err
			}
		}
		view.ReviseStage = optional(revise)
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
	if view.Composition, err = c.composition(agentImageProvider(generation)); err != nil {
		return View{}, err
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
		if descriptionApproved && c.ReferencesMethod {
			return textApproveReferencesFirst
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
// Запись пишется только при смене статуса running. После записи итогового статуса предложения
// опор рабочая папка задания в каталоге состояния удаляется (releaseImageJob): больше её никто
// не читает. Возвращает задание агента записи или nil.
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
			var refusal *refusalError
			if errors.As(err, &refusal) {
				// Отказ со списком противоречий: таблица исправлений и её пересказ.
				proposal.Set("message", textAgentRefused)
				proposal.Set("refused", true)
				proposal.Set("agentText", refusal.text)
				proposal.Set("problems", refusal.problems)
			} else if !stored.ImageJob() {
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
	if err := w.store.Write(c.Project, c.Shot, stored); err != nil {
		// Запись осталась running: следующий вид плана повторит сбор, рабочая папка ещё нужна.
		return job, err
	}
	// Итоговый статус записан: кандидаты скопированы в проект или собирать больше нечего.
	if stored.ImageJob() {
		releaseImageJob(w.options.LocalDir, stored.JobID())
	}
	return job, nil
}

// accept разбирает результат завершённого задания: предложение записывается в after до
// проверки возможностей (неподходящий запрос остаётся виден вместе с причиной). Кандидаты опор
// копируются из рабочей папки задания в проект (Store.pinCandidates): after ссылается на копии, и
// запоминаются SHA-256 их байтов. Дальше предложение не зависит ни от рабочей папки, ни от истории
// заданий этой машины.
func (w *Workflow) accept(c *Context, stored *Stored, job agents.Job) error {
	raw := job.Result
	if stored.ImageJob() {
		images, provider, err := w.collectImages(job)
		if err != nil {
			return err
		}
		// Применение отметит опоры этим провайдером: учёт расхода отличает их от своих файлов.
		stored.Tree.Set("imageProvider", provider)
		// Промпты, которые программа передала генератору, применение запишет на опоры попытки.
		if prompts := generatorPrompts(job.Result); prompts != nil {
			stored.Tree.Set("imagePrompts", prompts)
		}
		document := dynvalue.NewObject()
		document.Set("schemaVersion", float64(1))
		document.Set("stage", "frames")
		document.Set("images", candidatesTree(images))
		raw = dynvalue.Stringify(document)
	}
	rules := stored.Rules()
	if rules.Stage == "description" {
		refusal, blocked, err := parseBlocked(c.Project, c.Shot, raw)
		if err != nil {
			return err
		}
		if blocked {
			return refusal
		}
	}
	after, err := ParseProposal(raw, rules)
	if err != nil {
		return err
	}
	if after.Value("stage") == "frames" {
		images, _ := dynvalue.AsArray(after.Value("images"))
		candidates := make([]FrameCandidate, len(images))
		for index, image := range images {
			candidates[index].ID, _ = dynvalue.Get(image, "id").(string)
			candidates[index].Path, _ = dynvalue.Get(image, "path").(string)
		}
		pinned, hashes, err := w.store.pinCandidates(c.Project, c.Shot, candidates)
		if err != nil {
			return err
		}
		after.Set("images", candidatesTree(pinned))
		stored.Tree.Set("imageHashes", hashes)
	}
	stored.Proposal().Set("after", after)
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
	// Keyframes — число опор, выбранное пользователем для этапа description (1…KeyframeLimit), 0 —
	// «авто»; nil при доработке описания — прежний выбор попытки (workflow keyframe_count), при
	// новой попытке — «авто».
	Keyframes *int `json:"keyframes,omitempty"`
	// Method — способ генерации новой попытки с описания: "references" — по референсам без опор,
	// "keyframes" или "" — по опорам. У остальных запусков способ — способ попытки, другой выбор
	// отклоняется.
	Method string `json:"method,omitempty"`
	// Looks — коды героев с сохранёнными образами, выбранных пользователем перед описанием, когда
	// образов больше, чем примет модель; nil — не выбирал (при доработке описания действует выбор
	// попытки).
	Looks []string `json:"looks,omitempty"`
	// own — свой текст пользователя (SaveOwn): открытый вопрос о тексте того же этапа не мешает
	// его заменить — применение задаст вопрос заново.
	own bool
}

// Start проверяет доступность этапа, снимает входы, получает врезки
// непрерывности и каталог моделей, запускает задание агента и записывает предложение running.
// Доступ к агенту (выбор, программа, вход) проверяет сервис приложения до вызова.
func (w *Workflow) Start(ctx context.Context, input StartInput) (View, error) {
	if !slices.Contains([]string{"prepare", "revise", "continue"}, input.Action) ||
		(input.Stage != nil && !slices.Contains([]string{"description", "prompt"}, *input.Stage)) {
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

// preparedStart — проверенный запуск: контекст, этап, целевой пакет, снимок входов и выбранное
// число опор этапа description (0 — «авто»).
type preparedStart struct {
	context    *Context
	stage      string
	newPackage bool
	target     string
	hashes     *dynvalue.Object
	keyframes  int
	// shotFrames и missingFrames — кадры других планов этапа description (shot_frames.go) и
	// связанные планы без принятого видео.
	shotFrames    []ShotFrame
	missingFrames []string
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
	// У попытки своего видео нет описания, опор и промпта: дорабатывать в ней нечего, план с агентом
	// начинается новой попыткой.
	if input.Action != "prepare" && c.workflowValue("own_video") == true {
		return nil, errors.New(textOwnVideoNoAgent)
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
	if c.StaticShot && prepared.stage == "prompt" {
		return nil, errors.New(textStaticNoVideoStage)
	}
	if c.ReferencesMethod, err = w.methodChoice(c, input); err != nil {
		return nil, err
	}
	if c.ReferencesMethod {
		// Попытку по референсам делает провайдер проекта: ручного способа прежней попытки у неё
		// нет, а число опор не выбирается.
		c.Manual = false
		if input.Keyframes != nil && *input.Keyframes != 0 {
			return nil, errors.New(textReferencesKeyframes)
		}
	} else if prepared.keyframes, err = keyframeChoice(c, prepared.stage, input.Keyframes, input.Action != "prepare"); err != nil {
		return nil, err
	}
	// Кадры других планов разрешены только описанию: опора может назвать их референсами, а видео
	// получает лишь принятые опоры. Пути в пакете target войдут в снимок входов ещё до извлечения.
	if prepared.stage == "description" {
		if prepared.shotFrames, prepared.missingFrames, err = shotFrames(c.Project, input.Shot); err != nil {
			return nil, err
		}
		for _, frame := range prepared.shotFrames {
			if path := frame.path(c.Project, prepared.target); !slices.Contains(c.AllowedPaths, path) {
				c.AllowedPaths = append(c.AllowedPaths, path)
			}
		}
		slices.SortFunc(c.AllowedPaths, compareUTF16)
	}
	if prepared.hashes, err = Snapshot(c.Project, c.PackageDir, prepared.target, c.AllowedPaths); err != nil {
		return nil, err
	}
	return prepared, nil
}

// keyframeChoice — число опор для задания этапа stage: явный выбор пользователя в пределах
// провайдера видео (0 — «авто»), без него при доработке описания попытки (inherit) — прежний
// выбор попытки (keyframe_count), иначе 0 («авто»). Речевой план ручной генерации всегда с одной опорой: другой выбор отклоняется,
// а сам он записывается как «авто» — правило одной опоры задаёт ручной режим.
func keyframeChoice(c *Context, stage string, chosen *int, inherit bool) (int, error) {
	if stage != "description" || (chosen != nil && *chosen == 0) {
		return 0, nil
	}
	if chosen == nil {
		if c.SingleFrame || !inherit {
			return 0, nil
		}
		previous, ok := c.workflowValue("keyframe_count").(float64)
		limit := mediaproviders.KeyframeLimit(c.Settings.Value("provider"))
		if c.StaticShot {
			limit = mediaproviders.DefaultKeyframeLimit
		}
		if !ok || !dynvalue.IsInteger(previous) || previous < 1 || int(previous) > limit {
			return 0, nil
		}
		return int(previous), nil
	}
	if c.SingleFrame {
		if *chosen != 1 {
			return 0, errors.New(textManualKeyframeCount)
		}
		return 0, nil
	}
	if c.StaticShot {
		// План из опор: база и необязательные состояния; видео не генерируется, предел провайдера
		// видео к нему не относится.
		if *chosen < 1 || *chosen > mediaproviders.DefaultKeyframeLimit {
			return 0, errors.New(textStaticKeyframeCountRange(mediaproviders.DefaultKeyframeLimit))
		}
		return *chosen, nil
	}
	if limit := mediaproviders.KeyframeLimit(c.Settings.Value("provider")); *chosen < 1 || *chosen > limit {
		return 0, errors.New(textKeyframeCountRange(limit))
	}
	return *chosen, nil
}

// reviseStage — этап, который переделает доработка без явного этапа: следующий проход пакета
// next (кроме запроса: его собирает приложение), а если его нет — ближайший пройденный (промпт,
// иначе описание). Тем же правилом
// View.ReviseStage называет доработку в интерфейсе.
func (c *Context) reviseStage(next string) (string, error) {
	// Запрос собирает приложение (PrepareRequest): доработка с замечанием начинается с промпта.
	if next != "" && next != "request" {
		return next, nil
	}
	prompt, err := c.PromptApproved()
	if err != nil {
		return "", err
	}
	frames, err := c.FramesApproved()
	if err != nil {
		return "", err
	}
	switch {
	case (prompt || frames) && !c.StaticShot:
		return "prompt", nil
	default:
		// У плана из опор видеопромпта нет: доработка после опор переделывает описание.
		return "description", nil
	}
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
	if pending := c.workflowValue("pending_decision"); dynvalue.Truthy(pending) &&
		!(input.own && input.Stage != nil && ownReplacesQuestion(c, *input.Stage)) {
		return "", errors.New(textResolveQuestionFirst)
	}
	next, err := c.StageFor()
	if err != nil {
		return "", err
	}
	stage := next
	if input.Stage != nil {
		stage = *input.Stage
	} else if input.Action == "revise" {
		if stage, err = c.reviseStage(next); err != nil {
			return "", err
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
		// Запрос собирает приложение без агента (PrepareRequest).
		return "", errors.New(textRequestByApp)
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
	reports, capabilitiesProblem := w.capabilities(ctx, c)
	title := ""
	if provider, ok := videoProvider(c.Settings); ok {
		title = provider.Title
	}
	// Речевому плану нужен режим со звуковым входом; без него точный липсинк невозможен, и агент
	// всё равно вернул бы ошибку.
	if c.Scene.Value("lipsync") == true && !c.Manual {
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
	rules.Keyframes = prepared.keyframes
	if c.ReferencesMethod {
		rules.MaxReferences = referenceLimit(w.referenceRules(c), reports)
	}
	looks, err := w.lookHeroes(ctx, c, stage, input.Looks, input.Action != "prepare")
	if err != nil {
		return err
	}
	if looks != nil && stage == "description" {
		rules.Looks = looks.chosen
	}
	generation, err := projectGeneration(c.Project)
	if err != nil {
		return err
	}
	prompt := agentPrompt(stage, c.Settings.Value("provider"), dynvalue.Get(dynvalue.Get(generation, "image"), "provider"), c.ReferencesMethod)
	contextInput := contextInput{stage: stage, briefs: briefs, description: nil, prompt: nil, lipSync: rules.LipSync, manual: rules.Manual,
		manualVideo: c.Manual && !c.SingleFrame, capabilities: capabilities,
		capabilitiesProblem: capabilitiesProblem}
	if stage == "prompt" {
		contextInput.promptMaxChars = c.PromptLimit()
	}
	contextInput.keyframeCount = rules.Keyframes
	if c.ReferencesMethod {
		contextInput.referencesVideo = referencesVideoTree(rules.MaxReferences)
	}
	if looks != nil && len(looks.entities) > 0 {
		contextInput.savedLooks = looks.tree()
	}
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
	contextInput.note = noteFor(c, input.Note)
	if stage == "description" {
		contextInput.stateSources = stateSourcesTree(c.Project, input.Shot, briefs)
	}
	var images []string
	if stage == "description" && (len(prepared.shotFrames) > 0 || len(prepared.missingFrames) > 0) {
		attachments, attached, problem := w.shotFrameAttachments(ctx, c.Project, input.Shot, prepared.shotFrames)
		images = attachments
		contextInput.shotFrames = shotFramesTree(c.Project, prepared.target, prepared.shotFrames, attached, prepared.missingFrames, problem)
	}
	if stage == "prompt" && c.PackageDir != "" {
		images, contextInput.attachedFrames, contextInput.materials = w.promptAttachments(ctx, c, input.Shot)
		if c.ReferencesMethod {
			var references []string
			references, contextInput.attachedReferences = w.referenceAttachments(c, input.Shot)
			images = append(references, images...)
		}
	}
	task := agents.StartInput{
		Project: c.Project, Task: "ai-clip-scene:" + input.Shot + ":" + stage, Prompt: prompt, Context: agentContext(c, contextInput),
		Images: images, Place: &agents.Place{Page: "production", Shot: input.Shot},
	}
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
// План без липсинка видит только черновые команды адаптера (длительности моделей для описания);
// речевому плану нужны все режимы со звуковым входом.
func (w *Workflow) capabilities(ctx context.Context, c *Context) ([]providers.CatalogReport, string) {
	reports := []providers.CatalogReport{}
	problems := []string{}
	adapter, ok := providers.PaidAdapter(c.Settings.Value("provider"))
	if !ok {
		return reports, textProviderCapabilitiesMissing
	}
	var draft []string
	if c.Scene.Value("lipsync") != true {
		draft = adapter.Rules.DraftVideoCommands
	}
	// Попытке по референсам нужен только режим по референсам и только его модели: запрос соберётся
	// моделью режима, и другие модели команды не должны попадать в совет агента о модели.
	var modes *mediaapi.ReferenceRules
	if c.ReferencesMethod && adapter.Rules.Video != nil && adapter.Rules.Video.References != nil {
		modes = adapter.Rules.Video.References
		draft = []string{modes.Command}
	}
	visible := func(command string) bool { return draft == nil || slices.Contains(draft, command) }
	catalog, err := w.options.Catalog.Read(ctx, c.Project, adapter.ID, mediaproviders.Video)
	if err != nil {
		return reports, err.Error()
	}
	for _, report := range catalog.Reports {
		if !visible(report.Command) {
			continue
		}
		if modes != nil && report.Models != nil {
			models := dynvalue.NewObject()
			for _, id := range modes.Models {
				if value, ok := report.Models.Get(id); ok {
					models.Set(id, value)
				}
			}
			report.Models = models
		}
		reports = append(reports, report)
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
// по планам проекта path из его папки записей (Store). Записи выполнявшихся заданий сначала
// обновляются видом плана; записи, которые уже нельзя показать (план убран из реестра или стал
// производным, пакет удалён, применённый пакет пропал), удаляются вместе с копиями кандидатов.
// Файлы *-request.json и всё, что не похоже на запись предложения, не трогаются. Ошибки чтения —
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
	byID := map[string]*dynvalue.Object{}
	for _, item := range scenes {
		if scene, isObject := item.(*dynvalue.Object); isObject {
			if id, isString := scene.Value("id").(string); isString {
				byID[id] = scene
			}
		}
	}
	// Путь записи на диске — от проекта; сводка и проверки работают с абсолютным.
	absolute := func(value any) (string, bool) {
		local, ok := value.(string)
		if !ok || local == "" {
			return "", ok
		}
		return filepath.Join(project, filepath.FromSlash(local)), true
	}
	entries, _ := os.ReadDir(w.store.Folder(project))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, "-request.json") {
			continue
		}
		shot := strings.TrimSuffix(name, ".json")
		file := w.store.Path(project, shot)
		value, err := readJSON(file)
		if err != nil {
			continue
		}
		if !dynvalue.IsRecord(value) || !dynvalue.IsRecord(dynvalue.Get(value, "rules")) || !dynvalue.IsRecord(dynvalue.Get(value, "proposal")) {
			continue
		}
		scene := byID[shot]
		// Завершённое задание переводит предложение в итоговый статус только при чтении вида плана:
		// иначе ответ агента по плану, на который пользователь не возвращался, не попал бы в сводку.
		if scene != nil && dynvalue.GetPath(value, "proposal", "status") == "running" {
			packageDir, _ := absolute(dynvalue.Get(value, "packageDir"))
			if _, err := w.view(project, shot, packageDir); err == nil {
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
		packageDir, hasPackage := absolute(dynvalue.Get(value, "packageDir"))
		target, hasTarget := absolute(dynvalue.Get(value, "target"))
		orphan := scene == nil || derivedshot.Source(scene) != "" || (hasPackage && !dynvalue.Exists(packageDir)) ||
			(status == "applied" && (!hasTarget || !dynvalue.Exists(target)))
		if orphan {
			if status != "running" {
				w.store.Remove(project, shot)
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
			result[shot] = Summary{Value: dynvalue.Raw(summary), Attention: attention(status, stale)}
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
