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
		stripped[index] = withoutColor(scheme)
	}
	return jsonValue(stripped)
}

// AgentLocation — схема локации location для агентов плана (описание, видеопромпт, опоры) как значение
// JSON, без цвета объектов, как в AgentView. Факты кадра называют, что видно и где, а схема — форму,
// протяжённость и высоту ориентиров: прямое ли ограждение, где кончается дом. Нет файла, схемы этой
// локации или файл повреждён — false, и ключа в контексте нет.
func AgentLocation(project, location string) (any, bool) {
	document, _, err := Read(project)
	if err != nil {
		return nil, false
	}
	for _, scheme := range document.Schemes {
		if scheme.Location == location {
			return jsonValue(withoutColor(scheme))
		}
	}
	return nil, false
}

// withoutColor — копия схемы без цвета объектов: цвет нужен только холсту редактора.
func withoutColor(scheme Scheme) Scheme {
	objects := make([]Object, len(scheme.Objects))
	for position, object := range scheme.Objects {
		object.Color = ""
		objects[position] = object
	}
	scheme.Objects = objects
	return scheme
}

// jsonValue — значение dynvalue из сериализации v; ошибка — false.
func jsonValue(v any) (any, bool) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, false
	}
	value, err := dynvalue.Parse(data)
	return value, err == nil
}
