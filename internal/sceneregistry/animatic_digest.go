package sceneregistry

import (
	"crypto/sha256"
	"encoding/hex"
	"os"

	"songframe/internal/toolrt"
)

// Отпечаток сценария для аниматика и карточек планов. Сборка аниматика и карточки читают из
// plan/scenes.json частоту кадров, песню, словарь референсов, названия частей и поля планов;
// логлайн, общее визуальное направление, направление и прочие поля частей, а также состояние
// планов (state_from, state_changes) в сборку не попадают. Отпечаток строится из
// проекции без этих полей: их правка не делает аниматик и карточки устаревшими. Поля плана
// остаются в проекции целиком, кроме состояния: новое поле плана по умолчанию считается входом
// сборки. Верхний уровень и части, наоборот, берутся по списку (animaticTopKeys,
// animaticSequenceKeys): там много полей сценарного прохода, которых сборка не читает, — поле,
// которое начнёт читать сборка или карточки, нужно добавить в список, иначе его правка не сделает
// аниматик устаревшим. Отпечаток пишут манифест аниматика (scene_registry_sha256), квитанция
// карточек (registry_sha256) и рецепт обзорной сборки; все сверки свежести считают его одной
// этой функцией, поэтому манифест и квитанция сравнимы между собой.

// animaticTopKeys — поля верхнего уровня сценария, которые входят в сборку.
var animaticTopKeys = []string{"fps", "audio", "references"}

// animaticSequenceKeys — поля части, которые печатаются на карточках (заголовок плана по умолчанию).
var animaticSequenceKeys = []string{"id", "title"}

// animaticSceneSkipped — поля плана, которые сборка и карточки не читают: состояние плана нужно
// принятию и непрерывности, но не кадру аниматика.
var animaticSceneSkipped = []string{"state_from", "state_changes"}

// AnimaticDigestFile — отпечаток сценария path для аниматика: SHA-256 канонического JSON проекции
// (ключи по возрастанию, компактно, UTF-8). Отсутствующий или нечитаемый файл — ошибка, как у
// хеша байтов. Текст, который не разбирается как JSON-объект, даёт SHA-256 байтов файла: любая его
// правка заметна, а сама сборка по такому сценарию всё равно откажет.
func AnimaticDigestFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", toolrt.OSErrorFrom(err, path)
	}
	return AnimaticDigest(data), nil
}

// AnimaticDigest — отпечаток содержимого plan/scenes.json для аниматика (см. AnimaticDigestFile).
func AnimaticDigest(data []byte) string {
	text, err := toolrt.DecodeUTF8(data)
	if err == nil {
		var value any
		if value, err = toolrt.LoadsJSON(toolrt.TranslateNewlines(text)); err == nil {
			if document, ok := value.(*toolrt.Dict); ok {
				if digest, err := projectionDigest(animaticProjection(document)); err == nil {
					return digest
				}
			}
		}
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// animaticProjection — часть сценария, от которой зависят аниматик и карточки.
func animaticProjection(document *toolrt.Dict) *toolrt.Dict {
	result := toolrt.NewDict()
	for _, key := range animaticTopKeys {
		if value, ok := document.Get(key); ok {
			result.Set(key, value)
		}
	}
	if value, ok := document.Get("sequences"); ok {
		result.Set("sequences", projectItems(value, func(item *toolrt.Dict) *toolrt.Dict {
			kept := toolrt.NewDict()
			for _, key := range animaticSequenceKeys {
				if field, ok := item.Get(key); ok {
					kept.Set(key, field)
				}
			}
			return kept
		}))
	}
	if value, ok := document.Get("scenes"); ok {
		result.Set("scenes", projectItems(value, func(item *toolrt.Dict) *toolrt.Dict {
			kept := item.Clone()
			for _, key := range animaticSceneSkipped {
				kept.Delete(key)
			}
			return kept
		}))
	}
	return result
}

// projectItems — список value с проекцией каждого объекта; не список сохраняется как есть, а не
// объекты в списке — без изменений: проверку формата выполняет сама сборка.
func projectItems(value any, project func(*toolrt.Dict) *toolrt.Dict) any {
	items, err := toolrt.Iter(value)
	if err != nil {
		return value
	}
	result := make([]any, len(items))
	for index, item := range items {
		if object, ok := item.(*toolrt.Dict); ok {
			result[index] = project(object)
		} else {
			result[index] = item
		}
	}
	return result
}

// projectionDigest — SHA-256 канонического JSON значения: ключи по возрастанию, компактные
// разделители, не-ASCII без экранирования; аниматик сверяет его только с самим собой.
func projectionDigest(value any) (string, error) {
	text, err := toolrt.DumpsJSON(value, toolrt.DumpOptions{SortKeys: true, Compact: true})
	if err != nil {
		return "", err
	}
	data, err := toolrt.EncodeUTF8(text)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}
