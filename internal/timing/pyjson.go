package timing

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
)

// Черновик автоматической разметки в оригинале собирал и записывал Python (align_lyrics,
// json.dumps(ensure_ascii=False, indent=2)). Чтобы файл, который пишет Go, не отличался от
// прежнего ни числами, ни форматом, черновик строится на значениях с семантикой Python json:
// целое и дробное различаются (7 и 7.0 пишутся по-разному и по-разному округляются), порядок
// ключей — порядок вставки, дробные числа печатаются как repr(float).
//
// Модель значений: nil (null), bool, pyInt (целое), float64, string, []any, *pyObject.

// pyInt — целое Python. Хранится текстом в нормализованной десятичной записи, чтобы целые
// за пределами int64 из прежнего файла переносились без потери.
type pyInt struct{ text string }

// newPyInt — целое из Go int.
func newPyInt(value int) pyInt { return pyInt{strconv.Itoa(value)} }

// float — значение целого для сравнений и арифметики с float (как int → float в Python).
func (i pyInt) float() float64 {
	value, _ := strconv.ParseFloat(i.text, 64)
	return value
}

// int — значение для номеров строк; ok=false — не помещается в int.
func (i pyInt) int() (int, bool) {
	value, err := strconv.Atoi(i.text)
	return value, err == nil
}

// pyObject — dict Python с порядком вставки ключей.
type pyObject struct {
	keys   []string
	values map[string]any
}

func newPyObject() *pyObject { return &pyObject{values: map[string]any{}} }

// set заменяет значение на месте существующего ключа или добавляет ключ в конец (dict[key] = v).
func (o *pyObject) set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// get — dict.get(key): отсутствующий ключ даёт (nil, false).
func (o *pyObject) get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

// clone — {**o}: новая карта с тем же порядком, значения не копируются глубоко.
func (o *pyObject) clone() *pyObject {
	result := &pyObject{keys: append([]string(nil), o.keys...), values: make(map[string]any, len(o.values))}
	for key, value := range o.values {
		result.values[key] = value
	}
	return result
}

// parsePyJSON — json.loads: дубликат ключа оставляет первое место и последнее значение, литерал
// с «.», «e» или «E» — float, иначе int. Числа за пределами float дают ±Inf, как в Python;
// их отклоняет последующая проверка allow_nan=False.
func parsePyJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodePy(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("лишние данные после JSON")
	}
	return value, nil
}

func decodePy(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		if value == '[' {
			items := []any{}
			for decoder.More() {
				item, err := decodePy(decoder)
				if err != nil {
					return nil, err
				}
				items = append(items, item)
			}
			_, err := decoder.Token()
			return items, err
		}
		object := newPyObject()
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			item, err := decodePy(decoder)
			if err != nil {
				return nil, err
			}
			object.set(keyToken.(string), item)
		}
		_, err := decoder.Token()
		return object, err
	case json.Number:
		text := string(value)
		if strings.ContainsAny(text, ".eE") {
			number, err := strconv.ParseFloat(text, 64)
			if err != nil && !errors.Is(err, strconv.ErrRange) {
				return nil, err
			}
			return number, nil
		}
		integer, ok := new(big.Int).SetString(text, 10)
		if !ok {
			return nil, fmt.Errorf("неверное целое %q", text)
		}
		return pyInt{integer.String()}, nil
	default:
		return value, nil
	}
}

// encodePyJSON — json.dumps(value, ensure_ascii=False, indent=2) + "\n". allow_nan=False:
// NaN/Infinity — ошибка, как проверка перед записью в оригинале.
func encodePyJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	if err := writePy(&buffer, value, ""); err != nil {
		return nil, err
	}
	buffer.WriteByte('\n')
	return buffer.Bytes(), nil
}

func writePy(buffer *bytes.Buffer, value any, indent string) error {
	switch item := value.(type) {
	case nil:
		buffer.WriteString("null")
	case bool:
		buffer.WriteString(strconv.FormatBool(item))
	case pyInt:
		buffer.WriteString(item.text)
	case float64:
		text, err := pyFloatRepr(item)
		if err != nil {
			return err
		}
		buffer.WriteString(text)
	case string:
		writePyString(buffer, item)
	case []any:
		if len(item) == 0 {
			buffer.WriteString("[]")
			return nil
		}
		inner := indent + "  "
		buffer.WriteString("[\n")
		for index, element := range item {
			if index > 0 {
				buffer.WriteString(",\n")
			}
			buffer.WriteString(inner)
			if err := writePy(buffer, element, inner); err != nil {
				return err
			}
		}
		buffer.WriteString("\n" + indent + "]")
	case *pyObject:
		if len(item.keys) == 0 {
			buffer.WriteString("{}")
			return nil
		}
		inner := indent + "  "
		buffer.WriteString("{\n")
		for index, key := range item.keys {
			if index > 0 {
				buffer.WriteString(",\n")
			}
			buffer.WriteString(inner)
			writePyString(buffer, key)
			buffer.WriteString(": ")
			if err := writePy(buffer, item.values[key], inner); err != nil {
				return err
			}
		}
		buffer.WriteString("\n" + indent + "}")
	default:
		return fmt.Errorf("значение %T не представимо в JSON", value)
	}
	return nil
}

// errNotFinite — значение, которое json.dumps(allow_nan=False) отвергает.
var errNotFinite = errors.New("нечисловое значение")

// pyFloatRepr — repr(float) Python: кратчайшая точная запись; экспонента при порядке < -4 или ≥ 16,
// у целого значения в обычной записи — «.0».
func pyFloatRepr(value float64) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", errNotFinite
	}
	if value == 0 {
		if math.Signbit(value) {
			return "-0.0", nil
		}
		return "0.0", nil
	}
	scientific := strconv.FormatFloat(value, 'e', -1, 64)
	sign := ""
	if scientific[0] == '-' {
		sign, scientific = "-", scientific[1:]
	}
	mantissa, exponentText, _ := strings.Cut(scientific, "e")
	exponent, _ := strconv.Atoi(exponentText)
	digits := strings.Replace(mantissa, ".", "", 1)
	if exponent < -4 || exponent >= 16 {
		result := digits[:1]
		if len(digits) > 1 {
			result += "." + digits[1:]
		}
		expSign := "+"
		if exponent < 0 {
			expSign, exponent = "-", -exponent
		}
		return fmt.Sprintf("%s%se%s%02d", sign, result, expSign, exponent), nil
	}
	if exponent < 0 {
		return sign + "0." + strings.Repeat("0", -exponent-1) + digits, nil
	}
	if len(digits) <= exponent+1 {
		return sign + digits + strings.Repeat("0", exponent+1-len(digits)) + ".0", nil
	}
	return sign + digits[:exponent+1] + "." + digits[exponent+1:], nil
}

// writePyString — строка с ensure_ascii=False: экранируются кавычка, обратная косая черта и
// управляющие символы до U+0020 (\n, \r, \t, \b, \f коротко, остальные — \u00xx).
func writePyString(buffer *bytes.Buffer, text string) {
	buffer.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"':
			buffer.WriteString(`\"`)
		case '\\':
			buffer.WriteString(`\\`)
		case '\n':
			buffer.WriteString(`\n`)
		case '\r':
			buffer.WriteString(`\r`)
		case '\t':
			buffer.WriteString(`\t`)
		case '\b':
			buffer.WriteString(`\b`)
		case '\f':
			buffer.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(buffer, `\u%04x`, r)
			} else {
				buffer.WriteRune(r)
			}
		}
	}
	buffer.WriteByte('"')
}

// pyRound — round(value, 3) Python: целое остаётся целым, float округляется по точному двоичному
// значению с половиной к чётному (как корректно округлённая десятичная запись).
func pyRound(value any) any {
	switch number := value.(type) {
	case pyInt:
		return number
	case float64:
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return number
		}
		rounded, _ := strconv.ParseFloat(strconv.FormatFloat(number, 'f', 3, 64), 64)
		return rounded
	}
	return value
}

// pyNumber — значение числа int/float/bool для сравнений; ok=false — не число (TypeError в Python).
func pyNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case pyInt:
		return number.float(), true
	case float64:
		return number, true
	case bool:
		if number {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// pyTruthy — истинность значения Python.
func pyTruthy(value any) bool {
	switch item := value.(type) {
	case nil:
		return false
	case bool:
		return item
	case pyInt:
		return item.text != "0"
	case float64:
		return item != 0
	case string:
		return item != ""
	case []any:
		return len(item) > 0
	case *pyObject:
		return len(item.keys) > 0
	}
	return true
}

// pyIsInt — isinstance(value, int): bool в Python — подкласс int.
func pyIsInt(value any) bool {
	switch value.(type) {
	case pyInt, bool:
		return true
	}
	return false
}

// RoundSeconds — round(value, 3) Python для float: длительность трека из ffprobe в черновике.
func RoundSeconds(value float64) float64 { return pyRound(value).(float64) }
