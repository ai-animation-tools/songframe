package pycompat

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Разбор JSON повторяет C-сканер модуля json CPython 3.12 (Modules/_json.c): какие документы
// принимаются (NaN, Infinity, дубликаты ключей) и какие тексты и позиции у JSONDecodeError
// («Expecting value: line 1 column 1 (char 0)»). Позиции — индексы кодовых точек строки.

// maxIntDigits — sys.get_int_max_str_digits() по умолчанию: длинные целые JSON отвергаются.
const maxIntDigits = 4300

// stopIteration — внутренний сигнал сканера «здесь нет значения» с позицией.
type stopIteration struct{ position int }

func (s *stopIteration) Error() string { return "StopIteration" }

// scanner — разбор одной строки; runes — кодовые точки документа.
type scanner struct{ runes []rune }

// decodeError — JSONDecodeError с позицией, строкой и столбцом, как JSONDecodeError.__init__.
func (s *scanner) decodeError(message string, position int) error {
	line, lastNewline := 1, -1
	for index := 0; index < position && index < len(s.runes); index++ {
		if s.runes[index] == '\n' {
			line++
			lastNewline = index
		}
	}
	return Raise(JSONDecodeError, "%s: line %d column %d (char %d)", message, line, position-lastNewline, position)
}

// LoadsJSON — json.loads(text) для str: значения модели пакета, дубликат ключа сохраняет первое
// место и последнее значение, литерал с дробной частью или экспонентой — float.
func LoadsJSON(text string) (any, error) {
	s := &scanner{runes: Runes(text)}
	if len(s.runes) > 0 && s.runes[0] == 0xFEFF {
		return nil, s.decodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0)
	}
	value, end, err := s.scan(s.skip(0))
	if err != nil {
		var stop *stopIteration
		if errors.As(err, &stop) {
			return nil, s.decodeError("Expecting value", stop.position)
		}
		return nil, err
	}
	if end = s.skip(end); end != len(s.runes) {
		return nil, s.decodeError("Extra data", end)
	}
	return value, nil
}

// LoadJSONFile — json.loads(Path(path).read_text(encoding="utf-8")).
func LoadJSONFile(path string) (any, error) {
	text, err := ReadText(path)
	if err != nil {
		return nil, err
	}
	return LoadsJSON(text)
}

// skip — пропуск пробелов JSON (пробел, \t, \n, \r).
func (s *scanner) skip(index int) int {
	for index < len(s.runes) {
		switch s.runes[index] {
		case ' ', '\t', '\n', '\r':
			index++
		default:
			return index
		}
	}
	return index
}

// literal — совпадает ли текст с позиции index.
func (s *scanner) literal(index int, word string) bool {
	runes := []rune(word)
	if index+len(runes) > len(s.runes) {
		return false
	}
	for offset, r := range runes {
		if s.runes[index+offset] != r {
			return false
		}
	}
	return true
}

// scan — scan_once: одно значение с позиции index; конец значения — вторым результатом.
func (s *scanner) scan(index int) (any, int, error) {
	if index >= len(s.runes) {
		return nil, 0, &stopIteration{index}
	}
	switch s.runes[index] {
	case '"':
		text, end, err := s.scanString(index + 1)
		return text, end, err
	case '{':
		return s.scanObject(index + 1)
	case '[':
		return s.scanArray(index + 1)
	case 'n':
		if s.literal(index, "null") {
			return nil, index + 4, nil
		}
	case 't':
		if s.literal(index, "true") {
			return true, index + 4, nil
		}
	case 'f':
		if s.literal(index, "false") {
			return false, index + 5, nil
		}
	case 'N':
		if s.literal(index, "NaN") {
			return math.NaN(), index + 3, nil
		}
	case 'I':
		if s.literal(index, "Infinity") {
			return math.Inf(1), index + 8, nil
		}
	case '-':
		if s.literal(index, "-Infinity") {
			return math.Inf(-1), index + 9, nil
		}
	}
	return s.scanNumber(index)
}

// isDigit — цифра ASCII (сканер чисел json не принимает цифры Unicode).
func isDigit(r rune) bool { return r >= '0' && r <= '9' }

// scanNumber — _match_number_unicode: целое без ведущих нулей, необязательные дробь и экспонента
// (экспонента без цифр откатывается и становится «Extra data»).
func (s *scanner) scanNumber(start int) (any, int, error) {
	index, last := start, len(s.runes)-1
	if s.runes[index] == '-' {
		index++
		if index > last {
			return nil, 0, &stopIteration{start}
		}
	}
	switch r := s.runes[index]; {
	case r >= '1' && r <= '9':
		index++
		for index <= last && isDigit(s.runes[index]) {
			index++
		}
	case r == '0':
		index++
	default:
		return nil, 0, &stopIteration{start}
	}
	isFloat := false
	if index < last && s.runes[index] == '.' && isDigit(s.runes[index+1]) {
		isFloat = true
		index += 2
		for index <= last && isDigit(s.runes[index]) {
			index++
		}
	}
	if index < last && (s.runes[index] == 'e' || s.runes[index] == 'E') {
		exponentStart := index
		index++
		if index < last && (s.runes[index] == '-' || s.runes[index] == '+') {
			index++
		}
		for index <= last && isDigit(s.runes[index]) {
			index++
		}
		if isDigit(s.runes[index-1]) {
			isFloat = true
		} else {
			index = exponentStart
		}
	}
	text := string(s.runes[start:index])
	if isFloat {
		value, err := strconv.ParseFloat(text, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, 0, err
		}
		return value, index, nil
	}
	if digits := len(strings.TrimPrefix(text, "-")); digits > maxIntDigits {
		return nil, 0, Raise(ValueError, "Exceeds the limit (%d digits) for integer string conversion: value has %d digits; use sys.set_int_max_str_digits() to increase the limit", maxIntDigits, digits)
	}
	value, _ := ParseInt(text)
	return value, index, nil
}

// hexValue — значение шестнадцатеричной цифры или -1.
func hexValue(r rune) rune {
	switch {
	case r >= '0' && r <= '9':
		return r - '0'
	case r >= 'a' && r <= 'f':
		return r - 'a' + 10
	case r >= 'A' && r <= 'F':
		return r - 'A' + 10
	}
	return -1
}

// scanString — scanstring_unicode в строгом режиме: end — позиция после открывающей кавычки.
// Управляющий символ до U+001F внутри строки — ошибка; \uD800 без пары остаётся суррогатом.
func (s *scanner) scanString(end int) (string, int, error) {
	begin := end - 1
	length := len(s.runes)
	var builder strings.Builder
	for {
		next := end
		var c rune
		for ; next < length; next++ {
			c = s.runes[next]
			if c == '"' || c == '\\' {
				break
			}
			if c <= 0x1f {
				return "", 0, s.decodeError("Invalid control character at", next)
			}
		}
		if next >= length {
			return "", 0, s.decodeError("Unterminated string starting at", begin)
		}
		for _, r := range s.runes[end:next] {
			appendRune(&builder, r)
		}
		next++
		if c == '"' {
			return builder.String(), next, nil
		}
		if next == length {
			return "", 0, s.decodeError("Unterminated string starting at", begin)
		}
		c = s.runes[next]
		if c != 'u' {
			end = next + 1
			switch c {
			case '"', '\\', '/':
			case 'b':
				c = '\b'
			case 'f':
				c = '\f'
			case 'n':
				c = '\n'
			case 'r':
				c = '\r'
			case 't':
				c = '\t'
			default:
				return "", 0, s.decodeError("Invalid \\escape", end-2)
			}
		} else {
			next++
			end = next + 4
			if end >= length {
				return "", 0, s.decodeError("Invalid \\uXXXX escape", next-1)
			}
			c = 0
			for ; next < end; next++ {
				digit := hexValue(s.runes[next])
				if digit < 0 {
					return "", 0, s.decodeError("Invalid \\uXXXX escape", end-5)
				}
				c = c<<4 | digit
			}
			if c >= 0xD800 && c <= 0xDBFF && end+6 < length && s.runes[next] == '\\' && s.runes[next+1] == 'u' {
				next += 2
				end += 6
				var low rune
				for ; next < end; next++ {
					digit := hexValue(s.runes[next])
					if digit < 0 {
						return "", 0, s.decodeError("Invalid \\uXXXX escape", end-5)
					}
					low = low<<4 | digit
				}
				if low >= 0xDC00 && low <= 0xDFFF {
					c = 0x10000 + (c-0xD800)<<10 + (low - 0xDC00)
				} else {
					end -= 6
				}
			}
		}
		appendRune(&builder, c)
	}
}

// scanObject — _parse_object_unicode: index — позиция после «{».
func (s *scanner) scanObject(index int) (any, int, error) {
	object := NewDict()
	last := len(s.runes) - 1
	index = s.skip(index)
	if index <= last && s.runes[index] == '}' {
		return object, index + 1, nil
	}
	for {
		if index > last || s.runes[index] != '"' {
			return nil, 0, s.decodeError("Expecting property name enclosed in double quotes", index)
		}
		key, next, err := s.scanString(index + 1)
		if err != nil {
			return nil, 0, err
		}
		index = s.skip(next)
		if index > last || s.runes[index] != ':' {
			return nil, 0, s.decodeError("Expecting ':' delimiter", index)
		}
		value, next, err := s.scan(s.skip(index + 1))
		if err != nil {
			return nil, 0, err
		}
		object.Set(key, value)
		index = s.skip(next)
		if index <= last && s.runes[index] == '}' {
			return object, index + 1, nil
		}
		if index > last || s.runes[index] != ',' {
			return nil, 0, s.decodeError("Expecting ',' delimiter", index)
		}
		index = s.skip(index + 1)
	}
}

// scanArray — _parse_array_unicode: index — позиция после «[».
func (s *scanner) scanArray(index int) (any, int, error) {
	items := []any{}
	last := len(s.runes) - 1
	index = s.skip(index)
	if index <= last && s.runes[index] == ']' {
		return items, index + 1, nil
	}
	for {
		value, next, err := s.scan(index)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, value)
		index = s.skip(next)
		if index <= last && s.runes[index] == ']' {
			return items, index + 1, nil
		}
		if index > last || s.runes[index] != ',' {
			return nil, 0, s.decodeError("Expecting ',' delimiter", index)
		}
		index = s.skip(index + 1)
	}
}

// DumpOptions — параметры json.dumps. Нулевое значение — json.dumps(value, ensure_ascii=False):
// одна строка с разделителями ", " и ": ".
type DumpOptions struct {
	// Indent — indent=N; отрицательное или нулевое значение без Pretty — без отступов.
	Indent int
	// Pretty — задан indent (0 даёт переводы строк без отступа, как в Python).
	Pretty bool
	// SortKeys — sort_keys=True: ключи по кодовым точкам.
	SortKeys bool
	// Compact — separators=(",", ":").
	Compact bool
	// EnsureASCII — ensure_ascii=True: всё вне ASCII — \uXXXX (суррогатными парами).
	EnsureASCII bool
	// RejectNaN — allow_nan=False: NaN и бесконечности — ValueError.
	RejectNaN bool
}

// Indented — json.dumps(value, ensure_ascii=False, indent=2): формат файлов инструментов.
var Indented = DumpOptions{Indent: 2, Pretty: true}

// DumpsJSON — json.dumps с параметрами options. Записываемые байты получаются EncodeUTF8.
func DumpsJSON(value any, options DumpOptions) (string, error) {
	var builder strings.Builder
	if err := dump(&builder, value, options, ""); err != nil {
		return "", err
	}
	return builder.String(), nil
}

func dump(builder *strings.Builder, value any, options DumpOptions, indent string) error {
	itemSeparator, keySeparator := ", ", ": "
	if options.Pretty {
		itemSeparator = ","
	}
	if options.Compact {
		itemSeparator, keySeparator = ",", ":"
	}
	inner := indent + strings.Repeat(" ", max(options.Indent, 0))
	open := func(bracket string) {
		builder.WriteString(bracket)
		if options.Pretty {
			builder.WriteString("\n" + inner)
		}
	}
	closing := func(bracket string) {
		if options.Pretty {
			builder.WriteString("\n" + indent)
		}
		builder.WriteString(bracket)
	}
	separator := func() {
		builder.WriteString(itemSeparator)
		if options.Pretty {
			builder.WriteString("\n" + inner)
		}
	}
	switch item := value.(type) {
	case nil:
		builder.WriteString("null")
	case bool:
		builder.WriteString(strconv.FormatBool(item))
	case Int:
		builder.WriteString(item.String())
	case float64:
		switch {
		case math.IsNaN(item) || math.IsInf(item, 0):
			if options.RejectNaN {
				return Raise(ValueError, "Out of range float values are not JSON compliant: %s", FloatRepr(item))
			}
			switch {
			case math.IsNaN(item):
				builder.WriteString("NaN")
			case item > 0:
				builder.WriteString("Infinity")
			default:
				builder.WriteString("-Infinity")
			}
		default:
			builder.WriteString(FloatRepr(item))
		}
	case string:
		dumpString(builder, item, options.EnsureASCII)
	case []any:
		if len(item) == 0 {
			builder.WriteString("[]")
			return nil
		}
		open("[")
		for index, element := range item {
			if index > 0 {
				separator()
			}
			if err := dump(builder, element, options, inner); err != nil {
				return err
			}
		}
		closing("]")
	case *Dict:
		if item == nil {
			// Пустой указатель словаря — None (так возвращают «нет документа» функции чтения).
			builder.WriteString("null")
			return nil
		}
		if item.Len() == 0 {
			builder.WriteString("{}")
			return nil
		}
		keys := item.Keys()
		if options.SortKeys {
			sort.Strings(keys)
		}
		open("{")
		for index, key := range keys {
			if index > 0 {
				separator()
			}
			dumpString(builder, key, options.EnsureASCII)
			builder.WriteString(keySeparator)
			if err := dump(builder, item.values[key], options, inner); err != nil {
				return err
			}
		}
		closing("}")
	default:
		return Raise(TypeError, "Object of type %T is not JSON serializable", value)
	}
	return nil
}

// dumpString — encode_basestring(_ascii): кавычка, обратная косая и управляющие символы до U+001F
// экранируются (\n, \r, \t, \b, \f коротко, остальные — \u00xx); U+007F и U+2028 — как есть,
// а при ensure_ascii экранируется всё вне печатного ASCII, включая U+007F.
func dumpString(builder *strings.Builder, text string, ensureASCII bool) {
	builder.WriteByte('"')
	for _, r := range Runes(text) {
		switch r {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(builder, `\u%04x`, r)
			case ensureASCII && r >= 0x7f && r <= 0xffff:
				fmt.Fprintf(builder, `\u%04x`, r)
			case ensureASCII && r > 0xffff:
				value := r - 0x10000
				fmt.Fprintf(builder, `\u%04x\u%04x`, 0xD800|(value>>10)&0x3FF, 0xDC00|value&0x3FF)
			default:
				appendRune(builder, r)
			}
		}
	}
	builder.WriteByte('"')
}

// EncodeIndented — байты файла json.dumps(value, ensure_ascii=False, indent=2) + "\n" в UTF-8:
// так пишут write_json_atomic и write_text инструментов.
func EncodeIndented(value any) ([]byte, error) {
	text, err := DumpsJSON(value, Indented)
	if err != nil {
		return nil, err
	}
	return EncodeUTF8(text + "\n")
}
