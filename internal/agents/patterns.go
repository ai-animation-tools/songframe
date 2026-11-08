package agents

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"songframe/internal/dynvalue"
)

// Регулярные выражения пакета используют уточнённые классы поверх RE2. Чтобы классификация ошибок,
// редактирование секретов и распознавание ответов CLI совпадали с эталонами, шаблоны
// компилируются так: \s — полный класс пробелов dynvalue.SpaceClass (spaceClass: ASCII-пробелы,
// NBSP, пробелы Unicode Zs, U+2028/U+2029 и U+FEFF), «.» — любой символ, кроме разделителей строк (lineDot), а флаг i
// действует только на ASCII-буквы (ascii): (?i) в RE2 сворачивает и Unicode (K → KELVIN SIGN),
// и под такой шаблон попадали бы лишние строки.

// spaceClass — класс пробельных символов, которым заменяется \s в шаблонах пакета.
const spaceClass = `[` + dynvalue.SpaceClass + `]`

// lineDot — «.» внутри строки: любой символ, кроме разделителей строк \n, \r, U+2028 и U+2029.
const lineDot = `[^\n\r\x{2028}\x{2029}]`

// ascii делает буквы шаблона вне классов и escape-последовательностей нечувствительными
// к регистру ([aA]): нечувствительность к регистру только для ASCII, без свёртки Unicode.
func ascii(pattern string) string {
	var builder strings.Builder
	inClass := false
	for index := 0; index < len(pattern); index++ {
		char := pattern[index]
		switch {
		case char == '\\' && index+1 < len(pattern):
			builder.WriteByte(char)
			index++
			builder.WriteByte(pattern[index])
			// \x{...} и \p{...} копируются целиком: буквы внутри фигурных скобок — не текст.
			if index+1 < len(pattern) && pattern[index+1] == '{' {
				end := strings.IndexByte(pattern[index:], '}')
				builder.WriteString(pattern[index+1 : index+end+1])
				index += end
			}
		case char == '[':
			inClass = true
			builder.WriteByte(char)
		case char == ']':
			inClass = false
			builder.WriteByte(char)
		case !inClass && (char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z'):
			lower, upper := char|0x20, char&^0x20
			builder.WriteString("[" + string(lower) + string(upper) + "]")
		default:
			builder.WriteByte(char)
		}
	}
	return builder.String()
}

// mustPattern компилирует шаблон с подстановкой класса \s; i — нечувствительность к ASCII-регистру.
// «.» внутри строки шаблоны пакета пишут явно через lineDot.
func mustPattern(pattern string, i bool) *regexp.Regexp {
	pattern = expandSpaces(pattern)
	if i {
		pattern = ascii(pattern)
	}
	return regexp.MustCompile(pattern)
}

// expandSpaces заменяет \s на класс пробелов spaceClass: внутри [...] — содержимым класса
// (вложенных классов RE2 нет), снаружи — целым классом.
func expandSpaces(pattern string) string {
	var builder strings.Builder
	inClass := false
	for index := 0; index < len(pattern); index++ {
		char := pattern[index]
		if char == '\\' && index+1 < len(pattern) {
			if pattern[index+1] == 's' {
				if inClass {
					builder.WriteString(dynvalue.SpaceClass)
				} else {
					builder.WriteString(spaceClass)
				}
			} else {
				builder.WriteString(pattern[index : index+2])
			}
			index++
			continue
		}
		if char == '[' {
			inClass = true
		} else if char == ']' {
			inClass = false
		}
		builder.WriteByte(char)
	}
	return builder.String()
}

// normalizeLines приводит все разделители строк (\r\n, \r, U+2028, U+2029) к \n: многострочные
// ^ и $ RE2 знают только \n, а вывод CLI может разделять строки любым из них. Применяется только
// к тексту, по которому ищут совпадение.
func normalizeLines(text string) string {
	return strings.NewReplacer("\r\n", "\n", "\r", "\n", " ", "\n", " ", "\n").Replace(text)
}

// utf16Len — длина текста в кодовых единицах UTF-16: так считаются лимиты длины причин,
// зафиксированные эталонами.
func utf16Len(text string) int { return len(utf16.Encode([]rune(text))) }

// utf16Slice — первые limit кодовых единиц UTF-16 текста. Если граница разрезает суррогатную
// пару, одиночный суррогат в UTF-8 непредставим, поэтому её первая половина отбрасывается.
func utf16Slice(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	units = units[:limit]
	if limit > 0 && utf16.IsSurrogate(rune(units[limit-1])) && units[limit-1] < 0xdc00 {
		units = units[:limit-1]
	}
	return string(utf16.Decode(units))
}
