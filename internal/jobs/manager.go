package jobs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// DefaultStepTimeout — лимит шага по умолчанию: ожидание провайдера генерации допускает
// до двух часов.
const DefaultStepTimeout = 2 * time.Hour

// logEventInterval прореживает события «изменился журнал»: поток вывода ffmpeg/Python
// не должен превращаться в тысячи событий Wails в секунду.
const logEventInterval = 250 * time.Millisecond

// Step — один шаг задания.
//
// Нулевые значения флагов означают поведение по умолчанию: шаг обязателен,
// а его сбой останавливает задание. Optional — сбой не делает задание неудачным (сопутствующий
// шаг); Continue — сбой обязательного шага делает задание неудачным, но следующие шаги идут.
type Step struct {
	// Tool — идентификатор операции в StepInfo.tool; по нему потребители узнают задание
	// (например, align_lyrics, separate_vocals, apply_montage).
	Tool string
	// Label — подпись шага; пустая означает Tool.
	Label string
	// Args показываются в строке «$ label args» журнала перед шагом.
	Args     []string
	Optional bool
	Continue bool
	// Timeout — лимит шага; 0 — DefaultStepTimeout. Истечение отменяет context шага.
	Timeout time.Duration
	// Before — проверка локального результата перед Run; ошибка — сбой шага
	// с записью «Ошибка запуска: …» в журнал.
	Before func(ctx context.Context) error
	// Run выполняет шаг. nil — успех (код 0). Ошибка с методом ExitCode() даёт код шага,
	// иначе код -1; текст причины — StepError.Message или текст ошибки.
	// При отмене задания Run обязан вернуться и не публиковать частичный результат.
	Run func(ctx context.Context, step *StepContext) error
}

func (s Step) label() string {
	if s.Label != "" {
		return s.Label
	}
	return s.Tool
}

// Spec — параметры запуска задания.
type Spec struct {
	Kind  Kind
	Title string
	// Project — папка проекта; пусто — общее задание приложения (project: null).
	Project string
	Steps   []Step
	// ModelDownload помечает загрузку весов (JobInfo.modelDownload).
	ModelDownload *ModelDownload
}

// Options настраивает менеджер. Нулевое значение — штатный режим приложения.
type Options struct {
	// SkipRestore не читает сведения прошлых сеансов: служебные проверки без окна
	// не должны объявлять чужие задания прерванными.
	SkipRestore bool
	// SavedLimit — сколько заданий прошлых сеансов хранить; 0 — SavedJobsLimit.
	SavedLimit int
	// Now — источник времени для тестов; nil — time.Now.
	Now func() time.Time
}

// Manager владеет заданиями этого и прошлых сеансов, их файлами и подписчиками.
// Все методы безопасны для параллельного вызова: состояние защищено mu, файлы сведений
// пишутся под mu (порядок записей совпадает с порядком изменений), подписчики вызываются
// вне mu из горутины задания, поэтому могут вызывать методы менеджера.
type Manager struct {
	directory string
	now       func() time.Time

	mu        sync.Mutex
	jobs      map[string]*job
	counter   int
	sequence  uint64
	listeners map[uint64]func(Change)
	finished  map[uint64]func(Info, string)
	nextID    uint64
}

// job — внутреннее состояние одного задания. info.Log не используется: хвост текущего
// сеанса хранится в tail, у прошлых сеансов журнал читается из файла.
type job struct {
	info     Info
	sequence uint64
	tail     string
	cancel   context.CancelCauseFunc
	done     chan struct{}
	logFile  *os.File
	lastLog  time.Time
}

// cancelReason — причина отмены задания; её текст становится JobInfo.error.
type cancelReason struct{ text string }

func (c *cancelReason) Error() string { return c.text }

// New создаёт менеджер с каталогом <localDir>/jobs и восстанавливает прошлые сеансы
// (если не SkipRestore). Каталог создаётся при первом запуске задания.
func New(localDir string, options Options) *Manager {
	m := &Manager{
		directory: filepath.Join(localDir, "jobs"),
		now:       options.Now,
		jobs:      map[string]*job{},
		listeners: map[uint64]func(Change){},
		finished:  map[uint64]func(Info, string){},
	}
	if m.now == nil {
		m.now = time.Now
	}
	if !options.SkipRestore {
		limit := options.SavedLimit
		if limit <= 0 {
			limit = SavedJobsLimit
		}
		for _, info := range loadSaved(m.directory, limit, m.timestamp()) {
			done := make(chan struct{})
			close(done)
			m.jobs[info.ID] = &job{info: info, done: done}
		}
	}
	return m
}

// timestamp — момент в формате Date.toISOString(): UTC с миллисекундами.
func (m *Manager) timestamp() string {
	return m.now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// Start регистрирует задание, сохраняет сведения и запускает шаги по очереди в отдельной
// горутине. Возвращает снимок только что созданного задания (status running).
// Ошибка — только неверные параметры или невозможность создать каталог заданий;
// тогда задание не регистрируется.
func (m *Manager) Start(spec Spec) (Info, error) {
	if spec.Title == "" || spec.Kind == "" {
		return Info{}, errors.New("у задания должны быть вид и название")
	}
	for _, step := range spec.Steps {
		if step.Tool == "" || step.Run == nil {
			return Info{}, errors.New("у шага задания должны быть Tool и Run")
		}
	}
	if err := os.MkdirAll(m.directory, 0o700); err != nil {
		return Info{}, fmt.Errorf("не удалось подготовить каталог заданий: %w", err)
	}
	steps := append([]Step(nil), spec.Steps...)
	ctx, cancel := context.WithCancelCause(context.Background())
	m.mu.Lock()
	started := m.now()
	var id string
	for {
		m.counter++
		id = strconv.FormatInt(started.UnixMilli(), 36) + "-" + strconv.Itoa(m.counter)
		if _, exists := m.jobs[id]; !exists {
			break
		}
	}
	m.sequence++
	info := Info{ID: id, Kind: spec.Kind, Title: spec.Title, Status: StatusRunning, StartedAt: started.UTC().Format("2006-01-02T15:04:05.000Z"), Steps: make([]StepInfo, len(steps))}
	if spec.Project != "" {
		project := spec.Project
		info.Project = &project
	}
	if spec.ModelDownload != nil {
		download := *spec.ModelDownload
		info.ModelDownload = &download
	}
	for index, step := range steps {
		info.Steps[index] = StepInfo{Label: step.label(), Tool: step.Tool, Status: StepPending}
	}
	j := &job{info: info, sequence: m.sequence, cancel: cancel, done: make(chan struct{})}
	m.jobs[id] = j
	saveInfo(m.directory, j.info)
	snapshot := m.snapshotLocked(j)
	m.mu.Unlock()
	m.emit(Change{ID: id, Project: info.Project, Status: StatusRunning})
	go m.run(ctx, j, steps)
	return snapshot, nil
}

// run выполняет шаги и завершает задание. Код первого сбоя обязательного шага становится
// кодом задания, его причина — error.
func (m *Manager) run(ctx context.Context, j *job, steps []Step) {
	defer j.cancel(nil)
	var failed *int
	for index, step := range steps {
		m.update(j, func() { j.info.Steps[index].Status = StepRunning })
		code, message := m.runStep(ctx, j, step)
		m.update(j, func() {
			j.info.Steps[index].Code = &code
			j.info.Steps[index].Status = StepDone
			if code != 0 {
				j.info.Steps[index].Status = StepFailed
			}
		})
		if code == 0 || step.Optional {
			continue
		}
		if failed == nil {
			failed = &code
			m.update(j, func() { j.info.Error = &message })
		}
		if !step.Continue {
			m.write(j, fmt.Sprintf("\nШаг «%s» завершился с кодом %d; задание остановлено.\n", step.label(), code))
			break
		}
		m.write(j, fmt.Sprintf("\nШаг «%s» завершился с кодом %d.\n", step.label(), code))
	}
	m.mu.Lock()
	j.info.Status = StatusDone
	code := 0
	if failed != nil {
		j.info.Status = StatusFailed
		code = *failed
	}
	finished := m.timestamp()
	j.info.Code = &code
	j.info.FinishedAt = &finished
	saveInfo(m.directory, j.info)
	if j.logFile != nil {
		j.logFile.Close()
		j.logFile = nil
	}
	final := m.snapshotLocked(j)
	listeners := make([]func(Info, string), 0, len(m.finished))
	for _, listener := range m.finished {
		listeners = append(listeners, listener)
	}
	m.mu.Unlock()
	m.emit(Change{ID: final.ID, Project: final.Project, Status: final.Status})
	project := ""
	if final.Project != nil {
		project = *final.Project
	}
	for _, listener := range listeners {
		// Каждый подписчик получает свою копию: изменения снимка не затрагивают историю и соседей.
		safely("завершение задания", func() { listener(final.clone(), project) })
	}
	close(j.done)
}

// runStep выполняет один шаг и возвращает его код и причину сбоя (для кода 0 — пусто).
// Отменённое задание: шаг не запускается, если отмена пришла раньше, а причиной любого
// сбоя становится текст отмены.
func (m *Manager) runStep(ctx context.Context, j *job, step Step) (int, string) {
	m.write(j, "\n$ "+step.label()+" "+strings.Join(step.Args, " ")+"\n")
	if ctx.Err() != nil {
		return -1, cancelText(ctx)
	}
	timeout := step.Timeout
	if timeout <= 0 {
		timeout = DefaultStepTimeout
	}
	stepCtx, cancel := context.WithTimeoutCause(ctx, timeout, &stepTimeout{timeout})
	defer cancel()
	if step.Before != nil {
		if err := protect(func() error { return step.Before(stepCtx) }); err != nil {
			if ctx.Err() != nil {
				return -1, cancelText(ctx)
			}
			m.write(j, "\nОшибка запуска: "+err.Error()+"\n")
			return -1, lastRunes(err.Error(), ErrorLimit)
		}
	}
	err := protect(func() error {
		return step.Run(stepCtx, &StepContext{manager: m, job: j, ctx: stepCtx, timeout: timeout})
	})
	if err == nil {
		return 0, ""
	}
	code := -1
	var coded interface{ ExitCode() int }
	if errors.As(err, &coded) && coded.ExitCode() != 0 {
		code = coded.ExitCode()
	}
	if ctx.Err() != nil {
		return -1, cancelText(ctx)
	}
	var message string
	var failure *StepError
	switch {
	case errors.As(err, &failure):
		// Exec уже записал вывод и служебную строку; причина — из вывода именно этого шага.
		message = failure.Message
	case isStepTimeout(stepCtx):
		message = timeoutText(timeout)
		m.write(j, "\n"+message+"\n")
	default:
		message = jsTrim(err.Error())
		m.write(j, "\nОшибка: "+message+"\n")
	}
	if message == "" {
		message = fmt.Sprintf("Шаг «%s» завершился с кодом %d.", step.label(), code)
	}
	return code, lastRunes(message, ErrorLimit)
}

// update меняет состояние под mu, сохраняет сведения и публикует изменение.
func (m *Manager) update(j *job, change func()) {
	m.mu.Lock()
	change()
	saveInfo(m.directory, j.info)
	event := Change{ID: j.info.ID, Project: cloneString(j.info.Project), Status: j.info.Status}
	m.mu.Unlock()
	m.emit(event)
}

// write дописывает текст в <id>.log и хвост в памяти. Ошибка файла журнала не останавливает
// задание: хвост в памяти и сведения остаются, причина уходит в служебный журнал.
func (m *Manager) write(j *job, text string) {
	if text == "" {
		return
	}
	m.mu.Lock()
	if j.logFile == nil {
		file, err := os.OpenFile(filepath.Join(m.directory, j.info.ID+".log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			log.Printf("Не удалось открыть журнал задания %s: %v", j.info.ID, err)
		} else {
			j.logFile = file
		}
	}
	if j.logFile != nil {
		if _, err := j.logFile.WriteString(text); err != nil {
			log.Printf("Не удалось записать журнал задания %s: %v", j.info.ID, err)
		}
	}
	j.tail = lastRunes(j.tail+text, LogTail)
	now := time.Now()
	publish := now.Sub(j.lastLog) >= logEventInterval
	if publish {
		j.lastLog = now
	}
	event := Change{ID: j.info.ID, Project: cloneString(j.info.Project), Status: j.info.Status, Log: true}
	m.mu.Unlock()
	if publish {
		m.emit(event)
	}
}

// snapshotLocked возвращает копию для вызывающего; вызывается под mu.
func (m *Manager) snapshotLocked(j *job) Info {
	info := j.info.clone()
	if !info.PreviousSession {
		info.Log = strings.ToValidUTF8(trimBrokenStart([]byte(j.tail)), "\uFFFD")
	}
	return info
}

// List возвращает задания этого и прошлых сеансов, новые сверху. У прошлых сеансов log пуст:
// тексты всех журналов в памяти не держатся. Срез никогда не nil.
func (m *Manager) List() []Info {
	m.mu.Lock()
	all := make([]*job, 0, len(m.jobs))
	for _, j := range m.jobs {
		all = append(all, j)
	}
	sort.Slice(all, func(a, b int) bool {
		if all[a].info.StartedAt != all[b].info.StartedAt {
			return all[a].info.StartedAt > all[b].info.StartedAt
		}
		if all[a].sequence != all[b].sequence {
			return all[a].sequence > all[b].sequence
		}
		return all[a].info.ID > all[b].info.ID
	})
	result := make([]Info, len(all))
	for index, j := range all {
		result[index] = m.snapshotLocked(j)
	}
	m.mu.Unlock()
	return result
}

// Get возвращает снимок задания; задание прошлого сеанса получает хвост журнала из файла
// (LogTail байт). false — задания нет.
func (m *Manager) Get(id string) (Info, bool) {
	m.mu.Lock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return Info{}, false
	}
	info := m.snapshotLocked(j)
	m.mu.Unlock()
	if info.PreviousSession {
		info.Log = readLogTail(m.LogPath(id), LogTail)
	}
	return info, true
}

// ReadLog возвращает журнал задания с диска, не больше maxBytes с конца (для копирования
// и отчёта). Неизвестное задание или отсутствующий файл — пустая строка.
func (m *Manager) ReadLog(id string, maxBytes int64) string {
	m.mu.Lock()
	_, ok := m.jobs[id]
	m.mu.Unlock()
	if !ok {
		return ""
	}
	return readLogTail(m.LogPath(id), maxBytes)
}

// LogPath — путь журнала <localDir>/jobs/<id>.log.
func (m *Manager) LogPath(id string) string {
	return filepath.Join(m.directory, id+".log")
}

// Cancel отменяет выполняющееся задание: context шагов отменяется с причиной reason
// (пусто — StoppedMessage), внешние программы завершаются вместе с потомками. Итог:
// прерванный шаг и оставшиеся шаги до первого останавливающего получают
// failed с кодом -1, задание — failed с error = reason. Завершённое задание не меняется.
// Возвращает текущий снимок (ещё running: итог приходит событием и onFinished); false — нет задания.
func (m *Manager) Cancel(id, reason string) (Info, bool) {
	if reason == "" {
		reason = StoppedMessage
	}
	m.mu.Lock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return Info{}, false
	}
	if j.info.Status == StatusRunning && j.cancel != nil {
		j.cancel(&cancelReason{reason})
	}
	info := m.snapshotLocked(j)
	m.mu.Unlock()
	return info, true
}

// Wait ждёт завершения задания и возвращает итоговый снимок; ошибка — нет задания
// или истёк ctx вызывающего (само задание при этом продолжается).
func (m *Manager) Wait(ctx context.Context, id string) (Info, error) {
	m.mu.Lock()
	j, ok := m.jobs[id]
	m.mu.Unlock()
	if !ok {
		return Info{}, ErrNotFound
	}
	select {
	case <-j.done:
	case <-ctx.Done():
		return Info{}, ctx.Err()
	}
	info, _ := m.Get(id)
	return info, nil
}

// Shutdown отменяет все выполняющиеся задания с причиной reason и ждёт их завершения
// не дольше ctx. Вызывается при штатном закрытии приложения.
func (m *Manager) Shutdown(ctx context.Context, reason string) error {
	if reason == "" {
		reason = StoppedMessage
	}
	m.mu.Lock()
	waiting := []chan struct{}{}
	for _, j := range m.jobs {
		if j.info.Status == StatusRunning && j.cancel != nil {
			j.cancel(&cancelReason{reason})
			waiting = append(waiting, j.done)
		}
	}
	m.mu.Unlock()
	for _, done := range waiting {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// Subscribe добавляет подписчика изменений (старт, смена статуса шага, журнал, завершение).
// Подписчик вызывается синхронно из горутины задания и должен быстро возвращаться
// (например, только отправлять событие Wails); паника перехватывается. Возвращает отписку.
func (m *Manager) Subscribe(listener func(Change)) func() {
	m.mu.Lock()
	m.nextID++
	id := m.nextID
	m.listeners[id] = listener
	m.mu.Unlock()
	return func() {
		m.mu.Lock()
		delete(m.listeners, id)
		m.mu.Unlock()
	}
}

// OnFinished добавляет подписчика завершения: он получает копию итогового задания и проект,
// выбранный при запуске (пусто — общее задание). Возвращает отписку.
func (m *Manager) OnFinished(listener func(job Info, project string)) func() {
	m.mu.Lock()
	m.nextID++
	id := m.nextID
	m.finished[id] = listener
	m.mu.Unlock()
	return func() {
		m.mu.Lock()
		delete(m.finished, id)
		m.mu.Unlock()
	}
}

// emit доставляет событие всем подписчикам вне mu.
func (m *Manager) emit(change Change) {
	m.mu.Lock()
	listeners := make([]func(Change), 0, len(m.listeners))
	for _, listener := range m.listeners {
		listeners = append(listeners, listener)
	}
	m.mu.Unlock()
	for _, listener := range listeners {
		safely("изменение задания", func() { listener(change) })
	}
}

// ErrNotFound — задания с таким ID нет в журнале.
var ErrNotFound = errors.New("Задание не найдено в журнале.")

// safely не даёт сбою подписчика нарушить задание и доставку остальным.
func safely(what string, call func()) {
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("Не удалось доставить %s подписчику: %v", what, recovered)
		}
	}()
	call()
}

// protect превращает панику шага в его сбой: задание завершается, а не роняет приложение.
func protect(call func() error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("внутренняя ошибка шага: %v", recovered)
		}
	}()
	return call()
}

// cancelText — причина отмены задания.
func cancelText(ctx context.Context) string {
	var reason *cancelReason
	if errors.As(context.Cause(ctx), &reason) {
		return lastRunes(reason.text, ErrorLimit)
	}
	return StoppedMessage
}

// lastRunes оставляет последние limit символов, считая кодовые точки Unicode.
func lastRunes(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	count := 0
	for index := len(text); index > 0; {
		_, size := utf8.DecodeLastRuneInString(text[:index])
		index -= size
		count++
		if count == limit {
			return text[index:]
		}
	}
	return text
}
