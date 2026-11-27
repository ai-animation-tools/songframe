package savedlooks

import (
	"regexp"
	"slices"
	"strings"
)

// Метки сущностей в видеопромпте. Агент и человек ставят метку [@код] сразу после упоминания
// героя («The man [@hero] stands…»); код — код сущности кастинга. До заморозки запроса метка
// превращается в разметку провайдера (модель с сохранёнными образами) или убирается (модель без
// образов, ручная генерация на сайте). Файл промпта попытки хранит текст с метками, замороженный
// запрос — текст после подстановки, без единой метки.

// markPattern — метка целиком: всё между «[@» и «]» без пробелов и скобок. Код проверяется
// отдельно (codePattern), чтобы опечатка в коде была ошибкой, а не простым текстом.
var markPattern = regexp.MustCompile(`\[@([^\[\]\s]*)\]`)

// brokenPattern — начало метки, записанной с ошибкой (пробелы, нет закрывающей скобки): ищется в
// тексте без распознанных меток, чтобы опечатка не ушла в запрос простым текстом.
var brokenPattern = regexp.MustCompile(`\[\s*@`)

// codePattern — код сущности кастинга (как в internal/cast).
var codePattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Mark — одна метка: код и границы в тексте (байты).
type Mark struct {
	Code       string
	Start, End int
}

// Marks — метки текста по порядку.
func Marks(text string) []Mark {
	marks := []Mark{}
	for _, match := range markPattern.FindAllStringSubmatchIndex(text, -1) {
		marks = append(marks, Mark{Code: text[match[2]:match[3]], Start: match[0], End: match[1]})
	}
	return marks
}

// Codes — коды меток в порядке первого упоминания, без повторов.
func Codes(text string) []string {
	codes := []string{}
	seen := map[string]bool{}
	for _, mark := range Marks(text) {
		if !seen[mark.Code] {
			seen[mark.Code] = true
			codes = append(codes, mark.Code)
		}
	}
	return codes
}

// Broken — фрагмент первой метки, записанной с ошибкой (до 24 символов от её начала); "" — таких
// нет.
func Broken(text string) string {
	rest := markPattern.ReplaceAllString(text, "")
	location := brokenPattern.FindStringIndex(rest)
	if location == nil {
		return ""
	}
	fragment := []rune(rest[location[0]:])
	if end := slices.IndexFunc(fragment, func(r rune) bool { return r == '\n' }); end >= 0 {
		fragment = fragment[:end]
	}
	if len(fragment) > 24 {
		fragment = fragment[:24]
	}
	return strings.TrimSpace(string(fragment))
}

// ValidCode — код метки записан как код сущности кастинга.
func ValidCode(code string) bool { return codePattern.MatchString(code) }

// Replace заменяет каждую метку разметкой mention(код).
func Replace(text string, mention func(code string) string) string {
	return markPattern.ReplaceAllStringFunc(text, func(mark string) string {
		return mention(markPattern.FindStringSubmatch(mark)[1])
	})
}

// Strip убирает метки вместе с пробелами перед ними: «The man [@hero] stands» → «The man
// stands». Метка в начале строки уносит пробелы после себя.
func Strip(text string) string {
	marks := Marks(text)
	if len(marks) == 0 {
		return text
	}
	var out strings.Builder
	last := 0
	for _, mark := range marks {
		before := strings.TrimRight(text[last:mark.Start], " \t")
		out.WriteString(before)
		last = mark.End
		if written := out.String(); written == "" || strings.HasSuffix(written, "\n") {
			for last < len(text) && (text[last] == ' ' || text[last] == '\t') {
				last++
			}
		}
	}
	out.WriteString(text[last:])
	return out.String()
}
