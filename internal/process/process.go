// Package process — единственный путь запуска внешних программ SongFrame (FFmpeg, ffprobe, агенты).
//
// Программа запускается без shell, с отменой через context, необязательным таймаутом,
// потоковой передачей вывода и захватом ограниченного хвоста stdout/stderr. Отмена и таймаут
// завершают программу вместе с потомками: в Linux — всю группу процессов, в Windows — дерево
// через taskkill. В Windows дочерние консольные программы не получают окна консоли.
package process

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultWaitDelay ограничивает ожидание закрытия pipes после выхода или убийства программы.
// Потомок, который отделился от группы и держит stdout, не должен навсегда задерживать Run.
const DefaultWaitDelay = time.Second

var (
	// ErrCanceled означает, что программа остановлена отменой context вызывающего.
	// Ошибка Run оборачивает и её, и причину отмены (context.Cause), поэтому errors.Is
	// срабатывает и для ErrCanceled, и для context.Canceled/DeadlineExceeded.
	ErrCanceled = errors.New("выполнение остановлено")
	// ErrTimeout означает, что истёк собственный Command.Timeout, а не deadline вызывающего.
	ErrTimeout = errors.New("превышено время выполнения")
)

// Command описывает один запуск. Нулевые поля означают поведение по умолчанию:
// наследуемое окружение, текущий каталог процесса, пустой stdin, без таймаута и без захвата.
type Command struct {
	// Path — путь к исполняемому файлу; shell и поиск через PATH-строку команды не применяются.
	// Голое имя ищется exec.LookPath, как у os/exec.
	Path string
	Args []string
	Dir  string
	// Env — полное окружение программы; nil наследует окружение приложения.
	Env   []string
	Stdin io.Reader
	// Name — понятное имя программы для сообщений журнала; по умолчанию имя файла Path.
	Name string
	// Timeout — собственный лимит запуска; 0 — без лимита (действует только context).
	Timeout time.Duration
	// StdoutLimit и StderrLimit — сколько последних байт каждого потока сохранить в Result;
	// 0 — поток не захватывается (но передаётся в OnOutput).
	StdoutLimit int
	StderrLimit int
	// OnOutput получает каждый фрагмент вывода по мере поступления. Вызовы сериализованы
	// (никогда не параллельны), фрагмент нельзя сохранять после возврата: буфер переиспользуется.
	// Фрагмент может разрезать многобайтный символ UTF-8.
	OnOutput func(data []byte, stderr bool)
	// WaitDelay — сколько ждать закрытия pipes после выхода программы; 0 — DefaultWaitDelay.
	WaitDelay time.Duration
}

// Result содержит код и захваченные хвосты вывода. Он заполняется и при ошибке:
// по нему видно, что программа успела вывести перед отменой или ненулевым кодом.
type Result struct {
	// Code — код выхода; -1, если программа не запустилась, убита сигналом или остановлена.
	Code            int
	Stdout          []byte
	Stderr          []byte
	StdoutTruncated bool
	StderrTruncated bool
}

// ExitError — программа завершилась сама с ненулевым кодом или посторонним сигналом.
// Остановку через отмену/таймаут описывают ErrCanceled/ErrTimeout, а не ExitError.
type ExitError struct {
	Code int
	// Signal — имя сигнала (например, SIGSEGV), если программа убита не приложением; иначе пусто.
	Signal string
}

func (e *ExitError) Error() string {
	if e.Signal != "" {
		return "программа остановлена сигналом " + e.Signal
	}
	return fmt.Sprintf("программа завершилась с кодом %d", e.Code)
}

// ExitCode позволяет менеджеру заданий взять код шага без знания типа ошибки.
func (e *ExitError) ExitCode() int { return e.Code }

// StartError — программу не удалось запустить (нет файла, нет прав, неверный каталог).
type StartError struct {
	Path string
	Err  error
}

func (e *StartError) Error() string {
	return fmt.Sprintf("не удалось запустить %s: %v", e.Path, e.Err)
}
func (e *StartError) Unwrap() error { return e.Err }

// timeoutCause отличает собственный таймаут команды от отмены или deadline вызывающего.
var timeoutCause = errors.New("таймаут команды")

// Run запускает программу и ждёт её завершения вместе с копированием вывода.
//
// Порядок ошибок: уже отменённый context — ErrCanceled без запуска; ошибка запуска — *StartError;
// остановка приложением — ErrCanceled или ErrTimeout (даже если программа успела выйти с кодом 0
// между сигналом и ожиданием); иначе ненулевой выход — *ExitError. Потомки убиваются только
// при отмене/таймауте: штатный выход родителя группу не трогает, как в оригинале.
func Run(ctx context.Context, c Command) (Result, error) {
	result := Result{Code: -1}
	if c.Path == "" {
		return result, &StartError{Path: c.Path, Err: errors.New("не указан исполняемый файл")}
	}
	if ctx.Err() != nil {
		return result, canceled(ctx)
	}
	runCtx, cancel := ctx, context.CancelFunc(func() {})
	if c.Timeout > 0 {
		runCtx, cancel = context.WithTimeoutCause(ctx, c.Timeout, timeoutCause)
	}
	defer cancel()

	command := exec.CommandContext(runCtx, c.Path, c.Args...)
	command.Dir = c.Dir
	command.Env = c.Env
	command.Stdin = c.Stdin
	Prepare(command)
	var killed atomic.Bool
	// Cancel вызывается os/exec только пока Wait не вернулся: процесс ещё не освобождён,
	// поэтому его pid (и в Windows — handle) принадлежат именно этой программе.
	command.Cancel = func() error {
		err := KillTree(command.Process)
		if err == nil {
			killed.Store(true)
		}
		return err
	}
	command.WaitDelay = c.WaitDelay
	if command.WaitDelay <= 0 {
		command.WaitDelay = DefaultWaitDelay
	}
	var mu sync.Mutex
	stdout := &stream{mu: &mu, limit: c.StdoutLimit, on: c.OnOutput}
	stderr := &stream{mu: &mu, limit: c.StderrLimit, on: c.OnOutput, stderr: true}
	command.Stdout = stdout
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		if ctx.Err() != nil {
			return result, canceled(ctx)
		}
		return result, &StartError{Path: c.Path, Err: err}
	}
	err := command.Wait()
	result.Stdout, result.StdoutTruncated = stdout.tail()
	result.Stderr, result.StderrTruncated = stderr.tail()
	if command.ProcessState != nil {
		result.Code = command.ProcessState.ExitCode()
	}
	if killed.Load() || (runCtx.Err() != nil && (command.ProcessState == nil || !command.ProcessState.Success())) {
		result.Code = -1
		if ctx.Err() == nil && errors.Is(context.Cause(runCtx), timeoutCause) {
			return result, fmt.Errorf("%w (%s)", ErrTimeout, c.Timeout)
		}
		return result, canceled(ctx)
	}
	if command.ProcessState != nil && !command.ProcessState.Success() {
		return result, &ExitError{Code: result.Code, Signal: signalName(command.ProcessState)}
	}
	if err != nil {
		// Программа вышла с кодом 0, но вывод не закрылся за WaitDelay или копирование не удалось:
		// результат может быть неполным, поэтому успехом он не считается.
		return result, fmt.Errorf("вывод %s не завершился: %w", displayName(c), err)
	}
	return result, nil
}

// canceled оборачивает ErrCanceled причиной отмены вызывающего.
func canceled(ctx context.Context) error {
	return fmt.Errorf("%w: %w", ErrCanceled, context.Cause(ctx))
}

// displayName возвращает Name или имя файла программы для сообщений.
func displayName(c Command) string {
	if c.Name != "" {
		return c.Name
	}
	return filepath.Base(c.Path)
}

// DisplayName — то же имя для внешних сообщений журнала (например, «Ошибка запуска FFmpeg»).
func DisplayName(c Command) string { return displayName(c) }

// stream передаёт вывод в OnOutput и хранит хвост не больше limit байт.
// Общий mu сериализует оба потока: OnOutput никогда не вызывается параллельно.
// Память ограничена примерно 2*limit: буфер сжимается, когда вдвое превышает лимит.
type stream struct {
	mu        *sync.Mutex
	limit     int
	on        func([]byte, bool)
	stderr    bool
	data      []byte
	truncated bool
}

func (s *stream) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.on != nil {
		s.on(p, s.stderr)
	}
	if s.limit > 0 {
		s.data = append(s.data, p...)
		if len(s.data) > s.limit {
			s.truncated = true
			if len(s.data) >= 2*s.limit {
				s.data = append(s.data[:0], s.data[len(s.data)-s.limit:]...)
			}
		}
	}
	return len(p), nil
}

// tail вызывается после Wait, когда копирование завершено.
func (s *stream) tail() ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := s.data
	if len(data) > s.limit {
		data = data[len(data)-s.limit:]
	}
	return append([]byte(nil), data...), s.truncated
}
