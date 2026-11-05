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

	"songframe-go/internal/jscompat"
)

// Шаблоны оригинала: UUID черновика (без учёта регистра), SHA-256 снимка и код сцены.
var (
	uuidPattern   = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	sha256Pattern = regexp.MustCompile(`^(?i)[0-9a-f]{64}$`)
	shotPattern   = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)
)

// fps — шкала монтажа (FPS из shared/video).
const fps = 30

// secondsToFrames — secondsToFrames(seconds) shared/video: округление до ближайшего кадра 30 к/с
// с запасом на погрешность двоичной дроби (4 эпсилона масштаба).
func secondsToFrames(seconds float64) float64 {
	scaled := seconds * fps
	return math.Floor(scaled + 0.5 + 2.220446049250313e-16*math.Max(1, math.Abs(scaled))*4)
}

// isObject — object(value): объект JSON, не массив и не null.
func isObject(value any) bool {
	_, ok := jscompat.AsObject(value)
	return ok
}

// isFrame — frame(value): неотрицательное безопасное целое.
func isFrame(value any) bool {
	number, ok := value.(float64)
	return ok && jscompat.IsSafeInteger(value) && number >= 0
}

// number — значение как число; для не-числа ok=false.
func number(value any) (float64, bool) {
	result, ok := value.(float64)
	return result, ok
}

// fileHash — hash(path): SHA-256 содержимого; ошибка чтения — текст node:fs.
func fileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", readError(path, err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// readError — ошибка readFileSync: каталог даёт EISDIR без пути, остальное — open '<путь>'.
func readError(path string, err error) error {
	if info, statErr := os.Stat(path); statErr == nil && info.IsDir() {
		return jscompat.FsError("read", "", err)
	}
	return jscompat.FsError("open", path, err)
}

// win32Absolute — path.win32.isAbsolute: от корня («/», «\») или с буквой диска и разделителем.
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

// projectPath — projectPath(project, value, requireFile): переносимый путь от корня проекта через «/»
// без пустых компонентов, «.» и «..»; оба вида абсолютных путей отклоняются на любой ОС. С
// requireFile путь обязан указывать на существующий обычный файл. Возвращает абсолютный путь.
func projectPath(project string, value any, requireFile bool) (string, error) {
	text, ok := value.(string)
	if !ok || text == "" || strings.Contains(text, `\`) || jscompat.IsAbs(text) || strings.HasPrefix(text, "/") || win32Absolute(text) {
		return "", errors.New(textRelativePathRequired)
	}
	for _, part := range strings.Split(text, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New(textInvalidProjectPath(text))
		}
	}
	full := jscompat.Resolve(project, filepath.FromSlash(text))
	if requireFile {
		if info, err := os.Stat(full); err != nil || !info.Mode().IsRegular() {
			return "", errors.New(textProjectFileMissing(text))
		}
	}
	return full, nil
}

// portable — portable(project, path): путь от корня проекта с «/» вместо «\».
func portable(project, path string) string {
	return strings.ReplaceAll(filepath.ToSlash(jscompat.Relative(project, path)), `\`, "/")
}

// join — path.join(base, name): склейка с нормализацией (абсолютное name не сбрасывает base).
func join(base, name string) string { return filepath.Join(base, filepath.FromSlash(name)) }

// readObject — readObject(path, label): JSON-объект или ошибка readFailed с подписью. Отсутствие,
// повреждение, массив и примитив файла дают одну и ту же ошибку; файл не меняется.
func readObject(path, label string) (*jscompat.Object, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		if value, parseErr := jscompat.Parse([]byte(jscompat.DecodeUTF8(data))); parseErr == nil {
			if object, ok := jscompat.AsObject(value); ok {
				return object, nil
			}
		}
	}
	return nil, errors.New(textReadFailed(label))
}

// randomUUID — crypto.randomUUID (версия 4, строчные): имена черновиков и папок проб.
var randomUUID = func() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

// isoTime — Date.toISOString времени изменения файла: UTC с миллисекундами.
func isoTime(info os.FileInfo) string {
	return info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z")
}

// encode — JSON.stringify(value, null, 2) + '\n', формат writeLocalJson.
func encode(value any) []byte { return []byte(jscompat.StringifyIndent(value, "  ") + "\n") }
