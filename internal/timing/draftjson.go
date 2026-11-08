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

// Черновик автоматической разметки записывается в формате, зафиксированном эталоном
// timing-draft: отступ два пробела, не-ASCII символы без экранирования, перевод строки в конце.
// Чтобы числа и формат не расходились с ним, черновик строится на собственной модели значений:
// целое и дробное различаются (7 и 7.0 пишутся по-разному и по-разному округляются), порядок
// ключей — порядок вставки, дробные числа печатаются кратчайшей точной записью (formatDraftFloat).
//
// Модель значений: nil (null), bool, exactInt (целое), float64, string, []any, *draftObject.

// exactInt — целое JSON без ограничения разрядности. Хранится текстом в нормализованной
// десятичной записи, чтобы целые за пределами int64 из прежнего файла переносились без потери.
type exactInt struct{ text string }

// newExactInt — целое из Go int.
func newExactInt(value int) exactInt { return exactInt{strconv.Itoa(value)} }

// float — значение целого для сравнений и арифметики с float (ближайшее float64).
func (i exactInt) float() float64 {
	value, _ := strconv.ParseFloat(i.text, 64)
	return value
}

// int — значение для номеров строк; ok=false — не помещается в int.
func (i exactInt) int() (int, bool) {
	value, err := strconv.Atoi(i.text)
	return value, err == nil
}

// draftObject — объект JSON с порядком вставки ключей.
type draftObject struct {
	keys   []string
	values map[string]any
}

func newDraftObject() *draftObject { return &draftObject{values: map[string]any{}} }

// set заменяет значение на месте существующего ключа или добавляет ключ в конец.
func (o *draftObject) set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// get — значение ключа: отсутствующий ключ даёт (nil, false).
func (o *draftObject) get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

// clone — поверхностная копия: новая карта с тем же порядком, значения не копируются глубоко.
func (o *draftObject) clone() *draftObject {
	result := &draftObject{keys: append([]string(nil), o.keys...), values: make(map[string]any, len(o.values))}
	for key, value := range o.values {
		result.values[key] = value
	}
	return result
}

// parseDraftJSON разбирает JSON в модель черновика: дубликат ключа оставляет первое место и
// последнее значение, литерал с «.», «e» или «E» — float, иначе целое. Числа за пределами float
// дают ±Inf; их отклоняет запись (encodeDraftJSON не пишет нечисловые значения).
func parseDraftJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeDraft(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("лишние данные после JSON")
	}
	return value, nil
}

func decodeDraft(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		if value == '[' {
			items := []any{}
			for decoder.More() {
				item, err := decodeDraft(decoder)
				if err != nil {
					return nil, err
				}
				items = append(items, item)
			}
			_, err := decoder.Token()
			return items, err
		}
		object := newDraftObject()
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			item, err := decodeDraft(decoder)
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
		return exactInt{integer.String()}, nil
	default:
		return value, nil
	}
}

// encodeDraftJSON — байты черновика: отступ два пробела, не-ASCII без экранирования и перевод
// строки в конце. NaN/Infinity — ошибка: такая разметка не записывается.
func encodeDraftJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	if err := writeDraft(&buffer, value, ""); err != nil {
		return nil, err
	}
	buffer.WriteByte('\n')
	return buffer.Bytes(), nil
}

func writeDraft(buffer *bytes.Buffer, value any, indent string) error {
	switch item := value.(type) {
	case nil:
		buffer.WriteString("null")
	case bool:
		buffer.WriteString(strconv.FormatBool(item))
	case exactInt:
		buffer.WriteString(item.text)
	case float64:
		text, err := formatDraftFloat(item)
		if err != nil {
			return err
		}
		buffer.WriteString(text)
	case string:
		writeDraftString(buffer, item)
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
			if err := writeDraft(buffer, element, inner); err != nil {
				return err
			}
		}
		buffer.WriteString("\n" + indent + "]")
	case *draftObject:
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
			writeDraftString(buffer, key)
			buffer.WriteString(": ")
			if err := writeDraft(buffer, item.values[key], inner); err != nil {
				return err
			}
		}
		buffer.WriteString("\n" + indent + "}")
	default:
		return fmt.Errorf("значение %T не представимо в JSON", value)
	}
	return nil
}

// errNotFinite — нечисловое значение (NaN, ±Inf), которое не записывается в JSON.
var errNotFinite = errors.New("нечисловое значение")

// formatDraftFloat — запись дробного числа: кратчайшая точная запись; экспонента при порядке
// < -4 или ≥ 16 (с двумя цифрами и знаком: 1e-07, 1e+16), у целого значения в обычной записи — «.0».
func formatDraftFloat(value float64) (string, error) {
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

// writeDraftString — строка JSON без экранирования не-ASCII: экранируются кавычка, обратная косая черта и
// управляющие символы до U+0020 (\n, \r, \t, \b, \f коротко, остальные — \u00xx).
func writeDraftString(buffer *bytes.Buffer, text string) {
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

// roundMillis — округление до трёх знаков: целое остаётся целым, float округляется по точному
// двоичному значению с половиной к чётному (как корректно округлённая десятичная запись).
func roundMillis(value any) any {
	switch number := value.(type) {
	case exactInt:
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

// numberOf — значение целого, дробного или bool для сравнений; ok=false — не число (ошибка данных).
func numberOf(value any) (float64, bool) {
	switch number := value.(type) {
	case exactInt:
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

// truthy — истинность значения: ложны null, false, ноль, пустые строка, список и объект.
func truthy(value any) bool {
	switch item := value.(type) {
	case nil:
		return false
	case bool:
		return item
	case exactInt:
		return item.text != "0"
	case float64:
		return item != 0
	case string:
		return item != ""
	case []any:
		return len(item) > 0
	case *draftObject:
		return len(item.keys) > 0
	}
	return true
}

// isIntegerValue — целое значение модели; bool тоже считается целым (true = 1, false = 0).
func isIntegerValue(value any) bool {
	switch value.(type) {
	case exactInt, bool:
		return true
	}
	return false
}

// RoundSeconds — округление float до трёх знаков (roundMillis): длительность трека из ffprobe в черновике.
func RoundSeconds(value float64) float64 { return roundMillis(value).(float64) }
