package cast

import (
	"errors"
	"regexp"
	"strings"

	"songframe/internal/dynvalue"
)

// Сообщения castTexts.main (frontend/src/shared/texts/cast.ts): показываются пользователю и
// входят в ошибки сохранения.
const (
	textStructureRequired       = "cast.json: нужны schema_version 1, entities и properties."
	textUnnamedEntity           = "(без имени)"
	textWorldMustBeUnique       = "Сущность типа world должна быть одна."
	textFileDamaged             = "plan/cast.json повреждён."
	textManifestMissing         = "Нет source/manifest.json: сначала загрузите исходники."
	textEntityStructureInvalid  = "cast.json: неверная структура сущности."
	textPropertiesInvalid       = "cast.json: неверный словарь свойств."
	textRestoreFailedPrefix     = "Не удалось восстановить исходники после ошибки. Резерв сохранён в "
	textDescriptionFromSources1 = "Для объектов "
	textDescriptionFromSources2 = " показано общее описание из исходников. Сохранённая копия в кастинге обновится при сохранении."
)

func textEntityCodeInvalid(label string) string {
	return "Код сущности «" + label + "»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы."
}
func textEntityCodeDuplicate(id string) string {
	return "Код сущности повторяется: " + id + "."
}
func textEntityKindInvalid(label string) string {
	return label + ": тип должен быть кодом латиницей."
}
func textEntityNameMissing(id string) string {
	return "Сущность " + id + ": нет названия."
}
func textImagePathInvalid(label, image string) string {
	return label + ": путь изображения должен быть вида heroes/<файл>.png: " + image
}
func textPropertyCodeInvalid(label, key string) string {
	return label + ": свойство " + key + " должно быть кодом латиницей."
}
func textPropertyEmpty(label, key string) string {
	return label + ": свойство " + key + " пустое."
}
func textReferencesMissing(ids []string) string {
	return "В исходниках есть референсы без сущности в кастинге: " + strings.Join(ids, ", ") + ". Нажмите «Дополнить из исходников»."
}
func textPropertyDuplicate(key, kind string) string {
	return "cast.json: свойство " + key + " повторяется в словаре типа " + kind + "."
}
func textImageMissing(name, image string) string {
	return name + ": нет файла source/" + image + "."
}

var (
	// slug — код сущности, типа и свойства: строчная латиница, цифры и подчёркивание с буквы.
	slug = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	// imagePath — путь изображения внутри source: одна папка вида и файл PNG/JPEG/WebP.
	// Регистронезависимость записана явными классами: (?i) Go сопоставил бы «K» (знак кельвина) и «ſ»
	// латинице, а расширение должно состоять только из ASCII-букв.
	imagePath = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]*/[^/]+\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$`)
)

// slugTest — значение, приведённое к строке (dynvalue.ToString), — допустимый код slug; число
// тоже проверяется по своей записи.
func slugTest(value any) bool { return slug.MatchString(dynvalue.ToString(value)) }

// valueSet — множество значений из JSON: строки и числа сравниваются по значению, объекты — по
// ссылке (dynvalue.StrictEqual; NaN в JSON не встречается). Размер наборов кастинга мал, поэтому
// линейный поиск.
type valueSet struct{ items []any }

func (s *valueSet) has(value any) bool {
	for _, item := range s.items {
		if dynvalue.StrictEqual(item, value) {
			return true
		}
	}
	return false
}
func (s *valueSet) add(value any) {
	if !s.has(value) {
		s.items = append(s.items, value)
	}
}

// trimmed — строка без пробелов по краям; нестрока даёт TypeError с именем поля name.
func trimmed(value any, name string) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", &dynvalue.TypeError{Message: name + ".trim is not a function"}
	}
	return dynvalue.Trim(text), nil
}

// Validate — проблемы кастинга для показа на странице и отказа сохранения. Порядок
// сообщений зафиксирован эталонами testdata/golden. Ошибка — TypeError dynvalue на документе другой формы
// (сущность null, название не строка и т. п.): такой документ отклоняется целиком.
func Validate(cast any) ([]string, error) {
	problems := []string{}
	properties := dynvalue.Get(cast, "properties")
	entities, isArray := dynvalue.AsArray(dynvalue.Get(cast, "entities"))
	if !dynvalue.StrictEqual(dynvalue.Get(cast, "schema_version"), 1.0) || !isArray ||
		dynvalue.TypeOf(properties) != "object" || !dynvalue.Truthy(properties) {
		return []string{textStructureRequired}, nil
	}
	seen := &valueSet{}
	worlds := 0
	for _, entity := range entities {
		name, err := dynvalue.Prop(entity, "name")
		if err != nil {
			return nil, err
		}
		id := dynvalue.Get(entity, "id")
		label := name
		if !dynvalue.Truthy(label) {
			label = id
		}
		if !dynvalue.Truthy(label) {
			label = textUnnamedEntity
		}
		labelText := dynvalue.ToString(label)
		if !slugTest(id) {
			problems = append(problems, textEntityCodeInvalid(labelText))
		}
		if seen.has(id) {
			problems = append(problems, textEntityCodeDuplicate(dynvalue.ToString(id)))
		}
		seen.add(id)
		kind := dynvalue.Get(entity, "kind")
		if !slugTest(kind) {
			problems = append(problems, textEntityKindInvalid(labelText))
		}
		trimmedName, err := trimmed(name, "entity.name")
		if err != nil {
			return nil, err
		}
		if trimmedName == "" {
			problems = append(problems, textEntityNameMissing(dynvalue.ToString(id)))
		}
		if dynvalue.StrictEqual(kind, "world") {
			worlds++
		}
		images, err := dynvalue.Iterate(dynvalue.Get(entity, "images"))
		if err != nil {
			return nil, err
		}
		for _, image := range images {
			if !imagePath.MatchString(dynvalue.ToString(image)) {
				problems = append(problems, textImagePathInvalid(labelText, dynvalue.ToString(image)))
			}
		}
		state, err := dynvalue.Entries(dynvalue.Get(entity, "initial_state"))
		if err != nil {
			return nil, err
		}
		for _, entry := range state {
			if !slug.MatchString(entry.Key) {
				problems = append(problems, textPropertyCodeInvalid(labelText, entry.Key))
			}
			if text, ok := entry.Value.(string); !ok || dynvalue.Trim(text) == "" {
				problems = append(problems, textPropertyEmpty(labelText, entry.Key))
			}
		}
	}
	if worlds > 1 {
		problems = append(problems, textWorldMustBeUnique)
	}
	return problems, nil
}

// EnsureProperties дополняет словари свойств: каждому типу сущности без словаря добавляется
// копия словаря по умолчанию (известному типу — свой набор, прочим — общий). Возвращает новый объект кастинга
// (поверхностная копия с новым properties): ключ properties остаётся на своём месте, а при отсутствии
// встаёт в конец.
func EnsureProperties(cast any, defaults Defaults) (*dynvalue.Object, error) {
	properties := dynvalue.Spread(dynvalue.Get(cast, "properties"))
	entities, err := dynvalue.Iterate(dynvalue.Get(cast, "entities"))
	if err != nil {
		return nil, err
	}
	for _, entity := range entities {
		kind, err := dynvalue.Prop(entity, "kind")
		if err != nil {
			return nil, err
		}
		key := dynvalue.ToString(kind)
		if dynvalue.Truthy(properties.Value(key)) {
			continue
		}
		source := dynvalue.Coalesce(defaults.Default.Value(key), defaults.Generic)
		properties.Set(key, dynvalue.DeepClone(source))
	}
	result := dynvalue.Spread(cast)
	result.Set("properties", properties)
	return result, nil
}

// isStrings — значение — массив, все элементы которого строки (пустой массив подходит).
func isStrings(value any) bool {
	items, ok := dynvalue.AsArray(value)
	if !ok {
		return false
	}
	for _, item := range items {
		if _, ok := item.(string); !ok {
			return false
		}
	}
	return true
}

// validProperty — элемент словаря свойств: код, непустая подпись и необязательные hint, values, checklist.
func validProperty(value any) bool {
	property, ok := dynvalue.AsObject(value)
	if !ok {
		return false
	}
	key, keyOK := property.Value("key").(string)
	label, labelOK := property.Value("label").(string)
	if !keyOK || !slug.MatchString(key) || !labelOK || dynvalue.Trim(label) == "" {
		return false
	}
	optionalString := func(name string) bool {
		item := property.Value(name)
		_, isString := item.(string)
		return item == dynvalue.Undefined || isString
	}
	values := property.Value("values")
	return optionalString("hint") && (values == dynvalue.Undefined || isStrings(values)) && optionalString("checklist")
}

// Normalize — строгая проверка типов документа (ответ агента и ручной JSON),
// затем нормализация полей и проверка Validate. Записываемый документ содержит только
// schema_version, entities (с восемью полями сущности) и properties — лишние поля отбрасываются.
// Ошибка — сообщение отказа сохранения (проблемы через пробел).
func Normalize(value any, defaults Defaults) (*dynvalue.Object, error) {
	document, ok := dynvalue.AsObject(value)
	if !ok || !dynvalue.StrictEqual(document.Value("schema_version"), 1.0) {
		return nil, errors.New(textStructureRequired)
	}
	entities, entitiesOK := dynvalue.AsArray(document.Value("entities"))
	properties, propertiesOK := dynvalue.AsObject(document.Value("properties"))
	if !entitiesOK || !propertiesOK {
		return nil, errors.New(textStructureRequired)
	}
	for _, item := range entities {
		entity, ok := dynvalue.AsObject(item)
		valid := ok
		if valid {
			for _, key := range []string{"id", "kind", "name", "short_name", "role", "appearance"} {
				if _, isString := entity.Value(key).(string); !isString {
					valid = false
				}
			}
		}
		if valid {
			state, stateOK := dynvalue.AsObject(entity.Value("initial_state"))
			valid = isStrings(entity.Value("images")) && stateOK
			for _, key := range keysOf(state) {
				if _, isString := state.Value(key).(string); !isString {
					valid = false
				}
			}
		}
		if !valid {
			return nil, errors.New(textEntityStructureInvalid)
		}
	}
	for _, kind := range properties.Keys() {
		list, ok := dynvalue.AsArray(properties.Value(kind))
		valid := slug.MatchString(kind) && ok
		for _, property := range list {
			valid = valid && validProperty(property)
		}
		if !valid {
			return nil, errors.New(textPropertiesInvalid)
		}
		// Код — адрес значения в состоянии: повтор внутри типа сделал бы одно из полей недостижимым.
		seen := map[string]bool{}
		for _, property := range list {
			key := property.(*dynvalue.Object).Value("key").(string)
			if seen[key] {
				return nil, errors.New(textPropertyDuplicate(key, kind))
			}
			seen[key] = true
		}
	}
	normalized := make([]any, len(entities))
	for index, item := range entities {
		entity := item.(*dynvalue.Object)
		text := func(key string) string { return entity.Value(key).(string) }
		name := dynvalue.Trim(text("name"))
		short := dynvalue.Trim(text("short_name"))
		if short == "" {
			short = name
		}
		state := dynvalue.NewObject()
		source := entity.Value("initial_state").(*dynvalue.Object)
		for _, key := range source.Keys() {
			if value := dynvalue.Trim(source.Value(key).(string)); value != "" {
				state.Set(key, value)
			}
		}
		result := dynvalue.NewObject()
		result.Set("id", dynvalue.Trim(text("id")))
		result.Set("kind", dynvalue.Trim(text("kind")))
		result.Set("name", name)
		result.Set("short_name", short)
		result.Set("role", dynvalue.Trim(text("role")))
		// Общее описание переносится дословно: правка другого поля не должна менять canonical source.
		result.Set("appearance", text("appearance"))
		result.Set("images", entity.Value("images"))
		result.Set("initial_state", state)
		normalized[index] = result
	}
	draft := dynvalue.NewObject()
	draft.Set("schema_version", 1.0)
	draft.Set("entities", &dynvalue.Array{Items: normalized})
	draft.Set("properties", properties)
	result, err := EnsureProperties(draft, defaults)
	if err != nil {
		return nil, err
	}
	problems, err := Validate(result)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, " "))
	}
	return result, nil
}

// keysOf — ключи объекта или пустой список для nil.
func keysOf(object *dynvalue.Object) []string {
	if object == nil {
		return nil
	}
	return object.Keys()
}

// References — карта references реестра сцен из сущностей с изображениями —
// название, путь первого изображения в source и короткое имя, если оно отличается от названия.
// Порядок ключей — порядок сущностей; он входит в байты plan/scenes.json.
func References(cast any) (*dynvalue.Object, error) {
	result := dynvalue.NewObject()
	entities, err := dynvalue.Iterate(dynvalue.Get(cast, "entities"))
	if err != nil {
		return nil, err
	}
	for _, entity := range entities {
		images, err := dynvalue.Prop(entity, "images")
		if err != nil {
			return nil, err
		}
		length, err := dynvalue.Prop(images, "length")
		if err != nil {
			return nil, err
		}
		if !dynvalue.Truthy(length) {
			continue
		}
		id := dynvalue.ToString(dynvalue.Get(entity, "id"))
		reference := dynvalue.NewObject()
		reference.Set("name", dynvalue.Get(entity, "name"))
		reference.Set("path", "source/"+dynvalue.ToString(dynvalue.Get(images, "0")))
		result.Set(id, reference)
		short := dynvalue.Get(entity, "short_name")
		if dynvalue.Truthy(short) && !dynvalue.StrictEqual(short, dynvalue.Get(entity, "name")) {
			reference.Set("short_name", short)
		}
	}
	return result, nil
}
