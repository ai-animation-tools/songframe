//go:build !linux

package filedigest

import (
	"fmt"
	"os"
)

// identity вне Linux: размер и mtime. Windows не отдаёт inode/ctime через os.FileInfo; замена файла
// с тем же размером и временем изменения — исключительный случай для проектных медиа.
func identity(info os.FileInfo) string {
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}
