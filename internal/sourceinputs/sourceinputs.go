// Package sourceinputs вычисляет отпечаток содержательных входов описи исходников.
// Декоративная обложка (cover) и время сохранения (updated_at) не являются входами
// сценария или производства: их смена не должна делать устаревшими предложения сценария, вопросы
// пакетов и показанные согласования платной отправки. Пакет только читает файлы.
//
// Потребители: снимок входов сценарного прохода (internal/scenarioworkflow) и токен материалов
// пакета производства (internal/production).
package sourceinputs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"songframe/internal/dynvalue"
)

// ManifestPath — опись исходников относительно папки проекта.
const ManifestPath = "source/manifest.json"

// digest — SHA-256 байтов в шестнадцатеричной записи.
func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// canonical — канонический вид значения: ключи объектов по возрастанию (сравнение строк по кодовым
// единицам UTF-16), массивы поэлементно; остальные значения без изменений.
func canonical(value any) any {
	switch typed := value.(type) {
	case *dynvalue.Array:
		items := make([]any, len(typed.Items))
		for index, item := range typed.Items {
			items[index] = canonical(item)
		}
		return &dynvalue.Array{Items: items}
	case *dynvalue.Object:
		keys := typed.Keys()
		sort.SliceStable(keys, func(i, j int) bool { return dynvalue.LessUTF16(keys[i], keys[j]) })
		result := dynvalue.NewObject()
		for _, key := range keys {
			result.Set(key, canonical(typed.Value(key)))
		}
		return result
	}
	return value
}

// DigestBytes — SHA-256 канонического JSON описи без cover и
// updated_at. Повреждённый JSON или не-объект — SHA-256 самих байтов, чтобы порча не
// маскировалась под прежний корректный набор входов.
func DigestBytes(data []byte) string {
	value, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
	record, ok := dynvalue.AsObject(value)
	if err != nil || !ok {
		return digest(data)
	}
	inputs := record.Clone()
	inputs.Delete("cover")
	inputs.Delete("updated_at")
	return digest([]byte(dynvalue.Stringify(canonical(inputs))))
}

// Digest — отпечаток описи проекта; ok=false — файла нет. Ошибка — опись есть, но не читается.
func Digest(project string) (value string, ok bool, err error) {
	path := filepath.Join(project, filepath.FromSlash(ManifestPath))
	data, readErr := os.ReadFile(path)
	if errors.Is(readErr, fs.ErrNotExist) {
		return "", false, nil
	}
	if readErr != nil {
		return "", false, dynvalue.FsError("open", path, readErr)
	}
	return DigestBytes(data), true, nil
}
