// Package cast читает кастинг plan/cast.json для вычислений, которым нужны сущности проекта:
// начальное состояние сущностей входит в отпечаток постановки каждого плана.
//
// Чтение идёт по дереву dynvalue: документ не проверяется
// по схеме, а описание (appearance) сущности, связанной со ссылкой исходников, заменяется
// каноническим описанием из source/manifest.json. Пакет ничего не записывает.
package cast

import (
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/sources"
)

// Result различает три исхода Read: файла нет, файл повреждён и прочитанный документ.
type Result struct {
	// Value — документ после проекции описаний; nil при Missing или Damaged, а также для JSON null.
	Value any
	// Missing — plan/cast.json отсутствует.
	Missing bool
	// Damaged — файл есть, но не разбирается или опись исходников непригодна.
	Damaged bool
}

// Path — путь кастинга внутри проекта.
func Path(project string) string {
	return filepath.Join(project, "plan", "cast.json")
}

// Read читает кастинг. Ошибка разбора, непригодная опись и исключение проекции (сущность null)
// делают результат Damaged: страница показывает повреждение, а не ошибку вызова.
func Read(project string) Result {
	path := Path(project)
	if !dynvalue.Exists(path) {
		return Result{Missing: true}
	}
	data, ok := dynvalue.ReadJSONFile(path)
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

// ProjectDescriptions проецирует описания: appearance сущности со ссылкой в описи заменяется
// её description (отсутствующее — пустой строкой). Без описи или без массива entities документ
// возвращается как есть. Отсутствующая сущность (null) даёт TypeError обращения к её id.
func ProjectDescriptions(cast, manifest any) (any, error) {
	entities, ok := dynvalue.AsArray(dynvalue.Get(cast, "entities"))
	if !ok || !dynvalue.Truthy(manifest) {
		return cast, nil
	}
	descriptions := map[string]string{}
	references, _ := dynvalue.AsArray(dynvalue.Get(manifest, "references"))
	for _, ref := range references {
		id, err := dynvalue.Prop(ref, "id")
		if err != nil {
			return nil, err
		}
		text, _ := dynvalue.Coalesce(dynvalue.Get(ref, "description"), "").(string)
		if key, ok := id.(string); ok {
			descriptions[key] = text
		}
	}
	projected := make([]any, len(entities))
	for index, entity := range entities {
		id, err := dynvalue.Prop(entity, "id")
		if err != nil {
			return nil, err
		}
		key, isString := id.(string)
		description, found := descriptions[key]
		if !isString || !found {
			projected[index] = entity
			continue
		}
		copy := dynvalue.Spread(entity)
		copy.Set("appearance", description)
		projected[index] = copy
	}
	result := dynvalue.Spread(cast)
	result.Set("entities", &dynvalue.Array{Items: projected})
	return result, nil
}

// InitialStates собирает начальные состояния: для каждой сущности с непустым initial_state —
// его копия под ключом id сущности, приведённым к строке (dynvalue.ToString). Нестандартные значения
// не отклоняются: строка или массив в initial_state дают индексные ключи, отсутствующий
// initial_state — TypeError перечисления ключей (dynvalue.Keys).
// Ошибка поднимается вызывающему: при вычислении отпечатков её текст выводится в проблеме.
func InitialStates(cast any) (*dynvalue.Object, error) {
	result := dynvalue.NewObject()
	entities, err := dynvalue.Iterate(dynvalue.Coalesce(dynvalue.Get(cast, "entities"), &dynvalue.Array{}))
	if err != nil {
		return nil, err
	}
	for _, entity := range entities {
		state, err := dynvalue.Prop(entity, "initial_state")
		if err != nil {
			return nil, err
		}
		keys, err := dynvalue.Keys(state)
		if err != nil {
			return nil, err
		}
		if len(keys) > 0 {
			result.Set(dynvalue.ToString(dynvalue.Get(entity, "id")), dynvalue.Spread(state))
		}
	}
	return result, nil
}
