// Package dynvalue — динамическая модель значений проектных JSON-файлов и ответов приложения:
// документ читается без схемы, а доменный код работает с деревом значений по фиксированным
// правилам истинности, строгого равенства, текстового приведения, порядка свойств и записи JSON.
//
// Байты файлов проекта и ответы renderer зафиксированы эталонами testdata/golden. Поэтому и
// повреждённый или нетипичный документ даёт вполне определённый результат (проблему,
// «устаревший» план или исключение), а не ошибку разбора в строгую структуру Go. Модель:
//
//   - nil — null; Undefined — отсутствующее свойство;
//   - bool, float64 (все числа двойной точности, отдельного целого типа нет), string;
//   - *Array и *Object — массив и объект; указатель даёт идентичность: разные объекты не равны.
//
// Значения сравнимы оператором ==, поэтому годятся ключами map для множеств и словарей значений:
// объекты совпадают по идентичности, числа по значению (+0 и −0 равны), а NaN JSON не даёт.
package dynvalue

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

// Undefined — значение отсутствующего свойства. В JSON не встречается, но отличается от null:
// StrictEqual их различает, Coalesce заменяет оба, а Stringify пропускает ключ со значением
// Undefined и пишет null для null.
var Undefined any = undefinedType{}

// Array — массив значений. Хранится по указателю, чтобы два разных массива не были равны друг другу.
type Array struct {
	Items []any
}

// Object — объект со строковыми ключами и фиксированным порядком свойств: сначала ключи-индексы
// массива (isArrayIndex) по возрастанию, затем остальные в порядке первой вставки. Повтор ключа
// при разборе заменяет значение, но не позицию. Порядок важен для Entries (первая ошибка в цикле
// определяет текст проблемы) и для Stringify сравниваемых снимков.
type Object struct {
	keys   []string
	values map[string]any
}

// NewObject создаёт пустой объект.
func NewObject() *Object {
	return &Object{values: map[string]any{}}
}

// Get возвращает собственное свойство объекта. Унаследованные свойства (toString, constructor и
// т. п.) не моделируются: проектные данные с такими ключами не ожидаются.
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

// Has сообщает, есть ли у объекта собственное свойство key.
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

// Delete удаляет свойство; отсутствующее — не ошибка.
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

// Keys возвращает ключи в порядке свойств (см. Object): индексы по возрастанию, затем
// остальные в порядке вставки.
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

// Clone копирует объект на один уровень: значения-объекты остаются общими.
func (o *Object) Clone() *Object {
	result := &Object{keys: append([]string(nil), o.keys...), values: make(map[string]any, len(o.values))}
	for key, value := range o.values {
		result.values[key] = value
	}
	return result
}

// MarshalJSON сериализует объект так же, как Stringify.
func (o *Object) MarshalJSON() ([]byte, error) { return []byte(Stringify(o)), nil }

// MarshalJSON сериализует массив так же, как Stringify.
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

// Parse разбирает JSON: числа — float64 (переполнение даёт ±Infinity), объекты сохраняют порядок
// свойств. Ошибкой считается любое отклонение от синтаксиса JSON (в том числе BOM в начале) и
// данные после значения; текст ошибки — «неверный JSON: причина…» (parseError).
func Parse(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := parseValue(decoder)
	if err != nil {
		return nil, parseError(data, err)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, parseError(data, errors.New("лишние данные после JSON"))
	}
	return value, nil
}

// syntaxReasons — причины ошибок синтаксиса encoding/json по остатку их текста после символа в
// кавычках; остаток сравнивается целиком. Прочие ошибки — «неожиданный символ 'x'».
var syntaxReasons = map[string]string{
	" looking for beginning of object key string": "ожидалось имя поля или «}»",
	" after object key:value pair":                "после значения поля ожидалась «,» или «}»",
	" after object key":                           "после имени поля ожидалось «:»",
	" after array element":                        "после элемента списка ожидалась «,» или «]»",
	" after top-level value":                      "лишние данные после JSON",
	" in string literal":                          "управляющий символ в строке",
	" in string escape code":                      "неверная escape-последовательность",
	" in \\u hexadecimal character escape":        "неверная escape-последовательность",
}

// parseError — ошибка разбора Parse по-русски: «неверный JSON: причина, позиция N (строка L,
// столбец C)». Причину и позицию даёт проверка документа сканером encoding/json (json.Unmarshal
// в RawMessage): его смещение всегда указывает сразу за неверный байт, а у потока токенов
// Decoder оно для разных ошибок отсчитывается по-разному. BOM в начале — «метка порядка байтов
// в начале файла», обрыв — «данные оборваны» без позиции. Если сканер документ принял, остаётся
// текст err (ошибки parseValue уже по-русски).
func parseError(data []byte, err error) error {
	if bytes.HasPrefix(data, []byte("\xef\xbb\xbf")) {
		return errors.New("неверный JSON: метка порядка байтов в начале файла")
	}
	var raw json.RawMessage
	var syntax *json.SyntaxError
	if !errors.As(json.Unmarshal(data, &raw), &syntax) {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return errors.New("неверный JSON: данные оборваны")
		}
		return errors.New("неверный JSON: " + err.Error())
	}
	message := syntax.Error()
	if message == "unexpected end of JSON input" {
		return errors.New("неверный JSON: данные оборваны")
	}
	body, ok := strings.CutPrefix(message, "invalid character ")
	if !ok {
		return errors.New("неверный JSON: неверный синтаксис")
	}
	reason := "неожиданный символ " + strings.TrimSuffix(body, syntaxRest(body))
	if known, ok := syntaxReasons[syntaxRest(body)]; ok {
		reason = known
	}
	return errors.New("неверный JSON: " + reason + syntaxPosition(data, int(syntax.Offset)-1))
}

// syntaxRest — остаток текста ошибки после символа в кавычках («'x' after array element» →
// « after array element»); символ записан encoding/json в одинарных кавычках ('\” для кавычки).
func syntaxRest(body string) string {
	if strings.HasPrefix(body, `'\''`) {
		return body[4:]
	}
	if end := strings.Index(body[min(1, len(body)):], "'"); end >= 0 {
		return body[end+2:]
	}
	return ""
}

// syntaxPosition — «, позиция N (строка L, столбец C)» байта index: позиция — номер кодовой точки
// с 0, строка и столбец — с 1.
func syntaxPosition(data []byte, index int) string {
	if index < 0 || index > len(data) {
		return ""
	}
	prefix := data[:index]
	line := bytes.Count(prefix, []byte("\n")) + 1
	column := utf8.RuneCount(prefix[bytes.LastIndexByte(prefix, '\n')+1:]) + 1
	return ", позиция " + strconv.Itoa(utf8.RuneCount(prefix)) + " (строка " + strconv.Itoa(line) + ", столбец " + strconv.Itoa(column) + ")"
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

// DecodeUTF8 декодирует UTF-8 с заменой: каждый недопустимый байт становится U+FFFD, BOM
// сохраняется.
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

// ReadJSONFile читает файл как текст UTF-8 (DecodeUTF8) и разбирает Parse: ok=false при любой
// ошибке чтения или разбора. Разобранный JSON null возвращается как (nil, true).
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

// TypeOf — имя типа значения в сообщениях: object (null, массив, объект), undefined, boolean,
// number, string.
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

// IsNullish — значение null или Undefined.
func IsNullish(value any) bool {
	return value == nil || value == Undefined
}

// Coalesce — value, а для null и Undefined — fallback.
func Coalesce(value, fallback any) any {
	if IsNullish(value) {
		return fallback
	}
	return value
}

// Truthy — истинность: ложны null, Undefined, false, 0, NaN и пустая строка; массивы и объекты
// (даже пустые) истинны.
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

// StrictEqual — строгое равенство без приведения типов: объекты равны только сами себе, NaN не
// равен ничему, +0 равен −0.
func StrictEqual(left, right any) bool {
	if a, ok := left.(float64); ok {
		b, ok := right.(float64)
		return ok && a == b
	}
	return left == right
}

// IsRecord — значение является объектом (не null и не массивом).
func IsRecord(value any) bool {
	_, ok := value.(*Object)
	return ok
}

// AsObject возвращает объект, если значение — запись.
func AsObject(value any) (*Object, bool) {
	object, ok := value.(*Object)
	return object, ok
}

// AsArray возвращает элементы, если значение — массив.
func AsArray(value any) ([]any, bool) {
	array, ok := value.(*Array)
	if !ok {
		return nil, false
	}
	return array.Items, true
}

// IsArray — значение является массивом.
func IsArray(value any) bool {
	_, ok := value.(*Array)
	return ok
}

// TypeError — ошибка типа при операции над значением (чтение свойства null, перебор не-массива и
// т. п.), которую доменный код возвращает ошибкой Go. Её текст доходит до пользователя и
// зафиксирован эталонами.
type TypeError struct{ Message string }

func (e *TypeError) Error() string { return e.Message }

// Prop — обязательное чтение свойства key: у null и Undefined это TypeError «нет поля 'key':
// значение null» или «… значение отсутствует», в остальном — как Get.
func Prop(value any, key string) (any, error) {
	switch value.(type) {
	case nil:
		return nil, &TypeError{"нет поля '" + key + "': значение null"}
	case undefinedType:
		return nil, &TypeError{"нет поля '" + key + "': значение отсутствует"}
	}
	return Get(value, key), nil
}

// Get — необязательное чтение свойства: у объекта — собственное свойство, у массива и строки —
// length и элементы по индексу (строка — по кодовым единицам UTF-16), иначе (и для null и
// Undefined) — Undefined без ошибки.
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

// GetPath — цепочка Get по ключам keys.
func GetPath(value any, keys ...string) any {
	for _, key := range keys {
		value = Get(value, key)
	}
	return value
}

// GetKey — Get с ключом-значением: ключ приводится к строке ToString.
func GetKey(value, key any) any {
	return Get(value, ToString(key))
}

// HasProperty — есть ли свойство key у объекта или массива (length и индексы в пределах). Для
// не-объекта это TypeError «нельзя проверить поле 'key': значение не объект».
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
	return false, &TypeError{"нельзя проверить поле '" + name + "': значение не объект"}
}

// Iterate — элементы перебора: элементы массива или кодовые точки строки, иначе TypeError.
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
	return nil, &TypeError{"нельзя перебрать значение"}
}

// Entry — пара ключ-значение из Entries.
type Entry struct {
	Key   string
	Value any
}

// Entries — пары собственных свойств в порядке Keys: для null и Undefined TypeError, для массива
// и строки ключи — индексы (у строки — по кодовым единицам UTF-16), для прочих — пусто.
func Entries(value any) ([]Entry, error) {
	switch item := value.(type) {
	case nil, undefinedType:
		return nil, &TypeError{"ожидается объект, получено: null"}
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

// Keys — ключи Entries.
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

// Spread — новый объект из пар Entries; null, Undefined, числа и логические значения дают пустой
// объект.
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

// ToString — текстовое приведение: null, undefined, true/false, NumberToString, строка как есть,
// массив — Join через «,», объект — «[object Object]». Так значения подставляются в тексты
// сообщений.
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

// Join — элементы через separator; null и Undefined дают пустую строку.
func Join(items []any, separator string) string {
	parts := make([]string, len(items))
	for index, item := range items {
		if !IsNullish(item) {
			parts[index] = ToString(item)
		}
	}
	return strings.Join(parts, separator)
}

// NumberToString — кратчайшая запись числа: NaN, Infinity, -Infinity, 0 (и для −0); обычная
// запись при 1e-6 ≤ |x| < 1e21, иначе экспоненциальная вида «1.5e+21» и «1e-7».
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
	// Кратчайшие цифры, однозначно задающие float64, даёт strconv; здесь выбирается только раскладка.
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

// decimalLiteral — десятичная запись числа для ToNumber: знак, цифры с необязательной точкой и
// экспонента; «inf», «nan» и подчёркивания, которые принимает ParseFloat, отсекаются.
var decimalLiteral = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$`)

// ToNumber — числовое приведение: null и false — 0, true — 1, Undefined и объект — NaN,
// строка и массив (через ToString) — stringToNumber.
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

// stringToNumber разбирает строку числа: пробелы Trim по краям, пустая строка — 0, Infinity со
// знаком, 0x/0o/0b без знака, десятичная запись decimalLiteral; иначе NaN.
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

// IsFinite — значение — конечное число (без приведения типа).
func IsFinite(value any) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

// IsInteger — значение — конечное число без дробной части.
func IsInteger(value any) bool {
	number, ok := value.(float64)
	return ok && IsFinite(number) && math.Trunc(number) == number
}

// IsSafeInteger — IsInteger с модулем не больше 2^53−1 (точно представимые целые).
func IsSafeInteger(value any) bool {
	number, ok := value.(float64)
	return IsInteger(value) && ok && math.Abs(number) <= 1<<53-1
}

// isTrimSpace — пробельные символы и разделители строк, которые убирает Trim и распознаёт
// SpaceClass: \t \n \v \f \r, пробел, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
// U+205F, U+3000, U+FEFF. unicode.IsSpace отличается (U+0085 входит, U+FEFF нет).
func isTrimSpace(char rune) bool {
	switch char {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return char >= 0x2000 && char <= 0x200a
}

// SpaceClass — содержимое класса символов RE2 с теми же символами, что isTrimSpace: в Go \s
// только ASCII.
const SpaceClass = `\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

// Trim — строка без пробельных символов isTrimSpace по краям.
func Trim(text string) string {
	return strings.TrimFunc(text, isTrimSpace)
}

// LessUTF16 сравнивает строки по кодовым единицам UTF-16: так упорядочены строки в
// зафиксированном эталонами выводе. Байтовый порядок UTF-8 отличается для символов за пределами
// BMP.
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

// Quote — строка JSON: экранируются кавычка, обратная косая черта и управляющие символы;
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

// Stringify — запись значения в JSON без отступов и пробелов; NaN и бесконечности — null.
// Undefined верхнего уровня даёт "undefined" (для подстановки в текст), внутри массива — null, в
// объекте ключ пропускается.
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

// Raw возвращает значение как json.RawMessage в форме Stringify (Undefined — null) — для полей
// DTO, которые отдаются как прочитанный документ без схемы (неизвестные поля и порядок
// сохраняются).
func Raw(value any) json.RawMessage {
	if value == Undefined {
		return json.RawMessage("null")
	}
	return json.RawMessage(Stringify(value))
}

// StringifyIndent — многострочная запись JSON с отступом indent и «: » после ключа; пустые
// массив и объект — «[]» и «{}». Это формат проектных JSON-файлов: StringifyIndent(data, "  ") и
// перевод строки в конце дают файл побайтно.
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
