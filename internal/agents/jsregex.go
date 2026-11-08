package agents

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"songframe-go/internal/jscompat"
)

// Регулярные выражения пакета записаны в семантике JS без флага u. Чтобы классификация ошибок,
// редактирование секретов и распознавание ответов CLI совпадали с эталонами, шаблоны
// переводятся на RE2 с теми же классами: \s JS (jsSpace), «.» без разделителей строк JS (jsDot)
// и флаг i только для ASCII-букв (ascii), так как (?i) в RE2 сворачивает и Unicode
// (K → KELVIN SIGN), а JS — нет.

// jsSpace — \s регулярных выражений JS.
const jsSpace = `[` + jscompat.SpaceClass + `]`

// jsDot — «.» JS без флага s: любой символ, кроме \n, \r, U+2028 и U+2029.
const jsDot = `[^\n\r\x{2028}\x{2029}]`

// ascii делает буквы шаблона вне классов и escape-последовательностей нечувствительными
// к регистру ([aA]) — аналог флага i JS для ASCII-шаблонов.
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

// mustJS компилирует шаблон с подстановкой \s и «.» JS; i — нечувствительность к ASCII-регистру.
func mustJS(pattern string, i bool) *regexp.Regexp {
	pattern = jsSpaces(pattern)
	if i {
		pattern = ascii(pattern)
	}
	return regexp.MustCompile(pattern)
}

// jsSpaces заменяет \s на класс пробелов JS: внутри [...] — содержимым класса (вложенных
// классов RE2 нет), снаружи — целым классом.
func jsSpaces(pattern string) string {
	var builder strings.Builder
	inClass := false
	for index := 0; index < len(pattern); index++ {
		char := pattern[index]
		if char == '\\' && index+1 < len(pattern) {
			if pattern[index+1] == 's' {
				if inClass {
					builder.WriteString(jscompat.SpaceClass)
				} else {
					builder.WriteString(jsSpace)
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

// jsLines приводит разделители строк JS (\r\n, \r, U+2028, U+2029) к \n, чтобы многострочные
// ^ и $ RE2 вели себя как флаг m JS. Применяется только к тексту, по которому ищут совпадение.
func jsLines(text string) string {
	return strings.NewReplacer("\r\n", "\n", "\r", "\n", " ", "\n", " ", "\n").Replace(text)
}

// utf16Len — String.prototype.length.
func utf16Len(text string) int { return len(utf16.Encode([]rune(text))) }

// utf16Slice — text.slice(0, limit) по кодовым единицам UTF-16. Разрезанная суррогатная пара
// в JS дала бы одиночный суррогат; Go не хранит его в UTF-8, поэтому половина пары отбрасывается.
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
