package main

// JSON с закреплённой раскладкой байтов. Квитанции сборки, отчёты политики runtime и метаданные
// frontend-пакетов в уведомлениях лицензий сравниваются между сборками побайтно, поэтому их
// запись не может зависеть от правил encoding/json (HTML-экранирование,  , порядок полей
// map). Здесь собраны ровно те правила, которые нужны этим файлам: отступ из двух пробелов или
// компактная строка с разделителями «, » и «: », экранирование управляющих символов в виде
// \u00XX, необязательное ASCII-экранирование с суррогатными парами и сохранение порядка ключей.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// field — пара ключ/значение объекта с сохранённым порядком.
type field struct {
	Key   string
	Value any
}

// object — JSON-объект, ключи которого записываются в порядке добавления (или по возрастанию
// при sortKeys). Повторная запись ключа через set заменяет значение на прежнем месте, как у
// словаря при разборе документа с повторяющимися ключами.
type object []field

// set заменяет значение существующего ключа или добавляет новый ключ в конец.
func (o *object) set(key string, value any) {
	for i := range *o {
		if (*o)[i].Key == key {
			(*o)[i].Value = value
			return
		}
	}
	*o = append(*o, field{key, value})
}

// get возвращает значение ключа и признак его наличия.
func (o object) get(key string) (any, bool) {
	for _, item := range o {
		if item.Key == key {
			return item.Value, true
		}
	}
	return nil, false
}

// jsonOptions задают раскладку: indent < 0 — одна строка, ensureASCII — экранировать всё вне
// печатного ASCII, sortKeys — упорядочить ключи всех вложенных объектов.
type jsonOptions struct {
	indent      int
	ensureASCII bool
	sortKeys    bool
}

// encodeJSON записывает значение без завершающего перевода строки. Поддерживаются nil, bool,
// целые, float64, json.Number, string, []string, []any, object и map[string]any (ключи map
// всегда упорядочены). Неподдерживаемый тип — ошибка программиста, поэтому вызывает panic.
func encodeJSON(value any, options jsonOptions) []byte {
	var out bytes.Buffer
	writeJSON(&out, value, options, 0)
	return out.Bytes()
}

// writeJSON рекурсивно записывает значение на заданной глубине вложенности.
func writeJSON(out *bytes.Buffer, value any, options jsonOptions, depth int) {
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if v {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case int:
		out.WriteString(strconv.Itoa(v))
	case int64:
		out.WriteString(strconv.FormatInt(v, 10))
	case float64:
		out.WriteString(formatFloat(v))
	case json.Number:
		out.WriteString(formatNumber(v))
	case string:
		writeString(out, v, options.ensureASCII)
	case []string:
		items := make([]any, len(v))
		for i, item := range v {
			items[i] = item
		}
		writeArray(out, items, options, depth)
	case []any:
		writeArray(out, v, options, depth)
	case object:
		fields := v
		if options.sortKeys {
			fields = append(object(nil), v...)
			sort.SliceStable(fields, func(i, j int) bool { return fields[i].Key < fields[j].Key })
		}
		writeObject(out, fields, options, depth)
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		fields := make(object, 0, len(keys))
		for _, key := range keys {
			fields = append(fields, field{key, v[key]})
		}
		writeObject(out, fields, options, depth)
	default:
		panic(fmt.Sprintf("неподдерживаемый тип JSON: %T", value))
	}
}

// separator пишет разделитель перед элементом контейнера: перевод строки с отступом или «, ».
func separator(out *bytes.Buffer, options jsonOptions, depth int, first bool) {
	if options.indent < 0 {
		if !first {
			out.WriteString(", ")
		}
		return
	}
	if !first {
		out.WriteByte(',')
	}
	out.WriteByte('\n')
	out.WriteString(strings.Repeat(" ", options.indent*depth))
}

// writeArray записывает массив; пустой массив всегда «[]».
func writeArray(out *bytes.Buffer, items []any, options jsonOptions, depth int) {
	if len(items) == 0 {
		out.WriteString("[]")
		return
	}
	out.WriteByte('[')
	for i, item := range items {
		separator(out, options, depth+1, i == 0)
		writeJSON(out, item, options, depth+1)
	}
	separator(out, options, depth, true)
	out.WriteByte(']')
}

// writeObject записывает объект; пустой объект всегда «{}».
func writeObject(out *bytes.Buffer, fields object, options jsonOptions, depth int) {
	if len(fields) == 0 {
		out.WriteString("{}")
		return
	}
	out.WriteByte('{')
	for i, item := range fields {
		separator(out, options, depth+1, i == 0)
		writeString(out, item.Key, options.ensureASCII)
		out.WriteString(": ")
		writeJSON(out, item.Value, options, depth+1)
	}
	separator(out, options, depth, true)
	out.WriteByte('}')
}

// writeString экранирует кавычку, обратную косую черту и управляющие символы; при ensureASCII
// также всё вне диапазона пробел..тильда, символы вне BMP — суррогатной парой. Байт неверного
// UTF-8 (имя файла не в UTF-8) записывается как одиночный суррогат U+DCxx или как есть.
func writeString(out *bytes.Buffer, value string, ensureASCII bool) {
	out.WriteByte('"')
	for i := 0; i < len(value); {
		r, size := utf8.DecodeRuneInString(value[i:])
		if r == utf8.RuneError && size == 1 {
			if ensureASCII {
				fmt.Fprintf(out, "\\u%04x", 0xdc00+int(value[i]))
			} else {
				out.WriteByte(value[i])
			}
			i++
			continue
		}
		i += size
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(out, "\\u%04x", r)
			case ensureASCII && r > 0x7e && r < 0x10000:
				fmt.Fprintf(out, "\\u%04x", r)
			case ensureASCII && r >= 0x10000:
				v := r - 0x10000
				fmt.Fprintf(out, "\\u%04x\\u%04x", 0xd800+(v>>10), 0xdc00+(v&0x3ff))
			default:
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}

// formatNumber сохраняет целое число из исходного документа как есть, а дробное переписывает
// кратчайшей записью float, как при повторной записи разобранного значения.
func formatNumber(number json.Number) string {
	text := number.String()
	if !strings.ContainsAny(text, ".eE") {
		return normalizeInteger(text)
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return text
	}
	return formatFloat(value)
}

// normalizeInteger переписывает десятичное целое без ведущих нулей и знака у нуля
// («-0» → «0»); длина числа не ограничивается.
func normalizeInteger(text string) string {
	digits := strings.TrimPrefix(text, "-")
	if digits == "" || strings.Trim(digits, "0123456789") != "" {
		return text
	}
	trimmed := strings.TrimLeft(digits, "0")
	if trimmed == "" {
		return "0"
	}
	if strings.HasPrefix(text, "-") {
		return "-" + trimmed
	}
	return trimmed
}

// formatFloat даёт кратчайшее представление float: фиксированная запись с «.0» при показателе
// от -4 до 15, иначе экспонента вида 1e+16 / 1e-05.
func formatFloat(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	}
	scientific := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponentText, _ := strings.Cut(scientific, "e")
	exponent, _ := strconv.Atoi(exponentText)
	if exponent < -4 || exponent >= 16 {
		sign := "+"
		if exponent < 0 {
			sign, exponent = "-", -exponent
		}
		return fmt.Sprintf("%se%s%02d", mantissa, sign, exponent)
	}
	fixed := strconv.FormatFloat(value, 'f', -1, 64)
	if !strings.ContainsAny(fixed, ".") {
		fixed += ".0"
	}
	return fixed
}

// decodeOrdered разбирает один JSON-документ, сохраняя порядок ключей объектов (object),
// числа как json.Number. Порядок важен там, где от него зависит результат обхода: зависимости
// frontend и требования манифеста медиавозможностей.
func decodeOrdered(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("лишние данные после JSON-документа")
	}
	return value, nil
}

// decodeValue читает одно значение из потока токенов.
func decodeValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch t := token.(type) {
	case json.Delim:
		switch t {
		case '{':
			result := object{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				value, err := decodeValue(decoder)
				if err != nil {
					return nil, err
				}
				result.set(keyToken.(string), value)
			}
			_, err := decoder.Token()
			return result, err
		case '[':
			result := []any{}
			for decoder.More() {
				value, err := decodeValue(decoder)
				if err != nil {
					return nil, err
				}
				result = append(result, value)
			}
			_, err := decoder.Token()
			return result, err
		}
		return nil, fmt.Errorf("неожиданный разделитель JSON %v", t)
	default:
		return token, nil
	}
}
