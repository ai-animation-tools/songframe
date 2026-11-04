//go:build !windows

package mcp

import (
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// lockFile — fcntl.flock(LOCK_EX): ждёт освобождения без срока, как оригинал в Linux.
func lockFile(file *os.File, _ time.Duration) error {
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX)
		if err != unix.EINTR {
			return err
		}
	}
}

// unlockFile — fcntl.flock(LOCK_UN).
func unlockFile(file *os.File) { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN) }
