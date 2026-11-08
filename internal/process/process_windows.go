package process

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// stillActive — код GetExitCodeProcess для ещё работающего процесса (STILL_ACTIVE).
const stillActive = 259

// Prepare запрещает фоновым программам создавать окно консоли. GUI subsystem приложения
// на дочерние exe не распространяется: без CREATE_NO_WINDOW каждый запуск ffmpeg, ffprobe
// или агента открывал бы отдельное окно. CREATE_NEW_CONSOLE несовместим с этим и снимается,
// остальные флаги и поля SysProcAttr сохраняются; pipes и отмена продолжают работать.
func Prepare(command *exec.Cmd) {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.HideWindow = true
	command.SysProcAttr.CreationFlags &^= windows.CREATE_NEW_CONSOLE
	command.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}

// KillTree завершает процесс вместе с потомками через taskkill /T /F, как Electron-версия
// (agent-command.ts killProcessTree). taskkill находит потомков только
// через живого родителя, поэтому уже завершённый процесс не трогается (os.ErrProcessDone).
// Пока Go держит handle процесса (до Wait), его pid не может достаться другой программе.
// taskkill запускается без окна и не дольше 5 секунд; при его сбое убивается сам процесс.
func KillTree(process *os.Process) error {
	if process == nil || process.Pid <= 0 {
		return os.ErrProcessDone
	}
	if alive, known := running(process.Pid); known && !alive {
		return os.ErrProcessDone
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, taskkillPath(), "/pid", strconv.Itoa(process.Pid), "/T", "/F")
	Prepare(command)
	if err := command.Run(); err != nil {
		return process.Kill()
	}
	return nil
}

// running сообщает, работает ли процесс; known=false, если состояние узнать не удалось
// (тогда KillTree всё же пытается завершить дерево, а не оставляет потомков).
func running(pid int) (alive, known bool) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false, false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false, false
	}
	return code == stillActive, true
}

// taskkillPath берёт системный taskkill из %SystemRoot%\System32, а не из PATH или cwd.
// Без переменной окружения используется системный каталог Windows из API (надёжнее голого имени
// в оригинале); голое имя остаётся последним вариантом.
func taskkillPath() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return filepath.Join(root, "System32", "taskkill.exe")
	}
	if directory, err := windows.GetSystemDirectory(); err == nil && directory != "" {
		return filepath.Join(directory, "taskkill.exe")
	}
	return "taskkill.exe"
}

// signalName пуст: в Windows программы не завершаются POSIX-сигналами.
func signalName(*os.ProcessState) string { return "" }

// StartDetached запускает программу отдельно от приложения и сразу отпускает её. В отличие
// от Prepare окно не скрывается: так запускается установщик обновления, которому нужен его
// собственный интерфейс. Новая группа процессов не получает Ctrl+C приложения.
func StartDetached(command *exec.Cmd) error {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.CreationFlags |= windows.CREATE_NEW_PROCESS_GROUP
	command.Stdin, command.Stdout, command.Stderr = nil, nil, nil
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
