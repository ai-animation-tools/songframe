package toolrt

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Строгий разбор JSON инструментов. Кроме стандартного JSON принимаются литералы NaN, Infinity и
// -Infinity и повторные ключи; строка с управляющим символом и BOM в начале отвергаются. Ошибка —
// JSONDecodeError с текстом причины и позицией («неверный JSON: ожидалось значение: строка 1,
// столбец 1 (символ 0)»): строка и столбец считаются с 1, символ — индекс кодовой точки
// документа с 0. Тексты и позиции
// зафиксированы эталоном JSON (TestJSONGolden).

// maxIntDigits — предел цифр целого литерала: более длинные целые JSON отвергаются ValueError
// «слишком длинное целое число».
const maxIntDigits = 4300

// stopIteration — внутренний сигнал сканера «здесь нет значения» с позицией.
type stopIteration struct{ position int }

func (s *stopIteration) Error() string { return "нет значения" }

// scanner — разбор одной строки; runes — кодовые точки документа.
type scanner struct{ runes []rune }

// decodeError — JSONDecodeError с позицией: строка — число переводов строк до позиции плюс 1,
// столбец — расстояние от последнего перевода строки.
func (s *scanner) decodeError(message string, position int) error {
	line, lastNewline := 1, -1
	for index := 0; index < position && index < len(s.runes); index++ {
		if s.runes[index] == '\n' {
			line++
			lastNewline = index
		}
	}
	return Raise(JSONDecodeError, "неверный JSON: %s: строка %d, столбец %d (символ %d)", message, line, position-lastNewline, position)
}

// LoadsJSON — разбор документа в значения модели пакета: дубликат ключа сохраняет первое место и
// последнее значение, литерал с дробной частью или экспонентой — float64, остальные числа — Int.
func LoadsJSON(text string) (any, error) {
	s := &scanner{runes: Runes(text)}
	if len(s.runes) > 0 && s.runes[0] == 0xFEFF {
		return nil, Raise(JSONDecodeError, "неверный JSON: метка порядка байтов в начале файла")
	}
	value, end, err := s.scan(s.skip(0))
	if err != nil {
		var stop *stopIteration
		if errors.As(err, &stop) {
			return nil, s.decodeError("ожидалось значение", stop.position)
		}
		return nil, err
	}
	if end = s.skip(end); end != len(s.runes) {
		return nil, s.decodeError("лишние данные после JSON", end)
	}
	return value, nil
}

// LoadJSONFile — разбор файла, прочитанного как текст UTF-8 (ReadText).
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

// scan — одно значение с позиции index; конец значения — вторым результатом.
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

// isDigit — цифра ASCII (числа JSON не принимают цифры Unicode).
func isDigit(r rune) bool { return r >= '0' && r <= '9' }

// scanNumber — число: целое без ведущих нулей, необязательные дробь и экспонента
// (экспонента без цифр откатывается и становится «лишние данные после JSON»).
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
		return nil, 0, Raise(ValueError, "слишком длинное целое число: %d цифр, предел %d", digits, maxIntDigits)
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

// scanString — строка в строгом режиме: end — позиция после открывающей кавычки.
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
				return "", 0, s.decodeError("управляющий символ в строке", next)
			}
		}
		if next >= length {
			return "", 0, s.decodeError("незакрытая строка", begin)
		}
		for _, r := range s.runes[end:next] {
			appendRune(&builder, r)
		}
		next++
		if c == '"' {
			return builder.String(), next, nil
		}
		if next == length {
			return "", 0, s.decodeError("незакрытая строка", begin)
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
				return "", 0, s.decodeError("неверная escape-последовательность", end-2)
			}
		} else {
			next++
			end = next + 4
			if end >= length {
				return "", 0, s.decodeError("неверная последовательность \\uXXXX", next-1)
			}
			c = 0
			for ; next < end; next++ {
				digit := hexValue(s.runes[next])
				if digit < 0 {
					return "", 0, s.decodeError("неверная последовательность \\uXXXX", end-5)
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
						return "", 0, s.decodeError("неверная последовательность \\uXXXX", end-5)
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

// scanObject — объект: index — позиция после «{».
func (s *scanner) scanObject(index int) (any, int, error) {
	object := NewDict()
	last := len(s.runes) - 1
	index = s.skip(index)
	if index <= last && s.runes[index] == '}' {
		return object, index + 1, nil
	}
	for {
		if index > last || s.runes[index] != '"' {
			return nil, 0, s.decodeError("ожидалось имя поля в двойных кавычках", index)
		}
		key, next, err := s.scanString(index + 1)
		if err != nil {
			return nil, 0, err
		}
		index = s.skip(next)
		if index > last || s.runes[index] != ':' {
			return nil, 0, s.decodeError("ожидалось двоеточие", index)
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
			return nil, 0, s.decodeError("ожидалась запятая", index)
		}
		index = s.skip(index + 1)
	}
}

// scanArray — массив: index — позиция после «[».
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
			return nil, 0, s.decodeError("ожидалась запятая", index)
		}
		index = s.skip(index + 1)
	}
}

// DumpOptions — параметры записи JSON. Нулевое значение — одна строка с разделителями ", " и
// ": ", символы вне ASCII как есть, NaN и бесконечности литералами.
type DumpOptions struct {
	// Indent — отступ вложенности в пробелах; отрицательное или нулевое значение без Pretty — без
	// отступов.
	Indent int
	// Pretty — многострочная запись: каждый элемент с новой строки, разделитель элементов «,»
	// (с Indent 0 — переводы строк без отступа).
	Pretty bool
	// SortKeys — ключи словарей по возрастанию кодовых точек.
	SortKeys bool
	// Compact — разделители без пробелов: «,» и «:».
	Compact bool
	// EnsureASCII — всё вне ASCII записывается \uXXXX (вне BMP — суррогатными парами).
	EnsureASCII bool
	// RejectNaN — NaN и бесконечности не записываются: ValueError.
	RejectNaN bool
}

// Indented — формат файлов инструментов: отступ 2, символы вне ASCII как есть.
var Indented = DumpOptions{Indent: 2, Pretty: true}

// DumpsJSON — запись значения в JSON с параметрами options. Записываемые байты получаются EncodeUTF8.
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
				return Raise(ValueError, "в JSON нельзя записать %s", FloatRepr(item))
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
			// Пустой указатель словаря пишется как null (так возвращают «нет документа» функции чтения).
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
		return Raise(TypeError, "в JSON нельзя записать значение вида %s", TypeName(value))
	}
	return nil
}

// dumpString — строка JSON: кавычка, обратная косая и управляющие символы до U+001F
// экранируются (\n, \r, \t, \b, \f коротко, остальные — \u00xx); U+007F и U+2028 — как есть,
// а при EnsureASCII экранируется всё вне печатного ASCII, включая U+007F.
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

// EncodeIndented — байты JSON-файла инструмента: запись Indented, перевод строки в конце, UTF-8.
// Так пишут WriteJSONAtomic и запись текстовых файлов инструментов.
func EncodeIndented(value any) ([]byte, error) {
	text, err := DumpsJSON(value, Indented)
	if err != nil {
		return nil, err
	}
	return EncodeUTF8(text + "\n")
}
