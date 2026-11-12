package process

import (
	"os/exec"
	"runtime"
	"syscall"
)

// bindToParent просит ядро убить программу SIGKILL, когда умирает приложение (prctl
// PR_SET_PDEATHSIG): при аварийном завершении (kill -9, сбой) агент не продолжает работать сиротой
// и не тратит лимит подписки. Go сам проверяет гонку «родитель умер до prctl». Сигнал получает
// только прямой потомок; его собственные потомки обычно завершаются сами по закрытым pipes.
func bindToParent(attr *syscall.SysProcAttr) {
	attr.Pdeathsig = syscall.SIGKILL
}

// spawner — запуски программ на одном навсегда закреплённом потоке ОС. Ядро посылает Pdeathsig,
// когда завершается поток-родитель, а не процесс: поток, который Go освободил бы после
// LockOSThread без Unlock, убил бы работающего агента. Этот поток живёт до выхода приложения.
var spawner = make(chan func())

func init() {
	go func() {
		runtime.LockOSThread()
		for start := range spawner {
			start()
		}
	}()
}

// start запускает подготовленную программу на потоке spawner. Запуски выполняются по одному;
// fork/exec занимает доли миллисекунды, ожидание программы идёт в вызывающей горутине.
func start(command *exec.Cmd) error {
	done := make(chan error, 1)
	spawner <- func() { done <- command.Start() }
	return <-done
}
