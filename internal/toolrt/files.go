package toolrt

import (
	"os"
	"runtime"
	"strings"

	"songframe/internal/projectfs"
)

// ReadJSON — чтение JSON инструментами: (значение, damaged). Отсутствующий файл и документ
// `null` дают (nil, false) — «документа нет»; ошибка чтения, декодирования или разбора —
// (nil, true) — «документ повреждён». Инструменты различают эти случаи в своём выводе.
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

// WriteJSONAtomic — атомарная запись JSON инструментами: байты EncodeIndented в текстовом режиме
// ОС (TextMode) во временный файл рядом и замена цели. Временный файл получает права 0600, права
// заменяемого файла не сохраняются. Перед заменой файл сбрасывается на
// диск (projectfs.WriteFile); сбой оставляет заменяемый файл целым.
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

// IsFile — путь указывает на обычный файл после разыменования ссылок.
func IsFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// lineSeparator — перевод строки текстового режима ОС: на Windows инструменты пишут «\n» как
// «\r\n» в текстовые файлы и в перенаправленные stdout/stderr.
var lineSeparator = func() string {
	if runtime.GOOS == "windows" {
		return "\r\n"
	}
	return "\n"
}()

// TextMode — текст с переводами строк текстового режима этой ОС (lineSeparator).
func TextMode(text string) string {
	if lineSeparator == "\n" {
		return text
	}
	return strings.ReplaceAll(text, "\n", lineSeparator)
}
