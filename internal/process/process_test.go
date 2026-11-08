package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// helperEnv выбирает режим TestHelperProcess в дочернем экземпляре тестового бинарника.
// Так тесты не зависят от sleep/sh и одинаково собираются для Linux и Windows.
const helperEnv = "SONGFRAME_PROCESS_HELPER"

// helper возвращает команду, запускающую этот тестовый бинарник в заданном режиме.
func helper(mode string, args ...string) Command {
	return Command{
		Path: os.Args[0],
		Args: append([]string{"-test.run=^TestHelperProcess$", "--"}, args...),
		Env:  append(os.Environ(), helperEnv+"="+mode),
	}
}

// TestHelperProcess — не тест, а дочерняя программа для остальных тестов.
func TestHelperProcess(t *testing.T) {
	mode := os.Getenv(helperEnv)
	if mode == "" {
		t.Skip("только дочерний процесс")
	}
	switch mode {
	case "exit":
		fmt.Fprint(os.Stdout, "вывод")
		fmt.Fprint(os.Stderr, "причина сбоя")
		os.Exit(7)
	case "both":
		fmt.Fprint(os.Stdout, "раз")
		fmt.Fprint(os.Stderr, "два")
		os.Exit(0)
	case "noise":
		chunk := bytes.Repeat([]byte("0123456789"), 1000)
		for i := 0; i < 100; i++ {
			os.Stdout.Write(chunk)
		}
		os.Stdout.WriteString("КОНЕЦ")
		os.Exit(0)
	case "hang":
		time.Sleep(time.Minute)
		os.Exit(0)
	case "spawn":
		// Потомок без Prepare наследует группу родителя: KillTree должен убить и его.
		child := helper("hang")
		command := newCommand(child)
		if err := command.Start(); err != nil {
			fmt.Fprint(os.Stderr, err)
			os.Exit(3)
		}
		fmt.Fprintf(os.Stdout, "%d\n", command.Process.Pid)
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(2)
}

// TestRunExitCode проверяет код выхода, захват обоих потоков и тип ошибки.
func TestRunExitCode(t *testing.T) {
	command := helper("exit")
	command.StdoutLimit, command.StderrLimit = 1024, 1024
	result, err := Run(context.Background(), command)
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Code != 7 || result.Code != 7 {
		t.Fatalf("ожидался код 7: %v %+v", err, result)
	}
	if string(result.Stdout) != "вывод" || string(result.Stderr) != "причина сбоя" {
		t.Fatalf("неверный захват: %q %q", result.Stdout, result.Stderr)
	}
	if !strings.Contains(err.Error(), "кодом 7") {
		t.Fatal(err)
	}
}

// TestRunStreams проверяет потоковую передачу с признаком потока и успешный код 0.
func TestRunStreams(t *testing.T) {
	var out, errText strings.Builder
	command := helper("both")
	command.OnOutput = func(data []byte, stderr bool) {
		if stderr {
			errText.Write(data)
		} else {
			out.Write(data)
		}
	}
	result, err := Run(context.Background(), command)
	if err != nil || result.Code != 0 || out.String() != "раз" || errText.String() != "два" {
		t.Fatalf("%v %+v %q %q", err, result, out.String(), errText.String())
	}
	if result.Stdout != nil && len(result.Stdout) != 0 {
		t.Fatal("поток без лимита не должен захватываться")
	}
}

// TestRunOutputLimit проверяет, что сохраняется именно хвост и выставляется признак обрезки.
func TestRunOutputLimit(t *testing.T) {
	command := helper("noise")
	command.StdoutLimit = 100
	total := 0
	command.OnOutput = func(data []byte, _ bool) { total += len(data) }
	result, err := Run(context.Background(), command)
	if err != nil || !result.StdoutTruncated || len(result.Stdout) != 100 || !bytes.HasSuffix(result.Stdout, []byte("КОНЕЦ")) {
		t.Fatalf("%v truncated=%v len=%d tail=%q", err, result.StdoutTruncated, len(result.Stdout), result.Stdout)
	}
	if total != 1000*1000+len("КОНЕЦ") {
		t.Fatalf("OnOutput получил %d байт", total)
	}
}

// TestRunTimeout проверяет собственный таймаут команды и его отличие от отмены.
func TestRunTimeout(t *testing.T) {
	command := helper("hang")
	command.Timeout = 200 * time.Millisecond
	started := time.Now()
	result, err := Run(context.Background(), command)
	if !errors.Is(err, ErrTimeout) || errors.Is(err, ErrCanceled) || result.Code != -1 || time.Since(started) > 5*time.Second {
		t.Fatalf("%v %+v %s", err, result, time.Since(started))
	}
}

// TestRunCanceledBeforeStart не запускает программу при уже отменённом context.
func TestRunCanceledBeforeStart(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("пользователь отменил")
	cancel(cause)
	_, err := Run(ctx, helper("exit"))
	if !errors.Is(err, ErrCanceled) || !errors.Is(err, cause) {
		t.Fatal(err)
	}
}

// TestRunStartError различает невозможность запуска и ненулевой код.
func TestRunStartError(t *testing.T) {
	_, err := Run(context.Background(), Command{Path: "/нет/такой/программы"})
	var start *StartError
	if !errors.As(err, &start) {
		t.Fatal(err)
	}
}
