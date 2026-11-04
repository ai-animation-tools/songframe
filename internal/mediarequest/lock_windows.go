package mediarequest

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// lockFile — msvcrt.locking(LK_NBLCK, 1) оригинала: Windows блокирует один существующий байт с
// неизменным смещением, поэтому в пустой .lock сначала пишется «\0» (тот же файл, что у Python).
// Неблокирующий захват сохраняет отказ повторной отправки вместо ожидания.
func lockFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		if _, err := file.Write([]byte{0}); err != nil {
			return err
		}
	}
	overlapped := new(windows.Overlapped)
	err = windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return errBusy
	}
	return err
}

// unlockFile снимает замок байта.
func unlockFile(file *os.File) {
	_ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, new(windows.Overlapped))
}
