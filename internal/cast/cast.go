// Package cast читает кастинг plan/cast.json для вычислений, которым нужны сущности проекта:
// начальное состояние сущностей входит в отпечаток постановки каждого плана.
//
// Чтение повторяет readCast и initialStates оригинала на дереве jscompat: документ не проверяется
// по схеме, а описание (appearance) сущности, связанной со ссылкой исходников, заменяется
// каноническим описанием из source/manifest.json. Пакет ничего не записывает.
package cast

import (
	"path/filepath"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/sources"
)

// Result различает три исхода readCast: файла нет, файл повреждён и прочитанный документ.
type Result struct {
	// Value — документ после проекции описаний; nil при Missing или Damaged, а также для JSON null.
	Value any
	// Missing — plan/cast.json отсутствует (null оригинала).
	Missing bool
	// Damaged — файл есть, но не разбирается или опись исходников непригодна (false оригинала).
	Damaged bool
}

// Path — путь кастинга внутри проекта.
func Path(project string) string {
	return filepath.Join(project, "plan", "cast.json")
}

// Read читает кастинг. Ошибка разбора, непригодная опись и исключение проекции (сущность null)
// делают результат Damaged, как catch в readCast.
func Read(project string) Result {
	path := Path(project)
	if !jscompat.Exists(path) {
		return Result{Missing: true}
	}
	data, ok := jscompat.ReadJSONFile(path)
	if !ok {
		return Result{Damaged: true}
	}
	manifest, err := sources.DescriptionManifest(project)
	if err != nil {
		return Result{Damaged: true}
	}
	value, err := ProjectDescriptions(data, manifest)
	if err != nil {
		return Result{Damaged: true}
	}
	return Result{Value: value}
}

// ProjectDescriptions — projectCastDescriptions: appearance сущности со ссылкой в описи заменяется
// её description (отсутствующее — пустой строкой). Без описи или без массива entities документ
// возвращается как есть. Сущность null/undefined даёт TypeError, как обращение entity.id.
func ProjectDescriptions(cast, manifest any) (any, error) {
	entities, ok := jscompat.AsArray(jscompat.Get(cast, "entities"))
	if !ok || !jscompat.Truthy(manifest) {
		return cast, nil
	}
	descriptions := map[string]string{}
	references, _ := jscompat.AsArray(jscompat.Get(manifest, "references"))
	for _, ref := range references {
		id, err := jscompat.Prop(ref, "id")
		if err != nil {
			return nil, err
		}
		text, _ := jscompat.Coalesce(jscompat.Get(ref, "description"), "").(string)
		if key, ok := id.(string); ok {
			descriptions[key] = text
		}
	}
	projected := make([]any, len(entities))
	for index, entity := range entities {
		id, err := jscompat.Prop(entity, "id")
		if err != nil {
			return nil, err
		}
		key, isString := id.(string)
		description, found := descriptions[key]
		if !isString || !found {
			projected[index] = entity
			continue
		}
		copy := jscompat.Spread(entity)
		copy.Set("appearance", description)
		projected[index] = copy
	}
	result := jscompat.Spread(cast)
	result.Set("entities", &jscompat.Array{Items: projected})
	return result, nil
}

// InitialStates — initialStates: для каждой сущности с непустым initial_state — его копия под
// ключом String(entity.id). Нестандартные значения обрабатываются по правилам JS: строка или массив
// в initial_state дают индексные ключи, отсутствующий initial_state — TypeError Object.keys.
// Ошибка поднимается вызывающему: при вычислении отпечатков оригинал выводит её текст в проблеме.
func InitialStates(cast any) (*jscompat.Object, error) {
	result := jscompat.NewObject()
	entities, err := jscompat.Iterate(jscompat.Coalesce(jscompat.Get(cast, "entities"), &jscompat.Array{}))
	if err != nil {
		return nil, err
	}
	for _, entity := range entities {
		state, err := jscompat.Prop(entity, "initial_state")
		if err != nil {
			return nil, err
		}
		keys, err := jscompat.Keys(state)
		if err != nil {
			return nil, err
		}
		if len(keys) > 0 {
			result.Set(jscompat.ToString(jscompat.Get(entity, "id")), jscompat.Spread(state))
		}
	}
	return result, nil
}
