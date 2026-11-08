//go:build unix

package productionworkflow

import (
	"syscall"
	"testing"
)

// fixUmask — umask 002 эталона Apply: права файлов, записанных с 0666, сверяются с эталоном и
// не должны зависеть от настроек машины. umask общий для процесса,
// поэтому тесты пакета, полагающиеся на него, не выполняются параллельно.
func fixUmask(t *testing.T) {
	previous := syscall.Umask(0o002)
	t.Cleanup(func() { syscall.Umask(previous) })
}
