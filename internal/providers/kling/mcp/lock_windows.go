//go:build windows

package mcp

import (
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// lockFile — неблокирующий замок первого байта (LK_NBLCK) с повтором каждые 0,1 с до срока
// wait. Пустой файл получает один нулевой байт: Windows блокирует только существующие байты.
func lockFile(file *os.File, wait time.Duration) error {
	if info, err := file.Stat(); err == nil && info.Size() == 0 {
		_, _ = file.Write([]byte{0})
	}
	deadline := time.Now().Add(wait)
	for {
		overlapped := new(windows.Overlapped)
		err := windows.LockFileEx(windows.Handle(file.Fd()),
			windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// unlockFile снимает блокировку первого байта.
func unlockFile(file *os.File) {
	_ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, new(windows.Overlapped))
}
