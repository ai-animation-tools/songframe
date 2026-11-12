//go:build unix

package process

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

// Prepare делает программу лидером собственной группы процессов:
// так KillTree одним сигналом завершает и её потомков (вложенный CLI, ffmpeg, распознавание).
// В Linux программа ещё и завершается вместе с приложением (bindToParent); привязка надёжна
// только при запуске через start, поэтому Prepare вызывается из Run. Остальные поля SysProcAttr
// сохраняются.
func Prepare(command *exec.Cmd) {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.Setpgid = true
	command.SysProcAttr.Pgid = 0
	bindToParent(command.SysProcAttr)
}

// KillTree посылает SIGKILL всей группе процесса; если группы нет (процесс запущен без Prepare),
// убивает только сам процесс. Возвращает os.ErrProcessDone, если завершать уже нечего.
// Вызывать до Wait: после освобождения pid мог быть переиспользован.
func KillTree(process *os.Process) error {
	if process == nil || process.Pid <= 0 {
		return os.ErrProcessDone
	}
	if err := syscall.Kill(-process.Pid, syscall.SIGKILL); err == nil {
		return nil
	}
	return process.Kill()
}

// signalName возвращает имя постороннего сигнала (SIGSEGV и т. п.), если программа убита им.
func signalName(state *os.ProcessState) string {
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return ""
	}
	return unix.SignalName(status.Signal())
}

// StartDetached запускает программу в отдельном сеансе без потоков ввода-вывода и сразу
// отпускает её: она переживает выход приложения и не попадает под KillTree его заданий.
// Нужен помощникам, которые продолжают работу после закрытия окна (перезапуск обновления).
func StartDetached(command *exec.Cmd) error {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.Setsid = true
	command.Stdin, command.Stdout, command.Stderr = nil, nil, nil
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
