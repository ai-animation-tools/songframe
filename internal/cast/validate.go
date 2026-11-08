package cast

import (
	"errors"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
)

// Сообщения castTexts.main оригинала: показываются пользователю и входят в ошибки сохранения.
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
	// Флаг i оригинала записан явными классами: (?i) Go сопоставил бы «K» (знак кельвина) и «ſ»
	// латинице, а регулярное выражение JS без флага u этого не делает.
	imagePath = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]*/[^/]+\.([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$`)
)

// slugTest — SLUG.test(value): RegExp.prototype.test приводит аргумент к строке.
func slugTest(value any) bool { return slug.MatchString(jscompat.ToString(value)) }

// valueSet — Set JS для значений из JSON: строки и числа сравниваются по значению, объекты — по
// ссылке (SameValueZero; NaN в JSON не встречается). Размер наборов кастинга мал, поэтому линейный поиск.
type valueSet struct{ items []any }

func (s *valueSet) has(value any) bool {
	for _, item := range s.items {
		if jscompat.StrictEqual(item, value) {
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

// trimmed — `value.trim()`: вызов на нестроке даёт TypeError оригинала.
func trimmed(value any, name string) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", &jscompat.TypeError{Message: name + ".trim is not a function"}
	}
	return jscompat.Trim(text), nil
}

// Validate — validateCast: проблемы кастинга для показа на странице и отказа сохранения. Порядок
// сообщений совпадает с оригиналом. Ошибка — исключение JS на документе другой формы (сущность
// null, название не строка и т. п.): оригинал при этом отклонял весь вызов.
func Validate(cast any) ([]string, error) {
	problems := []string{}
	properties := jscompat.Get(cast, "properties")
	entities, isArray := jscompat.AsArray(jscompat.Get(cast, "entities"))
	if !jscompat.StrictEqual(jscompat.Get(cast, "schema_version"), 1.0) || !isArray ||
		jscompat.TypeOf(properties) != "object" || !jscompat.Truthy(properties) {
		return []string{textStructureRequired}, nil
	}
	seen := &valueSet{}
	worlds := 0
	for _, entity := range entities {
		name, err := jscompat.Prop(entity, "name")
		if err != nil {
			return nil, err
		}
		id := jscompat.Get(entity, "id")
		label := name
		if !jscompat.Truthy(label) {
			label = id
		}
		if !jscompat.Truthy(label) {
			label = textUnnamedEntity
		}
		labelText := jscompat.ToString(label)
		if !slugTest(id) {
			problems = append(problems, textEntityCodeInvalid(labelText))
		}
		if seen.has(id) {
			problems = append(problems, textEntityCodeDuplicate(jscompat.ToString(id)))
		}
		seen.add(id)
		kind := jscompat.Get(entity, "kind")
		if !slugTest(kind) {
			problems = append(problems, textEntityKindInvalid(labelText))
		}
		trimmedName, err := trimmed(name, "entity.name")
		if err != nil {
			return nil, err
		}
		if trimmedName == "" {
			problems = append(problems, textEntityNameMissing(jscompat.ToString(id)))
		}
		if jscompat.StrictEqual(kind, "world") {
			worlds++
		}
		images, err := jscompat.Iterate(jscompat.Get(entity, "images"))
		if err != nil {
			return nil, err
		}
		for _, image := range images {
			if !imagePath.MatchString(jscompat.ToString(image)) {
				problems = append(problems, textImagePathInvalid(labelText, jscompat.ToString(image)))
			}
		}
		state, err := jscompat.Entries(jscompat.Get(entity, "initial_state"))
		if err != nil {
			return nil, err
		}
		for _, entry := range state {
			if !slug.MatchString(entry.Key) {
				problems = append(problems, textPropertyCodeInvalid(labelText, entry.Key))
			}
			if text, ok := entry.Value.(string); !ok || jscompat.Trim(text) == "" {
				problems = append(problems, textPropertyEmpty(labelText, entry.Key))
			}
		}
	}
	if worlds > 1 {
		problems = append(problems, textWorldMustBeUnique)
	}
	return problems, nil
}

// EnsureProperties — ensureProperties: каждому типу сущности без словаря добавляется копия словаря
// по умолчанию (известному типу — свой набор, прочим — общий). Возвращает новый объект кастинга
// `{ ...cast, properties }`: ключ properties остаётся на своём месте, а при отсутствии встаёт в конец.
func EnsureProperties(cast any, defaults Defaults) (*jscompat.Object, error) {
	properties := jscompat.Spread(jscompat.Get(cast, "properties"))
	entities, err := jscompat.Iterate(jscompat.Get(cast, "entities"))
	if err != nil {
		return nil, err
	}
	for _, entity := range entities {
		kind, err := jscompat.Prop(entity, "kind")
		if err != nil {
			return nil, err
		}
		key := jscompat.ToString(kind)
		if jscompat.Truthy(properties.Value(key)) {
			continue
		}
		source := jscompat.Coalesce(defaults.Default.Value(key), defaults.Generic)
		properties.Set(key, jscompat.DeepClone(source))
	}
	result := jscompat.Spread(cast)
	result.Set("properties", properties)
	return result, nil
}

// isStrings — массив строк (`Array.isArray(v) && v.every(s => typeof s === 'string')`).
func isStrings(value any) bool {
	items, ok := jscompat.AsArray(value)
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
	property, ok := jscompat.AsObject(value)
	if !ok {
		return false
	}
	key, keyOK := property.Value("key").(string)
	label, labelOK := property.Value("label").(string)
	if !keyOK || !slug.MatchString(key) || !labelOK || jscompat.Trim(label) == "" {
		return false
	}
	optionalString := func(name string) bool {
		item := property.Value(name)
		_, isString := item.(string)
		return item == jscompat.Undefined || isString
	}
	values := property.Value("values")
	return optionalString("hint") && (values == jscompat.Undefined || isStrings(values)) && optionalString("checklist")
}

// Normalize — normalizeCast: строгая проверка типов документа (ответ агента и ручной JSON),
// затем нормализация полей и проверка Validate. Записываемый документ содержит только
// schema_version, entities (с восемью полями сущности) и properties — лишние поля отбрасываются,
// как в оригинале. Ошибка — сообщение отказа сохранения (проблемы через пробел).
func Normalize(value any, defaults Defaults) (*jscompat.Object, error) {
	document, ok := jscompat.AsObject(value)
	if !ok || !jscompat.StrictEqual(document.Value("schema_version"), 1.0) {
		return nil, errors.New(textStructureRequired)
	}
	entities, entitiesOK := jscompat.AsArray(document.Value("entities"))
	properties, propertiesOK := jscompat.AsObject(document.Value("properties"))
	if !entitiesOK || !propertiesOK {
		return nil, errors.New(textStructureRequired)
	}
	for _, item := range entities {
		entity, ok := jscompat.AsObject(item)
		valid := ok
		if valid {
			for _, key := range []string{"id", "kind", "name", "short_name", "role", "appearance"} {
				if _, isString := entity.Value(key).(string); !isString {
					valid = false
				}
			}
		}
		if valid {
			state, stateOK := jscompat.AsObject(entity.Value("initial_state"))
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
		list, ok := jscompat.AsArray(properties.Value(kind))
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
			key := property.(*jscompat.Object).Value("key").(string)
			if seen[key] {
				return nil, errors.New(textPropertyDuplicate(key, kind))
			}
			seen[key] = true
		}
	}
	normalized := make([]any, len(entities))
	for index, item := range entities {
		entity := item.(*jscompat.Object)
		text := func(key string) string { return entity.Value(key).(string) }
		name := jscompat.Trim(text("name"))
		short := jscompat.Trim(text("short_name"))
		if short == "" {
			short = name
		}
		state := jscompat.NewObject()
		source := entity.Value("initial_state").(*jscompat.Object)
		for _, key := range source.Keys() {
			if value := jscompat.Trim(source.Value(key).(string)); value != "" {
				state.Set(key, value)
			}
		}
		result := jscompat.NewObject()
		result.Set("id", jscompat.Trim(text("id")))
		result.Set("kind", jscompat.Trim(text("kind")))
		result.Set("name", name)
		result.Set("short_name", short)
		result.Set("role", jscompat.Trim(text("role")))
		// Общее описание переносится дословно: правка другого поля не должна менять canonical source.
		result.Set("appearance", text("appearance"))
		result.Set("images", entity.Value("images"))
		result.Set("initial_state", state)
		normalized[index] = result
	}
	draft := jscompat.NewObject()
	draft.Set("schema_version", 1.0)
	draft.Set("entities", &jscompat.Array{Items: normalized})
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
func keysOf(object *jscompat.Object) []string {
	if object == nil {
		return nil
	}
	return object.Keys()
}

// References — castReferences: карта references реестра сцен из сущностей с изображениями —
// название, путь первого изображения в source и короткое имя, если оно отличается от названия.
// Порядок ключей — порядок сущностей; он входит в байты plan/scenes.json.
func References(cast any) (*jscompat.Object, error) {
	result := jscompat.NewObject()
	entities, err := jscompat.Iterate(jscompat.Get(cast, "entities"))
	if err != nil {
		return nil, err
	}
	for _, entity := range entities {
		images, err := jscompat.Prop(entity, "images")
		if err != nil {
			return nil, err
		}
		length, err := jscompat.Prop(images, "length")
		if err != nil {
			return nil, err
		}
		if !jscompat.Truthy(length) {
			continue
		}
		id := jscompat.ToString(jscompat.Get(entity, "id"))
		reference := jscompat.NewObject()
		reference.Set("name", jscompat.Get(entity, "name"))
		reference.Set("path", "source/"+jscompat.ToString(jscompat.Get(images, "0")))
		result.Set(id, reference)
		short := jscompat.Get(entity, "short_name")
		if jscompat.Truthy(short) && !jscompat.StrictEqual(short, jscompat.Get(entity, "name")) {
			reference.Set("short_name", short)
		}
	}
	return result, nil
}
