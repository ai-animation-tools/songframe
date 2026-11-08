//go:build linux

package filedigest

import (
	"fmt"
	"os"
	"syscall"
)

// identity — ключ кэша dev:ino:size:mtimeNs:ctimeNs.
func identity(info os.FileInfo) string {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d:%d:%d:%d", stat.Dev, stat.Ino, stat.Size,
			stat.Mtim.Sec*1e9+stat.Mtim.Nsec, stat.Ctim.Sec*1e9+stat.Ctim.Nsec)
	}
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}
