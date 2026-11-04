//go:build unix

package agents

import "golang.org/x/sys/unix"

// canExecute — access(path, X_OK) от имени текущего пользователя, как fs.access оригинала.
func canExecute(path string) bool { return unix.Access(path, unix.X_OK) == nil }
