package process

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// newCommand собирает exec.Cmd без Prepare для помощника, порождающего потомка.
func newCommand(c Command) *exec.Cmd {
	command := exec.Command(c.Path, c.Args...)
	command.Env = c.Env
	Prepare(command)
	return command
}

// TestPreparePreservesFlags защищает прочие настройки процесса при обязательном скрытии консоли.
// CREATE_NEW_CONSOLE несовместим с этой границей и снимается, остальные флаги не теряются.
func TestPreparePreservesFlags(t *testing.T) {
	command := exec.Command("ffmpeg.exe", "-version")
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NEW_CONSOLE}
	Prepare(command)
	if !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 || command.SysProcAttr.CreationFlags&windows.CREATE_NEW_CONSOLE != 0 || command.SysProcAttr.CreationFlags&windows.CREATE_NEW_PROCESS_GROUP == 0 {
		t.Fatalf("неверные настройки фонового процесса: %+v", command.SysProcAttr)
	}
}

// TestRunNoConsole запускает настоящий console-subsystem тестовый exe через Run:
// дочерний процесс должен сохранить stdout и не иметь окна даже при console-родителе.
func TestRunNoConsole(t *testing.T) {
	command := Command{Path: os.Args[0], Args: []string{"-test.run=^TestConsoleChild$", "-test.v"}, Env: append(os.Environ(), "SONGFRAME_CONSOLE_PROBE_CHILD=1"), Timeout: 10 * time.Second, StdoutLimit: 64 * 1024}
	result, err := Run(context.Background(), command)
	if err != nil {
		t.Fatalf("console-проверка дочернего процесса: %v; stdout: %s", err, result.Stdout)
	}
}

// TestConsoleChild измеряет реальное состояние Win32, а не только заданные флаги exec.Cmd.
func TestConsoleChild(t *testing.T) {
	if os.Getenv("SONGFRAME_CONSOLE_PROBE_CHILD") != "1" {
		t.Skip("только дочерняя проверка")
	}
	window, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow").Call()
	if window != 0 {
		t.Fatalf("фоновый процесс получил окно консоли: %#x", window)
	}
}

// TestTaskkillPath проверяет, что taskkill берётся из системного каталога, а не из PATH.
func TestTaskkillPath(t *testing.T) {
	t.Setenv("SystemRoot", `C:\Windows`)
	if path := taskkillPath(); path != `C:\Windows\System32\taskkill.exe` {
		t.Fatal(path)
	}
}

// TestRunCancelKillsDescendants (Windows) проверяет taskkill /T: потомок помощника
// завершается вместе с ним. Выполняется только в нативном Windows.
func TestRunCancelKillsDescendants(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pids := make(chan int, 1)
	command := helper("spawn")
	var line []byte
	command.OnOutput = func(data []byte, stderr bool) {
		if stderr {
			return
		}
		line = append(line, data...)
		if n := len(line); n > 0 && line[n-1] == '\n' {
			var pid int
			for _, c := range line {
				if c >= '0' && c <= '9' {
					pid = pid*10 + int(c-'0')
				}
			}
			pids <- pid
		}
	}
	done := make(chan error, 1)
	go func() {
		_, err := Run(ctx, command)
		done <- err
	}()
	child := <-pids
	cancel()
	<-done
	deadline := time.Now().Add(5 * time.Second)
	for {
		alive, known := running(child)
		if known && !alive || !known {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("потомок %d пережил отмену", child)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
