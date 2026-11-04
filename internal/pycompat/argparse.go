package pycompat

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Разбор аргументов повторяет argparse CPython 3.12 (снято на 3.12.3) для инструментов без
// позиционных аргументов: флаги store_true, опции с одним значением (store, необязательный список
// choices) и nargs="+", плюс -h/--help. Сохраняются классификация строк (опция/значение/«--»),
// уникальные префиксы длинных опций (allow_abbrev) и их «=значение», склейка коротких флагов
// (-hx), отрицательные числа и строки с пробелом как значения, порядок ошибок (неоднозначная опция
// — при классификации, «expected one argument», «invalid choice», «ignored explicit argument» —
// в момент обработки опции, «unrecognized arguments» — в конце), -h печатает справку в момент
// своей обработки. Usage и справка форматируются HelpFormatter с шириной 78 (COLUMNS не задан).

// Flag — опция парсера. Без Value и Plus — store_true.
type Flag struct {
	// Name — длинное имя с «--».
	Name string
	// Help — строка справки; пустая — опция без описания.
	Help string
	// Value — опция с одним значением (action="store", nargs=None).
	Value bool
	// Plus — nargs="+": одно или несколько значений подряд.
	Plus bool
	// Choices — допустимые значения (choices=…); пусто — любые.
	Choices []string
	// Metavar — имя значения в usage и справке; пусто — {choices} либо DEST в верхнем регистре.
	Metavar string
}

// ArgParser — argparse.ArgumentParser(prog, description) с опциями.
type ArgParser struct {
	Prog        string
	Description string
	Flags       []Flag
}

// ArgExit — завершение разбора: справка (код 0, stdout) или ошибка аргументов (код 2, stderr).
type ArgExit struct {
	Code   int
	Stdout string
	Stderr string
}

// Args — результат parse_args: установленные флаги store_true и значения опций по имени
// (у опции с одним значением — срез из одного элемента; отсутствующая опция — нет ключа).
type Args struct {
	Bools  map[string]bool
	Values map[string][]string
}

// helpWidth — ширина справки argparse без терминала: COLUMNS по умолчанию 80 минус 2.
const helpWidth = 78

// takesValue — опция требует значения.
func (f Flag) takesValue() bool { return f.Value || f.Plus }

// metavar — metavar значения: явный, {choices} или DEST.
func (f Flag) metavar() string {
	if f.Metavar != "" {
		return f.Metavar
	}
	if len(f.Choices) > 0 {
		return "{" + strings.Join(f.Choices, ",") + "}"
	}
	return strings.ToUpper(strings.ReplaceAll(strings.TrimPrefix(f.Name, "--"), "-", "_"))
}

// argsText — _format_args: «M» или «M [M ...]».
func (f Flag) argsText() string {
	if f.Plus {
		return f.metavar() + " [" + f.metavar() + " ...]"
	}
	return f.metavar()
}

// usagePart — элемент usage: [--flag] или [--flag ARGS].
func (f Flag) usagePart() string {
	if f.takesValue() {
		return "[" + f.Name + " " + f.argsText() + "]"
	}
	return "[" + f.Name + "]"
}

// invocation — _format_action_invocation для справки.
func (f Flag) invocation() string {
	if f.takesValue() {
		return f.Name + " " + f.argsText()
	}
	return f.Name
}

func runeLen(text string) int { return utf8.RuneCountInString(text) }

// fill — textwrap.fill/wrap после замены пробельных последовательностей одним пробелом
// (_whitespace_matcher argparse): жадный перенос по словам, слишком длинное слово режется.
// Перенос после дефиса (break_on_hyphens) не воспроизводится: в описаниях инструментов дефисов нет.
func fill(text string, width int) []string {
	words := strings.Fields(text)
	lines := []string{}
	current := []rune{}
	for _, word := range words {
		runes := []rune(word)
		for len(runes) > 0 {
			space := 0
			if len(current) > 0 {
				space = 1
			}
			if len(current)+space+len(runes) <= width {
				if space == 1 {
					current = append(current, ' ')
				}
				current = append(current, runes...)
				runes = nil
				continue
			}
			if len(runes) > width {
				// break_long_words: начало слова дополняет текущую строку до ширины.
				left := width - len(current) - space
				if left < 1 {
					lines = append(lines, string(current))
					current = []rune{}
					continue
				}
				if space == 1 {
					current = append(current, ' ')
				}
				current = append(current, runes[:left]...)
				runes = runes[left:]
			}
			lines = append(lines, string(current))
			current = []rune{}
		}
	}
	if len(current) > 0 {
		lines = append(lines, string(current))
	}
	return lines
}

// Usage — format_usage(): «usage: prog [-h] [--flag] …» и перевод строки. Длинная строка
// переносится, как HelpFormatter._format_usage: части опций выравниваются под первой после prog.
func (p ArgParser) Usage() string {
	parts := []string{"[-h]"}
	for _, flag := range p.Flags {
		parts = append(parts, flag.usagePart())
	}
	const prefix = "usage: "
	line := p.Prog + " " + strings.Join(parts, " ")
	if runeLen(prefix)+runeLen(line) <= helpWidth {
		return prefix + line + "\n"
	}
	// get_lines([prog] + opt_parts, indent, prefix): prog короткий (не длиннее 0.75 ширины).
	indent := strings.Repeat(" ", runeLen(prefix)+runeLen(p.Prog)+1)
	lines := []string{}
	current := []string{}
	length := runeLen(prefix) - 1
	for _, part := range append([]string{p.Prog}, parts...) {
		if length+1+runeLen(part) > helpWidth && len(current) > 0 {
			lines = append(lines, indent+strings.Join(current, " "))
			current = nil
			length = runeLen(indent) - 1
		}
		current = append(current, part)
		length += runeLen(part) + 1
	}
	if len(current) > 0 {
		lines = append(lines, indent+strings.Join(current, " "))
	}
	lines[0] = lines[0][len(indent):]
	return prefix + strings.Join(lines, "\n") + "\n"
}

// Help — print_help(): использование, описание и раздел options с выравниванием HelpFormatter
// (колонка справки — длина самого длинного вызова + 4, не дальше 24; текст справки переносится
// по ширине 78 − колонка).
func (p ArgParser) Help() string {
	type row struct{ invocation, help string }
	rows := []row{{"-h, --help", "show this help message and exit"}}
	for _, flag := range p.Flags {
		rows = append(rows, row{flag.invocation(), flag.Help})
	}
	longest := 0
	for _, item := range rows {
		longest = max(longest, runeLen(item.invocation)+2)
	}
	position := min(longest+2, min(24, max(helpWidth-20, 4)))
	width := position - 4
	helpText := max(helpWidth-position, 11)
	var builder strings.Builder
	builder.WriteString(p.Usage())
	if p.Description != "" {
		builder.WriteString("\n" + strings.Join(fill(p.Description, helpWidth), "\n") + "\n")
	}
	builder.WriteString("\noptions:\n")
	for _, item := range rows {
		length := runeLen(item.invocation)
		if item.help == "" {
			builder.WriteString("  " + item.invocation + "\n")
			continue
		}
		lines := fill(item.help, helpText)
		if length <= width {
			builder.WriteString("  " + item.invocation + strings.Repeat(" ", width-length) + "  " + lines[0] + "\n")
		} else {
			builder.WriteString("  " + item.invocation + "\n" + strings.Repeat(" ", position) + lines[0] + "\n")
		}
		for _, line := range lines[1:] {
			builder.WriteString(strings.Repeat(" ", position) + line + "\n")
		}
	}
	return builder.String()
}

// fail — parser.error(message): использование и текст в stderr, код 2.
func (p ArgParser) fail(message string) *ArgExit {
	return &ArgExit{Code: 2, Stderr: p.Usage() + p.Prog + ": error: " + message + "\n"}
}

// helpName — «-h»/«--help» как строки опций справки.
const helpName = "--help"

// optionStrings — строки опций в порядке _option_string_actions: -h, --help, затем опции.
func (p ArgParser) optionStrings() []string {
	names := []string{"-h", helpName}
	for _, flag := range p.Flags {
		names = append(names, flag.Name)
	}
	return names
}

// option — разобранная строка-опция: индекс опции (-1 — справка, -2 — неизвестная), строка
// опции, разделитель и явное значение (nil — нет).
type option struct {
	index    int
	name     string
	sep      string
	explicit *string
}

// actionIndex — индекс опции по строке: -1 для -h/--help, иначе номер в Flags.
func (p ArgParser) actionIndex(name string) (int, bool) {
	if name == "-h" || name == helpName {
		return -1, true
	}
	for index, flag := range p.Flags {
		if flag.Name == name {
			return index, true
		}
	}
	return 0, false
}

// negativeNumber — _negative_number_matcher: такие строки — значения, а не опции.
var negativeNumber = regexp.MustCompile(`^-\p{Nd}+\n?\z|^-\p{Nd}*\.\p{Nd}+\n?\z`)

// parseOptional — _parse_optional: nil — строка-значение ('A'); ambiguous — текст ошибки.
func (p ArgParser) parseOptional(arg string) (result *option, ambiguous string) {
	if arg == "" || arg[0] != '-' {
		return nil, ""
	}
	if index, ok := p.actionIndex(arg); ok {
		return &option{index: index, name: arg}, ""
	}
	if runeLen(arg) == 1 {
		return nil, ""
	}
	if name, value, hasSep := strings.Cut(arg, "="); hasSep {
		if index, ok := p.actionIndex(name); ok {
			return &option{index: index, name: name, sep: "=", explicit: &value}, ""
		}
	}
	tuples := []option{}
	if arg[1] == '-' {
		prefix, value, hasSep := strings.Cut(arg, "=")
		for _, name := range p.optionStrings() {
			if strings.HasPrefix(name, prefix) {
				index, _ := p.actionIndex(name)
				item := option{index: index, name: name}
				if hasSep {
					explicit := value
					item.sep, item.explicit = "=", &explicit
				}
				tuples = append(tuples, item)
			}
		}
	} else {
		short := string([]rune(arg)[:2])
		rest := string([]rune(arg)[2:])
		for _, name := range p.optionStrings() {
			index, _ := p.actionIndex(name)
			if name == short {
				explicit := rest
				tuples = append(tuples, option{index: index, name: name, explicit: &explicit})
			} else if strings.HasPrefix(name, arg) {
				tuples = append(tuples, option{index: index, name: name})
			}
		}
	}
	if len(tuples) > 1 {
		names := make([]string, len(tuples))
		for index, item := range tuples {
			names[index] = item.name
		}
		return nil, "ambiguous option: " + arg + " could match " + strings.Join(names, ", ")
	}
	if len(tuples) == 1 {
		return &tuples[0], ""
	}
	if negativeNumber.MatchString(arg) || strings.Contains(arg, " ") {
		return nil, ""
	}
	return &option{index: -2, name: arg}, ""
}

// argumentName — имя опции в ArgumentError: «-h/--help» или длинное имя.
func (p ArgParser) argumentName(index int) string {
	if index == -1 {
		return "-h/--help"
	}
	return p.Flags[index].Name
}

// Parse — parse_args(args) для парсера только с флагами store_true.
func (p ArgParser) Parse(args []string) (map[string]bool, *ArgExit) {
	parsed, exit := p.ParseArgs(args)
	if exit != nil {
		return nil, exit
	}
	return parsed.Bools, nil
}

// ParseArgs — parse_args(args): значения опций или завершение (справка либо ошибка).
func (p ArgParser) ParseArgs(args []string) (Args, *ArgExit) {
	result := Args{Bools: map[string]bool{}, Values: map[string][]string{}}
	// Классификация: 'O' — опция, 'A' — значение, '-' — «--» (после него всё — значения).
	pattern := make([]byte, len(args))
	options := map[int]*option{}
	for index := 0; index < len(args); index++ {
		if args[index] == "--" {
			pattern[index] = '-'
			for rest := index + 1; rest < len(args); rest++ {
				pattern[rest] = 'A'
			}
			break
		}
		parsed, ambiguous := p.parseOptional(args[index])
		if ambiguous != "" {
			return Args{}, p.fail(ambiguous)
		}
		if parsed == nil {
			pattern[index] = 'A'
			continue
		}
		pattern[index] = 'O'
		options[index] = parsed
	}
	extras := []string{}
	// take — take_action: проверка choices и запись значения; -h печатает справку.
	take := func(index int, values []string) *ArgExit {
		if index == -1 {
			return &ArgExit{Code: 0, Stdout: p.Help()}
		}
		flag := p.Flags[index]
		if !flag.takesValue() {
			result.Bools[flag.Name] = true
			return nil
		}
		if len(flag.Choices) > 0 {
			for _, value := range values {
				allowed := false
				for _, choice := range flag.Choices {
					allowed = allowed || choice == value
				}
				if !allowed {
					quoted := make([]string, len(flag.Choices))
					for position, choice := range flag.Choices {
						quoted[position] = Repr(choice)
					}
					return p.fail("argument " + flag.Name + ": invalid choice: " + Repr(value) + " (choose from " + strings.Join(quoted, ", ") + ")")
				}
			}
		}
		result.Values[flag.Name] = append([]string(nil), values...)
		return nil
	}
	// consume — consume_optional: опция (возможно, склейка коротких флагов) и её значения.
	consume := func(start int) (int, *ArgExit) {
		current := *options[start]
		type action struct {
			index  int
			values []string
		}
		actions := []action{}
		stop := start + 1
		for {
			if current.index == -2 {
				extras = append(extras, args[start])
				return start + 1, nil
			}
			takes := current.index >= 0 && p.Flags[current.index].takesValue()
			if current.explicit != nil {
				explicit := *current.explicit
				if !takes && current.name[1] != '-' && explicit != "" {
					if current.sep != "" || explicit[0] == '-' {
						return 0, p.fail("argument " + p.argumentName(current.index) + ": ignored explicit argument " + Repr(explicit))
					}
					actions = append(actions, action{index: current.index})
					first, size := utf8.DecodeRuneInString(explicit)
					next := "-" + string(first)
					if index, ok := p.actionIndex(next); ok {
						remaining := explicit[size:]
						current = option{index: index, name: next}
						switch {
						case remaining == "":
						case remaining[0] == '=':
							value := remaining[1:]
							current.sep, current.explicit = "=", &value
						default:
							current.explicit = &remaining
						}
						continue
					}
					extras = append(extras, "-"+explicit)
					stop = start + 1
					break
				}
				if takes {
					actions = append(actions, action{index: current.index, values: []string{explicit}})
					stop = start + 1
					break
				}
				return 0, p.fail("argument " + p.argumentName(current.index) + ": ignored explicit argument " + Repr(explicit))
			}
			count := 0
			if takes {
				for position := start + 1; position < len(args) && pattern[position] == 'A'; position++ {
					count++
					if !p.Flags[current.index].Plus {
						break
					}
				}
				if count == 0 {
					message := "expected one argument"
					if p.Flags[current.index].Plus {
						message = "expected at least one argument"
					}
					return 0, p.fail("argument " + p.argumentName(current.index) + ": " + message)
				}
			}
			stop = start + 1 + count
			actions = append(actions, action{index: current.index, values: args[start+1 : stop]})
			break
		}
		for _, item := range actions {
			if exit := take(item.index, item.values); exit != nil {
				return 0, exit
			}
		}
		return stop, nil
	}
	index := 0
	for index < len(args) {
		next := -1
		for position := index; position < len(args); position++ {
			if pattern[position] == 'O' {
				next = position
				break
			}
		}
		if next < 0 {
			break
		}
		extras = append(extras, args[index:next]...)
		stop, exit := consume(next)
		if exit != nil {
			return Args{}, exit
		}
		index = stop
	}
	extras = append(extras, args[min(index, len(args)):]...)
	if len(extras) > 0 {
		return Args{}, p.fail("unrecognized arguments: " + strings.Join(extras, " "))
	}
	return result, nil
}
