//go:build !windows

package components

import "golang.org/x/sys/unix"

// availableSpace учитывает доступные текущему пользователю блоки, а не резерв файловой системы.
func availableSpace(directory string) (uint64, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(directory, &stat); err != nil {
		return 0, err
	}
	return stat.Bavail * uint64(stat.Bsize), nil
}
