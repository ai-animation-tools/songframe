package cast

import (
	_ "embed"
	"fmt"

	"songframe-go/internal/jscompat"
)

// WorldID — код единственной сущности типа world: общие условия сцены (время, погода, окружение).
const WorldID = "world"

// defaultProperties — словарь свойств по умолчанию, побайтная копия
// tools/cast_registry/default_properties.json замороженного оригинала (634fd94). В Electron его
// читал loadDefaults из каталога комплекса; в поставке комплекс был всегда, поэтому резервный набор
// FALLBACK оригинала здесь не нужен. Словарь сохраняется в cast.json как данные проекта
// (properties типов, сущность world), поэтому его тексты не относятся к подписям интерфейса.
//
//go:embed default_properties.json
var defaultProperties []byte

// Defaults — разобранный словарь: свойства известных типов, общий набор для прочих типов и
// шаблон сущности world. Каждый вызов LoadDefaults даёт независимое дерево: вызывающий может
// вставлять его части в документ без копирования.
type Defaults struct {
	// Default — тип сущности → массив свойств (CastProperty[]).
	Default *jscompat.Object
	// Generic — свойства для типа без собственного словаря.
	Generic *jscompat.Array
	// World — сущность «Мир сцены» для нового кастинга.
	World *jscompat.Object
}

// LoadDefaults разбирает встроенный словарь. Ошибка означает повреждённую сборку, а не данные
// пользователя, поэтому приводит к панике: без словаря кастинг не может работать вовсе.
func LoadDefaults() Defaults {
	value, err := jscompat.Parse(defaultProperties)
	if err != nil {
		panic(fmt.Sprintf("встроенный словарь кастинга повреждён: %v", err))
	}
	root, _ := jscompat.AsObject(value)
	defaults, _ := jscompat.AsObject(root.Value("default"))
	generic, _ := root.Value("generic").(*jscompat.Array)
	world, _ := jscompat.AsObject(root.Value("world"))
	if defaults == nil || generic == nil || world == nil {
		panic("встроенный словарь кастинга без default, generic или world")
	}
	return Defaults{Default: defaults, Generic: generic, World: world}
}
