package jscompat

import "math"

// DeepStrictEqual — util.isDeepStrictEqual Node.js для значений этого пакета: объекты равны при
// одинаковом наборе собственных ключей (порядок не важен) и попарно равных значениях, массивы —
// поэлементно, числа — по Object.is (NaN равен NaN, +0 не равен −0), остальные примитивы — ===.
func DeepStrictEqual(left, right any) bool {
	switch a := left.(type) {
	case *Object:
		b, ok := right.(*Object)
		if !ok || a.Len() != b.Len() {
			return false
		}
		for _, key := range a.Keys() {
			other, has := b.Get(key)
			if !has || !DeepStrictEqual(a.Value(key), other) {
				return false
			}
		}
		return true
	case *Array:
		b, ok := right.(*Array)
		if !ok || len(a.Items) != len(b.Items) {
			return false
		}
		for index := range a.Items {
			if !DeepStrictEqual(a.Items[index], b.Items[index]) {
				return false
			}
		}
		return true
	case float64:
		b, ok := right.(float64)
		if !ok {
			return false
		}
		if math.IsNaN(a) && math.IsNaN(b) {
			return true
		}
		if a == 0 && b == 0 {
			return math.Signbit(a) == math.Signbit(b)
		}
		return a == b
	}
	return left == right
}

// JSONText — JSON.stringify(value) в шаблонной строке: undefined (и функции) дают "undefined".
func JSONText(value any) string {
	if value == Undefined {
		return "undefined"
	}
	return Stringify(value)
}
