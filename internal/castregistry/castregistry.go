// Package castregistry читает кастинг для инструментов tools.run (scene_registry, scene_scaffold,
// проверки): load_cast, validate_cast, проекция описаний из source/manifest.json, initial_states и
// references.
//
// Кастинг для страниц приложения читает internal/cast. Здесь — семантика Python: значения
// pycompat, тексты проблем инструмента (они отличаются от текстов страниц) и его исключения на
// данных неожиданной формы; от них зависят байты вывода, проверяемые эталонами. Пакет только
// читает файлы проекта.
package castregistry

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/pycompat"
)

// Пути внутри проекта.
const (
	CastPath       = "plan/cast.json"
	SourceManifest = "source/manifest.json"
	// WorldID — зарезервированный тип и код сущности мира.
	WorldID = "world"
)

// kindPattern — KIND_PATTERN.match: `$` Python совпадает и перед последним переводом строки.
var kindPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*\n?\z`)

// Тексты проблем validate_cast и отказов чтения; зафиксированы эталонами инструментов.
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

// Validate — validate_cast: список проблем структуры кастинга (пустой — кастинг пригоден).
// Ошибка — исключение Python на данных неожиданной формы (например, images — число).
func Validate(data any) ([]string, error) {
	document, ok := data.(*pycompat.Dict)
	if !ok || !pycompat.Equal(document.Value("schema_version"), pycompat.NewInt(1)) {
		return []string{textStructure}, nil
	}
	entities, entitiesOK := document.Value("entities").([]any)
	if _, propertiesOK := document.Value("properties").(*pycompat.Dict); !entitiesOK || !propertiesOK {
		return []string{textStructure}, nil
	}
	problems := []string{}
	seen := map[string]bool{}
	for _, item := range entities {
		entity, ok := item.(*pycompat.Dict)
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
		if name, isString := entity.Value("name").(string); !isString || pycompat.Strip(name) == "" {
			problems = append(problems, id+": нет названия.")
		}
		images, _ := pycompat.DictGet(entity, "images", []any{})
		if !pycompat.Truthy(images) {
			images = []any{}
		}
		list, err := pycompat.Iter(images)
		if err != nil {
			return nil, err
		}
		for _, image := range list {
			if text, isString := image.(string); !isString || !strings.Contains(text, "/") {
				problems = append(problems, id+": путь изображения должен быть вида heroes/<файл>.")
			}
		}
		state, _ := pycompat.DictGet(entity, "initial_state", pycompat.NewDict())
		if !validState(state) {
			problems = append(problems, id+": initial_state должен быть объектом из непустых строк.")
		}
	}
	worlds := 0
	for _, item := range entities {
		if entity, ok := item.(*pycompat.Dict); ok && pycompat.Equal(entity.Value("kind"), WorldID) {
			worlds++
		}
	}
	if worlds > 1 {
		problems = append(problems, textWorldNotSingle)
	}
	return problems, nil
}

// validState — initial_state: словарь непустых (после strip) строк.
func validState(value any) bool {
	state, ok := value.(*pycompat.Dict)
	if !ok {
		return false
	}
	for _, key := range state.Keys() {
		text, isString := state.Value(key).(string)
		if !isString || pycompat.Strip(text) == "" {
			return false
		}
	}
	return true
}

// SourceDescriptions — source_descriptions: id референса → общее описание из описи исходников,
// включая явно пустую строку.
func SourceDescriptions(manifest *pycompat.Dict) (map[string]string, error) {
	references, _ := pycompat.DictGet(manifest, "references", []any{})
	list, ok := references.([]any)
	if !ok {
		return nil, pycompat.New(pycompat.ValueError, textReferencesNoList)
	}
	descriptions := map[string]string{}
	for _, item := range list {
		reference, ok := item.(*pycompat.Dict)
		id, isString := reference.Value("id").(string)
		if !ok || !isString {
			return nil, pycompat.New(pycompat.ValueError, textReferenceNoID)
		}
		description, _ := pycompat.DictGet(reference, "description", "")
		text, isString := description.(string)
		if !isString {
			return nil, pycompat.Raise(pycompat.ValueError, "%s: description референса %s должен быть строкой.", SourceManifest, id)
		}
		descriptions[id] = text
	}
	return descriptions, nil
}

// projectSavedDescriptions — project_saved_descriptions: appearance сущностей заменяется
// описаниями из source/manifest.json (проекция в памяти, файлы не меняются). Нет описи — кастинг
// как есть; повреждённая опись — ValueError.
func projectSavedDescriptions(root string, cast *pycompat.Dict) (*pycompat.Dict, error) {
	path := filepath.Join(root, filepath.FromSlash(SourceManifest))
	value, damaged := pycompat.ReadJSON(path)
	if value == nil && !damaged {
		// `manifest is None and not path.exists()`: документ `null` в существующем файле — повреждение.
		if _, err := os.Stat(path); err != nil {
			return cast, nil
		}
	}
	manifest, ok := value.(*pycompat.Dict)
	if !ok || !pycompat.Equal(manifest.Value("schema_version"), pycompat.NewInt(1)) {
		return nil, pycompat.New(pycompat.ValueError, textManifestDamaged)
	}
	descriptions, err := SourceDescriptions(manifest)
	if err != nil {
		return nil, err
	}
	entities, _ := cast.Value("entities").([]any)
	for _, item := range entities {
		entity := item.(*pycompat.Dict)
		if description, ok := descriptions[entity.Value("id").(string)]; ok {
			entity.Set("appearance", description)
		}
	}
	return cast, nil
}

// Load — load_cast(root): кастинг проекта с описаниями из описи или nil, если файла нет (или в нём
// `null`). Повреждённый файл, проблемы Validate и повреждённая опись — ValueError с текстом
// проблем через пробел.
func Load(root string) (*pycompat.Dict, error) {
	value, damaged := pycompat.ReadJSON(filepath.Join(root, filepath.FromSlash(CastPath)))
	if damaged {
		return nil, pycompat.New(pycompat.ValueError, textCastDamaged)
	}
	if value == nil {
		return nil, nil
	}
	problems, err := Validate(value)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, pycompat.New(pycompat.ValueError, strings.Join(problems, " "))
	}
	return projectSavedDescriptions(root, value.(*pycompat.Dict))
}

// InitialStates — initial_states(cast): {сущность: {свойство: значение}} для сущностей с непустым
// initial_state; nil-кастинг — пустой словарь. Кастинг должен пройти Validate.
func InitialStates(cast *pycompat.Dict) *pycompat.Dict {
	result := pycompat.NewDict()
	if cast == nil || cast.Len() == 0 {
		return result
	}
	entities, _ := cast.Value("entities").([]any)
	for _, item := range entities {
		entity := item.(*pycompat.Dict)
		if state, ok := entity.Value("initial_state").(*pycompat.Dict); ok && state.Len() > 0 {
			result.Set(entity.Value("id").(string), state.Clone())
		}
	}
	return result
}

// References — references(cast): карта references реестра сцен из сущностей с изображением
// (первый файл — основной, путь от корня проекта). short_name добавляется, если отличается от name.
func References(cast *pycompat.Dict) (*pycompat.Dict, error) {
	result := pycompat.NewDict()
	entities, _ := cast.Value("entities").([]any)
	for _, item := range entities {
		entity := item.(*pycompat.Dict)
		if !pycompat.Truthy(entity.Value("images")) {
			continue
		}
		first, err := pycompat.GetItem(entity.Value("images"), pycompat.NewInt(0))
		if err != nil {
			return nil, err
		}
		path, err := pycompat.Add("source/", first)
		if err != nil {
			return nil, err
		}
		reference := pycompat.NewDict()
		name, err := pycompat.Item(entity, "name")
		if err != nil {
			return nil, err
		}
		reference.Set("name", name)
		reference.Set("path", path)
		if short := entity.Value("short_name"); pycompat.Truthy(short) && !pycompat.Equal(short, name) {
			reference.Set("short_name", short)
		}
		result.Set(entity.Value("id").(string), reference)
	}
	return result, nil
}
