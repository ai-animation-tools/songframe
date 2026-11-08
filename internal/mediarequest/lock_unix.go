//go:build !windows

package mediarequest

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// lockFile — flock(LOCK_EX | LOCK_NB): замок всего файла .lock на открытом
// описании файла. Занятый замок (EAGAIN/EACCES/EDEADLK) — errBusy.
func lockFile(file *os.File) error {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EACCES) || errors.Is(err, unix.EDEADLK) {
		return errBusy
	}
	return err
}

// unlockFile снимает замок (закрытие файла снимает его и без этого).
func unlockFile(file *os.File) { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN) }
