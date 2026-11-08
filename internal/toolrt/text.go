package toolrt

import (
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Строки модели индексируются кодовыми точками и могут содержать одиночные суррогаты (их даёт
// \ud800 в JSON). В Go строка — байты; суррогаты хранятся в WTF-8 (три байта ED A0..BF xx), которые
// utf8 считает ошибочными. Функции ниже читают и пишут такие строки без замены на U+FFFD.

// decodeRune — следующая кодовая точка WTF-8: суррогат возвращается как есть.
func decodeRune(text string) (rune, int) {
	r, size := utf8.DecodeRuneInString(text)
	if r == utf8.RuneError && size == 1 && len(text) >= 3 && text[0] == 0xED && text[1] >= 0xA0 && text[1] <= 0xBF && text[2] >= 0x80 && text[2] <= 0xBF {
		return rune(0xD000 | rune(text[1]&0x3F)<<6 | rune(text[2]&0x3F)), 3
	}
	return r, size
}

// Runes — кодовые точки строки (по ним строка индексируется и измеряется), включая одиночные суррогаты.
func Runes(text string) []rune {
	result := make([]rune, 0, len(text))
	for index := 0; index < len(text); {
		r, size := decodeRune(text[index:])
		result = append(result, r)
		index += size
	}
	return result
}

// appendRune — запись кодовой точки, суррогат — тремя байтами WTF-8.
func appendRune(builder *strings.Builder, r rune) {
	if r >= 0xD800 && r <= 0xDFFF {
		builder.WriteByte(0xED)
		builder.WriteByte(byte(0x80 | (r>>6)&0x3F))
		builder.WriteByte(byte(0x80 | r&0x3F))
		return
	}
	builder.WriteRune(r)
}

// FromRunes — строка из кодовых точек (обратное Runes).
func FromRunes(runes []rune) string {
	var builder strings.Builder
	for _, r := range runes {
		appendRune(&builder, r)
	}
	return builder.String()
}

// Len — длина строки в кодовых точках.
func Len(text string) int { return len(Runes(text)) }

// DecodeUTF8 — строгое декодирование UTF-8: ошибка — UnicodeDecodeError с текстом
// «'utf-8' codec can't decode byte 0xff in position 3: invalid start byte». Позиция — смещение в
// байтах; границы неверного участка и причина — по invalidUTF8.
func DecodeUTF8(data []byte) (string, error) {
	if start, end, reason, ok := invalidUTF8(data, 0); ok {
		return "", decodeError(data, start, end, reason)
	}
	return string(data), nil
}

// DecodeReplace — декодирование UTF-8 с заменой: каждый максимальный неверный участок
// (invalidUTF8) заменяется одним U+FFFD. utf8/strings.ToValidUTF8 Go режут иначе (по байту или
// целыми сериями), поэтому хвосты stderr FFmpeg в текстах ошибок разошлись бы с эталонами.
func DecodeReplace(data []byte) string {
	var builder strings.Builder
	for index := 0; index < len(data); {
		start, end, _, ok := invalidUTF8(data, index)
		if !ok {
			builder.Write(data[index:])
			break
		}
		builder.Write(data[index:start])
		builder.WriteRune(utf8.RuneError)
		index = end
	}
	return builder.String()
}

// invalidUTF8 — первый неверный участок [start, end) начиная с from и его причина; ok=false —
// дальше всё верно. Участок — максимальная допустимая начальная часть последовательности:
// недопустимый первый байт — один байт («invalid start byte»), обрыв данных — до конца
// («unexpected end of data»), неверный байт продолжения — до него, не включая
// («invalid continuation byte»). Суррогаты (ED A0..BF) и избыточные записи (C0, C1, E0 80..9F,
// F0 80..8F) отвергаются вторым байтом. Те же границы печатает UnicodeDecodeError и заменяет
// DecodeReplace.
func invalidUTF8(data []byte, from int) (start, end int, reason string, ok bool) {
	for index := from; index < len(data); {
		first := data[index]
		if first < 0x80 {
			index++
			continue
		}
		need, low, high := 0, byte(0x80), byte(0xBF)
		switch {
		case first >= 0xC2 && first <= 0xDF:
			need = 1
		case first >= 0xE0 && first <= 0xEF:
			need = 2
			if first == 0xE0 {
				low = 0xA0
			} else if first == 0xED {
				high = 0x9F
			}
		case first >= 0xF0 && first <= 0xF4:
			need = 3
			if first == 0xF0 {
				low = 0x90
			} else if first == 0xF4 {
				high = 0x8F
			}
		default:
			return index, index + 1, "invalid start byte", true
		}
		for offset := 1; offset <= need; offset++ {
			position := index + offset
			if position >= len(data) {
				return index, len(data), "unexpected end of data", true
			}
			value := data[position]
			minimum, maximum := byte(0x80), byte(0xBF)
			if offset == 1 {
				minimum, maximum = low, high
			}
			if value < minimum || value > maximum {
				return index, position, "invalid continuation byte", true
			}
		}
		index += need + 1
	}
	return 0, 0, "", false
}

// decodeError — UnicodeDecodeError для байтов [start, end).
func decodeError(data []byte, start, end int, reason string) error {
	if end-start == 1 {
		return Raise(UnicodeDecodeError, "'utf-8' codec can't decode byte 0x%02x in position %d: %s", data[start], start, reason)
	}
	return Raise(UnicodeDecodeError, "'utf-8' codec can't decode bytes in position %d-%d: %s", start, end-1, reason)
}

// EncodeUTF8 — кодирование строки в UTF-8: одиночный суррогат (или их серия) —
// UnicodeEncodeError с позицией в кодовых точках.
func EncodeUTF8(text string) ([]byte, error) {
	if utf8.ValidString(text) {
		return []byte(text), nil
	}
	runes := Runes(text)
	for index, r := range runes {
		if r < 0xD800 || r > 0xDFFF {
			continue
		}
		end := index + 1
		for end < len(runes) && runes[end] >= 0xD800 && runes[end] <= 0xDFFF {
			end++
		}
		if end-index == 1 {
			return nil, Raise(UnicodeEncodeError, "'utf-8' codec can't encode character '\\u%04x' in position %d: surrogates not allowed", r, index)
		}
		return nil, Raise(UnicodeEncodeError, "'utf-8' codec can't encode characters in position %d-%d: surrogates not allowed", index, end-1)
	}
	return []byte(text), nil
}

// TranslateNewlines — универсальные переводы строк при чтении текста: \r\n и \r — \n.
func TranslateNewlines(text string) string {
	if !strings.Contains(text, "\r") {
		return text
	}
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
}

// ReadText — чтение текстового файла: байты файла, строгое декодирование UTF-8 и
// универсальные переводы строк. Ошибка — OSError (с путём, как его передал вызывающий) или
// UnicodeDecodeError.
func ReadText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", OSErrorFrom(err, path)
	}
	text, err := DecodeUTF8(data)
	if err != nil {
		return "", err
	}
	return TranslateNewlines(text), nil
}

// IsNotFound — ошибка ReadText означает отсутствующий файл (FileNotFoundError).
func IsNotFound(err error) bool { return Is(err, FileNotFoundError) }

// IsSpace — пробельный символ: пробелы Unicode и разделители \x1c–\x1f.
func IsSpace(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) }

// Strip — строка без пробельных символов (IsSpace) по краям.
func Strip(text string) string { return strings.TrimFunc(text, IsSpace) }

// SplitLines — разбиение на строки по всем границам строк Unicode (\n, \r, \r\n как одна, \v, \f,
// \x1c–\x1e, U+0085, U+2028, U+2029), без пустого хвоста и без самих разделителей.
func SplitLines(text string) []string {
	lines := []string{}
	start := 0
	for index := 0; index < len(text); {
		r, size := decodeRune(text[index:])
		switch r {
		case '\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\u0085', ' ', ' ':
			lines = append(lines, text[start:index])
			start = index + size
		case '\r':
			lines = append(lines, text[start:index])
			if strings.HasPrefix(text[index+size:], "\n") {
				size++
			}
			start = index + size
		}
		index += size
	}
	if start < len(text) {
		lines = append(lines, text[start:])
	}
	return lines
}

// DigitValue — значение десятичной цифры Unicode (категория Nd) или -1. Цифры Nd в Unicode идут
// блоками по десять, начиная с нуля, поэтому значение — позиция в непрерывном блоке.
func DigitValue(r rune) int {
	if r >= '0' && r <= '9' {
		return int(r - '0')
	}
	if !unicode.Is(unicode.Nd, r) {
		return -1
	}
	count := 0
	for previous := r - 1; unicode.Is(unicode.Nd, previous); previous-- {
		count++
	}
	return count % 10
}

// asciiNumber — подготовка строки числа к разбору: строка не из ASCII получает цифры ASCII вместо
// цифр Unicode и пробел вместо любого пробельного символа; ASCII-строка не меняется.
func asciiNumber(text string) string {
	isASCII := true
	for index := 0; index < len(text); index++ {
		if text[index] >= 0x80 {
			isASCII = false
			break
		}
	}
	if isASCII {
		return text
	}
	var builder strings.Builder
	for _, r := range Runes(text) {
		switch {
		case IsSpace(r):
			builder.WriteByte(' ')
		case r >= 0x80 && DigitValue(r) >= 0:
			builder.WriteByte(byte('0' + DigitValue(r)))
		default:
			appendRune(&builder, r)
		}
	}
	return builder.String()
}

// asciiSpace — пробельные символы ASCII (пробел, \t, \n, \v, \f, \r).
func asciiSpace(r rune) bool { return r == ' ' || (r >= '\t' && r <= '\r') }

// digitGroups — запись из цифр ASCII, разделённых одиночными подчёркиваниями (не в начале и не
// в конце).
func digitGroups(text string) bool {
	if text == "" || text[0] == '_' || text[len(text)-1] == '_' || strings.Contains(text, "__") {
		return false
	}
	for index := 0; index < len(text); index++ {
		if (text[index] < '0' || text[index] > '9') && text[index] != '_' {
			return false
		}
	}
	return true
}

// FloatFromString — дробное число из строки: пробелы по краям, знак, inf/infinity/nan без учёта
// регистра, десятичная запись с подчёркиваниями между цифрами и цифры Unicode. Ошибка —
// ValueError «could not convert string to float: 'текст'».
func FloatFromString(text string) (float64, error) {
	failed := Raise(ValueError, "could not convert string to float: %s", Repr(text))
	body := strings.TrimFunc(asciiNumber(text), asciiSpace)
	unsigned := strings.TrimLeft(body, "+-")
	if len(body)-len(unsigned) > 1 {
		return 0, failed
	}
	sign := 1.0
	if strings.HasPrefix(body, "-") {
		sign = -1
	}
	switch strings.ToLower(unsigned) {
	case "inf", "infinity":
		return math.Inf(int(sign)), nil
	case "nan":
		return math.NaN(), nil
	}
	mantissa, exponent := unsigned, ""
	if position := strings.IndexAny(unsigned, "eE"); position >= 0 {
		mantissa, exponent = unsigned[:position], unsigned[position+1:]
		digits := strings.TrimLeft(exponent, "+-")
		if len(exponent)-len(digits) > 1 || !digitGroups(digits) {
			return 0, failed
		}
	}
	whole, fraction, hasDot := strings.Cut(mantissa, ".")
	if whole == "" && fraction == "" || whole != "" && !digitGroups(whole) || hasDot && fraction != "" && !digitGroups(fraction) {
		return 0, failed
	}
	value, err := strconv.ParseFloat(strings.ReplaceAll(body, "_", ""), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return 0, failed
	}
	return value, nil
}

// Float — приведение к дробному: bool и Int преобразуются, строка разбирается FloatFromString,
// прочие типы — TypeError.
func Float(value any) (float64, error) {
	switch item := value.(type) {
	case float64:
		return item, nil
	case bool:
		if item {
			return 1, nil
		}
		return 0, nil
	case Int:
		return item.Float()
	case string:
		return FloatFromString(item)
	}
	return 0, Raise(TypeError, "float() argument must be a string or a real number, not '%s'", TypeName(value))
}

// FloatToInt — дробное в целое: с round — округление половины к чётному, без — отбрасывание
// дробной части. NaN — ValueError, бесконечность и значение вне int64 — OverflowError.
func FloatToInt(value float64, round bool) (int64, error) {
	if math.IsNaN(value) {
		return 0, Raise(ValueError, "cannot convert float NaN to integer")
	}
	if math.IsInf(value, 0) {
		return 0, Raise(OverflowError, "cannot convert float infinity to integer")
	}
	if round {
		value = math.RoundToEven(value)
	} else {
		value = math.Trunc(value)
	}
	if value >= 9.223372036854775807e18 || value < -9.223372036854775808e18 {
		// Целые вне int64 здесь не нужны: кадры такого порядка недостижимы в клипе.
		return 0, Raise(OverflowError, "Python int too large to convert to C long")
	}
	return int64(value), nil
}

// Repr — запись значения в сообщениях: None, True/False, числа, строки в кавычках (reprString),
// списки «[a, b]» и словари «{'k': v}» с разделителями «, ».
func Repr(value any) string {
	switch item := value.(type) {
	case nil:
		return "None"
	case bool:
		if item {
			return "True"
		}
		return "False"
	case Int:
		return item.String()
	case float64:
		return FloatRepr(item)
	case string:
		return reprString(item)
	case []any:
		parts := make([]string, len(item))
		for index, element := range item {
			parts[index] = Repr(element)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case *Dict:
		parts := make([]string, len(item.keys))
		for index, key := range item.keys {
			parts[index] = reprString(key) + ": " + Repr(item.values[key])
		}
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return fmt.Sprint(value)
}

// Str — текстовая запись значения: строка как есть, остальное — Repr.
func Str(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return Repr(value)
}

// reprString — строка в кавычках: одинарные, а двойные — если внутри только одинарные; непечатаемые
// символы (Cc, Cf, Cs, Co, Cn, Zl, Zp, Zs кроме пробела) — \xNN, \uNNNN или \UNNNNNNNN.
func reprString(text string) string {
	quote := '\''
	if strings.ContainsRune(text, '\'') && !strings.ContainsRune(text, '"') {
		quote = '"'
	}
	var builder strings.Builder
	builder.WriteRune(quote)
	for _, r := range Runes(text) {
		switch {
		case r == quote || r == '\\':
			builder.WriteByte('\\')
			builder.WriteRune(r)
		case r == '\t':
			builder.WriteString(`\t`)
		case r == '\n':
			builder.WriteString(`\n`)
		case r == '\r':
			builder.WriteString(`\r`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&builder, `\x%02x`, r)
		case r < 0x7f:
			builder.WriteRune(r)
		case r >= 0xD800 && r <= 0xDFFF || !unicode.IsPrint(r):
			switch {
			case r <= 0xff:
				fmt.Fprintf(&builder, `\x%02x`, r)
			case r <= 0xffff:
				fmt.Fprintf(&builder, `\u%04x`, r)
			default:
				fmt.Fprintf(&builder, `\U%08x`, r)
			}
		default:
			builder.WriteRune(r)
		}
	}
	builder.WriteRune(quote)
	return builder.String()
}

// FloatRepr — запись дробного числа: кратчайшая точная запись; экспонента при порядке < -4 или ≥ 16,
// у целого значения в обычной записи — «.0»; nan, inf, -inf.
func FloatRepr(value float64) string {
	switch {
	case math.IsNaN(value):
		return "nan"
	case math.IsInf(value, 1):
		return "inf"
	case math.IsInf(value, -1):
		return "-inf"
	case value == 0:
		if math.Signbit(value) {
			return "-0.0"
		}
		return "0.0"
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
		exponentSign := "+"
		if exponent < 0 {
			exponentSign, exponent = "-", -exponent
		}
		return fmt.Sprintf("%s%se%s%02d", sign, result, exponentSign, exponent)
	}
	if exponent < 0 {
		return sign + "0." + strings.Repeat("0", -exponent-1) + digits
	}
	if len(digits) <= exponent+1 {
		return sign + digits + strings.Repeat("0", exponent+1-len(digits)) + ".0"
	}
	return sign + digits[:exponent+1] + "." + digits[exponent+1:]
}

// FormatFixed — дробное с digits знаками после точки: округление точного двоичного значения (как printf).
func FormatFixed(value float64, digits int) string {
	switch {
	case math.IsNaN(value):
		return "nan"
	case math.IsInf(value, 1):
		return "inf"
	case math.IsInf(value, -1):
		return "-inf"
	}
	return strconv.FormatFloat(value, 'f', digits, 64)
}
