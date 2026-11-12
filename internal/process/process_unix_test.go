//go:build unix

package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// newCommand собирает exec.Cmd без Prepare: потомок остаётся в группе родителя-помощника.
func newCommand(c Command) *exec.Cmd {
	command := exec.Command(c.Path, c.Args...)
	command.Env = c.Env
	return command
}

// processGone считает завершённым и зомби: его может не успеть забрать новый родитель.
func processGone(pid int) bool {
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return true
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return os.IsNotExist(err)
	}
	fields := strings.Fields(string(data[strings.LastIndexByte(string(data), ')')+1:]))
	return len(fields) > 0 && fields[0] == "Z"
}

// TestRunCancelKillsDescendants проверяет главное свойство отмены: потомок программы
// тоже завершается, а не остаётся работать после отменённого задания.
func TestRunCancelKillsDescendants(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	pids := make(chan int, 1)
	command := helper("spawn")
	var line strings.Builder
	command.OnOutput = func(data []byte, stderr bool) {
		if stderr {
			return
		}
		line.Write(data)
		if text := line.String(); strings.HasSuffix(text, "\n") {
			if pid, err := strconv.Atoi(strings.TrimSpace(text)); err == nil {
				pids <- pid
			}
		}
	}
	done := make(chan error, 1)
	go func() {
		_, err := Run(ctx, command)
		done <- err
	}()
	var child int
	select {
	case child = <-pids:
	case <-time.After(10 * time.Second):
		t.Fatal("помощник не сообщил pid потомка")
	}
	if processGone(child) {
		t.Fatal("потомок завершился до отмены")
	}
	reason := errors.New("отмена теста")
	cancel(reason)
	select {
	case err := <-done:
		if !errors.Is(err, ErrCanceled) || !errors.Is(err, reason) {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run не завершился после отмены")
	}
	deadline := time.Now().Add(3 * time.Second)
	for !processGone(child) {
		if time.Now().After(deadline) {
			syscall.Kill(child, syscall.SIGKILL)
			t.Fatalf("потомок %d пережил отмену", child)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestRunForeignSignal отличает посторонний сигнал от остановки приложением:
// Run возвращает ExitError с именем сигнала, а не ErrCanceled.
func TestRunForeignSignal(t *testing.T) {
	command := helper("spawn")
	pids := make(chan int, 1)
	var line strings.Builder
	command.OnOutput = func(data []byte, stderr bool) {
		if !stderr {
			line.Write(data)
			if text := line.String(); strings.HasSuffix(text, "\n") {
				pid, _ := strconv.Atoi(strings.TrimSpace(text))
				pids <- pid
			}
		}
	}
	done := make(chan error, 1)
	var result Result
	go func() {
		var err error
		result, err = Run(context.Background(), command)
		done <- err
	}()
	child := <-pids
	// Родитель помощника — лидер группы; узнаём его pid через группу потомка.
	group, err := syscall.Getpgid(child)
	if err != nil {
		t.Fatal(err)
	}
	syscall.Kill(child, syscall.SIGKILL)
	syscall.Kill(group, syscall.SIGTERM)
	err = <-done
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Signal != "SIGTERM" || result.Code != -1 || errors.Is(err, ErrCanceled) {
		t.Fatalf("%v %+v", err, result)
	}
}

// childGone — программа завершилась (или стала зомби) для теста сироты.
func childGone(pid int) bool { return processGone(pid) }

// killPid убирает программу, если тест сироты не прошёл.
func killPid(pid int) { syscall.Kill(pid, syscall.SIGKILL) }
