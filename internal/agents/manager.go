package agents

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/process"
	"songframe-go/internal/projectfile"
)

// Пределы задания агента; значения входят в поведение, проверяемое эталонами.
const (
	// TextLimit — наибольший размер промпта, контекста и результата в байтах UTF-8.
	TextLimit = 256 * 1024
	// logLimit — хвост журнала задания в кодовых единицах UTF-16.
	logLimit = 12000
	// stderrTail — хвост stderr для классификации сбоя, в кодовых единицах UTF-16.
	stderrTail = 4096
	// DefaultTimeout — предельное время одного задания CLI.
	DefaultTimeout = 20 * time.Minute
	// DefaultOutputBytes — общий предел stdout+stderr CLI.
	DefaultOutputBytes = 8 * 1024 * 1024
	// flushDelay — задержка сохранения промежуточного состояния: запись истории не идёт на каждую дельту.
	flushDelay = 250 * time.Millisecond
	// Вложения: число, размер одного файла и суммарный объём (учитывают base64 в stdin Claude).
	imageCount      = 64
	imageBytes      = 5 * 1024 * 1024
	imageTotalBytes = 20 * 1024 * 1024
)

// Виды событий задания (AgentEvent.type).
const (
	EventStarted      = "started"
	EventTextDelta    = "text_delta"
	EventToolStarted  = "tool_started"
	EventToolFinished = "tool_finished"
	EventCompleted    = "completed"
	EventFailed       = "failed"
)

// Префиксы промпта задания. Это часть промпта агента, а не тексты интерфейса: менять их нельзя
// без решения пользователя, они фиксированы эталонами дословно.
const (
	readPrefix  = "Подготовь предложение для пользователя. Не изменяй файлы проекта, не выполняй commit/push, не удаляй исходники или assets и не отправляй платные запросы сервисам генерации. Правила хранения проекта описаны в его README.md."
	writePrefix = "Создай только запрошенные изображения в текущей рабочей папке кандидатов. Не изменяй материалы исходного проекта, не выполняй commit/push и не отправляй запросы сервисам генерации. Верни финальный JSON в запрошенном формате."
)

// StartInput — AgentStartInput контракта. Пустой Context равнозначен отсутствующему: ни хеш, ни
// промпт их не различают.
type StartInput struct {
	Project string `json:"project"`
	Task    string `json:"task"`
	Prompt  string `json:"prompt"`
	Context string `json:"context,omitempty"`
	// Images — абсолютные пути PNG/JPEG; передаются модели вложениями только в заданиях без записи.
	Images  []string `json:"images,omitempty"`
	RetryOf string   `json:"retryOf,omitempty"`
}

// Event — AgentEvent контракта: приращение (text_delta, tool_*) или снимок задания (started,
// completed, failed). Text — указатель, потому что пустая дельта всё равно передаётся.
type Event struct {
	JobID    string  `json:"jobId"`
	Project  string  `json:"project"`
	Sequence int     `json:"sequence"`
	Phase    string  `json:"phase"`
	Type     string  `json:"type"`
	Text     *string `json:"text,omitempty"`
	Tool     string  `json:"tool,omitempty"`
	Job      *Job    `json:"job,omitempty"`
}

// Runner — то, что нужно потребителям заданий агента (предложения сценария, разбор видео,
// маршрут Wails): запуск, снимки, отмена и подписка на события. Manager его реализует;
// потребители тестируются на собственной подделке без CLI.
type Runner interface {
	Start(input StartInput) (Job, error)
	Get(id string) (Job, bool)
	List(project string) []Job
	Cancel(id string) (Job, error)
	OnEvent(listener func(Event)) (unsubscribe func())
}

// Options подменяют пределы и запуск CLI в тестах. Нулевые значения — штатные пределы и
// окружение приложения.
type Options struct {
	Timeout     time.Duration
	OutputBytes int
	// Check — окружение, home, системные каталоги и платформа: ими пользуются и диагностика CLI,
	// и рабочий запуск.
	Check CheckOptions
	// Adapter — адаптер на запуск; nil — NewAdapterOptions(provider, Check).
	Adapter func(provider string) Adapter
}

// running — состояние выполняющегося задания. Все поля, как и *Job, меняются только под Manager.mu.
type running struct {
	job         *Job
	projectKey  string // realpath проекта: занятость проверяется по нему, а не по строке пути
	cancel      context.CancelFunc
	ctx         context.Context
	timer       *time.Timer
	flush       *time.Timer
	ended       bool
	completed   bool
	outputBytes int
	// lastNotice — последнее нефатальное уведомление CLI: причина, если процесс завершится без результата.
	lastNotice string
}

// Manager владеет запуском CLI, историей заданий агента и завершением дерева процессов.
//
// Конкурентность: mu защищает карты, задания и их running; длительные вызовы (диагностика CLI,
// сам процесс) идут без блокировки в отдельной горутине на задание. События копятся в outbox под
// mu и доставляются подписчикам вне блокировки строго в порядке публикации (deliver), поэтому
// подписчик может вызвать Get/List/Cancel. Отмена закрывает context запуска: process.Run убивает
// всё дерево CLI. wg считает горутины запуска до фактического закрытия процесса и его потоков.
type Manager struct {
	settings *SettingsStore
	options  Options
	history  *History

	mu        sync.Mutex
	jobs      map[string]*Job
	order     []string // порядок вставки jobs: стабильная сортировка List
	running   map[string]*running
	listeners []listener
	nextID    int
	stopping  bool
	outbox    []Event

	emit sync.Mutex
	wg   sync.WaitGroup
}

type listener struct {
	id int
	on func(Event)
}

// NewManager читает историю каталога состояния. Задание, оставшееся running после прошлого
// запуска приложения, помечается interrupted: автоматического повтора нет, запись сохраняется.
func NewManager(settings *SettingsStore, options Options) *Manager {
	if options.Timeout <= 0 {
		options.Timeout = DefaultTimeout
	}
	if options.OutputBytes <= 0 {
		options.OutputBytes = DefaultOutputBytes
	}
	if options.Adapter == nil {
		check := options.Check
		options.Adapter = func(provider string) Adapter { return NewAdapterOptions(provider, check) }
	}
	m := &Manager{
		settings: settings,
		options:  options,
		history:  NewHistory(settings.LocalDir()),
		jobs:     map[string]*Job{},
		running:  map[string]*running{},
	}
	for _, job := range m.history.Read() {
		if job.Status == StatusRunning {
			finished := timestamp(time.Now())
			job.Status = StatusInterrupted
			job.Phase = phaseRestartInterrupted
			job.FinishedAt = &finished
			job.Diagnostic = CodeInterrupted
			job.Message = textRestartInterrupted
			job.Sequence++
			if err := m.history.Write(job); err != nil {
				log.Printf("Не удалось сохранить прерванное задание агента %s: %v", job.ID, err)
			}
		}
		if _, seen := m.jobs[job.ID]; !seen {
			m.order = append(m.order, job.ID)
		}
		m.jobs[job.ID] = &job
	}
	return m
}

// List — снимки заданий проекта (пустая строка — все), новые первыми.
func (m *Manager) List(project string) []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := []Job{}
	for _, id := range m.order {
		job := m.jobs[id]
		if project == "" || job.Project == project {
			result = append(result, *job)
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].StartedAt > result[j].StartedAt })
	return result
}

// Get — снимок задания; ok=false, если такого нет.
func (m *Manager) Get(id string) (Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[id]
	if !ok {
		return Job{}, false
	}
	return *job, true
}

// OnEvent подписывает на события всех заданий; возвращённая функция отписывает. Паника
// подписчика не мешает другим подписчикам и заданию.
func (m *Manager) OnEvent(on func(Event)) func() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	id := m.nextID
	m.listeners = append(m.listeners, listener{id: id, on: on})
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		for index, item := range m.listeners {
			if item.id == id {
				m.listeners = append(m.listeners[:index:index], m.listeners[index+1:]...)
				return
			}
		}
	}
}

// Start запускает задание выбранного текстового агента в режиме чтения проекта. Возвращает
// снимок сразу после записи истории; диагностика и запуск CLI идут асинхронно, итог приходит
// событием completed/failed. Ошибки до создания задания — *Error с кодом диагностики.
func (m *Manager) Start(input StartInput) (Job, error) {
	defer m.deliver()
	return m.begin(input, "", nil)
}

// StartImages — внутренний маршрут кандидатов изображений: запись разрешена только в
// подготовленной рабочей папке внутри <каталог состояния>/image-jobs. Программу и модель задаёт
// провайдер изображений (ImageAgent), а не выбранный текстовый агент; постоянные инструкции
// проекта текстовому агенту сюда не вкладываются.
func (m *Manager) StartImages(input StartInput, workDir string, config Settings) (Job, error) {
	defer m.deliver()
	directory, err := jscompat.Realpath(workDir)
	if err != nil {
		return Job{}, err
	}
	base, err := jscompat.Realpath(filepath.Join(m.settings.LocalDir(), "image-jobs"))
	if err != nil {
		return Job{}, err
	}
	if !strings.HasPrefix(directory, base+string(filepath.Separator)) {
		return Job{}, agentError(CodeInvalidInput, textInvalidCandidateDir)
	}
	return m.begin(input, directory, &config)
}

// begin проверяет ввод, резервирует проект и создаёт запись задания. Весь путь до записи истории
// идёт под mu: два быстрых клика не создают два запроса к одному проекту.
func (m *Manager) begin(input StartInput, workDir string, imageConfig *Settings) (Job, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopping {
		return Job{}, agentError(CodeInterrupted, textApplicationStopping)
	}
	if err := validate(input); err != nil {
		return Job{}, err
	}
	images, err := readImages(input.Images)
	if err != nil {
		return Job{}, err
	}
	if workDir != "" && len(images) > 0 {
		return Job{}, agentError(CodeInvalidInput, textImageAttachmentsReadOnly)
	}
	project, err := jscompat.Realpath(input.Project)
	if err != nil {
		return Job{}, agentError(CodeInvalidInput, textProjectNotFound)
	}
	if _, err := os.Stat(filepath.Join(project, "plan", "project.json")); err != nil {
		return Job{}, agentError(CodeInvalidInput, textProjectManifestMissing)
	}
	for _, run := range m.running {
		if run.projectKey == project {
			return Job{}, agentError(CodeProjectBusy, textProjectBusy)
		}
	}
	var config Settings
	if imageConfig != nil {
		// Пустая модель изображений оставляет выбор самой программе.
		config = Settings{Provider: imageConfig.Provider, Model: jscompat.Trim(imageConfig.Model)}
	} else {
		agent, err := m.settings.Agent()
		if err != nil {
			return Job{}, err
		}
		if agent == nil {
			return Job{}, agentError(CodeInvalidInput, textChooseAgentInSettings)
		}
		config = *agent
	}
	if input.RetryOf != "" {
		previous, ok := m.jobs[input.RetryOf]
		previousProject := ""
		if ok {
			// Перемещённый проект нужно выбрать заново.
			previousProject, _ = jscompat.Realpath(previous.Project)
		}
		if !ok || previousProject != project || previous.Status == StatusRunning {
			return Job{}, agentError(CodeInvalidInput, textRetryUnavailable)
		}
	}
	// Снимок инструкций привязан к проекту задания до диагностики; повтор читает их заново.
	instructions := ""
	if workDir == "" {
		settings, err := projectfile.ReadSettings(project)
		if err != nil {
			return Job{}, agentError(CodeInvalidInput, err.Error())
		}
		instructions = settings.AgentInstructions
	}
	permissions := PermissionsReadOnly
	if workDir != "" {
		permissions = PermissionsWorkspaceWrite
	}
	job := &Job{
		SchemaVersion: 1,
		ID:            randomUUID(),
		Project:       jscompat.Resolve(input.Project),
		Provider:      config.Provider,
		Task:          Redact(jscompat.Trim(input.Task)),
		Model:         config.Model,
		RetryOf:       input.RetryOf,
		Permissions:   permissions,
		InputHashes:   InputHashes{Prompt: hashText(input.Prompt), Context: contextHash(input.Context, images)},
		Status:        StatusRunning,
		Phase:         phaseChecking,
		StartedAt:     timestamp(time.Now()),
	}
	if err := m.history.Write(*job); err != nil {
		return Job{}, err
	}
	m.jobs[job.ID] = job
	m.order = append(m.order, job.ID)
	ctx, cancel := context.WithCancel(context.Background())
	run := &running{job: job, projectKey: project, ctx: ctx, cancel: cancel}
	m.running[job.ID] = run
	m.publish(run, EventStarted, nil, "")
	m.wg.Add(1)
	go m.launch(run, config, composePrompt(workDir != "", instructions, input.Prompt, input.Context), images, workDir)
	return *job, nil
}

// Cancel останавливает выполняющееся задание (CANCELLED) и возвращает его снимок; завершённое
// задание возвращается без изменений.
func (m *Manager) Cancel(id string) (Job, error) {
	defer m.deliver()
	m.mu.Lock()
	defer m.mu.Unlock()
	if run, ok := m.running[id]; ok {
		m.finish(run, StatusCancelled, agentError(CodeCancelled, textCancelled))
	}
	job, ok := m.jobs[id]
	if !ok {
		return Job{}, agentError(CodeInvalidInput, textJobNotFound)
	}
	return *job, nil
}

// Shutdown запрещает новые задания и прерывает выполняющиеся (INTERRUPTED) при закрытии приложения.
func (m *Manager) Shutdown() {
	defer m.deliver()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopping = true
	for _, id := range m.order {
		if run, ok := m.running[id]; ok {
			m.finish(run, StatusInterrupted, agentError(CodeInterrupted, textShutdownInterrupted))
		}
	}
}

// ShutdownAndWait прерывает задания и ждёт фактического закрытия CLI и его потоков: только после
// этого можно удалять временные рабочие папки. ctx ограничивает ожидание.
func (m *Manager) ShutdownAndWait(ctx context.Context) error {
	m.Shutdown()
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// launch — асинхронная часть задания: диагностика CLI, аргументы, запуск и разбор потока.
// Любая ошибка завершает задание; после finish (отмена, тайм-аут) результат запуска игнорируется.
func (m *Manager) launch(run *running, config Settings, prompt string, images []Image, workDir string) {
	defer m.wg.Done()
	defer m.deliver()
	adapter := m.options.Adapter(config.Provider)
	check, err := adapter.Check(run.ctx, config)
	m.mu.Lock()
	command, stdin, err := m.prepare(run, adapter, config, check, err, prompt, images, workDir)
	if err != nil || run.ended {
		if err != nil && !run.ended {
			m.fail(run, err)
		}
		m.mu.Unlock()
		return
	}
	run.timer = time.AfterFunc(m.options.Timeout, func() {
		defer m.deliver()
		m.mu.Lock()
		defer m.mu.Unlock()
		m.finish(run, StatusFailed, agentError(CodeTimeout, textJobTimeout))
	})
	m.mu.Unlock()
	m.deliver()

	parser := NewJSONLines(func(value *jscompat.Object) error {
		updates, err := adapter.Parse(value)
		if err != nil {
			return err
		}
		for _, update := range updates {
			if err := m.update(run, update); err != nil {
				return err
			}
		}
		return nil
	}, DefaultLineBytes)
	// stderr не передаётся в историю: CLI может печатать ключи, промпт и содержимое файлов.
	stderr := ""
	command.OnOutput = func(data []byte, isStderr bool) {
		defer m.deliver()
		m.mu.Lock()
		defer m.mu.Unlock()
		if run.ended {
			return
		}
		run.outputBytes += len(data)
		if run.outputBytes > m.options.OutputBytes {
			m.finish(run, StatusFailed, agentError(CodeOutputLimit, textJobOutputLimit))
			return
		}
		if isStderr {
			stderr = utf16Tail(stderr+jscompat.DecodeUTF8(data), stderrTail)
			return
		}
		if err := parser.Push(data); err != nil {
			m.fail(run, err)
		}
	}
	command.Stdin = strings.NewReader(stdin)
	result, runErr := process.Run(run.ctx, command)

	m.mu.Lock()
	defer m.mu.Unlock()
	if run.ended {
		return
	}
	var startErr *process.StartError
	if errors.As(runErr, &startErr) {
		m.finish(run, StatusFailed, agentError(CodeCLIUnavailable, textLaunchFailed(Title(config.Provider))))
		return
	}
	// Завершение сигналом — exitCode null: кода выхода нет.
	var exitErr *process.ExitError
	if !(errors.As(runErr, &exitErr) && exitErr.Signal != "") && result.Code >= 0 {
		code := result.Code
		run.job.ExitCode = &code
	}
	if err := parser.Finish(); err != nil {
		m.fail(run, err)
		return
	}
	if run.ended {
		return
	}
	// stderr только классифицирует сбой и не показывается; причину даёт последнее уведомление агента.
	switch {
	case run.job.ExitCode == nil || *run.job.ExitCode != 0:
		m.fail(run, providerFailure(stderr+" "+run.lastNotice, run.lastNotice))
	case !run.completed && run.lastNotice != "":
		m.fail(run, providerFailure(run.lastNotice, run.lastNotice))
	case !run.completed:
		m.fail(run, agentError(CodeProtocolError, textCompletionMissing))
	default:
		m.finish(run, StatusCompleted, nil)
	}
}

// prepare (под mu) проверяет итог диагностики и готовит команду: аргументы адаптера, stdin
// и окружение. Порядок проверок задаёт текст первой ошибки: наличие, версия, аргументы,
// транспорт вложений, вход.
func (m *Manager) prepare(run *running, adapter Adapter, config Settings, check CheckResult, checkErr error, prompt string, images []Image, workDir string) (process.Command, string, error) {
	if checkErr != nil || run.ended {
		return process.Command{}, "", checkErr
	}
	if check.Availability != Available || check.ExecutablePath == "" {
		code := CodeCLIUnavailable
		if check.Availability == NotFound {
			code = CodeCLINotFound
		}
		return process.Command{}, "", agentError(code, check.Message)
	}
	if check.Version == "" {
		return process.Command{}, "", agentError(CodeUnsupportedVersion, textVersionUnknown(Title(config.Provider)))
	}
	run.job.CLIVersion = check.Version
	mode := ModeRead
	if workDir != "" {
		mode = ModeWrite
	}
	args, err := adapter.Args(config, check.Version, mode, images)
	if err != nil {
		return process.Command{}, "", err
	}
	encoder, canEncode := adapter.(InputEncoder)
	if len(images) > 0 && !canEncode {
		return process.Command{}, "", agentError(CodeUnsupportedVersion, textUnsupportedVersion)
	}
	if check.Authorization != Authenticated {
		code := CodeAuthUnknown
		if check.Authorization == Unauthenticated {
			code = CodeAuthRequired
		}
		return process.Command{}, "", agentError(code, check.Message)
	}
	run.job.Phase = phaseWorking
	if err := m.history.Write(*run.job); err != nil {
		return process.Command{}, "", err
	}
	stdin := prompt
	if canEncode {
		if stdin, err = encoder.Input(prompt, images); err != nil {
			return process.Command{}, "", err
		}
	}
	options := m.options.Check.resolve()
	env := options.environment()
	target := AgentCommand(check.ExecutablePath, args, env, options.Platform)
	dir := workDir
	if dir == "" {
		dir = run.job.Project
	}
	return process.Command{Path: target.File, Args: target.Args, Dir: dir, Env: env, Name: Title(config.Provider)}, stdin, nil
}

// update (под mu) применяет обновление CLI к заданию и публикует приращения. Ошибка завершает
// задание вызывающим (разбор потока).
func (m *Manager) update(run *running, update Update) error {
	if run.ended {
		return nil
	}
	switch update.Type {
	case UpdateFailed:
		return update.Err
	case UpdateNotice:
		if message := providerDetail(update.Text); message != "" {
			run.lastNotice = message
			m.log(run, "Агент сообщил: "+message)
		}
	case UpdateSession:
		run.job.SessionID = update.ID
	case UpdateCompleted:
		run.completed = true
		if update.Result != nil {
			run.job.Result = Redact(*update.Result)
		}
	case UpdateTextDelta:
		text := Redact(update.Text)
		run.job.Result += text
		run.job.Phase = phaseReceiving
		if err := limitResult(run); err != nil {
			return err
		}
		m.publish(run, EventTextDelta, &text, "")
	case UpdateToolStarted, UpdateToolFinished:
		if update.Type == UpdateToolStarted {
			run.job.Phase = phaseReading
			m.log(run, "Агент начал работу инструмента.")
		} else {
			run.job.Phase = phaseWorking
			m.log(run, "Агент завершил работу инструмента.")
		}
		m.publish(run, update.Type, nil, Redact(update.Tool))
	}
	if err := limitResult(run); err != nil {
		return err
	}
	if run.flush == nil {
		run.flush = time.AfterFunc(flushDelay, func() {
			defer m.deliver()
			m.mu.Lock()
			defer m.mu.Unlock()
			run.flush = nil
			if run.ended {
				return
			}
			if err := m.history.Write(*run.job); err != nil {
				m.fail(run, err)
			}
		})
	}
	return nil
}

// limitResult обрезает слишком большой результат и сообщает OUTPUT_LIMIT: ошибочная запись
// тоже не раздувает историю. Обрезка по байтам UTF-8; разрезанный символ становится U+FFFD,
// как у Buffer.toString('utf8').
func limitResult(run *running) error {
	if len(run.job.Result) <= TextLimit {
		return nil
	}
	run.job.Result = jscompat.DecodeUTF8([]byte(run.job.Result[:TextLimit-4]))
	return agentError(CodeOutputLimit, textResultTooLarge)
}

// log (под mu) дописывает строку журнала и оставляет хвост logLimit.
func (m *Manager) log(run *running, text string) {
	run.job.Log = utf16Tail(run.job.Log+text+"\n", logLimit)
}

// publish (под mu) увеличивает sequence и ставит событие в очередь доставки.
func (m *Manager) publish(run *running, kind string, text *string, tool string) {
	run.job.Sequence++
	event := Event{JobID: run.job.ID, Project: run.job.Project, Sequence: run.job.Sequence, Phase: run.job.Phase, Type: kind, Text: text, Tool: tool}
	if kind == EventStarted || kind == EventCompleted || kind == EventFailed {
		snapshot := *run.job
		event.Job = &snapshot
	}
	m.outbox = append(m.outbox, event)
}

// deliver доставляет накопленные события вне mu в порядке публикации. Доставкой одновременно
// занимается одна горутина; остальные оставляют события ей (TryLock), поэтому повторный вход из
// подписчика не блокируется, а порядок не нарушается.
func (m *Manager) deliver() {
	for {
		if !m.emit.TryLock() {
			return
		}
		for {
			m.mu.Lock()
			events := m.outbox
			m.outbox = nil
			listeners := append([]listener(nil), m.listeners...)
			m.mu.Unlock()
			if len(events) == 0 {
				break
			}
			for _, event := range events {
				for _, item := range listeners {
					notify(item.on, event)
				}
			}
		}
		m.emit.Unlock()
		// Событие, поставленное между последней проверкой и Unlock, забирает следующий проход.
		m.mu.Lock()
		empty := len(m.outbox) == 0
		m.mu.Unlock()
		if empty {
			return
		}
	}
}

// notify вызывает подписчика; его паника только журналируется.
func notify(on func(Event), event Event) {
	defer func() {
		if recover() != nil {
			log.Print("Не удалось доставить событие агента подписчику.")
		}
	}()
	on(event)
}

// fail (под mu) завершает задание ошибкой; не *Error (сбой записи истории, разбора) — CLI_ERROR.
func (m *Manager) fail(run *running, err error) {
	var agentErr *Error
	if !errors.As(err, &agentErr) {
		agentErr = agentError(CodeCLIError, textJobSaveFailed)
	}
	m.finish(run, StatusFailed, agentErr)
}

// finish (под mu) завершает задание один раз: останавливает таймеры, убивает дерево CLI через
// context, записывает итог, публикует completed/failed и сохраняет историю.
func (m *Manager) finish(run *running, status string, err *Error) {
	if run.ended {
		return
	}
	run.ended = true
	if run.timer != nil {
		run.timer.Stop()
	}
	if run.flush != nil {
		run.flush.Stop()
	}
	run.cancel()
	finished := timestamp(time.Now())
	run.job.Status = status
	run.job.FinishedAt = &finished
	run.job.Phase = statusPhase[status]
	if err != nil {
		run.job.Diagnostic = err.Code
		run.job.Message = err.Detail
		m.log(run, err.Error())
	} else {
		m.log(run, "Задание завершено.")
	}
	delete(m.running, run.job.ID)
	kind := EventFailed
	if status == StatusCompleted {
		kind = EventCompleted
	}
	m.publish(run, kind, nil, "")
	if err := m.history.Write(*run.job); err != nil {
		log.Print("Не удалось сохранить итог задания агента. Проверьте каталог состояния.")
	}
}

// validate — проверка ввода: обязательные строки без \0, абсолютный проект, задача
// до 120 кодовых единиц UTF-16, промпт и контекст до TextLimit байт.
func validate(input StartInput) error {
	for _, value := range []string{input.Project, input.Task, input.Prompt} {
		if jscompat.Trim(value) == "" || strings.ContainsRune(value, 0) {
			return agentError(CodeInvalidInput, textInputRequired)
		}
	}
	if !jscompat.IsAbs(input.Project) || utf16Len(input.Task) > 120 || len(input.Prompt) > TextLimit || len(input.Context) > TextLimit {
		return agentError(CodeInvalidInput, textInvalidInputSize)
	}
	return nil
}

var (
	imageName = regexp.MustCompile(`(?i)\.(png|jpe?g)$`)
	pngMagic  = []byte{137, 80, 78, 71, 13, 10, 26, 10}
	jpegMagic = []byte{255, 216, 255}
)

// readImages проверяет и читает вложения до диагностики CLI и создания истории. MIME
// определяется расширением вместе с сигнатурой, чтобы CLI не получил произвольный файл под видом
// картинки; пределы учитывают base64 в stdin Claude.
func readImages(paths []string) ([]Image, error) {
	if len(paths) > imageCount {
		return nil, agentError(CodeInvalidInput, textImageAttachmentsTooLarge)
	}
	invalid := agentError(CodeInvalidInput, textImageAttachmentsInvalid)
	images := make([]Image, 0, len(paths))
	total := int64(0)
	for _, path := range paths {
		if jscompat.Trim(path) == "" || strings.ContainsRune(path, 0) || !jscompat.IsAbs(path) || !imageName.MatchString(path) {
			return nil, invalid
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return nil, invalid
		}
		total += info.Size()
		if info.Size() > imageBytes || total > imageTotalBytes {
			return nil, agentError(CodeInvalidInput, textImageAttachmentsTooLarge)
		}
		data, err := os.ReadFile(path)
		png := strings.EqualFold(filepath.Ext(path), ".png")
		magic, mediaType := jpegMagic, "image/jpeg"
		if png {
			magic, mediaType = pngMagic, "image/png"
		}
		if err != nil || int64(len(data)) != info.Size() || !bytes.HasPrefix(data, magic) {
			return nil, invalid
		}
		images = append(images, Image{Path: path, Data: data, MediaType: mediaType})
	}
	return images, nil
}

// composePrompt — полный промпт задания: префикс режима, постоянные инструкции проекта, задача
// и необязательный контекст.
func composePrompt(write bool, instructions, prompt, context string) string {
	var text strings.Builder
	if write {
		text.WriteString(writePrefix)
	} else {
		text.WriteString(readPrefix)
	}
	if instructions != "" {
		text.WriteString("\n\nПостоянные инструкции текстовому агенту этого проекта:\n" + instructions)
	}
	text.WriteString("\n\nЗадача:\n" + prompt)
	if context != "" {
		text.WriteString("\n\nДополнительный контекст:\n" + context)
	}
	return text.String()
}

// hashText — SHA-256 в hex.
func hashText(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

// contextHash — хеш контекста; с вложениями значимы их содержимое и порядок, а не имя
// временного файла: JSON.stringify({context, images: [sha256 байтов]}).
func contextHash(context string, images []Image) string {
	if len(images) == 0 {
		return hashText(context)
	}
	hashes := &jscompat.Array{}
	for _, image := range images {
		sum := sha256.Sum256(image.Data)
		hashes.Items = append(hashes.Items, hex.EncodeToString(sum[:]))
	}
	value := jscompat.NewObject()
	value.Set("context", context)
	value.Set("images", hashes)
	return hashText(jscompat.Stringify(value))
}

// utf16Tail — text.slice(-limit) по кодовым единицам UTF-16; отрезанная половина суррогатной
// пары отбрасывается.
func utf16Tail(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	units = units[len(units)-limit:]
	if len(units) > 0 && units[0] >= 0xdc00 && units[0] <= 0xdfff {
		units = units[1:]
	}
	return string(utf16.Decode(units))
}

// randomUUID — crypto.randomUUID(): UUID версии 4 в нижнем регистре.
func randomUUID() string {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic(err)
	}
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", data[0:4], data[4:6], data[6:8], data[8:10], data[10:16])
}
