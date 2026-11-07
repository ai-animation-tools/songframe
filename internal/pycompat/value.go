// Package pycompat воспроизводит семантику значений Python 3.12, на которой работали инструменты
// замороженного оригинала (`tools/*.py` Electron-версии SongFrame на срезе `634fd94`): разбор и запись JSON модулем json, repr/str,
// равенство и истинность, индексацию, приведение float()/round() и десятичную арифметику Decimal.
//
// Зачем отдельная модель, а не jscompat: TS-оригинал и Python-инструменты по-разному видят одни и те
// же байты. Python различает int и float (7 и 7.0 пишутся по-разному, `type(x) is int` отвергает
// 7.0), печатает дробные числа как repr(float), сравнивает ключи по кодовым точкам, а тексты его
// исключений (KeyError: 'start', repr словаря в сообщении) попадают в stderr инструмента, который
// показывает интерфейс. Перенос Python-инструмента на Go обязан давать те же байты файлов и те же
// сообщения, поэтому он работает на значениях этого пакета.
//
// Модель значений: nil (None), bool, Int (int), float64 (float), string (str, строки с одиночными
// суррогатами хранятся в WTF-8), []any (list), *Dict (dict со строковыми ключами в порядке
// вставки). Ошибки Python — *Exception с типом и текстом str(error).
package pycompat

import (
	"math"
	"math/big"
	"strconv"
)

// Int — целое Python произвольной длины. Хранится нормализованной десятичной записью: так целые
// вне int64 из прочитанного файла переносятся без потери, а сравнение по значению остаётся простым.
type Int struct{ text string }

// NewInt — целое из int64.
func NewInt(value int64) Int { return Int{strconv.FormatInt(value, 10)} }

// IntFromBig — целое из big.Int.
func IntFromBig(value *big.Int) Int { return Int{value.String()} }

// ParseInt — int(text) для уже проверенной записи из цифр с необязательным минусом.
func ParseInt(text string) (Int, bool) {
	value, ok := new(big.Int).SetString(text, 10)
	if !ok {
		return Int{}, false
	}
	return IntFromBig(value), true
}

// String — десятичная запись (repr(int)). Нулевое значение Int{} — 0.
func (i Int) String() string {
	if i.text == "" {
		return "0"
	}
	return i.text
}

// Big — значение как big.Int (новая копия).
func (i Int) Big() *big.Int {
	value, _ := new(big.Int).SetString(i.String(), 10)
	return value
}

// Int64 — значение, если помещается в int64.
func (i Int) Int64() (int64, bool) {
	value, err := strconv.ParseInt(i.String(), 10, 64)
	return value, err == nil
}

// Sign — знак: -1, 0 или 1.
func (i Int) Sign() int { return i.Big().Sign() }

// Float — float(int): корректно округлённое значение; слишком большое целое — OverflowError.
func (i Int) Float() (float64, error) {
	// SetInt хранит целое точно, Float64 округляет к ближайшему с половиной к чётному, как Python.
	value, _ := new(big.Float).SetInt(i.Big()).Float64()
	if math.IsInf(value, 0) {
		return 0, Raise(OverflowError, "int too large to convert to float")
	}
	return value, nil
}

// Dict — dict Python с порядком вставки. Ключи — строки: все словари, которые читают и пишут
// инструменты, приходят из JSON или строятся со строковыми ключами.
type Dict struct {
	keys   []string
	values map[string]any
}

// NewDict — пустой словарь.
func NewDict() *Dict { return &Dict{values: map[string]any{}} }

// Get — d.get(key) без значения по умолчанию: (значение, есть ли ключ).
func (d *Dict) Get(key string) (any, bool) {
	if d == nil {
		return nil, false
	}
	value, ok := d.values[key]
	return value, ok
}

// Value — d.get(key): отсутствующий ключ — nil (None).
// Методы чтения допускают nil-словарь (пустой): так проверка `isinstance(x, dict) and x.get(...)`
// переносится без отдельной ветки.
func (d *Dict) Value(key string) any {
	if d == nil {
		return nil
	}
	return d.values[key]
}

// Has — key in d.
func (d *Dict) Has(key string) bool {
	if d == nil {
		return false
	}
	_, ok := d.values[key]
	return ok
}

// Set — d[key] = value: существующий ключ сохраняет место, новый добавляется в конец.
func (d *Dict) Set(key string, value any) {
	if _, ok := d.values[key]; !ok {
		d.keys = append(d.keys, key)
	}
	d.values[key] = value
}

// Delete — d.pop(key, None): отсутствующий ключ не ошибка.
func (d *Dict) Delete(key string) {
	if _, ok := d.values[key]; !ok {
		return
	}
	delete(d.values, key)
	for index, item := range d.keys {
		if item == key {
			d.keys = append(d.keys[:index:index], d.keys[index+1:]...)
			break
		}
	}
}

// Keys — ключи в порядке вставки (копия).
func (d *Dict) Keys() []string {
	if d == nil {
		return nil
	}
	return append([]string(nil), d.keys...)
}

// Len — len(d).
func (d *Dict) Len() int {
	if d == nil {
		return 0
	}
	return len(d.keys)
}

// Clone — dict(d) или {**d}: новый словарь с тем же порядком, значения не копируются глубоко.
func (d *Dict) Clone() *Dict {
	result := &Dict{keys: append([]string(nil), d.keys...), values: make(map[string]any, len(d.values))}
	for key, value := range d.values {
		result.values[key] = value
	}
	return result
}

// DeepCopy — copy.deepcopy для значений модели: словари и списки копируются рекурсивно.
func DeepCopy(value any) any {
	switch item := value.(type) {
	case []any:
		result := make([]any, len(item))
		for index, element := range item {
			result[index] = DeepCopy(element)
		}
		return result
	case *Dict:
		result := &Dict{keys: append([]string(nil), item.keys...), values: make(map[string]any, len(item.values))}
		for key, element := range item.values {
			result.values[key] = DeepCopy(element)
		}
		return result
	}
	return value
}

// TypeName — type(value).__name__ для сообщений TypeError.
func TypeName(value any) string {
	switch value.(type) {
	case nil:
		return "NoneType"
	case bool:
		return "bool"
	case Int:
		return "int"
	case float64:
		return "float"
	case string:
		return "str"
	case []any:
		return "list"
	case *Dict:
		return "dict"
	}
	return "object"
}

// Truthy — bool(value).
func Truthy(value any) bool {
	switch item := value.(type) {
	case nil:
		return false
	case bool:
		return item
	case Int:
		return item.String() != "0"
	case float64:
		return item != 0
	case string:
		return item != ""
	case []any:
		return len(item) > 0
	case *Dict:
		return len(item.keys) > 0
	}
	return true
}

// IsInt — isinstance(value, int): bool в Python — подкласс int.
func IsInt(value any) bool {
	switch value.(type) {
	case Int, bool:
		return true
	}
	return false
}

// IsExactInt — type(value) is int: без bool и float.
func IsExactInt(value any) bool {
	_, ok := value.(Int)
	return ok
}

// IsNumber — isinstance(value, (int, float)), включая bool.
func IsNumber(value any) bool {
	switch value.(type) {
	case Int, bool, float64:
		return true
	}
	return false
}

// numeric — значение числа для сравнения: целое (bool, Int) точно, float — как есть.
type numeric struct {
	integer *big.Int
	float   float64
	isFloat bool
}

// asNumeric — число Python или ok=false.
func asNumeric(value any) (numeric, bool) {
	switch item := value.(type) {
	case bool:
		if item {
			return numeric{integer: big.NewInt(1)}, true
		}
		return numeric{integer: big.NewInt(0)}, true
	case Int:
		return numeric{integer: item.Big()}, true
	case float64:
		return numeric{float: item, isFloat: true}, true
	}
	return numeric{}, false
}

// compareNumeric — точное сравнение чисел, как в Python (int и float сравниваются без потери
// точности). ok=false — среди значений есть NaN: любое упорядочивание ложно.
func compareNumeric(left, right numeric) (int, bool) {
	if left.isFloat && math.IsNaN(left.float) || right.isFloat && math.IsNaN(right.float) {
		return 0, false
	}
	if !left.isFloat && !right.isFloat {
		return left.integer.Cmp(right.integer), true
	}
	if left.isFloat && right.isFloat {
		switch {
		case left.float < right.float:
			return -1, true
		case left.float > right.float:
			return 1, true
		}
		return 0, true
	}
	// Смешанное сравнение: бесконечность больше любого целого, конечный float сравнивается точно.
	toFloat := func(value numeric) *big.Float {
		if value.isFloat {
			return new(big.Float).SetFloat64(value.float)
		}
		return new(big.Float).SetInt(value.integer)
	}
	if left.isFloat && math.IsInf(left.float, 0) {
		if left.float > 0 {
			return 1, true
		}
		return -1, true
	}
	if right.isFloat && math.IsInf(right.float, 0) {
		if right.float > 0 {
			return -1, true
		}
		return 1, true
	}
	return toFloat(left).Cmp(toFloat(right)), true
}

// Equal — left == right в Python: числа равны по значению независимо от типа (1 == 1.0 == True),
// списки и словари — поэлементно (элементы-одинаковые объекты равны, поэтому общая константа NaN
// json внутри контейнеров равна себе), остальные типы между собой не равны.
func Equal(left, right any) bool { return equal(left, right, false) }

func equal(left, right any, inContainer bool) bool {
	if a, ok := asNumeric(left); ok {
		b, ok := asNumeric(right)
		if !ok {
			return false
		}
		if inContainer && a.isFloat && b.isFloat && math.IsNaN(a.float) && math.IsNaN(b.float) {
			return true
		}
		result, ordered := compareNumeric(a, b)
		return ordered && result == 0
	}
	switch a := left.(type) {
	case nil:
		return right == nil
	case string:
		b, ok := right.(string)
		return ok && a == b
	case []any:
		b, ok := right.([]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for index := range a {
			if !equal(a[index], b[index], true) {
				return false
			}
		}
		return true
	case *Dict:
		b, ok := right.(*Dict)
		if !ok || a.Len() != b.Len() {
			return false
		}
		for _, key := range a.keys {
			other, found := b.values[key]
			if !found || !equal(a.values[key], other, true) {
				return false
			}
		}
		return true
	}
	return false
}

// HashKey — ключ для set/dict Python со значениями любого хешируемого типа: равные числа разных
// типов (1, 1.0, True) дают один ключ. Список и словарь — TypeError unhashable type.
func HashKey(value any) (string, error) {
	switch item := value.(type) {
	case nil:
		return "n", nil
	case string:
		return "s" + item, nil
	case bool, Int:
		number, _ := asNumeric(item)
		return "i" + number.integer.String(), nil
	case float64:
		if !math.IsInf(item, 0) && !math.IsNaN(item) && item == math.Trunc(item) {
			integer, _ := new(big.Float).SetFloat64(item).Int(nil)
			return "i" + integer.String(), nil
		}
		return "f" + strconv.FormatFloat(item, 'g', -1, 64), nil
	}
	return "", Raise(TypeError, "unhashable type: '%s'", TypeName(value))
}
