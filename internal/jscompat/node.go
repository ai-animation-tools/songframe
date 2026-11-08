package jscompat

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

// PathArg проверяет аргумент функции node:path. Нестроковое значение — ERR_INVALID_ARG_TYPE с
// текстом Node: например, его даёт join() на плане без строкового id.
func PathArg(name string, value any) (string, error) {
	if text, ok := value.(string); ok {
		return text, nil
	}
	return "", &TypeError{`The "` + name + `" argument must be of type string. Received ` + describeReceived(value)}
}

// describeReceived повторяет determineSpecificType из внутренних ошибок Node.
func describeReceived(value any) string {
	switch item := value.(type) {
	case nil:
		return "null"
	case undefinedType:
		return "undefined"
	case *Array:
		return "an instance of Array"
	case *Object:
		return "an instance of Object"
	case bool:
		return "type boolean (" + ToString(item) + ")"
	case float64:
		return "type number (" + NumberToString(item) + ")"
	}
	return "type " + TypeOf(value)
}

// IsAbs — path.isAbsolute. В Windows Node считает абсолютным и путь от корня без буквы диска.
func IsAbs(path string) bool {
	if filepath.IsAbs(path) {
		return true
	}
	return runtime.GOOS == "windows" && (strings.HasPrefix(path, `\`) || strings.HasPrefix(path, "/"))
}

// Resolve — path.resolve(base, path): абсолютный путь из рабочего каталога процесса.
func Resolve(base string, parts ...string) string {
	result := base
	for _, part := range parts {
		if IsAbs(part) {
			result = part
		} else {
			result = filepath.Join(result, part)
		}
	}
	if absolute, err := filepath.Abs(result); err == nil {
		return absolute
	}
	return filepath.Clean(result)
}

// Relative — path.relative для абсолютных путей; одинаковые пути дают пустую строку, как в Node.
func Relative(from, to string) string {
	local, err := filepath.Rel(Resolve(from), Resolve(to))
	if err != nil {
		return Resolve(to)
	}
	if local == "." {
		return ""
	}
	return local
}

// Basename — path.basename без суффикса: завершающие разделители отбрасываются, корень даёт "".
func Basename(path string) string {
	trimmed := strings.TrimRight(path, string(filepath.Separator)+"/")
	if trimmed == "" {
		return ""
	}
	if runtime.GOOS == "windows" {
		if volume := filepath.VolumeName(trimmed); volume == trimmed {
			return ""
		}
	}
	return filepath.Base(trimmed)
}

// Exists — fs.existsSync: ссылки разыменовываются, любая ошибка означает «нет».
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// errnoTexts — коды и описания libuv для ошибок, которые реально встречаются при чтении проекта.
var errnoTexts = map[syscall.Errno][2]string{
	syscall.ENOENT:  {"ENOENT", "no such file or directory"},
	syscall.ENOTDIR: {"ENOTDIR", "not a directory"},
	syscall.EISDIR:  {"EISDIR", "illegal operation on a directory"},
	syscall.EACCES:  {"EACCES", "permission denied"},
	syscall.EPERM:   {"EPERM", "operation not permitted"},
	syscall.ELOOP:   {"ELOOP", "too many symbolic links encountered"},
}

// NodeError — ошибка node:fs: у неё, в отличие от обычного Error, есть поле code. Часть
// кода различает эти два вида ошибок (`'code' in error`), например генерация обложки
// показывает вместо текста файловой ошибки общее «не удалось прочитать файл».
type NodeError struct {
	// Code — код errno Node (ENOENT, EACCES, …) или UNKNOWN.
	Code    string
	message string
}

func (e *NodeError) Error() string { return e.message }

// FsError строит сообщение ошибки node:fs вида «ENOENT: no such file or directory, lstat '<path>'».
// Пустой path опускает хвост, как у readFileSync каталога («EISDIR: …, read»). Результат —
// *NodeError с кодом ошибки.
func FsError(syscallName, path string, err error) error {
	code, text := "UNKNOWN", err.Error()
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if known, ok := errnoTexts[errno]; ok {
			code, text = known[0], known[1]
		}
	} else if errors.Is(err, fs.ErrNotExist) {
		code, text = errnoTexts[syscall.ENOENT][0], errnoTexts[syscall.ENOENT][1]
	}
	message := code + ": " + text + ", " + syscallName
	if path != "" {
		message += " '" + path + "'"
	}
	return &NodeError{Code: code, message: message}
}

// Realpath — fs.realpathSync. При ошибке сообщение повторяет JS-реализацию Node: она обходит путь
// по компонентам через lstat и сообщает первый недоступный префикс.
func Realpath(path string) (string, error) {
	absolute := Resolve(path)
	real, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return real, nil
	}
	volume := filepath.VolumeName(absolute)
	rest := strings.TrimPrefix(absolute[len(volume):], string(filepath.Separator))
	current := volume + string(filepath.Separator)
	for _, part := range strings.Split(rest, string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		if _, statErr := os.Lstat(current); statErr != nil {
			return "", FsError("lstat", current, statErr)
		}
	}
	return "", FsError("realpath", absolute, err)
}

// ReadFileCheck повторяет отказы readFileSync без чтения содержимого: каталог даёт EISDIR,
// недоступный файл — ошибку open. Нужен там, где файл хешируется ради одного факта отказа.
func ReadFileCheck(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return FsError("open", path, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err == nil && info.IsDir() {
		return FsError("read", "", syscall.EISDIR)
	}
	return nil
}

// ReadDir — fs.readdirSync(path, { withFileTypes: true }): имена в байтовом порядке (как scandir
// libuv), ссылки не считаются каталогами. Ошибка — с текстом Node для scandir.
func ReadDir(path string) ([]fs.DirEntry, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, FsError("scandir", path, err)
	}
	return entries, nil
}
