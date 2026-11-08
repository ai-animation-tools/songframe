// Package castregistry читает кастинг для инструментов tools.run (scene_registry, scene_scaffold,
// проверки): загрузка (Load), проверка (Validate), проекция описаний из source/manifest.json,
// начальные состояния (InitialStates) и карта референсов (References).
//
// Кастинг для страниц приложения читает internal/cast. Здесь — модель значений инструментов:
// значения toolrt, тексты проблем инструмента (они отличаются от текстов страниц) и его исключения на
// данных неожиданной формы; от них зависят байты вывода, проверяемые эталонами. Пакет только
// читает файлы проекта.
package castregistry

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/toolrt"
)

// Пути внутри проекта.
const (
	CastPath       = "plan/cast.json"
	SourceManifest = "source/manifest.json"
	// WorldID — зарезервированный тип и код сущности мира.
	WorldID = "world"
)

// kindPattern — допустимый тип сущности; один завершающий перевод строки тоже принимается
// (зафиксировано эталонами инструментов).
var kindPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*\n?\z`)

// Тексты проблем Validate и отказов чтения; зафиксированы эталонами инструментов.
const (
	textStructure        = "cast.json: нужны schema_version 1, entities и properties."
	textEntityNotObject  = "entities: элемент не объект."
	textEntityWithoutID  = "entities: сущность без id."
	textWorldNotSingle   = "Сущность типа world должна быть одна."
	textCastDamaged      = CastPath + " повреждён."
	textManifestDamaged  = SourceManifest + " повреждён."
	textReferencesNoList = SourceManifest + ": references должен быть списком."
	textReferenceNoID    = SourceManifest + ": у референса нет строкового id."
)

// Validate — список проблем структуры кастинга (пустой — кастинг пригоден).
// Ошибка — исключение toolrt на данных неожиданной формы (например, images — число).
func Validate(data any) ([]string, error) {
	document, ok := data.(*toolrt.Dict)
	if !ok || !toolrt.Equal(document.Value("schema_version"), toolrt.NewInt(1)) {
		return []string{textStructure}, nil
	}
	entities, entitiesOK := document.Value("entities").([]any)
	if _, propertiesOK := document.Value("properties").(*toolrt.Dict); !entitiesOK || !propertiesOK {
		return []string{textStructure}, nil
	}
	problems := []string{}
	seen := map[string]bool{}
	for _, item := range entities {
		entity, ok := item.(*toolrt.Dict)
		if !ok {
			problems = append(problems, textEntityNotObject)
			continue
		}
		id, isString := entity.Value("id").(string)
		if !isString || id == "" {
			problems = append(problems, textEntityWithoutID)
			continue
		}
		if seen[id] {
			problems = append(problems, id+": id повторяется.")
		}
		seen[id] = true
		if kind, isString := entity.Value("kind").(string); !isString || !kindPattern.MatchString(kind) {
			problems = append(problems, id+": тип должен быть кодом из латиницы, цифр и подчёркивания.")
		}
		if name, isString := entity.Value("name").(string); !isString || toolrt.Strip(name) == "" {
			problems = append(problems, id+": нет названия.")
		}
		images, _ := toolrt.DictGet(entity, "images", []any{})
		if !toolrt.Truthy(images) {
			images = []any{}
		}
		list, err := toolrt.Iter(images)
		if err != nil {
			return nil, err
		}
		for _, image := range list {
			if text, isString := image.(string); !isString || !strings.Contains(text, "/") {
				problems = append(problems, id+": путь изображения должен быть вида heroes/<файл>.")
			}
		}
		state, _ := toolrt.DictGet(entity, "initial_state", toolrt.NewDict())
		if !validState(state) {
			problems = append(problems, id+": initial_state должен быть объектом из непустых строк.")
		}
	}
	worlds := 0
	for _, item := range entities {
		if entity, ok := item.(*toolrt.Dict); ok && toolrt.Equal(entity.Value("kind"), WorldID) {
			worlds++
		}
	}
	if worlds > 1 {
		problems = append(problems, textWorldNotSingle)
	}
	return problems, nil
}

// validState — пригодный initial_state: словарь непустых (без пробелов по краям) строк.
func validState(value any) bool {
	state, ok := value.(*toolrt.Dict)
	if !ok {
		return false
	}
	for _, key := range state.Keys() {
		text, isString := state.Value(key).(string)
		if !isString || toolrt.Strip(text) == "" {
			return false
		}
	}
	return true
}

// SourceDescriptions — id референса → общее описание из описи исходников,
// включая явно пустую строку.
func SourceDescriptions(manifest *toolrt.Dict) (map[string]string, error) {
	references, _ := toolrt.DictGet(manifest, "references", []any{})
	list, ok := references.([]any)
	if !ok {
		return nil, toolrt.New(toolrt.ValueError, textReferencesNoList)
	}
	descriptions := map[string]string{}
	for _, item := range list {
		reference, ok := item.(*toolrt.Dict)
		id, isString := reference.Value("id").(string)
		if !ok || !isString {
			return nil, toolrt.New(toolrt.ValueError, textReferenceNoID)
		}
		description, _ := toolrt.DictGet(reference, "description", "")
		text, isString := description.(string)
		if !isString {
			return nil, toolrt.Raise(toolrt.ValueError, "%s: description референса %s должен быть строкой.", SourceManifest, id)
		}
		descriptions[id] = text
	}
	return descriptions, nil
}

// projectSavedDescriptions — appearance сущностей заменяется
// описаниями из source/manifest.json (проекция в памяти, файлы не меняются). Нет описи — кастинг
// как есть; повреждённая опись — ValueError.
func projectSavedDescriptions(root string, cast *toolrt.Dict) (*toolrt.Dict, error) {
	path := filepath.Join(root, filepath.FromSlash(SourceManifest))
	value, damaged := toolrt.ReadJSON(path)
	if value == nil && !damaged {
		// Опись пропускается, только если файла нет: документ `null` в существующем файле — повреждение.
		if _, err := os.Stat(path); err != nil {
			return cast, nil
		}
	}
	manifest, ok := value.(*toolrt.Dict)
	if !ok || !toolrt.Equal(manifest.Value("schema_version"), toolrt.NewInt(1)) {
		return nil, toolrt.New(toolrt.ValueError, textManifestDamaged)
	}
	descriptions, err := SourceDescriptions(manifest)
	if err != nil {
		return nil, err
	}
	entities, _ := cast.Value("entities").([]any)
	for _, item := range entities {
		entity := item.(*toolrt.Dict)
		if description, ok := descriptions[entity.Value("id").(string)]; ok {
			entity.Set("appearance", description)
		}
	}
	return cast, nil
}

// Load — кастинг проекта root с описаниями из описи или nil, если файла нет (или в нём
// `null`). Повреждённый файл, проблемы Validate и повреждённая опись — ValueError с текстом
// проблем через пробел.
func Load(root string) (*toolrt.Dict, error) {
	value, damaged := toolrt.ReadJSON(filepath.Join(root, filepath.FromSlash(CastPath)))
	if damaged {
		return nil, toolrt.New(toolrt.ValueError, textCastDamaged)
	}
	if value == nil {
		return nil, nil
	}
	problems, err := Validate(value)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, toolrt.New(toolrt.ValueError, strings.Join(problems, " "))
	}
	return projectSavedDescriptions(root, value.(*toolrt.Dict))
}

// InitialStates — {сущность: {свойство: значение}} для сущностей кастинга с непустым
// initial_state; nil-кастинг — пустой словарь. Кастинг должен пройти Validate.
func InitialStates(cast *toolrt.Dict) *toolrt.Dict {
	result := toolrt.NewDict()
	if cast == nil || cast.Len() == 0 {
		return result
	}
	entities, _ := cast.Value("entities").([]any)
	for _, item := range entities {
		entity := item.(*toolrt.Dict)
		if state, ok := entity.Value("initial_state").(*toolrt.Dict); ok && state.Len() > 0 {
			result.Set(entity.Value("id").(string), state.Clone())
		}
	}
	return result
}

// References — карта references реестра сцен из сущностей кастинга с изображением
// (первый файл — основной, путь от корня проекта). short_name добавляется, если отличается от name.
func References(cast *toolrt.Dict) (*toolrt.Dict, error) {
	result := toolrt.NewDict()
	entities, _ := cast.Value("entities").([]any)
	for _, item := range entities {
		entity := item.(*toolrt.Dict)
		if !toolrt.Truthy(entity.Value("images")) {
			continue
		}
		first, err := toolrt.GetItem(entity.Value("images"), toolrt.NewInt(0))
		if err != nil {
			return nil, err
		}
		path, err := toolrt.Add("source/", first)
		if err != nil {
			return nil, err
		}
		reference := toolrt.NewDict()
		name, err := toolrt.Item(entity, "name")
		if err != nil {
			return nil, err
		}
		reference.Set("name", name)
		reference.Set("path", path)
		if short := entity.Value("short_name"); toolrt.Truthy(short) && !toolrt.Equal(short, name) {
			reference.Set("short_name", short)
		}
		result.Set(entity.Value("id").(string), reference)
	}
	return result, nil
}
