//go:build unix && !linux

package process

import (
	"os/exec"
	"syscall"
)

// bindToParent: в Unix без PR_SET_PDEATHSIG привязки к жизни приложения нет; отмену и таймаут
// по-прежнему обеспечивает группа процессов (KillTree).
func bindToParent(*syscall.SysProcAttr) {}

// start запускает программу обычным образом.
func start(command *exec.Cmd) error { return command.Start() }
