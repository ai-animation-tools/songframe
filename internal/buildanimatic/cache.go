package buildanimatic

import (
	"crypto/sha256"
	"encoding/hex"
	"os"

	"songframe/internal/projectviews"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// artifactCache — кэш проверенных производных plan/animatic/.cache/<kind>/<ключ><suffix> с
// квитанцией <ключ>.json.
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

// cacheEvent — запись журнала обращений: попадание в кэш и путь производной (для отчёта сборки).
type cacheEvent struct {
	kind string
	hit  bool
	path string
}

// paths — ключ, путь производной и путь квитанции фрагмента kind с рецептом recipe. Ключ —
// SHA-256 компактного JSON {"schema": 1, "kind": kind, "recipe": recipe}: ключи по возрастанию
// кодовых точек, не-ASCII без экранирования, без пробелов после «,» и «:».
func (c *artifactCache) paths(kind string, recipe *toolrt.Dict, suffix string) (key, artifact, receipt string, err error) {
	raw, err := toolrt.DumpsJSON(toolcli.Record("schema", toolrt.NewInt(1), "kind", kind, "recipe", recipe),
		toolrt.DumpOptions{SortKeys: true, Compact: true})
	if err != nil {
		return "", "", "", err
	}
	data, err := toolrt.EncodeUTF8(raw)
	if err != nil {
		return "", "", "", err
	}
	sum := sha256.Sum256(data)
	key = hex.EncodeToString(sum[:])
	folder := toolrt.JoinPath(c.directory, kind)
	return key, toolrt.JoinPath(folder, key+suffix), toolrt.JoinPath(folder, key+".json"), nil
}

// lookup — готовая производная и её details, если квитанция читается и совпадает по ключу,
// размеру и SHA-256 файла. Любая ошибка чтения или неверный тип поля (OSError, ValueError,
// KeyError, TypeError) означает промах, а не отказ сборки.
func (c *artifactCache) lookup(key, artifact, receipt string) (any, bool) {
	value, err := toolrt.LoadJSONFile(receipt)
	if err != nil {
		return nil, false
	}
	stored, err := toolrt.GetItem(value, "key")
	if err != nil || !toolrt.Equal(stored, key) {
		return nil, false
	}
	size, err := toolrt.GetItem(value, "bytes")
	if err != nil {
		return nil, false
	}
	info, err := os.Stat(artifact)
	if err != nil || !toolrt.Equal(size, toolrt.NewInt(info.Size())) {
		return nil, false
	}
	digest, err := toolrt.GetItem(value, "sha256")
	if err != nil {
		return nil, false
	}
	actual, err := projectviews.FileSHA(artifact)
	if err != nil || !toolrt.Equal(digest, actual) {
		return nil, false
	}
	details, err := toolrt.GetItem(value, "details")
	if err != nil {
		return nil, false
	}
	return details, true
}

// obtain — производная из кэша или новая. producer пишет
// файл по переданному пути внутри .pending-* и возвращает details; его ошибка прерывает запись,
// временная папка удаляется, прежнее содержимое кэша остаётся. Возвращает путь производной.
func (c *artifactCache) obtain(kind string, recipe *toolrt.Dict, suffix string, producer func(path string) (any, error)) (string, error) {
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
	folder := toolrt.JoinPath(c.directory, kind)
	if err := os.MkdirAll(folder, 0o777); err != nil {
		return toolrt.OSErrorFrom(err, folder)
	}
	temporary, err := os.MkdirTemp(folder, ".pending-")
	if err != nil {
		return toolrt.OSErrorFrom(err, folder)
	}
	defer os.RemoveAll(temporary)
	pending := toolrt.JoinPath(temporary, "artifact"+suffix)
	details, err := producer(pending)
	if err != nil {
		return err
	}
	info, err := os.Stat(pending)
	if err != nil {
		return toolrt.OSErrorFrom(err, pending)
	}
	digest, err := projectviews.FileSHA(pending)
	if err != nil {
		return err
	}
	text, err := toolrt.DumpsJSON(toolcli.Record("key", key, "bytes", toolrt.NewInt(info.Size()), "sha256", digest, "details", details), toolrt.Indented)
	if err != nil {
		return err
	}
	note := toolrt.JoinPath(temporary, "receipt.json")
	if err := writeText(note, text+"\n"); err != nil {
		return err
	}
	if err := os.Rename(pending, artifact); err != nil {
		return toolrt.OSErrorFrom(err, pending)
	}
	if err := os.Rename(note, receipt); err != nil {
		return toolrt.OSErrorFrom(err, note)
	}
	return nil
}
