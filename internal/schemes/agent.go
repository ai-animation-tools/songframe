package schemes

import (
	"encoding/json"

	"songframe/internal/dynvalue"
)

// AgentView — схемы проекта для агента сценария как значение JSON: все схемы с фигурами, координатами и
// объёмом, но без цвета объектов — цвет нужен только холсту редактора. Нет файла или нет схем — false:
// контекст агента тогда не получает ключа. Повреждённый файл тоже даёт false: страница «Схемы» показывает
// повреждение, а подготовка сценария не прерывается.
func AgentView(project string) (any, bool) {
	document, _, err := Read(project)
	if err != nil || len(document.Schemes) == 0 {
		return nil, false
	}
	stripped := make([]Scheme, len(document.Schemes))
	for index, scheme := range document.Schemes {
		objects := make([]Object, len(scheme.Objects))
		for position, object := range scheme.Objects {
			object.Color = ""
			objects[position] = object
		}
		scheme.Objects = objects
		stripped[index] = scheme
	}
	data, err := json.Marshal(stripped)
	if err != nil {
		return nil, false
	}
	value, err := dynvalue.Parse(data)
	return value, err == nil
}
