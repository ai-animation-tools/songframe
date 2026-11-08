// Package jscompat воспроизводит семантику JavaScript/Node.js, в которой записаны проектные
// файлы и ответы приложения.
//
// Байты файлов проекта и ответы renderer зафиксированы эталонами testdata/golden в семантике
// JavaScript: документ читается без схемы, а результат следует правилам JS — истинность,
// строгое равенство, String(x), порядок свойств объекта, JSON.stringify. Поэтому и повреждённый
// или нетипичный документ даёт вполне определённый результат (проблему, «устаревший» план или
// исключение). Чтобы на тех же файлах получался тот же JSON, доменный код работает с деревом
// значений этого пакета, а не со строгими структурами Go:
//
//   - nil — null; Undefined — отсутствующее свойство;
//   - bool, float64 (все числа JS — double), string;
//   - *Array и *Object — массив и объект; указатель даёт идентичность объекта, как в JS.
//
// Значения сравнимы оператором ==, поэтому годятся ключами map вместо Map/Set JS
// (SameValueZero для всех значений, которые даёт JSON).
package jscompat

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// undefinedType — тип единственного значения Undefined.
type undefinedType struct{}

// Undefined соответствует undefined в JS: свойство отсутствует. В JSON не встречается, но
// отличается от null при чтении свойств (`x === undefined`, `??`, пропуск ключа в JSON.stringify).
var Undefined any = undefinedType{}

// Array — массив JS. Хранится по указателю, чтобы два разных массива не были равны друг другу.
type Array struct {
	Items []any
}

// Object — обычный объект JS с порядком свойств по правилам спецификации: сначала ключи-индексы
// массива по возрастанию, затем остальные в порядке первой вставки. Повтор ключа при JSON.parse
// заменяет значение, но не позицию. Порядок важен для Object.entries (первая ошибка в цикле
// определяет текст проблемы) и для JSON.stringify сравниваемых снимков.
type Object struct {
	keys   []string
	values map[string]any
}

// NewObject создаёт пустой объект.
func NewObject() *Object {
	return &Object{values: map[string]any{}}
}

// Get возвращает собственное свойство объекта. Свойства прототипа (toString, constructor и т. п.)
// не моделируются: проектные данные с такими ключами не ожидаются.
func (o *Object) Get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

// Value возвращает свойство или Undefined.
func (o *Object) Value(key string) any {
	if value, ok := o.values[key]; ok {
		return value
	}
	return Undefined
}

// Has сообщает о собственном свойстве (Object.hasOwn).
func (o *Object) Has(key string) bool {
	_, ok := o.values[key]
	return ok
}

// Set присваивает свойство; новое свойство встаёт в конец порядка вставки.
func (o *Object) Set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// Delete удаляет свойство (delete obj[key]).
func (o *Object) Delete(key string) {
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	for index, item := range o.keys {
		if item == key {
			o.keys = append(o.keys[:index:index], o.keys[index+1:]...)
			break
		}
	}
}

// Len — число собственных свойств.
func (o *Object) Len() int { return len(o.keys) }

// Keys возвращает ключи в порядке Object.keys.
func (o *Object) Keys() []string {
	var indices []string
	var named []string
	for _, key := range o.keys {
		if isArrayIndex(key) {
			indices = append(indices, key)
		} else {
			named = append(named, key)
		}
	}
	if len(indices) == 0 {
		return append([]string(nil), o.keys...)
	}
	sort.Slice(indices, func(i, j int) bool {
		left, _ := strconv.ParseUint(indices[i], 10, 64)
		right, _ := strconv.ParseUint(indices[j], 10, 64)
		return left < right
	})
	return append(indices, named...)
}

// Clone копирует объект на один уровень, как `{ ...obj }`.
func (o *Object) Clone() *Object {
	result := &Object{keys: append([]string(nil), o.keys...), values: make(map[string]any, len(o.values))}
	for key, value := range o.values {
		result.values[key] = value
	}
	return result
}

// MarshalJSON сериализует объект так же, как JSON.stringify.
func (o *Object) MarshalJSON() ([]byte, error) { return []byte(Stringify(o)), nil }

// MarshalJSON сериализует массив так же, как JSON.stringify.
func (a *Array) MarshalJSON() ([]byte, error) { return []byte(Stringify(a)), nil }

// isArrayIndex распознаёт канонический ключ-индекс массива 0..2^32-2.
func isArrayIndex(key string) bool {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return false
	}
	for _, char := range key {
		if char < '0' || char > '9' {
			return false
		}
	}
	value, err := strconv.ParseUint(key, 10, 64)
	return err == nil && value < math.MaxUint32
}

// Parse разбирает JSON как JSON.parse: числа — double (переполнение даёт ±Infinity), объекты
// сохраняют порядок свойств. Ошибкой считается любое отклонение от синтаксиса JSON и данные
// после значения.
func Parse(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := parseValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("после JSON-значения есть лишние данные")
	}
	return value, nil
}

// parseValue читает одно значение потока токенов.
func parseValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		if err == io.EOF {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	switch item := token.(type) {
	case json.Delim:
		switch item {
		case '{':
			object := NewObject()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("ключ объекта не строка")
				}
				value, err := parseValue(decoder)
				if err != nil {
					return nil, err
				}
				object.Set(key, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return object, nil
		case '[':
			array := &Array{Items: []any{}}
			for decoder.More() {
				value, err := parseValue(decoder)
				if err != nil {
					return nil, err
				}
				array.Items = append(array.Items, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return array, nil
		}
		return nil, errors.New("неожиданный разделитель JSON")
	case json.Number:
		value, err := strconv.ParseFloat(string(item), 64)
		if err != nil {
			var numErr *strconv.NumError
			if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
				return value, nil
			}
			return nil, err
		}
		return value, nil
	case string, bool, nil:
		return item, nil
	}
	return nil, errors.New("неизвестный токен JSON")
}

// DecodeUTF8 повторяет Buffer.toString('utf-8'): недопустимые байты становятся U+FFFD, BOM сохраняется.
func DecodeUTF8(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var builder strings.Builder
	for len(data) > 0 {
		char, size := utf8.DecodeRune(data)
		builder.WriteRune(char)
		data = data[size:]
	}
	return builder.String()
}

// ReadJSONFile — `JSON.parse(readFileSync(path, 'utf-8'))` в try: ok=false при любой ошибке чтения
// или разбора. Разобранный JSON null возвращается как (nil, true).
func ReadJSONFile(path string) (any, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	value, err := Parse([]byte(DecodeUTF8(data)))
	if err != nil {
		return nil, false
	}
	return value, true
}

// TypeOf — оператор typeof.
func TypeOf(value any) string {
	switch value.(type) {
	case nil, *Array, *Object:
		return "object"
	case undefinedType:
		return "undefined"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	}
	return "object"
}

// IsNullish — `value === null || value === undefined`.
func IsNullish(value any) bool {
	return value == nil || value == Undefined
}

// Coalesce — `value ?? fallback`.
func Coalesce(value, fallback any) any {
	if IsNullish(value) {
		return fallback
	}
	return value
}

// Truthy — приведение к boolean (`!!value`).
func Truthy(value any) bool {
	switch item := value.(type) {
	case nil, undefinedType:
		return false
	case bool:
		return item
	case float64:
		return item != 0 && !math.IsNaN(item)
	case string:
		return item != ""
	}
	return true
}

// StrictEqual — `===`: объекты равны только сами себе, NaN не равен ничему.
func StrictEqual(left, right any) bool {
	if a, ok := left.(float64); ok {
		b, ok := right.(float64)
		return ok && a == b
	}
	return left == right
}

// IsRecord — `typeof v === 'object' && v !== null && !Array.isArray(v)`.
func IsRecord(value any) bool {
	_, ok := value.(*Object)
	return ok
}

// AsObject возвращает объект, если значение — запись.
func AsObject(value any) (*Object, bool) {
	object, ok := value.(*Object)
	return object, ok
}

// AsArray возвращает элементы, если значение — массив (Array.isArray).
func AsArray(value any) ([]any, bool) {
	array, ok := value.(*Array)
	if !ok {
		return nil, false
	}
	return array.Items, true
}

// IsArray — Array.isArray.
func IsArray(value any) bool {
	_, ok := value.(*Array)
	return ok
}

// TypeError — исключение JS, которое доменный код возвращает ошибкой Go. Там, где текст
// исключения доходит до пользователя, сообщение повторяет V8 для типичных случаев.
type TypeError struct{ Message string }

func (e *TypeError) Error() string { return e.Message }

// Prop — чтение свойства `value.key`: у null/undefined это TypeError, у примитивов — свойства
// строки (length и индексы) либо undefined.
func Prop(value any, key string) (any, error) {
	switch value.(type) {
	case nil:
		return nil, &TypeError{"Cannot read properties of null (reading '" + key + "')"}
	case undefinedType:
		return nil, &TypeError{"Cannot read properties of undefined (reading '" + key + "')"}
	}
	return Get(value, key), nil
}

// Get — `value?.[key]`: для null/undefined возвращает Undefined без ошибки.
func Get(value any, key string) any {
	switch item := value.(type) {
	case *Object:
		return item.Value(key)
	case *Array:
		if key == "length" {
			return float64(len(item.Items))
		}
		if isArrayIndex(key) {
			index, _ := strconv.Atoi(key)
			if index < len(item.Items) {
				return item.Items[index]
			}
		}
	case string:
		units := utf16.Encode([]rune(item))
		if key == "length" {
			return float64(len(units))
		}
		if isArrayIndex(key) {
			index, _ := strconv.Atoi(key)
			if index < len(units) {
				return string(utf16.Decode(units[index : index+1]))
			}
		}
	}
	return Undefined
}

// GetPath — цепочка `value?.a?.b`.
func GetPath(value any, keys ...string) any {
	for _, key := range keys {
		value = Get(value, key)
	}
	return value
}

// GetKey — `value?.[key]` с ключом-значением: ключ приводится ToPropertyKey.
func GetKey(value, key any) any {
	return Get(value, ToString(key))
}

// HasProperty — оператор `key in value`. Для примитива это TypeError, как в JS.
func HasProperty(value, key any) (bool, error) {
	name := ToString(key)
	switch item := value.(type) {
	case *Object:
		return item.Has(name), nil
	case *Array:
		if name == "length" {
			return true, nil
		}
		if isArrayIndex(name) {
			index, _ := strconv.Atoi(name)
			return index < len(item.Items), nil
		}
		return false, nil
	}
	return false, &TypeError{"Cannot use 'in' operator to search for '" + name + "' in " + ToString(value)}
}

// Iterate — элементы `for...of`: массив или кодовые точки строки, иначе TypeError.
func Iterate(value any) ([]any, error) {
	switch item := value.(type) {
	case *Array:
		return item.Items, nil
	case string:
		result := []any{}
		for _, char := range item {
			result = append(result, string(char))
		}
		return result, nil
	}
	return nil, &TypeError{"object is not iterable (cannot read property Symbol(Symbol.iterator))"}
}

// Entry — пара Object.entries.
type Entry struct {
	Key   string
	Value any
}

// Entries — Object.entries: для null/undefined TypeError, для строки и массива — индексы.
func Entries(value any) ([]Entry, error) {
	switch item := value.(type) {
	case nil, undefinedType:
		return nil, &TypeError{"Cannot convert undefined or null to object"}
	case *Object:
		keys := item.Keys()
		result := make([]Entry, 0, len(keys))
		for _, key := range keys {
			result = append(result, Entry{key, item.values[key]})
		}
		return result, nil
	case *Array:
		result := make([]Entry, 0, len(item.Items))
		for index, element := range item.Items {
			result = append(result, Entry{strconv.Itoa(index), element})
		}
		return result, nil
	case string:
		units := utf16.Encode([]rune(item))
		result := make([]Entry, 0, len(units))
		for index := range units {
			result = append(result, Entry{strconv.Itoa(index), string(utf16.Decode(units[index : index+1]))})
		}
		return result, nil
	}
	return []Entry{}, nil
}

// Keys — Object.keys.
func Keys(value any) ([]string, error) {
	entries, err := Entries(value)
	if err != nil {
		return nil, err
	}
	keys := make([]string, len(entries))
	for index, entry := range entries {
		keys[index] = entry.Key
	}
	return keys, nil
}

// Spread — `{ ...value }`: собственные перечислимые свойства; null/undefined и числа дают пустой объект.
func Spread(value any) *Object {
	result := NewObject()
	if IsNullish(value) {
		return result
	}
	entries, _ := Entries(value)
	for _, entry := range entries {
		result.Set(entry.Key, entry.Value)
	}
	return result
}

// ToString — String(value) и подстановка в шаблонную строку.
func ToString(value any) string {
	switch item := value.(type) {
	case nil:
		return "null"
	case undefinedType:
		return "undefined"
	case bool:
		if item {
			return "true"
		}
		return "false"
	case float64:
		return NumberToString(item)
	case string:
		return item
	case *Array:
		return Join(item.Items, ",")
	}
	return "[object Object]"
}

// Join — Array.prototype.join: null и undefined дают пустую строку.
func Join(items []any, separator string) string {
	parts := make([]string, len(items))
	for index, item := range items {
		if !IsNullish(item) {
			parts[index] = ToString(item)
		}
	}
	return strings.Join(parts, separator)
}

// NumberToString — Number.prototype.toString() для конечных и особых значений.
func NumberToString(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	case value == 0:
		return "0"
	case value < 0:
		return "-" + NumberToString(-value)
	}
	// Кратчайшие цифры, однозначно задающие double, у Go и JS совпадают; различается только раскладка.
	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponent, _ := strings.Cut(formatted, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	exp, _ := strconv.Atoi(exponent)
	n := exp + 1
	k := len(digits)
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	power := strconv.Itoa(abs(n - 1))
	if k == 1 {
		return digits + "e" + sign + power
	}
	return digits[:1] + "." + digits[1:] + "e" + sign + power
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

// decimalLiteral — StrDecimalLiteral из ToNumber, без «inf», «nan» и подчёркиваний ParseFloat.
var decimalLiteral = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$`)

// ToNumber — Number(value).
func ToNumber(value any) float64 {
	switch item := value.(type) {
	case nil:
		return 0
	case undefinedType:
		return math.NaN()
	case bool:
		if item {
			return 1
		}
		return 0
	case float64:
		return item
	case string:
		return stringToNumber(item)
	case *Array:
		return stringToNumber(ToString(item))
	}
	return math.NaN()
}

// stringToNumber разбирает строку как ToNumber: пробелы JS по краям, пустая строка — 0.
func stringToNumber(text string) float64 {
	text = Trim(text)
	switch text {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(text) > 2 && text[0] == '0' {
		base := 0
		switch text[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			value, err := strconv.ParseUint(text[2:], base, 64)
			if err != nil || strings.Contains(text, "_") {
				return math.NaN()
			}
			return float64(value)
		}
	}
	if !decimalLiteral.MatchString(text) {
		return math.NaN()
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
			return value
		}
		return math.NaN()
	}
	return value
}

// IsFinite — Number.isFinite (без приведения типа).
func IsFinite(value any) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

// IsInteger — Number.isInteger.
func IsInteger(value any) bool {
	number, ok := value.(float64)
	return ok && IsFinite(number) && math.Trunc(number) == number
}

// IsSafeInteger — Number.isSafeInteger.
func IsSafeInteger(value any) bool {
	number, ok := value.(float64)
	return IsInteger(value) && ok && math.Abs(number) <= 1<<53-1
}

// isJSSpace — WhiteSpace и LineTerminator ECMAScript: их убирает String.prototype.trim и
// распознаёт \s. unicode.IsSpace отличается (U+0085 входит, U+FEFF нет).
func isJSSpace(char rune) bool {
	switch char {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return char >= 0x2000 && char <= 0x200a
}

// SpaceClass — содержимое класса символов RE2, равное \s регулярных выражений JS.
const SpaceClass = `\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

// Trim — String.prototype.trim.
func Trim(text string) string {
	return strings.TrimFunc(text, isJSSpace)
}

// LessUTF16 сравнивает строки по кодовым единицам UTF-16, как `<` и Array.prototype.sort в JS.
// Байтовый порядок UTF-8 отличается для символов за пределами BMP.
func LessUTF16(left, right string) bool {
	a := utf16.Encode([]rune(left))
	b := utf16.Encode([]rune(right))
	for index := 0; index < len(a) && index < len(b); index++ {
		if a[index] != b[index] {
			return a[index] < b[index]
		}
	}
	return len(a) < len(b)
}

// Quote — JSON.stringify строки: экранируются кавычка, обратная косая черта и управляющие символы;
// не-ASCII и `<>&` остаются как есть (в отличие от encoding/json).
func Quote(text string) string {
	var builder strings.Builder
	builder.Grow(len(text) + 2)
	builder.WriteByte('"')
	for _, char := range text {
		switch char {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if char < 0x20 {
				builder.WriteString(`\u00`)
				builder.WriteByte("0123456789abcdef"[char>>4])
				builder.WriteByte("0123456789abcdef"[char&0xf])
			} else {
				builder.WriteRune(char)
			}
		}
	}
	builder.WriteByte('"')
	return builder.String()
}

// Stringify — JSON.stringify(value) без отступов. Undefined верхнего уровня даёт "undefined"
// (в JS — значение undefined), внутри массива — null, в объекте ключ пропускается.
func Stringify(value any) string {
	var builder strings.Builder
	stringify(&builder, value)
	return builder.String()
}

func stringify(builder *strings.Builder, value any) {
	switch item := value.(type) {
	case nil:
		builder.WriteString("null")
	case undefinedType:
		builder.WriteString("undefined")
	case bool:
		builder.WriteString(ToString(item))
	case float64:
		if IsFinite(item) {
			builder.WriteString(NumberToString(item))
		} else {
			builder.WriteString("null")
		}
	case string:
		builder.WriteString(Quote(item))
	case *Array:
		builder.WriteByte('[')
		for index, element := range item.Items {
			if index > 0 {
				builder.WriteByte(',')
			}
			if element == Undefined {
				builder.WriteString("null")
			} else {
				stringify(builder, element)
			}
		}
		builder.WriteByte(']')
	case *Object:
		builder.WriteByte('{')
		first := true
		for _, key := range item.Keys() {
			element := item.values[key]
			if element == Undefined {
				continue
			}
			if !first {
				builder.WriteByte(',')
			}
			first = false
			builder.WriteString(Quote(key))
			builder.WriteByte(':')
			stringify(builder, element)
		}
		builder.WriteByte('}')
	default:
		builder.WriteString("null")
	}
}

// Raw возвращает значение как json.RawMessage в форме JSON.stringify — для полей DTO, которые
// отдаются как прочитанный документ без схемы (неизвестные поля и порядок сохраняются).
func Raw(value any) json.RawMessage {
	if value == Undefined {
		return json.RawMessage("null")
	}
	return json.RawMessage(Stringify(value))
}

// StringifyIndent — JSON.stringify(value, null, indent): формат проектных JSON
// (`JSON.stringify(data, null, 2) + '\n'` даёт побайтно тот же файл).
func StringifyIndent(value any, indent string) string {
	var builder strings.Builder
	stringifyIndent(&builder, value, indent, "")
	return builder.String()
}

func stringifyIndent(builder *strings.Builder, value any, indent, prefix string) {
	inner := prefix + indent
	switch item := value.(type) {
	case *Array:
		if len(item.Items) == 0 {
			builder.WriteString("[]")
			return
		}
		builder.WriteString("[\n")
		for index, element := range item.Items {
			if index > 0 {
				builder.WriteString(",\n")
			}
			builder.WriteString(inner)
			if element == Undefined {
				builder.WriteString("null")
			} else {
				stringifyIndent(builder, element, indent, inner)
			}
		}
		builder.WriteString("\n" + prefix + "]")
	case *Object:
		first := true
		for _, key := range item.Keys() {
			element := item.values[key]
			if element == Undefined {
				continue
			}
			if first {
				builder.WriteString("{\n")
			} else {
				builder.WriteString(",\n")
			}
			first = false
			builder.WriteString(inner + Quote(key) + ": ")
			stringifyIndent(builder, element, indent, inner)
		}
		if first {
			builder.WriteString("{}")
			return
		}
		builder.WriteString("\n" + prefix + "}")
	default:
		stringify(builder, value)
	}
}
