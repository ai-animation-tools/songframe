package toolrt

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Разбор аргументов командной строки инструментов: логические флаги, опции с одним значением
// (необязательный список допустимых значений) и с одним или несколькими значениями, плюс
// -h/--help; обязательные позиционные аргументы с одним значением и одна необязательная
// взаимоисключающая группа опций. Правила, от которых зависят вывод и коды завершения:
//   - каждая строка сначала классифицируется: опция, значение или «--» (после него всё — значения);
//   - длинную опцию можно сократить до уникального префикса, значение можно дать через «=»;
//   - короткие флаги склеиваются (-hx), отрицательные числа и строки с пробелом — значения;
//   - ошибки идут в фиксированном порядке: неоднозначная опция — при классификации,
//     «expected one argument», «invalid choice», «ignored explicit argument» — в момент обработки
//     опции, «unrecognized arguments» — в конце; -h печатает справку в момент своей обработки.
//
// Usage и справка форматируются по ширине 78 символов. Тексты, отступы и переносы зафиксированы
// эталонами вывода инструментов.

// Flag — опция парсера. Без Value и Plus — логический флаг.
type Flag struct {
	// Name — длинное имя с «--».
	Name string
	// Help — строка справки; пустая — опция без описания.
	Help string
	// Value — опция с одним значением.
	Value bool
	// Plus — одно или несколько значений подряд.
	Plus bool
	// Choices — допустимые значения; пусто — любые.
	Choices []string
	// Metavar — имя значения в usage и справке; пусто — {a,b} из Choices либо имя опции без «--»
	// в верхнем регистре с «_» вместо «-».
	Metavar string
}

// Positional — обязательный позиционный аргумент с одним значением (без списка допустимых).
// Значение попадает в Args.Values[Name].
type Positional struct {
	// Name — ключ значения в Args и имя аргумента в usage и справке.
	Name string
	// Help — строка справки; пустая — без описания.
	Help string
}

// ArgParser — парсер инструмента prog с описанием для справки, опциями, позиционными аргументами
// (разбираются после опций в порядке объявления) и одной необязательной взаимоисключающей
// группой: Exclusive — имена опций группы, идущих в Flags подряд.
type ArgParser struct {
	Prog        string
	Description string
	Flags       []Flag
	Positionals []Positional
	Exclusive   []string
}

// ArgExit — завершение разбора: справка (код 0, stdout) или ошибка аргументов (код 2, stderr).
type ArgExit struct {
	Code   int
	Stdout string
	Stderr string
}

// Args — результат разбора: установленные логические флаги и значения опций по имени
// (у опции с одним значением — срез из одного элемента; отсутствующая опция — нет ключа).
type Args struct {
	Bools  map[string]bool
	Values map[string][]string
}

// helpWidth — ширина usage и справки: 80 колонок минус поле 2; от терминала не зависит.
const helpWidth = 78

// takesValue — опция требует значения.
func (f Flag) takesValue() bool { return f.Value || f.Plus }

// metavar — имя значения: явное Metavar, {choices} или имя опции (см. Flag.Metavar).
func (f Flag) metavar() string {
	if f.Metavar != "" {
		return f.Metavar
	}
	if len(f.Choices) > 0 {
		return "{" + strings.Join(f.Choices, ",") + "}"
	}
	return strings.ToUpper(strings.ReplaceAll(strings.TrimPrefix(f.Name, "--"), "-", "_"))
}

// argsText — запись значений опции: «M» или «M [M ...]» для Plus.
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

// invocation — запись опции в левой колонке справки: «--flag» или «--flag ARGS».
func (f Flag) invocation() string {
	if f.takesValue() {
		return f.Name + " " + f.argsText()
	}
	return f.Name
}

func runeLen(text string) int { return utf8.RuneCountInString(text) }

// fill — перенос текста справки по ширине после замены пробельных последовательностей одним
// пробелом: жадно по словам, слишком длинное слово режется. Перенос после дефиса не делается:
// в описаниях инструментов дефисов нет.
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
				// Слово длиннее ширины: его начало дополняет текущую строку до ширины.
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

// inGroup — опция входит во взаимоисключающую группу.
func (p ArgParser) inGroup(name string) bool {
	for _, member := range p.Exclusive {
		if member == name {
			return true
		}
	}
	return false
}

// optionParts — части usage опций: [-h], [--flag ARGS] и группа «[--a | --b B]» одним элементом:
// при переносе группа не разрывается.
func (p ArgParser) optionParts() []string {
	parts := []string{"[-h]"}
	group := []string{}
	for index, flag := range p.Flags {
		if !p.inGroup(flag.Name) {
			parts = append(parts, flag.usagePart())
			continue
		}
		group = append(group, strings.TrimSuffix(strings.TrimPrefix(flag.usagePart(), "["), "]"))
		if index+1 == len(p.Flags) || !p.inGroup(p.Flags[index+1].Name) {
			parts = append(parts, "["+strings.Join(group, " | ")+"]")
			group = nil
		}
	}
	return parts
}

// getLines — жадная укладка частей usage по ширине с отступом indent; с префиксом первая строка
// начинается сразу после «usage: ».
func getLines(parts []string, indent string, prefix string, withPrefix bool) []string {
	lines := []string{}
	current := []string{}
	length := runeLen(indent) - 1
	if withPrefix {
		length = runeLen(prefix) - 1
	}
	for _, part := range parts {
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
	if withPrefix {
		lines[0] = lines[0][len(indent):]
	}
	return lines
}

// Usage — «usage: prog [-h] [--flag] … позиционные» и перевод строки. Длинная строка
// переносится: части опций выравниваются под первой после prog, позиционные аргументы начинаются
// с новой строки.
func (p ArgParser) Usage() string {
	parts := p.optionParts()
	positionals := []string{}
	for _, positional := range p.Positionals {
		positionals = append(positionals, positional.Name)
	}
	const prefix = "usage: "
	line := p.Prog + " " + strings.Join(append(append([]string{}, parts...), positionals...), " ")
	if runeLen(prefix)+runeLen(line) <= helpWidth {
		return prefix + line + "\n"
	}
	// Ветка короткого prog (не длиннее 0.75 ширины): опции всегда есть ([-h]).
	indent := strings.Repeat(" ", runeLen(prefix)+runeLen(p.Prog)+1)
	lines := getLines(append([]string{p.Prog}, parts...), indent, prefix, true)
	if len(positionals) > 0 {
		lines = append(lines, getLines(positionals, indent, "", false)...)
	}
	return prefix + strings.Join(lines, "\n") + "\n"
}

// Help — справка -h: использование, описание, разделы positional arguments и options с
// выравниванием колонок (колонка справки — длина самого длинного вызова по всем разделам + 4,
// не дальше 24; текст справки переносится по ширине 78 − колонка).
func (p ArgParser) Help() string {
	type row struct{ invocation, help string }
	positionals := []row{}
	for _, positional := range p.Positionals {
		positionals = append(positionals, row{positional.Name, positional.Help})
	}
	rows := []row{{"-h, --help", "show this help message and exit"}}
	for _, flag := range p.Flags {
		rows = append(rows, row{flag.invocation(), flag.Help})
	}
	longest := 0
	for _, item := range append(append([]row{}, positionals...), rows...) {
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
	section := func(title string, items []row) {
		builder.WriteString("\n" + title + ":\n")
		for _, item := range items {
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
	}
	if len(positionals) > 0 {
		section("positional arguments", positionals)
	}
	section("options", rows)
	return builder.String()
}

// fail — ошибка аргументов: usage и «prog: error: текст» в stderr, код 2.
func (p ArgParser) fail(message string) *ArgExit {
	return &ArgExit{Code: 2, Stderr: p.Usage() + p.Prog + ": error: " + message + "\n"}
}

// helpName — «-h»/«--help» как строки опций справки.
const helpName = "--help"

// optionStrings — строки опций в порядке поиска префиксов: -h, --help, затем опции.
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

// negativeNumber — отрицательное число (целое или с дробной частью): такие строки — значения, а
// не опции.
var negativeNumber = regexp.MustCompile(`^-\p{Nd}+\n?\z|^-\p{Nd}*\.\p{Nd}+\n?\z`)

// parseOptional — классификация строки: опция (точное имя, «имя=значение», уникальный префикс
// длинной опции, короткий флаг со склейкой) или nil — строка-значение ('A'); ambiguous — текст
// ошибки неоднозначного префикса. Неизвестная строка с «-» — опция с индексом -2.
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

// argumentName — имя опции в тексте ошибки: «-h/--help» или длинное имя.
func (p ArgParser) argumentName(index int) string {
	if index == -1 {
		return "-h/--help"
	}
	return p.Flags[index].Name
}

// Parse — разбор для парсера только с логическими флагами.
func (p ArgParser) Parse(args []string) (map[string]bool, *ArgExit) {
	parsed, exit := p.ParseArgs(args)
	if exit != nil {
		return nil, exit
	}
	return parsed.Bools, nil
}

// ParseArgs — разбор args: значения опций или завершение (справка либо ошибка).
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
	// seen — опции группы, уже встреченные в args; повтор той же опции конфликтом не считается,
	// и логический флаг тоже считается встреченным.
	seen := map[string]bool{}
	// conflict — проверка взаимоисключающей группы: в ошибке — первая уже встреченная опция
	// группы в порядке объявления, кроме самой опции.
	conflict := func(name string) *ArgExit {
		if !p.inGroup(name) {
			return nil
		}
		seen[name] = true
		for _, other := range p.Exclusive {
			if other != name && seen[other] {
				return p.fail("argument " + name + ": not allowed with argument " + other)
			}
		}
		return nil
	}
	// take — применение опции: проверка Choices и запись значения; -h печатает справку.
	take := func(index int, values []string) *ArgExit {
		if index == -1 {
			return &ArgExit{Code: 0, Stdout: p.Help()}
		}
		flag := p.Flags[index]
		if !flag.takesValue() {
			if exit := conflict(flag.Name); exit != nil {
				return exit
			}
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
		if exit := conflict(flag.Name); exit != nil {
			return exit
		}
		result.Values[flag.Name] = append([]string(nil), values...)
		return nil
	}
	// consumePositionals — оставшиеся позиционные аргументы с позиции start: каждому достаётся
	// одно значение 'A' вместе с окружающими «--» (шаблон '(-*A-*)', жадно подряд), из значений
	// убирается первое «--».
	remaining := p.Positionals
	consumePositionals := func(start int) int {
		for len(remaining) > 0 {
			position := start
			for position < len(args) && pattern[position] == '-' {
				position++
			}
			if position >= len(args) || pattern[position] != 'A' {
				break
			}
			position++
			for position < len(args) && pattern[position] == '-' {
				position++
			}
			values := []string{}
			removed := false
			for _, value := range args[start:position] {
				if value == "--" && !removed {
					removed = true
					continue
				}
				values = append(values, value)
			}
			result.Values[remaining[0].Name] = values
			remaining = remaining[1:]
			start = position
		}
		return start
	}
	// consume — опция с позиции start (возможно, склейка коротких флагов) и её значения.
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
		if index != next {
			if end := consumePositionals(index); end > index {
				index = end
				continue
			}
		}
		extras = append(extras, args[index:next]...)
		stop, exit := consume(next)
		if exit != nil {
			return Args{}, exit
		}
		index = stop
	}
	index = consumePositionals(min(index, len(args)))
	extras = append(extras, args[min(index, len(args)):]...)
	if len(remaining) > 0 {
		names := make([]string, len(remaining))
		for position, positional := range remaining {
			names[position] = positional.Name
		}
		return Args{}, p.fail("the following arguments are required: " + strings.Join(names, ", "))
	}
	if len(extras) > 0 {
		return Args{}, p.fail("unrecognized arguments: " + strings.Join(extras, " "))
	}
	return result, nil
}
