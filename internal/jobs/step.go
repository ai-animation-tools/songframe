package jobs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"songframe-go/internal/process"
)

// execCaptureLimit — хвост каждого потока внешней программы по умолчанию: причине сбоя
// нужны последние ErrorLimit символов, а полный вывод уже лежит в журнале.
const execCaptureLimit = 64 * 1024

// StepContext передаётся в Step.Run: журнал задания и запуск внешних программ.
// Методы безопасны для вызова из нескольких горутин шага.
type StepContext struct {
	manager *Manager
	job     *job
	ctx     context.Context
	timeout time.Duration
}

// JobID — ID задания, которому принадлежит шаг.
func (s *StepContext) JobID() string { return s.job.info.ID }

// Log дописывает текст в журнал задания (файл <id>.log и хвост JobInfo.log).
func (s *StepContext) Log(text string) { s.manager.write(s.job, text) }

// Write делает журнал задания io.Writer, например для вывода Go-операций.
func (s *StepContext) Write(data []byte) (int, error) {
	s.manager.write(s.job, string(data))
	return len(data), nil
}

// StepError — сбой шага с кодом и причиной для JobInfo.error. Exec возвращает его для любой
// неудачи внешней программы; Go-шаг может вернуть его сам, чтобы задать код и причину.
// Пустой Message означает «Шаг «label» завершился с кодом N.».
type StepError struct {
	Code    int
	Message string
	Err     error
}

func (e *StepError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	return fmt.Sprintf("код %d", e.Code)
}

// ExitCode — код шага для менеджера.
func (e *StepError) ExitCode() int { return e.Code }

func (e *StepError) Unwrap() error { return e.Err }

// Exec запускает внешнюю программу в context шага (отмена и таймаут шага завершают её вместе
// с потомками), передаёт весь вывод в журнал и, если задан, в command.OnOutput.
//
// Служебные строки журнала — фиксированные тексты: остановка пользователем,
// превышение времени (в мс лимита шага или command.Timeout), ошибка запуска «Ошибка запуска
// <Name>: …», посторонний сигнал. При неудаче возвращается *StepError: код выхода или -1,
// причина — stderr этого шага вместе со служебной строкой, иначе stdout (после trim).
// Без явных лимитов захватывается по execCaptureLimit байт каждого потока.
func (s *StepContext) Exec(command process.Command) (process.Result, error) {
	if s.ctx.Err() != nil {
		return process.Result{Code: -1}, &StepError{Code: -1, Message: StoppedMessage, Err: process.ErrCanceled}
	}
	name := process.DisplayName(command)
	user := command.OnOutput
	command.OnOutput = func(data []byte, stderr bool) {
		s.manager.write(s.job, string(data))
		if user != nil {
			user(data, stderr)
		}
	}
	if command.StdoutLimit == 0 && command.StderrLimit == 0 {
		command.StdoutLimit, command.StderrLimit = execCaptureLimit, execCaptureLimit
	}
	result, err := process.Run(s.ctx, command)
	if err == nil {
		return result, nil
	}
	code := -1
	line := ""
	var start *process.StartError
	var exit *process.ExitError
	switch {
	case errors.As(err, &start):
		line = "\nОшибка запуска " + name + ": " + start.Err.Error() + "\n"
	case errors.Is(err, process.ErrTimeout):
		line = "\n" + timeoutText(command.Timeout) + "\n"
	case errors.Is(err, process.ErrCanceled) && isStepTimeout(s.ctx):
		line = "\n" + timeoutText(s.timeout) + "\n"
	case errors.Is(err, process.ErrCanceled):
		line = "\n" + StoppedMessage + "\n"
	case errors.As(err, &exit):
		code = exit.Code
		if exit.Signal != "" {
			code = -1
			line = "\n" + name + " остановлен сигналом " + exit.Signal + ".\n"
		}
	default:
		line = "\n" + err.Error() + "\n"
	}
	s.manager.write(s.job, line)
	message := jsTrim(string(result.Stderr) + line)
	if message == "" {
		message = jsTrim(string(result.Stdout))
	}
	return result, &StepError{Code: code, Message: message, Err: err}
}

// stepTimeout — причина отмены context шага по его лимиту.
type stepTimeout struct{ limit time.Duration }

func (t *stepTimeout) Error() string { return timeoutText(t.limit) }

// isStepTimeout сообщает, что context шага отменён его собственным лимитом.
func isStepTimeout(ctx context.Context) bool {
	var timeout *stepTimeout
	return errors.As(context.Cause(ctx), &timeout)
}

// timeoutText — служебная строка журнала о превышении лимита шага, без переводов строк.
func timeoutText(limit time.Duration) string {
	return fmt.Sprintf("Превышено время выполнения (%d мс).", limit.Milliseconds())
}

// jsTrim повторяет String.prototype.trim: пробельные символы Unicode и BOM,
// но не U+0085, который unicode.IsSpace считает пробелом, а JS — нет.
func jsTrim(text string) string {
	return strings.TrimFunc(text, isJSSpace)
}

func isJSSpace(r rune) bool {
	return r == 0xFEFF || (r != '\u0085' && unicode.IsSpace(r))
}
