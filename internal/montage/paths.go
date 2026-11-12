package montage

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/dynvalue"
)

// Шаблоны: UUID черновика (без учёта регистра), SHA-256 снимка и код сцены.
var (
	uuidPattern   = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	sha256Pattern = regexp.MustCompile(`^(?i)[0-9a-f]{64}$`)
	shotPattern   = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)
)

// secondsToFrames — та же формула, что secondsToFrames в frontend/src/shared/video.ts: округление
// до ближайшего кадра частоты проекта fps с запасом на погрешность двоичной дроби (4 эпсилона
// масштаба).
func secondsToFrames(seconds, fps float64) float64 {
	scaled := seconds * fps
	return math.Floor(scaled + 0.5 + 2.220446049250313e-16*math.Max(1, math.Abs(scaled))*4)
}

// isObject сообщает, что значение — объект JSON, а не массив и не null.
func isObject(value any) bool {
	_, ok := dynvalue.AsObject(value)
	return ok
}

// isFrame сообщает, что значение — номер кадра: неотрицательное безопасное целое.
func isFrame(value any) bool {
	number, ok := value.(float64)
	return ok && dynvalue.IsSafeInteger(value) && number >= 0
}

// number — значение как число; для не-числа ok=false.
func number(value any) (float64, bool) {
	result, ok := value.(float64)
	return result, ok
}

// fileHash — SHA-256 содержимого файла (hex); ошибка чтения — ReadError.
func fileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ReadError(path, err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// ReadError — текст ошибки чтения файла (dynvalue.FsError): каталог даёт EISDIR без пути,
// остальное — «open '<путь>'».
func ReadError(path string, err error) error {
	if info, statErr := os.Stat(path); statErr == nil && info.IsDir() {
		return dynvalue.FsError("read", "", err)
	}
	return dynvalue.FsError("open", path, err)
}

// win32Absolute сообщает, что путь абсолютен по правилам Windows: от корня («/», «\») или с буквой
// диска и разделителем.
func win32Absolute(value string) bool {
	if value == "" {
		return false
	}
	if value[0] == '/' || value[0] == '\\' {
		return true
	}
	letter := value[0] | 0x20
	return len(value) > 2 && letter >= 'a' && letter <= 'z' && value[1] == ':' && (value[2] == '/' || value[2] == '\\')
}

// projectPath проверяет переносимый путь от корня проекта через «/»
// без пустых компонентов, «.» и «..»; оба вида абсолютных путей отклоняются на любой ОС. С
// requireFile путь обязан указывать на существующий обычный файл. Возвращает абсолютный путь.
func projectPath(project string, value any, requireFile bool) (string, error) {
	text, ok := value.(string)
	if !ok || text == "" || strings.Contains(text, `\`) || dynvalue.IsAbs(text) || strings.HasPrefix(text, "/") || win32Absolute(text) {
		return "", errors.New(textRelativePathRequired)
	}
	for _, part := range strings.Split(text, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New(textInvalidProjectPath(text))
		}
	}
	full := dynvalue.Resolve(project, filepath.FromSlash(text))
	if requireFile {
		if info, err := os.Stat(full); err != nil || !info.Mode().IsRegular() {
			return "", errors.New(textProjectFileMissing(text))
		}
	}
	return full, nil
}

// portable — путь от корня проекта с «/» вместо «\».
func portable(project, path string) string {
	return strings.ReplaceAll(filepath.ToSlash(dynvalue.Relative(project, path)), `\`, "/")
}

// join склеивает base и name с нормализацией; абсолютное name не сбрасывает base.
func join(base, name string) string { return filepath.Join(base, filepath.FromSlash(name)) }

// readObject читает JSON-объект файла или возвращает ошибку textReadFailed с подписью. Отсутствие,
// повреждение, массив и примитив файла дают одну и ту же ошибку; файл не меняется.
func readObject(path, label string) (*dynvalue.Object, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		if value, parseErr := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data))); parseErr == nil {
			if object, ok := dynvalue.AsObject(value); ok {
				return object, nil
			}
		}
	}
	return nil, errors.New(textReadFailed(label))
}

// RandomUUID — случайный UUID версии 4 строчными буквами: имена черновиков и папок проб.
var RandomUUID = func() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

// isoTime — время изменения файла в ISO 8601: UTC с миллисекундами и суффиксом Z.
func isoTime(info os.FileInfo) string {
	return info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z")
}

// encode — формат JSON-файлов монтажа: отступ в два пробела, порядок ключей значения
// (dynvalue.StringifyIndent) и перевод строки в конце.
func encode(value any) []byte { return []byte(dynvalue.StringifyIndent(value, "  ") + "\n") }
