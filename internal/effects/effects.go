// Package effects — библиотека локальных эффектов кадра: сборка плана из опор-состояний,
// эффекты поверх кадров (дождь, свет, зерно, цифровой наезд) и реверс — перестановка кадров принятого видео.
// Эффект — модуль с идентификатором, версией и схемой параметров; новый эффект добавляется
// одним файлом с регистрацией в init, остальное приложение узнаёт о нём только из реестра
// (Kinds, Lookup). Агент в эффектах не участвует: результат определяется рецептом (источник,
// цепочка эффектов, параметры) и не зависит от порядка рендера кадров.
//
// Кадры обрабатываются в линейном свете (Frame), видео кодирует FFmpeg через общий запуск
// процессов (Render). Пакет не знает о файлах проекта: где лежат опоры, рецепт и результат,
// решают вызывающие (производство плана из опор, страница эффектов).
package effects

import (
	"fmt"
	"math"
	"sort"
)

// ParamSpec — описание числового параметра эффекта: по нему проверяется рецепт и строится
// панель параметров в интерфейсе. Title — подпись для человека; Step — шаг значения на панели.
// Целый шаг (1, 10) задают только целым параметрам (пиксели, кадры, слои, число капель, вариант
// картины): Resolve отвергает у них дробные значения. Дробным параметрам шаг меньше единицы.
type ParamSpec struct {
	Name    string  `json:"name"`
	Title   string  `json:"title"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	Default float64 `json:"default"`
	Step    float64 `json:"step"`
	// Hint — подсказка человеку простыми словами: что меняет параметр и какие значения к чему ведут.
	Hint string `json:"hint"`
}

// Integer — параметр принимает только целые значения.
func (s ParamSpec) Integer() bool { return s.Step >= 1 && s.Step == math.Trunc(s.Step) }

// Params — значения всех параметров эффекта после Resolve.
type Params map[string]float64

// Resolve — значения параметров по схеме: заданное значение проверяется по диапазону,
// отсутствующее берётся по умолчанию. Неизвестное имя — ошибка: опечатка в рецепте не должна
// молча давать значение по умолчанию.
func Resolve(specs []ParamSpec, given map[string]float64) (Params, error) {
	known := make(map[string]bool, len(specs))
	result := make(Params, len(specs))
	for _, spec := range specs {
		known[spec.Name] = true
		value, ok := given[spec.Name]
		if !ok {
			value = spec.Default
		}
		if math.IsNaN(value) || math.IsInf(value, 0) || value < spec.Min || value > spec.Max {
			return nil, fmt.Errorf("«%s»: значение %v вне диапазона от %v до %v", spec.Title, value, spec.Min, spec.Max)
		}
		if spec.Integer() && value != math.Trunc(value) {
			return nil, fmt.Errorf("«%s»: нужно целое значение, получено %v", spec.Title, value)
		}
		result[spec.Name] = value
	}
	var unknown []string
	for name := range given {
		if !known[name] {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, fmt.Errorf("неизвестные параметры: %v", unknown)
	}
	return result, nil
}

// Context — сведения о текущем кадре, общие для цепочки эффектов. Lights наполняют эффекты
// света: следующие за ними эффекты (дождь) учитывают этот свет. Новый Context создаётся на
// каждый кадр, поэтому эффект не может перенести в него состояние между кадрами.
type Context struct {
	Frame, Frames int
	FPS           float64
	Lights        []LightField
}

// LightField — свет источника в точке кадра (пиксели), линейные RGB.
type LightField interface {
	At(x, y float64) [3]float32
}

// Effect — обработка кадра на месте. Реализация может держать буферы между вызовами, но
// результат кадра зависит только от Context и входного кадра.
type Effect interface {
	Apply(ctx *Context, frame *Frame)
}

// Kind — регистрируемый вид эффекта. Version меняется вместе с изменением результата при тех же
// параметрах: по ней вызывающие отличают устаревший производный файл. WindAngle — имя параметра
// экранного наклона, который вызывающий может вычислить из ветра и направления камеры
// (ScreenAngle); "" — эффект от ветра не зависит. Order — место в цепочке по умолчанию: реверс
// первым (переставляет кадры источника), наезд до света, дождя и зерна (капли и зерно не растут вместе с
// кадром), свет раньше дождя (капли подсвечиваются им), зерно последним (ложится поверх всего).
type Kind struct {
	ID    string
	Title string
	// Hint — когда и зачем применять эффект и что получится; показывается на странице «Эффекты».
	Hint      string
	Version   int
	Order     int
	Params    []ParamSpec
	WindAngle string
	// Reverse — эффект не меняет пиксели, а переставляет кадры источника задом наперёд: вызывающий
	// читает источник в обратном порядке (OpenVideoReversed), и остальные эффекты цепочки, где бы
	// реверс в ней ни стоял, ложатся уже на развёрнутое видео со своим временем вывода.
	Reverse bool
	// PlanTime — параметры, задающие момент плана долей его длины (0 — первый кадр, 1 — последний):
	// рецепт хранит долю, а интерфейс показывает и принимает секунды плана с отметками строк песни.
	PlanTime []string
	// Beam — параметры источника и луча, которые интерфейс ставит мышью на кадре; nil — у эффекта
	// нет источника.
	Beam *Beam
	New  func(p Params, size Size) Effect
}

// Beam — имена параметров источника света и его луча. Координаты источника — доли ширины и высоты
// кадра (за краем — меньше 0 или больше 1), дальность — доля диагонали кадра, направление —
// градусы на экране против часовой стрелки от направления вправо, ширина — полный угол конуса в
// градусах (360 — во все стороны).
type Beam struct {
	X         string `json:"x"`
	Y         string `json:"y"`
	Radius    string `json:"radius"`
	Direction string `json:"direction"`
	Cone      string `json:"cone"`
}

// Size — размер и длина ролика, которые эффект знает при создании.
type Size struct {
	Width, Height, Frames int
}

var registry = map[string]Kind{}

// register добавляет вид эффекта; повтор идентификатора — ошибка программы.
func register(kind Kind) {
	if _, ok := registry[kind.ID]; ok {
		panic("effects: повторный идентификатор " + kind.ID)
	}
	registry[kind.ID] = kind
}

// Kinds — зарегистрированные эффекты в порядке цепочки (Order, затем идентификатор).
func Kinds() []Kind {
	result := make([]Kind, 0, len(registry))
	for _, kind := range registry {
		result = append(result, kind)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Order != result[j].Order {
			return result[i].Order < result[j].Order
		}
		return result[i].ID < result[j].ID
	})
	return result
}

// Lookup — вид эффекта по идентификатору.
func Lookup(id string) (Kind, bool) {
	kind, ok := registry[id]
	return kind, ok
}

// Step — эффект цепочки в рецепте: идентификатор и заданные параметры (остальные — по
// умолчанию).
type Step struct {
	ID     string             `json:"id"`
	Params map[string]float64 `json:"params,omitempty"`
}

// Reversed — есть ли в цепочке эффект, разворачивающий источник (Kind.Reverse). Неизвестные
// идентификаторы не учитываются: их отвергает Build.
func Reversed(steps []Step) bool {
	for _, step := range steps {
		if kind, ok := Lookup(step.ID); ok && kind.Reverse {
			return true
		}
	}
	return false
}

// Build создаёт цепочку эффектов рецепта в заданном порядке.
func Build(steps []Step, size Size) ([]Effect, error) {
	chain := make([]Effect, 0, len(steps))
	for _, step := range steps {
		kind, ok := Lookup(step.ID)
		if !ok {
			return nil, fmt.Errorf("неизвестный эффект %q", step.ID)
		}
		params, err := Resolve(kind.Params, step.Params)
		if err != nil {
			return nil, fmt.Errorf("эффект %s: %w", step.ID, err)
		}
		chain = append(chain, kind.New(params, size))
	}
	return chain, nil
}

// smoothstep — плавный переход от 0 при x ≤ a к 1 при x ≥ b.
func smoothstep(a, b, x float64) float64 {
	if b <= a {
		if x < a {
			return 0
		}
		return 1
	}
	t := math.Max(0, math.Min(1, (x-a)/(b-a)))
	return t * t * (3 - 2*t)
}

// hash — детерминированное псевдослучайное число [0, 1) по двум ключам: эффекты не держат
// генератор случайных чисел, поэтому кадр t не зависит от того, какие кадры считались раньше.
func hash(a, b uint32) float64 {
	x := a*0x9E3779B1 ^ (b+0x7F4A7C15)*0x85EBCA77
	x ^= x >> 15
	x *= 0x2C1B3C6D
	x ^= x >> 12
	x *= 0x297A2D39
	x ^= x >> 15
	return float64(x) / 4294967296
}
