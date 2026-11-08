package cast

import (
	_ "embed"
	"fmt"

	"songframe/internal/dynvalue"
)

// WorldID — код единственной сущности типа world: общие условия сцены (время, погода, окружение).
const WorldID = "world"

// defaultProperties — словарь свойств по умолчанию, встроенный в бинарник: он всегда доступен,
// поэтому резервный набор не нужен. Словарь сохраняется в cast.json как данные проекта
// (properties типов, сущность world), поэтому его тексты не относятся к подписям интерфейса.
//
//go:embed default_properties.json
var defaultProperties []byte

// Defaults — разобранный словарь: свойства известных типов, общий набор для прочих типов и
// шаблон сущности world. Каждый вызов LoadDefaults даёт независимое дерево: вызывающий может
// вставлять его части в документ без копирования.
type Defaults struct {
	// Default — тип сущности → массив свойств (CastProperty[]).
	Default *dynvalue.Object
	// Generic — свойства для типа без собственного словаря.
	Generic *dynvalue.Array
	// World — сущность «Мир сцены» для нового кастинга.
	World *dynvalue.Object
}

// LoadDefaults разбирает встроенный словарь. Ошибка означает повреждённую сборку, а не данные
// пользователя, поэтому приводит к панике: без словаря кастинг не может работать вовсе.
func LoadDefaults() Defaults {
	value, err := dynvalue.Parse(defaultProperties)
	if err != nil {
		panic(fmt.Sprintf("встроенный словарь кастинга повреждён: %v", err))
	}
	root, _ := dynvalue.AsObject(value)
	defaults, _ := dynvalue.AsObject(root.Value("default"))
	generic, _ := root.Value("generic").(*dynvalue.Array)
	world, _ := dynvalue.AsObject(root.Value("world"))
	if defaults == nil || generic == nil || world == nil {
		panic("встроенный словарь кастинга без default, generic или world")
	}
	return Defaults{Default: defaults, Generic: generic, World: world}
}
