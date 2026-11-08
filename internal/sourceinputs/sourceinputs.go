// Package sourceinputs — отпечаток содержательных входов описи исходников (source-input-hash.ts
// оригинала). Декоративная обложка (cover) и время сохранения (updated_at) не являются входами
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

	"songframe-go/internal/jscompat"
)

// ManifestPath — опись исходников относительно папки проекта.
const ManifestPath = "source/manifest.json"

// digest — SHA-256 байтов в шестнадцатеричной записи.
func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// canonical — canonical оригинала: ключи объектов по возрастанию (сравнение строк JS по кодовым
// единицам UTF-16), массивы поэлементно; остальные значения без изменений.
func canonical(value any) any {
	switch typed := value.(type) {
	case *jscompat.Array:
		items := make([]any, len(typed.Items))
		for index, item := range typed.Items {
			items[index] = canonical(item)
		}
		return &jscompat.Array{Items: items}
	case *jscompat.Object:
		keys := typed.Keys()
		sort.SliceStable(keys, func(i, j int) bool { return jscompat.LessUTF16(keys[i], keys[j]) })
		result := jscompat.NewObject()
		for _, key := range keys {
			result.Set(key, canonical(typed.Value(key)))
		}
		return result
	}
	return value
}

// DigestBytes — sourceInputDigestFromBytes: SHA-256 канонического JSON описи без cover и
// updated_at. Повреждённый JSON или не-объект — SHA-256 самих байтов, чтобы порча не
// маскировалась под прежний корректный набор входов.
func DigestBytes(data []byte) string {
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
	record, ok := jscompat.AsObject(value)
	if err != nil || !ok {
		return digest(data)
	}
	inputs := record.Clone()
	inputs.Delete("cover")
	inputs.Delete("updated_at")
	return digest([]byte(jscompat.Stringify(canonical(inputs))))
}

// Digest — sourceInputDigest(project): отпечаток описи проекта; ok=false — файла нет. Ошибка —
// опись есть, но не читается (readFileSync оригинала бросал исключение).
func Digest(project string) (value string, ok bool, err error) {
	path := filepath.Join(project, filepath.FromSlash(ManifestPath))
	data, readErr := os.ReadFile(path)
	if errors.Is(readErr, fs.ErrNotExist) {
		return "", false, nil
	}
	if readErr != nil {
		return "", false, jscompat.FsError("open", path, readErr)
	}
	return DigestBytes(data), true, nil
}
