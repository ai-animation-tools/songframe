// Package projectfs записывает файлы проекта и локального состояния атомарно и решает,
// разрешена ли запись в проект. Чтение и открытие проекта остаются в internal/project.
//
// Формат JSON совпадает с writeLocalJson оригинала (JSON.stringify(value, null, 2) + "\n"),
// поэтому файлы, записанные Go-версией, байт в байт равны файлам Electron при тех же значениях.
package projectfs

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// writeData и syncFile — точки подмены для тестов сбоя посреди записи; в работе не меняются.
var (
	writeData = func(file *os.File, data []byte) error {
		_, err := file.Write(data)
		return err
	}
	syncFile = func(file *os.File) error { return file.Sync() }
)

// MarshalJSON возвращает байты в формате JSON.stringify(value, null, 2) + "\n".
//
// Порядок ключей задаёт значение: поля структуры — в порядке объявления, json.RawMessage —
// как есть; ключи map Go сортирует (в отличие от порядка вставки JS), поэтому для документов
// с заданным порядком нужны структуры или RawMessage. Отличия кодировщика Go от JS исправляются:
// HTML-символы не экранируются, U+2028/U+2029 пишутся как есть, \b и \f — короткими escape.
func MarshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return jsEscapes(buffer.Bytes()), nil
}

// jsEscapes приводит escape-последовательности encoding/json к виду JSON.stringify.
// Обратная косая вне строк в JSON не встречается, поэтому достаточно пройти по парам «\x»:
// экранированная косая «\\» пропускается целиком и не путается с началом \u2028.
func jsEscapes(data []byte) []byte {
	if !bytes.Contains(data, []byte(`\u`)) {
		return data
	}
	result := make([]byte, 0, len(data))
	for index := 0; index < len(data); index++ {
		if data[index] != '\\' || index+1 >= len(data) {
			result = append(result, data[index])
			continue
		}
		if data[index+1] == 'u' && index+6 <= len(data) {
			switch string(data[index+2 : index+6]) {
			case "2028":
				result = append(result, "\u2028"...)
				index += 5
				continue
			case "2029":
				result = append(result, "\u2029"...)
				index += 5
				continue
			case "0008":
				result = append(result, `\b`...)
				index += 5
				continue
			case "000c":
				result = append(result, `\f`...)
				index += 5
				continue
			}
		}
		result = append(result, data[index], data[index+1])
		index++
	}
	return result
}

// WriteJSON атомарно заменяет файл JSON-документом в формате оригинала.
// Ошибка сериализации не трогает файл; сообщение об ошибке записи — как у writeLocalJson.
func WriteJSON(path string, value any) error {
	data, err := MarshalJSON(value)
	if err != nil {
		return writeFailed(path, err)
	}
	return WriteFile(path, data, 0)
}

// WriteFile атомарно заменяет файл: данные пишутся во временный файл в той же папке
// (тот же том, поэтому rename атомарен), сбрасываются на диск, затем переименовываются
// поверх цели. Сбой на любом шаге оставляет прежний файл целым, а временный удаляется.
//
// perm 0 сохраняет права существующего файла, а для нового берёт 0600, как оригинал
// (umask применяется так же, как в Node). Родительские папки создаются при необходимости.
// После rename на Unix сбрасывается и каталог, чтобы замена пережила сбой питания.
func WriteFile(path string, data []byte, perm os.FileMode) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return writeFailed(path, err)
	}
	if perm == 0 {
		perm = 0o600
		if info, err := os.Stat(path); err == nil {
			perm = info.Mode().Perm()
		}
	}
	suffix := make([]byte, 16)
	if _, err := rand.Read(suffix); err != nil {
		return writeFailed(path, err)
	}
	temporary := path + "." + hex.EncodeToString(suffix) + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return writeFailed(path, err)
	}
	defer os.Remove(temporary)
	err = writeData(file, data)
	if err == nil {
		err = syncFile(file)
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporary, path)
	}
	if err != nil {
		return writeFailed(path, err)
	}
	syncDirectory(directory)
	return nil
}

// syncDirectory — необязательное усиление: ошибка не отменяет уже выполненную замену.
// В Windows каталог нельзя сбросить через дескриптор, там шаг пропускается.
func syncDirectory(directory string) {
	if runtime.GOOS == "windows" {
		return
	}
	if handle, err := os.Open(directory); err == nil {
		_ = handle.Sync()
		_ = handle.Close()
	}
}

// writeFailed повторяет пользовательское сообщение оригинала localFilesTexts.writeFailed.
func writeFailed(path string, err error) error {
	return fmt.Errorf("Не удалось сохранить %s: %w. Проверьте доступ на запись к папке.", path, err)
}

// ReadJSON читает JSON-объект (или массив, как typeof === 'object' в оригинале) в value.
// Отсутствующий файл — (false, nil), чтобы вызывающий подставил значение по умолчанию;
// повреждённый — ошибка с сообщением readLocalJson: файл не трогается и не перезаписывается.
func ReadJSON(path string, value any) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err == nil {
		trimmed := bytes.TrimLeft(data, " \t\r\n")
		if len(trimmed) == 0 || (trimmed[0] != '{' && trimmed[0] != '[') {
			if json.Valid(data) {
				err = errors.New("ожидался JSON-объект")
			} else {
				err = json.Unmarshal(data, value)
			}
		} else {
			err = json.Unmarshal(data, value)
		}
	}
	if err != nil {
		return true, fmt.Errorf("Не удалось прочитать %s: %w. Файл сохранён; исправьте его или перенесите в резервную папку.", path, err)
	}
	return true, nil
}
