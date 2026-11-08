package continuitybrief

import (
	"errors"
	"strings"
	"unicode"

	"songframe/internal/toolrt"
)

// errUnsupportedFormat — конструкция шаблона, которую formatValue не поддерживает (доступ к
// атрибутам и индексам поля, вложенные поля в спецификации, числовые спецификации). В словарях
// свойств SongFrame шаблоны чек-листа используют только «{value}»; такая ошибка не относится к
// исключениям toolrt и печатается трассировкой с этим текстом.
var errUnsupportedFormat = errors.New("шаблон чек-листа использует возможность str.format, не перенесённую в Go-версию")

// formatValue подставляет value в шаблон чек-листа: «{{»/«}}» — литеральные скобки,
// поле value с преобразованием !s/!r/!a и строковой спецификацией [[fill]align][0][width][.precision][s].
// Ошибки — исключения toolrt с текстами, зафиксированными эталоном: KeyError неизвестного имени,
// IndexError позиционного поля, ValueError разбора.
func formatValue(template string, value any) (string, error) {
	runes := toolrt.Runes(template)
	var builder strings.Builder
	for index := 0; index < len(runes); index++ {
		r := runes[index]
		if r == '}' {
			if index+1 < len(runes) && runes[index+1] == '}' {
				builder.WriteRune('}')
				index++
				continue
			}
			return "", toolrt.New(toolrt.ValueError, "Single '}' encountered in format string")
		}
		if r != '{' {
			builder.WriteString(toolrt.FromRunes([]rune{r}))
			continue
		}
		if index+1 < len(runes) && runes[index+1] == '{' {
			builder.WriteRune('{')
			index++
			continue
		}
		if index+1 >= len(runes) {
			return "", toolrt.New(toolrt.ValueError, "Single '{' encountered in format string")
		}
		// Поле до парной «}» с учётом вложенных скобок спецификации.
		depth, end := 1, index+1
		for ; end < len(runes); end++ {
			if runes[end] == '{' {
				depth++
			} else if runes[end] == '}' {
				depth--
				if depth == 0 {
					break
				}
			}
		}
		if end >= len(runes) {
			return "", toolrt.New(toolrt.ValueError, "expected '}' before end of string")
		}
		text, err := replaceField(runes[index+1:end], value)
		if err != nil {
			return "", err
		}
		builder.WriteString(text)
		index = end
	}
	return builder.String(), nil
}

// replaceField — одно поле «имя[!преобразование][:спецификация]».
func replaceField(field []rune, value any) (string, error) {
	nameEnd := len(field)
	for position, r := range field {
		if r == '!' || r == ':' {
			nameEnd = position
			break
		}
		if r == '{' {
			return "", toolrt.New(toolrt.ValueError, "unexpected '{' in field name")
		}
	}
	name := toolrt.FromRunes(field[:nameEnd])
	rest := field[nameEnd:]
	conversion := rune(0)
	if len(rest) > 0 && rest[0] == '!' {
		if len(rest) < 2 {
			return "", toolrt.New(toolrt.ValueError, "end of string while looking for conversion specifier")
		}
		conversion = rest[1]
		rest = rest[2:]
		if len(rest) > 0 && rest[0] != ':' {
			return "", toolrt.New(toolrt.ValueError, "expected ':' after conversion specifier")
		}
		if conversion == '}' || conversion == ':' {
			return "", toolrt.New(toolrt.ValueError, "unmatched '{' in format spec")
		}
	}
	spec := ""
	if len(rest) > 0 {
		spec = toolrt.FromRunes(rest[1:])
	}
	// Имя поля: первая часть до «.» или «[»; пустое и число — позиционные аргументы, которых нет.
	first := name
	if cut := strings.IndexAny(name, ".["); cut >= 0 {
		first = name[:cut]
	}
	if first == "" || isDecimal(first) {
		number := "0"
		if first != "" {
			number = strings.TrimLeft(first, "0")
			if number == "" {
				number = "0"
			}
		}
		return "", toolrt.Raise(toolrt.IndexError, "Replacement index %s out of range for positional args tuple", number)
	}
	if first != "value" {
		return "", toolrt.NewKeyError(first)
	}
	if first != name || strings.ContainsAny(spec, "{}") {
		return "", errUnsupportedFormat
	}
	switch conversion {
	case 0:
	case 's':
		value = toolrt.Str(value)
	case 'r':
		value = toolrt.Repr(value)
	case 'a':
		value = asciiRepr(toolrt.Repr(value))
	default:
		return "", toolrt.Raise(toolrt.ValueError, "Unknown conversion specifier %s", string(conversion))
	}
	if spec == "" {
		return toolrt.Str(value), nil
	}
	text, ok := value.(string)
	if !ok {
		switch value.(type) {
		case nil, []any, *toolrt.Dict:
			typeName := toolrt.TypeName(value)
			return "", toolrt.Raise(toolrt.TypeError, "unsupported format string passed to %s.__format__", typeName)
		}
		return "", errUnsupportedFormat
	}
	return formatString(text, spec)
}

// isDecimal — имя поля непустое и состоит из ASCII-цифр (позиционное поле).
func isDecimal(text string) bool {
	for _, r := range text {
		if r < '0' || r > '9' {
			return false
		}
	}
	return text != ""
}

// asciiRepr — преобразование !a: repr-запись с не-ASCII символами в виде \x, \u, \U.
func asciiRepr(text string) string {
	var builder strings.Builder
	for _, r := range toolrt.Runes(text) {
		switch {
		case r < 0x80:
			builder.WriteRune(r)
		case r <= 0xff:
			builder.WriteString(`\x` + hex(int(r), 2))
		case r <= 0xffff:
			builder.WriteString(`\u` + hex(int(r), 4))
		default:
			builder.WriteString(`\U` + hex(int(r), 8))
		}
	}
	return builder.String()
}

// hex — шестнадцатеричная запись строчными с дополнением нулями.
func hex(value, width int) string {
	const digits = "0123456789abcdef"
	result := make([]byte, width)
	for index := width - 1; index >= 0; index-- {
		result[index] = digits[value&0xf]
		value >>= 4
	}
	return string(result)
}

// formatString — строка text по строковой спецификации spec: заполнитель и выравнивание (<, >,
// ^; по умолчанию влево; «=» для строк запрещено), «0» перед шириной без выравнивания — заполнитель
// «0» слева направо («05» дополняет нулями справа), ширина, точность (обрезка) и тип «s».
func formatString(text, spec string) (string, error) {
	runes := toolrt.Runes(spec)
	fill, align := ' ', rune(0)
	position := 0
	isAlign := func(r rune) bool { return r == '<' || r == '>' || r == '^' || r == '=' }
	if len(runes) >= 2 && isAlign(runes[1]) {
		fill, align, position = runes[0], runes[1], 2
	} else if len(runes) >= 1 && isAlign(runes[0]) {
		align, position = runes[0], 1
	}
	if position < len(runes) && (runes[position] == '+' || runes[position] == '-' || runes[position] == ' ') {
		return "", toolrt.New(toolrt.ValueError, "Sign not allowed in string format specifier")
	}
	if position < len(runes) && runes[position] == '0' {
		if align == 0 {
			fill, align = '0', '<'
		}
		position++
	}
	width := 0
	for position < len(runes) && runes[position] >= '0' && runes[position] <= '9' {
		width = width*10 + int(runes[position]-'0')
		position++
	}
	precision := -1
	if position < len(runes) && runes[position] == '.' {
		position++
		precision = 0
		start := position
		for position < len(runes) && runes[position] >= '0' && runes[position] <= '9' {
			precision = precision*10 + int(runes[position]-'0')
			position++
		}
		if position == start {
			return "", toolrt.New(toolrt.ValueError, "Format specifier missing precision")
		}
	}
	if position < len(runes) {
		if runes[position] == 's' && position == len(runes)-1 {
			position++
		} else if position == len(runes)-1 {
			return "", toolrt.Raise(toolrt.ValueError, "Unknown format code '%s' for object of type 'str'", string(runes[position]))
		} else {
			return "", toolrt.New(toolrt.ValueError, "Invalid format specifier")
		}
	}
	if align == '=' {
		return "", toolrt.New(toolrt.ValueError, "'=' alignment not allowed in string format specifier")
	}
	body := toolrt.Runes(text)
	if precision >= 0 && precision < len(body) {
		body = body[:precision]
	}
	pad := width - len(body)
	if pad <= 0 {
		return toolrt.FromRunes(body), nil
	}
	padding := func(count int) string { return strings.Repeat(string(fill), count) }
	switch align {
	case '>':
		return padding(pad) + toolrt.FromRunes(body), nil
	case '^':
		return padding(pad/2) + toolrt.FromRunes(body) + padding(pad-pad/2), nil
	}
	return toolrt.FromRunes(body) + padding(pad), nil
}

// unicodeLower — строчные буквы подписи: простые соответствия Unicode, безусловное правило
// SpecialCasing для «İ» (i и точка сверху) и условная конечная сигма (Σ в конце слова — ς).
// Одиночные суррогаты остаются как есть.
func unicodeLower(text string) string {
	runes := toolrt.Runes(text)
	var builder strings.Builder
	for index, r := range runes {
		switch {
		case r >= 0xD800 && r <= 0xDFFF:
			builder.WriteString(toolrt.FromRunes([]rune{r}))
		case r == 0x0130:
			builder.WriteString("i̇")
		case r == 0x03A3 && finalSigma(runes, index):
			builder.WriteRune(0x03C2)
		default:
			builder.WriteRune(unicode.ToLower(r))
		}
	}
	return builder.String()
}

// finalSigma — условие Final_Sigma: перед сигмой (через пропускаемые символы) есть буква с
// регистром, а после неё — нет.
func finalSigma(runes []rune, index int) bool {
	cased := func(r rune) bool { return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) }
	ignorable := func(r rune) bool {
		return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk) || strings.ContainsRune("'.:^`·’", r)
	}
	before := false
	for position := index - 1; position >= 0; position-- {
		if ignorable(runes[position]) {
			continue
		}
		before = cased(runes[position])
		break
	}
	if !before {
		return false
	}
	for position := index + 1; position < len(runes); position++ {
		if ignorable(runes[position]) {
			continue
		}
		return !cased(runes[position])
	}
	return true
}
