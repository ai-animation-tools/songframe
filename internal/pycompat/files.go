package pycompat

import (
	"os"
	"runtime"
	"strings"

	"songframe-go/internal/projectfs"
)

// ReadJSON — tools/common.py read_json: (значение, damaged). Отсутствующий файл и документ
// `null` дают (nil, false), как None в Python; ошибка чтения, декодирования или разбора — (nil, true),
// как False.
func ReadJSON(path string) (any, bool) {
	value, err := LoadJSONFile(path)
	if err != nil {
		if IsNotFound(err) {
			return nil, false
		}
		return nil, true
	}
	return value, false
}

// WriteJSONAtomic — tools/common.py write_json_atomic: json.dumps(indent=2, ensure_ascii=False) +
// "\n" во временный файл рядом и замена цели. Оригинал создавал временный файл через
// NamedTemporaryFile (права 0600) и не сохранял права прежнего файла; запись повторяет это.
// Отличие от оригинала: перед заменой файл сбрасывается на диск (projectfs.WriteFile), сбой
// по-прежнему оставляет прежний файл целым.
func WriteJSONAtomic(path string, value any) error {
	data, err := EncodeIndented(value)
	if err != nil {
		return err
	}
	if err := projectfs.WriteFile(path, []byte(TextMode(string(data))), 0o600); err != nil {
		return OSErrorFrom(err, path)
	}
	return nil
}

// IsFile — Path(path).is_file(): обычный файл после разыменования ссылок.
func IsFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// lineSeparator — os.linesep: текстовый режим Python на Windows пишет «\n» как «\r\n» в файлы
// (write_text, NamedTemporaryFile mode="w") и в перенаправленные stdout/stderr.
var lineSeparator = func() string {
	if runtime.GOOS == "windows" {
		return "\r\n"
	}
	return "\n"
}()

// TextMode — текст в том виде, в каком его записал бы текстовый поток Python на этой ОС.
func TextMode(text string) string {
	if lineSeparator == "\n" {
		return text
	}
	return strings.ReplaceAll(text, "\n", lineSeparator)
}
