package dynvalue

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"songframe/internal/project"
)

// PathArg проверяет, что аргумент name операции над путём — строка. Нестроковое значение —
// TypeError «путь должен быть строкой» (для аргумента с другим именем — «путь name должен быть
// строкой»): например, его даёт соединение пути на плане без строкового id.
func PathArg(name string, value any) (string, error) {
	if text, ok := value.(string); ok {
		return text, nil
	}
	if name == "path" {
		return "", &TypeError{"путь должен быть строкой"}
	}
	return "", &TypeError{"путь " + name + " должен быть строкой"}
}

// IsAbs — путь абсолютный. В Windows абсолютным считается и путь от корня без буквы диска.
func IsAbs(path string) bool {
	if filepath.IsAbs(path) {
		return true
	}
	return runtime.GOOS == "windows" && (strings.HasPrefix(path, `\`) || strings.HasPrefix(path, "/"))
}

// Resolve — абсолютный путь: части справа налево до первой абсолютной (она заменяет
// накопленное), относительный результат — от рабочего каталога процесса.
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

// Relative — путь to относительно from после Resolve; одинаковые пути дают пустую строку.
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

// Basename — последний компонент пути: завершающие разделители отбрасываются, корень даёт "".
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

// Exists — путь существует: ссылки разыменовываются, любая ошибка означает «нет».
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// errnoTexts — коды и русские описания errno файловых ошибок, которые реально встречаются при
// работе с проектом. Код — признак для логики (FileError.Code), описание — текст сообщения.
var errnoTexts = map[syscall.Errno][2]string{
	syscall.ENOENT:    {"ENOENT", "нет такого файла или каталога"},
	syscall.ENOTDIR:   {"ENOTDIR", "не каталог"},
	syscall.EISDIR:    {"EISDIR", "это каталог"},
	syscall.EACCES:    {"EACCES", "нет доступа"},
	syscall.EPERM:     {"EPERM", "операция запрещена"},
	syscall.ELOOP:     {"ELOOP", "слишком много уровней символических ссылок"},
	syscall.EEXIST:    {"EEXIST", "файл уже существует"},
	syscall.ENOTEMPTY: {"ENOTEMPTY", "каталог не пуст"},
}

// FileError — файловая ошибка с кодом errno. Часть кода отличает её от прочих ошибок, например
// генерация обложки показывает вместо текста файловой ошибки общее «не удалось прочитать файл».
type FileError struct {
	// Code — код errno (ENOENT, EACCES, …) или UNKNOWN.
	Code    string
	message string
}

func (e *FileError) Error() string { return e.message }

// FsError строит файловую ошибку. Для пути в папке проекта текст даёт project.FileProblem: путь
// от папки проекта и подсказка, что сделать. Иначе (путь вне проекта, служебный сбой) — технический
// текст «нет такого файла или каталога: '<path>'»: описание по errno и путь. Имя системной операции syscallName в текст не входит (оно говорит о способе
// чтения, а не о причине); пустой path опускает хвост (чтение каталога даёт «это каталог»).
// Результат — *FileError с кодом ошибки; код вне errnoTexts — UNKNOWN с описанием «ошибка
// файловой системы».
func FsError(syscallName, path string, err error) error {
	code, text := "UNKNOWN", "ошибка файловой системы"
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if known, ok := errnoTexts[errno]; ok {
			code, text = known[0], known[1]
		}
	} else if errors.Is(err, fs.ErrNotExist) {
		errno = syscall.ENOENT
		code, text = errnoTexts[errno][0], errnoTexts[errno][1]
	}
	if problem, ok := project.FileProblem(errno, path); ok {
		return &FileError{Code: code, message: problem}
	}
	message := text
	if path != "" {
		message += ": '" + path + "'"
	}
	return &FileError{Code: code, message: message}
}

// Realpath — абсолютный путь с разыменованными ссылками. При ошибке путь обходится по компонентам
// через lstat, и ошибка называет первый недоступный префикс; если все префиксы доступны —
// ошибку realpath для всего пути.
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

// ReadFileCheck проверяет, что файл читается, не читая содержимого: каталог даёт EISDIR (read),
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

// ReadDir — записи каталога в байтовом порядке имён; ссылки не считаются каталогами. Ошибка —
// FsError операции scandir.
func ReadDir(path string) ([]fs.DirEntry, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, FsError("scandir", path, err)
	}
	return entries, nil
}
