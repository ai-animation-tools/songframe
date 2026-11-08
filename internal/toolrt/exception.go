package toolrt

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"syscall"
)

// Типы исключений, которые встречаются в инструментах. Тип — внутренний признак для перехвата
// (Is) и выбора ветки обработки; в вывод инструмента он не попадает: необработанная ошибка
// печатается только своим текстом (Unhandled).
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

// NewKeyError — KeyError для ключа key: текст «нет ключа 'start'» с repr ключа.
func NewKeyError(key any) *Exception {
	return &Exception{Type: KeyError, Message: "нет ключа " + Repr(key)}
}

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

// unhandledPrefix — начало stderr необработанной ошибки инструмента (Unhandled).
const unhandledPrefix = "Ошибка: "

// Unhandled — stderr необработанной ошибки: одна строка «Ошибка: текст» без типа исключения и
// кадров стека. Формат зафиксирован эталонами вывода инструментов; интерфейс показывает именно
// последние строки stderr. Проваленная внутренняя проверка (AssertionError) получает общий текст
// «внутренняя проверка не прошла» и свой текст после двоеточия, исключение без текста —
// «внутренняя ошибка инструмента»; ошибка Go без типа печатается своим текстом.
func Unhandled(err error) string {
	var exception *Exception
	if !errors.As(err, &exception) {
		return unhandledPrefix + err.Error() + "\n"
	}
	message := exception.Message
	switch {
	case exception.Type == "AssertionError" && message == "":
		message = "внутренняя проверка не прошла"
	case exception.Type == "AssertionError":
		message = "внутренняя проверка не прошла: " + message
	case message == "":
		message = "внутренняя ошибка инструмента"
	}
	return unhandledPrefix + message + "\n"
}

// IsUnhandled — stderr инструмента выведен Unhandled (начинается с «Ошибка: »). По этому
// признаку тесты отличают необработанную ошибку от ожидаемого отказа с собственным текстом.
func IsUnhandled(stderr string) bool { return strings.HasPrefix(stderr, unhandledPrefix) }

// strerrors — тип исключения и русский текст для errno, которые встречаются при работе с
// файлами проекта. Тип выбирает ветку обработки (Is), текст попадает в сообщение.
var strerrors = map[syscall.Errno]struct{ kind, text string }{
	syscall.ENOENT:    {FileNotFoundError, "нет такого файла или каталога"},
	syscall.EACCES:    {PermissionError, "нет доступа"},
	syscall.EPERM:     {PermissionError, "операция запрещена"},
	syscall.EISDIR:    {IsADirectoryError, "это каталог"},
	syscall.ENOTDIR:   {NotADirectoryError, "не каталог"},
	syscall.ELOOP:     {OSError, "слишком много уровней символических ссылок"},
	syscall.EIO:       {OSError, "ошибка ввода-вывода"},
	syscall.ENOSPC:    {OSError, "нет места на устройстве"},
	syscall.EROFS:     {OSError, "файловая система только для чтения"},
	syscall.EEXIST:    {OSError, "файл уже существует"},
	syscall.ENOTEMPTY: {OSError, "каталог не пуст"},
}

// OSErrorFrom — OSError для ошибки файловой операции Go над path: текст — «описание: 'путь'»,
// тип — подтип по errno (FileNotFoundError и т.п.); errno вне strerrors получает описание
// «ошибка файловой системы (код N)», ошибка без errno — «ошибка файловой системы: текст Go».
func OSErrorFrom(err error, path string) *Exception {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		if errors.Is(err, fs.ErrNotExist) {
			errno = syscall.ENOENT
		} else {
			return &Exception{Type: OSError, Message: "ошибка файловой системы: " + err.Error()}
		}
	}
	known, ok := strerrors[errno]
	if !ok {
		known = struct{ kind, text string }{OSError, fmt.Sprintf("ошибка файловой системы (код %d)", int(errno))}
	}
	return &Exception{Type: known.kind, Message: known.text + ": " + Repr(path)}
}
