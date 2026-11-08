package components

import (
	"context"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

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
