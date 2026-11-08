package toolrt

import (
	"math/big"
	"strings"
)

// Операции над значениями модели с типизированными исключениями. Инструмент вызывает их там, где
// значения из JSON индексируются, перебираются или складываются без проверки типа: неверные
// данные дают исключение с зафиксированным эталонами текстом (нет ключа 'start', ожидается
// объект и т.п.), которое попадает в stderr инструмента.

// GetItem — container[key] для словаря, списка и строки: у списка и строки целый индекс,
// отрицательный отсчитывается с конца; строка индексируется кодовыми точками.
func GetItem(container, key any) (any, error) {
	switch item := container.(type) {
	case *Dict:
		text, isString := key.(string)
		if !isString {
			if _, err := HashKey(key); err != nil {
				return nil, err
			}
			return nil, NewKeyError(key)
		}
		value, ok := item.values[text]
		if !ok {
			return nil, NewKeyError(key)
		}
		return value, nil
	case []any:
		index, ok := indexOf(key)
		if !ok {
			return nil, Raise(TypeError, "индекс списка должен быть целым числом, получено: %s", TypeName(key))
		}
		if index < 0 {
			index += int64(len(item))
		}
		if index < 0 || index >= int64(len(item)) {
			return nil, Raise(IndexError, "индекс за пределами списка")
		}
		return item[index], nil
	case string:
		index, ok := indexOf(key)
		if !ok {
			return nil, Raise(TypeError, "индекс строки должен быть целым числом, получено: %s", TypeName(key))
		}
		runes := Runes(item)
		if index < 0 {
			index += int64(len(runes))
		}
		if index < 0 || index >= int64(len(runes)) {
			return nil, Raise(IndexError, "индекс за пределами строки")
		}
		return FromRunes(runes[index : index+1]), nil
	}
	return nil, Raise(TypeError, "нельзя обратиться по индексу или ключу: %s", TypeName(container))
}

// indexOf — целый индекс из Int или bool.
func indexOf(key any) (int64, bool) {
	switch item := key.(type) {
	case bool:
		if item {
			return 1, true
		}
		return 0, true
	case Int:
		value, ok := item.Int64()
		return value, ok
	}
	return 0, false
}

// Item — container[key] для строкового ключа (самый частый случай).
func Item(container any, key string) (any, error) { return GetItem(container, key) }

// DictGet — значение ключа словаря или fallback; не-словарь — AttributeError «ожидается объект».
func DictGet(value any, key string, fallback any) (any, error) {
	dict, ok := value.(*Dict)
	if !ok {
		return nil, Raise(AttributeError, "ожидается объект, получено: %s", TypeName(value))
	}
	if found, ok := dict.values[key]; ok {
		return found, nil
	}
	return fallback, nil
}

// Iter — элементы перебора значения: элементы списка, ключи словаря, символы строки;
// остальное — TypeError «нельзя перебрать».
func Iter(value any) ([]any, error) {
	switch item := value.(type) {
	case []any:
		return item, nil
	case *Dict:
		keys := make([]any, len(item.keys))
		for index, key := range item.keys {
			keys[index] = key
		}
		return keys, nil
	case string:
		runes := Runes(item)
		chars := make([]any, len(runes))
		for index, r := range runes {
			chars[index] = FromRunes([]rune{r})
		}
		return chars, nil
	}
	return nil, Raise(TypeError, "нельзя перебрать: %s", TypeName(value))
}

// Contains — вхождение item в container: ключ словаря, равный элемент списка, подстрока строки.
func Contains(container, item any) (bool, error) {
	switch value := container.(type) {
	case *Dict:
		if _, err := HashKey(item); err != nil {
			return false, err
		}
		text, ok := item.(string)
		return ok && value.Has(text), nil
	case []any:
		for _, element := range value {
			if Equal(element, item) {
				return true, nil
			}
		}
		return false, nil
	case string:
		text, ok := item.(string)
		if !ok {
			return false, Raise(TypeError, "в строке можно искать только строку, получено: %s", TypeName(item))
		}
		return strings.Contains(value, text), nil
	}
	return false, Raise(TypeError, "нельзя перебрать: %s", TypeName(container))
}

// Less — left < right: числа точно, строки по кодовым точкам, списки лексикографически.
func Less(left, right any) (bool, error) { return compare(left, right, "<") }

// LessEqual — left <= right.
func LessEqual(left, right any) (bool, error) { return compare(left, right, "<=") }

func compare(left, right any, operator string) (bool, error) {
	if a, ok := asNumeric(left); ok {
		if b, ok := asNumeric(right); ok {
			result, ordered := compareNumeric(a, b)
			if !ordered {
				return false, nil
			}
			if operator == "<" {
				return result < 0, nil
			}
			return result <= 0, nil
		}
	}
	if a, ok := left.(string); ok {
		if b, ok := right.(string); ok {
			if operator == "<" {
				return a < b, nil
			}
			return a <= b, nil
		}
	}
	if a, ok := left.([]any); ok {
		if b, ok := right.([]any); ok {
			for index := 0; index < len(a) && index < len(b); index++ {
				if !equal(a[index], b[index], true) {
					return compare(a[index], b[index], operator)
				}
			}
			if operator == "<" {
				return len(a) < len(b), nil
			}
			return len(a) <= len(b), nil
		}
	}
	return false, Raise(TypeError, "нельзя сравнить «%s»: %s и %s", operator, TypeName(left), TypeName(right))
}

// arithmetic — операнды арифметики: оба целые (точно) или хотя бы один дробный (оба float64).
func arithmetic(left, right any, operator string) (*big.Int, *big.Int, float64, float64, bool, error) {
	a, okA := asNumeric(left)
	b, okB := asNumeric(right)
	if !okA || !okB {
		return nil, nil, 0, 0, false, Raise(TypeError, "операция «%s» неприменима: %s и %s", operator, TypeName(left), TypeName(right))
	}
	if !a.isFloat && !b.isFloat {
		return a.integer, b.integer, 0, 0, false, nil
	}
	toFloat := func(value numeric) (float64, error) {
		if value.isFloat {
			return value.float, nil
		}
		return IntFromBig(value.integer).Float()
	}
	x, err := toFloat(a)
	if err != nil {
		return nil, nil, 0, 0, false, err
	}
	y, err := toFloat(b)
	if err != nil {
		return nil, nil, 0, 0, false, err
	}
	return nil, nil, x, y, true, nil
}

// Add — left + right: числа, конкатенация строк и списков.
func Add(left, right any) (any, error) {
	switch a := left.(type) {
	case string:
		if b, ok := right.(string); ok {
			return a + b, nil
		}
		return nil, Raise(TypeError, "к строке можно прибавить только строку, получено: %s", TypeName(right))
	case []any:
		if b, ok := right.([]any); ok {
			return append(append([]any{}, a...), b...), nil
		}
		return nil, Raise(TypeError, "к списку можно прибавить только список, получено: %s", TypeName(right))
	}
	x, y, fx, fy, isFloat, err := arithmetic(left, right, "+")
	if err != nil {
		return nil, err
	}
	if isFloat {
		return fx + fy, nil
	}
	return IntFromBig(new(big.Int).Add(x, y)), nil
}

// Sub — left - right для чисел.
func Sub(left, right any) (any, error) {
	x, y, fx, fy, isFloat, err := arithmetic(left, right, "-")
	if err != nil {
		return nil, err
	}
	if isFloat {
		return fx - fy, nil
	}
	return IntFromBig(new(big.Int).Sub(x, y)), nil
}

// TrueDiv — деление left / right: результат float64; деление целых округляется корректно по
// точной дроби.
func TrueDiv(left, right any) (float64, error) {
	x, y, fx, fy, isFloat, err := arithmetic(left, right, "/")
	if err != nil {
		return 0, err
	}
	if isFloat {
		if fy == 0 {
			return 0, Raise(ZeroDivisionError, "деление на ноль")
		}
		return fx / fy, nil
	}
	if y.Sign() == 0 {
		return 0, Raise(ZeroDivisionError, "деление на ноль")
	}
	value, _ := new(big.Rat).SetFrac(x, y).Float64()
	return value, nil
}
