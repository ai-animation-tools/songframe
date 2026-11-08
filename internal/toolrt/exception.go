package toolrt

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"syscall"
)

// Типы исключений, которые встречаются в инструментах. Значение — имя типа в выводе и
// сообщениях; полное имя для трассировки даёт qualifiedNames.
const (
	ValueError         = "ValueError"
	TypeError          = "TypeError"
	KeyError           = "KeyError"
	IndexError         = "IndexError"
	AttributeError     = "AttributeError"
	OSError            = "OSError"
	FileNotFoundError  = "FileNotFoundError"
	PermissionError    = "PermissionError"
	IsADirectoryError  = "IsADirectoryError"
	NotADirectoryError = "NotADirectoryError"
	UnicodeDecodeError = "UnicodeDecodeError"
	UnicodeEncodeError = "UnicodeEncodeError"
	JSONDecodeError    = "JSONDecodeError"
	ZeroDivisionError  = "ZeroDivisionError"
	OverflowError      = "OverflowError"
	InvalidOperation   = "InvalidOperation"
	RecursionError     = "RecursionError"
)

// parents — иерархия типов исключений: проверка Is(err, ValueError) ловит и подтипы
// (JSONDecodeError, UnicodeDecodeError), Is(err, OSError) — FileNotFoundError и т.п.
var parents = map[string]string{
	ValueError:         "Exception",
	TypeError:          "Exception",
	KeyError:           "LookupError",
	IndexError:         "LookupError",
	"LookupError":      "Exception",
	AttributeError:     "Exception",
	OSError:            "Exception",
	FileNotFoundError:  OSError,
	PermissionError:    OSError,
	IsADirectoryError:  OSError,
	NotADirectoryError: OSError,
	UnicodeDecodeError: "UnicodeError",
	UnicodeEncodeError: "UnicodeError",
	"UnicodeError":     ValueError,
	JSONDecodeError:    ValueError,
	ZeroDivisionError:  "ArithmeticError",
	OverflowError:      "ArithmeticError",
	InvalidOperation:   "ArithmeticError",
	"ArithmeticError":  "Exception",
	RecursionError:     "RuntimeError",
	"RuntimeError":     "Exception",
}

// qualifiedNames — полное имя типа в последней строке трассировки для типов, которые печатаются
// с префиксом модуля.
var qualifiedNames = map[string]string{
	JSONDecodeError:  "json.decoder.JSONDecodeError",
	InvalidOperation: "decimal.InvalidOperation",
}

// Exception — исключение инструмента: тип и текст сообщения. Ошибки Go, не созданные пакетом,
// считаются исключениями без типа и не ловятся ни одной проверкой Is.
type Exception struct {
	Type    string
	Message string
}

// Error — текст сообщения без типа: его инструмент печатает в stderr перед выходом с кодом 1.
func (e *Exception) Error() string { return e.Message }

// Raise — исключение с форматированным текстом.
func Raise(kind, format string, args ...any) *Exception {
	if len(args) == 0 {
		return &Exception{Type: kind, Message: format}
	}
	return &Exception{Type: kind, Message: fmt.Sprintf(format, args...)}
}

// New — исключение с готовым текстом (без форматирования).
func New(kind, message string) *Exception { return &Exception{Type: kind, Message: message} }

// NewKeyError — KeyError для ключа key: текст сообщения — repr ключа ('start', 0).
func NewKeyError(key any) *Exception { return &Exception{Type: KeyError, Message: Repr(key)} }

// Is — относится ли err к типу kind или его подтипу; err может быть любой ошибкой Go.
func Is(err error, kind string) bool {
	var exception *Exception
	if !errors.As(err, &exception) {
		return false
	}
	for current := exception.Type; current != ""; current = parents[current] {
		if current == kind {
			return true
		}
	}
	return false
}

// IsAny — Is хотя бы для одного из типов kinds.
func IsAny(err error, kinds ...string) bool {
	for _, kind := range kinds {
		if Is(err, kind) {
			return true
		}
	}
	return false
}

// Traceback — stderr необработанного исключения: заголовок трассировки и последняя строка
// «Тип: текст» без кадров стека. Формат зафиксирован эталонами вывода инструментов; интерфейс
// показывает именно последние строки stderr. Ошибка Go без типа печатается как RuntimeError.
func Traceback(err error) string {
	var exception *Exception
	if !errors.As(err, &exception) {
		return "Traceback (most recent call last):\nRuntimeError: " + err.Error() + "\n"
	}
	name := exception.Type
	if qualified, ok := qualifiedNames[name]; ok {
		name = qualified
	}
	if exception.Message == "" {
		return "Traceback (most recent call last):\n" + name + "\n"
	}
	return "Traceback (most recent call last):\n" + name + ": " + exception.Message + "\n"
}

// strerrors — тексты strerror glibc для errno, которые встречаются при чтении проекта. У Go свои
// тексты со строчной буквы, а вывод инструментов содержит системные.
var strerrors = map[syscall.Errno]struct{ kind, text string }{
	syscall.ENOENT:  {FileNotFoundError, "No such file or directory"},
	syscall.EACCES:  {PermissionError, "Permission denied"},
	syscall.EPERM:   {PermissionError, "Operation not permitted"},
	syscall.EISDIR:  {IsADirectoryError, "Is a directory"},
	syscall.ENOTDIR: {NotADirectoryError, "Not a directory"},
	syscall.ELOOP:   {OSError, "Too many levels of symbolic links"},
	syscall.EIO:     {OSError, "Input/output error"},
	syscall.ENOSPC:  {OSError, "No space left on device"},
	syscall.EROFS:   {OSError, "Read-only file system"},
}

// OSErrorFrom — OSError для ошибки файловой операции Go над path: текст —
// «[Errno N] Текст: 'путь'», тип — подтип по errno (FileNotFoundError и т.п.); errno вне
// strerrors получает текст Go с заглавной буквы.
func OSErrorFrom(err error, path string) *Exception {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		if errors.Is(err, fs.ErrNotExist) {
			errno = syscall.ENOENT
		} else {
			return &Exception{Type: OSError, Message: err.Error()}
		}
	}
	known, ok := strerrors[errno]
	if !ok {
		text := errno.Error()
		if text != "" {
			text = strings.ToUpper(text[:1]) + text[1:]
		}
		known = struct{ kind, text string }{OSError, text}
	}
	return &Exception{Type: known.kind, Message: fmt.Sprintf("[Errno %d] %s: %s", int(errno), known.text, Repr(path))}
}
