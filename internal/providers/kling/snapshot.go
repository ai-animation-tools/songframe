// Package kling — Go-адаптер провайдера генерации kling (перенос нужного из
// tools/kling_request/kling_request.py оригинала). Особенности сервиса живут только здесь;
// общий код обращается к ним через таблицу internal/mediaadapters.
package kling

import "songframe-go/internal/pycompat"

// multiShotModels — MULTI_SHOT_MODELS: модели с авто-раскадровкой, у которых сервис по умолчанию
// включает prefer_multi_shots.
var multiShotModels = map[string]bool{"kling-video-v3_0": true, "kling-video-v3_0_omni": true}

// textMultiShot — предупреждение о снимке без явного prefer_multi_shots (дословно из оригинала).
const textMultiShot = "запрос к модели с авто-раскадровкой отправлен без prefer_multi_shots: " +
	"у сервиса значение по умолчанию true"

// SnapshotWarnings — snapshot_warnings(snapshot): пары (поле, текст) о снимке принятого комплекта.
// Ошибка — TypeError Python, если model нехешируемый (список, объект) и не проверяется по множеству.
func SnapshotWarnings(snapshot *pycompat.Dict) ([][2]string, error) {
	arguments, _ := pycompat.DictGet(snapshot, "arguments", pycompat.NewDict())
	parameters, _ := pycompat.DictGet(snapshot, "parameters", arguments)
	model := snapshot.Value("model")
	if _, err := pycompat.HashKey(model); err != nil {
		return nil, err
	}
	name, isString := model.(string)
	if !isString || !multiShotModels[name] {
		return [][2]string{}, nil
	}
	if values, ok := parameters.(*pycompat.Dict); ok && !values.Has("prefer_multi_shots") && !snapshot.Has("prefer_multi_shots") {
		return [][2]string{{"parameters", textMultiShot}}, nil
	}
	return [][2]string{}, nil
}
