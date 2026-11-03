package components

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// TestMediaProcessPreservesFlags защищает прочие настройки процесса при обязательном скрытии консоли.
// CREATE_NEW_CONSOLE несовместим с этой границей и снимается, остальные флаги не теряются.
func TestMediaProcessPreservesFlags(t *testing.T) {
	command := exec.Command("ffmpeg.exe", "-version")
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NEW_CONSOLE}
	configureMediaProcess(command)
	if !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 || command.SysProcAttr.CreationFlags&windows.CREATE_NEW_CONSOLE != 0 || command.SysProcAttr.CreationFlags&windows.CREATE_NEW_PROCESS_GROUP == 0 {
		t.Fatalf("неверные настройки фонового процесса: %+v", command.SysProcAttr)
	}
}

// TestMediaProcessNoConsole запускает настоящий console-subsystem тестовый exe через production mediaRunner.
// Проверка не требует FFmpeg; дочерний процесс должен сохранить stdout и не иметь окна даже при console-родителе.
func TestMediaProcessNoConsole(t *testing.T) {
	t.Setenv("SONGFRAME_CONSOLE_PROBE_CHILD", "1")
	runner := mediaRunner{ctx: context.Background(), timeout: 10 * time.Second}
	output, err := runner.run(os.Args[0], "-test.run=^TestMediaConsoleChild$", "-test.v")
	if err != nil {
		t.Fatalf("console-проверка дочернего процесса: %v; stdout: %s", err, output)
	}
}

// TestMediaConsoleChild измеряет реальное состояние Win32, а не только заданные флаги exec.Cmd.
// Он выполняется адресно в дочернем console exe; обычный запуск набора его пропускает.
func TestMediaConsoleChild(t *testing.T) {
	if os.Getenv("SONGFRAME_CONSOLE_PROBE_CHILD") != "1" {
		t.Skip("только дочерняя проверка")
	}
	window, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow").Call()
	if window != 0 {
		t.Fatalf("фоновый медиапроцесс получил окно консоли: %#x", window)
	}
}
