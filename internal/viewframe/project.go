package viewframe

import (
	"encoding/json"

	"songframe/internal/dynvalue"
	"songframe/internal/schemes"
)

// noteSchemesDamaged — plan/schemes.json не читается: факты не считаются, подготовка плана не прерывается.
const noteSchemesDamaged = "Схемы локаций повреждены: факты кадра не посчитаны."

// ForProject — факты кадра точки съёмки value (scene.viewpoint как есть) по схеме её локации из
// plan/schemes.json проекта project и росту героев heights. Повреждённые схемы не прерывают работу: факты
// приходят без кадров с пояснением. Неразборчивая точка съёмки фактов не даёт — false; её отклоняет проверка
// сценария.
func ForProject(project string, value any, heights map[string]float64) (Frame, bool) {
	viewpoint, err := ParseViewpoint(value)
	if err != nil {
		return Frame{}, false
	}
	document, _, err := schemes.Read(project)
	if err != nil {
		camera := CameraFacts{Side: viewpoint.Side, Size: viewpoint.Size, Fov: round(viewpoint.FieldOfView(), 1)}
		return Frame{Camera: camera, Note: noteSchemesDamaged}, true
	}
	return Compute(viewpoint, LocationScheme(document, viewpoint.Location), heights), true
}

// LocationScheme — схема локации location; nil — у локации схемы нет.
func LocationScheme(document schemes.Document, location string) *schemes.Scheme {
	for index := range document.Schemes {
		if document.Schemes[index].Location == location {
			return &document.Schemes[index]
		}
	}
	return nil
}

// CastHeights — рост сущностей кастинга (поле height, метры) из значения plan/cast.json; без роста сущность
// в карту не входит.
func CastHeights(castValue any) map[string]float64 {
	heights := map[string]float64{}
	entities, ok := dynvalue.AsArray(dynvalue.Get(castValue, "entities"))
	if !ok {
		return heights
	}
	for _, entity := range entities {
		id, isString := dynvalue.Get(entity, "id").(string)
		height, isNumber := dynvalue.Get(entity, "height").(float64)
		if isString && isNumber && height > 0 {
			heights[id] = height
		}
	}
	return heights
}

// Tree — факты как значение dynvalue для вложения в JSON контекста агента с порядком ключей Go-структуры.
func (f Frame) Tree() (any, error) {
	data, err := json.Marshal(f)
	if err != nil {
		return nil, err
	}
	return dynvalue.Parse(data)
}
