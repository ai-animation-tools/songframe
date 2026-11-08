package buildanimatic

import (
	"crypto/sha256"
	"encoding/hex"
	"os"

	"songframe-go/internal/projectviews"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// artifactCache — ArtifactCache из tools/animatic_cache/animatic_cache.py: кэш проверенных
// производных plan/animatic/.cache/<kind>/<ключ><suffix> с квитанцией <ключ>.json.
//
// Ключ — SHA-256 канонического JSON {schema, kind, recipe}, поэтому зависит только от содержимого
// входов и параметров кодирования (рецепт включает SHA-256 входа и полную строку версии FFmpeg).
// Квитанция хранит ключ, размер, SHA-256 и details производной: запись без квитанции, с чужим
// ключом или с изменёнными байтами не считается готовой и пересоздаётся. Новая запись появляется
// только после успешного producer: файл и квитанция пишутся во временную папку .pending-* рядом
// и переносятся на место переименованием. Кэш не является источником данных проекта: его можно
// удалить целиком, это влияет только на скорость. Состояние — только журнал обращений events
// одного запуска; конкурентный доступ не предусмотрен (одна сборка за раз).
type artifactCache struct {
	directory string
	events    []cacheEvent
}

// cacheEvent — запись self.events оригинала: попадание в кэш и путь производной. Время обращения
// оригинал тоже записывал, но в отчёт сборки оно не входит.
type cacheEvent struct {
	kind string
	hit  bool
	path string
}

// paths — paths(kind, recipe, suffix): ключ, путь производной и путь квитанции. Ключ — SHA-256
// json.dumps({"schema": 1, "kind": kind, "recipe": recipe}, sort_keys=True, ensure_ascii=False,
// separators=(",", ":")).
func (c *artifactCache) paths(kind string, recipe *pycompat.Dict, suffix string) (key, artifact, receipt string, err error) {
	raw, err := pycompat.DumpsJSON(pytool.Record("schema", pycompat.NewInt(1), "kind", kind, "recipe", recipe),
		pycompat.DumpOptions{SortKeys: true, Compact: true})
	if err != nil {
		return "", "", "", err
	}
	data, err := pycompat.EncodeUTF8(raw)
	if err != nil {
		return "", "", "", err
	}
	sum := sha256.Sum256(data)
	key = hex.EncodeToString(sum[:])
	folder := pycompat.JoinPath(c.directory, kind)
	return key, pycompat.JoinPath(folder, key+suffix), pycompat.JoinPath(folder, key+".json"), nil
}

// lookup — lookup(kind, recipe, suffix): готовая производная и её details, если квитанция читается
// и совпадает по ключу, размеру и SHA-256 файла. Любая ошибка чтения или неверный тип поля
// (OSError, ValueError, KeyError, TypeError оригинала) означает промах, а не отказ сборки.
func (c *artifactCache) lookup(key, artifact, receipt string) (any, bool) {
	value, err := pycompat.LoadJSONFile(receipt)
	if err != nil {
		return nil, false
	}
	stored, err := pycompat.GetItem(value, "key")
	if err != nil || !pycompat.Equal(stored, key) {
		return nil, false
	}
	size, err := pycompat.GetItem(value, "bytes")
	if err != nil {
		return nil, false
	}
	info, err := os.Stat(artifact)
	if err != nil || !pycompat.Equal(size, pycompat.NewInt(info.Size())) {
		return nil, false
	}
	digest, err := pycompat.GetItem(value, "sha256")
	if err != nil {
		return nil, false
	}
	actual, err := projectviews.FileSHA(artifact)
	if err != nil || !pycompat.Equal(digest, actual) {
		return nil, false
	}
	details, err := pycompat.GetItem(value, "details")
	if err != nil {
		return nil, false
	}
	return details, true
}

// obtain — obtain(kind, recipe, suffix, producer): производная из кэша или новая. producer пишет
// файл по переданному пути внутри .pending-* и возвращает details; его ошибка прерывает запись,
// временная папка удаляется, прежнее содержимое кэша остаётся. Возвращает путь производной.
func (c *artifactCache) obtain(kind string, recipe *pycompat.Dict, suffix string, producer func(path string) (any, error)) (string, error) {
	key, artifact, receipt, err := c.paths(kind, recipe, suffix)
	if err != nil {
		return "", err
	}
	_, hit := c.lookup(key, artifact, receipt)
	if !hit {
		if err := c.produce(kind, key, artifact, receipt, suffix, producer); err != nil {
			return "", err
		}
	}
	c.events = append(c.events, cacheEvent{kind: kind, hit: hit, path: artifact})
	return artifact, nil
}

// produce — ветка промаха obtain: producer во временной папке, квитанция с размером и SHA-256,
// перенос файла и квитанции на место (сначала производная, затем квитанция: обрыв между ними
// оставляет запись без квитанции, которую следующий lookup пересоздаст).
func (c *artifactCache) produce(kind, key, artifact, receipt, suffix string, producer func(path string) (any, error)) error {
	folder := pycompat.JoinPath(c.directory, kind)
	if err := os.MkdirAll(folder, 0o777); err != nil {
		return pycompat.OSErrorFrom(err, folder)
	}
	temporary, err := os.MkdirTemp(folder, ".pending-")
	if err != nil {
		return pycompat.OSErrorFrom(err, folder)
	}
	defer os.RemoveAll(temporary)
	pending := pycompat.JoinPath(temporary, "artifact"+suffix)
	details, err := producer(pending)
	if err != nil {
		return err
	}
	info, err := os.Stat(pending)
	if err != nil {
		return pycompat.OSErrorFrom(err, pending)
	}
	digest, err := projectviews.FileSHA(pending)
	if err != nil {
		return err
	}
	text, err := pycompat.DumpsJSON(pytool.Record("key", key, "bytes", pycompat.NewInt(info.Size()), "sha256", digest, "details", details), pycompat.Indented)
	if err != nil {
		return err
	}
	note := pycompat.JoinPath(temporary, "receipt.json")
	if err := writeText(note, text+"\n"); err != nil {
		return err
	}
	if err := os.Rename(pending, artifact); err != nil {
		return pycompat.OSErrorFrom(err, pending)
	}
	if err := os.Rename(note, receipt); err != nil {
		return pycompat.OSErrorFrom(err, note)
	}
	return nil
}
