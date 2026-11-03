//go:build !windows

package components

import "os/exec"

// configureMediaProcess оставляет запуск на Unix прежним: отдельной Windows-консоли здесь нет.
// Общий mediaRunner сохраняет одинаковые pipes, ограничения вывода и отмену на обеих платформах.
func configureMediaProcess(command *exec.Cmd) {}
