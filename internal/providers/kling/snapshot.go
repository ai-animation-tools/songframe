// Package kling — адаптер провайдера генерации Kling: правила и проверка запроса, каталог
// возможностей моделей, оценка цены, остаток кредитов и вход, отправка, опрос задания и
// скачивание оригинала через MCP-клиент internal/providers/kling/mcp. Особенности сервиса живут
// только здесь; общий код обращается к ним через таблицу internal/mediaadapters.
package kling

import "songframe/internal/toolrt"

// multiShotModels — модели с авто-раскадровкой, у которых сервис по умолчанию
// включает prefer_multi_shots.
var multiShotModels = map[string]bool{"kling-video-v3_0": true, "kling-video-v3_0_omni": true}

// textMultiShot — предупреждение о снимке без явного prefer_multi_shots.
const textMultiShot = "запрос к модели с авто-раскадровкой отправлен без prefer_multi_shots: " +
	"у сервиса значение по умолчанию true"

// SnapshotWarnings — пары (поле, текст) о снимке принятого комплекта.
// Ошибка — TypeError, если model нехешируемый (список, объект) и не проверяется по множеству.
func SnapshotWarnings(snapshot *toolrt.Dict) ([][2]string, error) {
	arguments, _ := toolrt.DictGet(snapshot, "arguments", toolrt.NewDict())
	parameters, _ := toolrt.DictGet(snapshot, "parameters", arguments)
	model := snapshot.Value("model")
	if _, err := toolrt.HashKey(model); err != nil {
		return nil, err
	}
	name, isString := model.(string)
	if !isString || !multiShotModels[name] {
		return [][2]string{}, nil
	}
	if values, ok := parameters.(*toolrt.Dict); ok && !values.Has("prefer_multi_shots") && !snapshot.Has("prefer_multi_shots") {
		return [][2]string{{"parameters", textMultiShot}}, nil
	}
	return [][2]string{}, nil
}
