package components

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// configureMediaProcess не позволяет фоновым ffmpeg/ffprobe создавать окна консоли.
// GUI subsystem родителя на дочерние exe не распространяется: без CREATE_NO_WINDOW
// каждая функциональная проверка на Windows открывает отдельное окно. Pipes и отмена сохраняются.
func configureMediaProcess(command *exec.Cmd) {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.HideWindow = true
	command.SysProcAttr.CreationFlags &^= windows.CREATE_NEW_CONSOLE
	command.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
