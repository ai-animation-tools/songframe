package agents

import (
	"bytes"
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/process"
)

// ProcessOptions — окружение короткой служебной сессии CLI (аккаунт, лимиты, каталог моделей):
// уже дополненный PATH, домашний каталог как рабочая папка, тайм-аут (0 — 10 секунд) и платформа
// для разворачивания обёрток npm.
type ProcessOptions struct {
	Env      []string
	Home     string
	Timeout  time.Duration
	Platform string
}

// accountOutputLimit — суммарный предел stdout и stderr служебной сессии (128 КиБ).
const accountOutputLimit = 128 * 1024

// closeGrace — сколько ждать самостоятельного выхода CLI после EOF stdin, прежде чем завершить
// его дерево. Даже CLI, который игнорирует EOF и SIGTERM, не остаётся фоновым сервером.
const closeGrace = 150 * time.Millisecond

var (
	errSessionFailed = errors.New(textDiagnosticsFailed)
	errSessionClosed = errors.New(textSessionClosed)
)

// serviceSession — двусторонняя связь со служебным процессом CLI через internal/process: запросы
// пишутся строками JSON в stdin, ответы читаются построчно из stdout. Очередь строк не ограничивает
// поток вывода (обработчик process не блокируется), а общий предел вывода и тайм-аут переводят
// сессию в сбой. Методы безопасны для одного читателя и одного писателя.
type serviceSession struct {
	stdin  *os.File
	mu     sync.Mutex
	notify chan struct{}
	lines  [][]byte
	buffer []byte
	bytes  int
	failed error
	closed bool
	code   *int
}

// signal будит ожидающего next/wait; канал на один элемент не теряет пробуждение.
func (s *serviceSession) signal() {
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

// output — обработчик фрагментов вывода process.Run: считает объём и режет stdout на строки.
func (s *serviceSession) output(data []byte, stderr bool, fail func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bytes += len(data)
	if s.bytes > accountOutputLimit && s.failed == nil {
		s.failed = errSessionFailed
		fail()
	}
	if !stderr && s.failed == nil {
		s.buffer = append(s.buffer, data...)
		for {
			end := bytes.IndexByte(s.buffer, '\n')
			if end < 0 {
				break
			}
			s.lines = append(s.lines, append([]byte(nil), s.buffer[:end]...))
			s.buffer = s.buffer[end+1:]
		}
	}
	s.signal()
}

// next возвращает следующую строку stdout. Уже полученные строки отдаются раньше признака
// закрытия: CLI мог ответить и сразу выйти. Сбой (тайм-аут, вывод) — errSessionFailed.
func (s *serviceSession) next(ctx context.Context) ([]byte, error) {
	for {
		s.mu.Lock()
		switch {
		case s.failed != nil:
			s.mu.Unlock()
			return nil, s.failed
		case len(s.lines) > 0:
			line := s.lines[0]
			s.lines = s.lines[1:]
			s.mu.Unlock()
			return line, nil
		case s.closed:
			s.mu.Unlock()
			return nil, errSessionClosed
		}
		s.mu.Unlock()
		select {
		case <-s.notify:
		case <-ctx.Done():
			return nil, errSessionFailed
		}
	}
}

// send пишет строку запроса в stdin; ошибка записи (CLI уже вышел) — сбой сессии.
func (s *serviceSession) send(line []byte) error {
	if _, err := s.stdin.Write(append(line, '\n')); err != nil {
		return errSessionFailed
	}
	return nil
}

// wait ждёт выхода программы и возвращает её код (nil — убита или не запущена).
func (s *serviceSession) wait(ctx context.Context) (*int, error) {
	for {
		s.mu.Lock()
		if s.failed != nil {
			s.mu.Unlock()
			return nil, s.failed
		}
		if s.closed {
			code := s.code
			s.mu.Unlock()
			return code, nil
		}
		s.mu.Unlock()
		select {
		case <-s.notify:
		case <-ctx.Done():
			return nil, errSessionFailed
		}
	}
}

// withServiceProcess запускает служебную команду CLI и выполняет operation над её сессией.
//
// Ограничения как у withAccountProcess оригинала: тайм-аут всей сессии, 128 КиБ вывода, без shell,
// в домашнем каталоге. После operation stdin закрывается (EOF); если программа не вышла за
// closeGrace, её дерево завершается. Функция возвращается только после фактического выхода
// процесса, поэтому служебный CLI не переживает диагностику.
func withServiceProcess[T any](ctx context.Context, executable string, args []string, options ProcessOptions, operation func(ctx context.Context, s *serviceSession) (T, error)) (T, error) {
	var zero T
	if options.Timeout <= 0 {
		options.Timeout = 10 * time.Second
	}
	if options.Platform == "" {
		options.Platform = hostPlatform()
	}
	command := AgentCommand(executable, args, options.Env, options.Platform)
	sessionCtx, cancelSession := context.WithTimeout(ctx, options.Timeout)
	defer cancelSession()
	runCtx, kill := context.WithCancel(context.Background())
	defer kill()
	// Настоящий pipe ОС, а не io.Pipe: os/exec передаёт его программе без копирующей горутины,
	// поэтому выход CLI сразу виден Run, даже пока приложение держит stdin открытым.
	reader, writer, err := os.Pipe()
	if err != nil {
		return zero, errSessionFailed
	}
	session := &serviceSession{stdin: writer, notify: make(chan struct{}, 1)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		result, err := process.Run(runCtx, process.Command{
			Path: command.File, Args: command.Args, Dir: options.Home, Env: options.Env, Stdin: reader,
			OnOutput: func(data []byte, stderr bool) { session.output(data, stderr, kill) },
		})
		// Копия читающего конца у приложения закрывается: запись после выхода CLI получит ошибку.
		_ = reader.Close()
		session.mu.Lock()
		session.closed = true
		var start *process.StartError
		if errors.As(err, &start) && session.failed == nil {
			session.failed = errSessionFailed
		}
		if err == nil || result.Code >= 0 {
			code := result.Code
			session.code = &code
		}
		session.mu.Unlock()
		session.signal()
	}()
	// Тайм-аут сессии переводит её в сбой: ожидающий next/wait получает errSessionFailed.
	stop := context.AfterFunc(sessionCtx, func() {
		session.mu.Lock()
		if session.failed == nil && !session.closed {
			session.failed = errSessionFailed
		}
		session.mu.Unlock()
		session.signal()
	})
	defer stop()
	value, err := operation(sessionCtx, session)
	_ = writer.Close()
	select {
	case <-done:
	case <-time.After(closeGrace):
		kill()
		<-done
	}
	if err != nil {
		return zero, err
	}
	return value, nil
}

// readAccountCommand — короткая команда диагностики с JSON-ответом (claude auth status --json):
// ненулевой код или не-JSON — ошибка, которую вызывающий заменяет сообщением о частичных данных.
func readAccountCommand(ctx context.Context, executable string, args []string, options ProcessOptions) (any, error) {
	return withServiceProcess(ctx, executable, args, options, func(ctx context.Context, s *serviceSession) (any, error) {
		_ = s.stdin.Close()
		code, err := s.wait(ctx)
		if err != nil {
			return nil, err
		}
		if code == nil || *code != 0 {
			return nil, errors.New("Команда диагностики завершилась с ошибкой.")
		}
		s.mu.Lock()
		output := append([]byte(nil), bytes.Join(s.lines, []byte("\n"))...)
		if len(s.lines) > 0 {
			output = append(output, '\n')
		}
		output = append(output, s.buffer...)
		s.mu.Unlock()
		return jscompat.Parse([]byte(jscompat.DecodeUTF8(output)))
	})
}
