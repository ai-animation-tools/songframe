package pycompat

import (
	"math/big"
	"strings"
	"unicode/utf8"
)

// Расширенный разбор аргументов argparse CPython 3.12 для инструментов с подкомандами
// (add_subparsers(dest=…, required=True)) и опциями, которых нет у ArgParser: обязательные опции
// (required=True), type=int, action="append" и значения по умолчанию. Классификация строк, префиксы
// длинных опций, «=значение», склейка коротких флагов, порядок ошибок, usage и справка повторяют
// ArgParser (общие помощники getLines, fill и negativeNumber); отдельный тип не меняет поведение
// уже перенесённых инструментов.
//
// Подкоманда разбирается так же, как в оригинале: её parse_known_args получает все строки после
// имени (nargs=PARSER), свои ошибки сообщает со своим prog («prog имя»), а нераспознанные строки
// возвращает родителю, который завершает разбор ошибкой «unrecognized arguments» со своим usage.

// ActionKind — вид действия опции.
type ActionKind int

const (
	// StoreValue — action="store" с одним значением (nargs=None).
	StoreValue ActionKind = iota
	// StoreTrue — action="store_true".
	StoreTrue
	// AppendValue — action="append": каждое появление добавляет значение в список.
	AppendValue
)

// Action — аргумент парсера в порядке add_argument. Name с «--» — опция, иначе обязательный
// позиционный аргумент с одним значением.
type Action struct {
	Name     string
	Kind     ActionKind
	Help     string
	Metavar  string
	Choices  []string
	Required bool
	// Int — type=int: значение преобразуется int(строка), ошибка — «invalid int value».
	Int bool
	// Default — значение по умолчанию (строка или nil); у append без значения — пустой список.
	Default any
}

// Command — argparse.ArgumentParser: свои аргументы и, если задан Dest, обязательные подкоманды.
type Command struct {
	// Name — имя подкоманды у родителя; у верхнего парсера пусто.
	Name        string
	Prog        string
	Description string
	Actions     []Action
	// Dest — dest add_subparsers; пусто — подкоманд нет.
	Dest        string
	Subcommands []*Command
}

// Namespace — результат разбора: dest → значение (string, Int, bool, []string или nil).
type Namespace map[string]any

// dest — имя атрибута Namespace: «--retry-of» → «retry_of».
func (a Action) dest() string {
	return strings.ReplaceAll(strings.TrimPrefix(a.Name, "--"), "-", "_")
}

// Dest — имя атрибута результата для опции или позиционного аргумента.
func (a Action) Dest() string { return a.dest() }

func (a Action) optional() bool { return strings.HasPrefix(a.Name, "-") }

func (a Action) takesValue() bool { return a.Kind != StoreTrue }

func (a Action) metavar() string {
	if a.Metavar != "" {
		return a.Metavar
	}
	if len(a.Choices) > 0 {
		return "{" + strings.Join(a.Choices, ",") + "}"
	}
	if !a.optional() {
		return a.Name
	}
	return strings.ToUpper(a.dest())
}

// invocation — _format_action_invocation.
func (a Action) invocation() string {
	if !a.optional() {
		return a.metavar()
	}
	if a.takesValue() {
		return a.Name + " " + a.metavar()
	}
	return a.Name
}

// prog — prog подкоманды: «prog родителя имя».
func (c *Command) child(name string) *Command {
	for _, sub := range c.Subcommands {
		if sub.Name == name {
			if sub.Prog == "" {
				sub.Prog = c.Prog + " " + name
			}
			return sub
		}
	}
	return nil
}

// choices — имена подкоманд в порядке add_parser.
func (c *Command) choices() []string {
	names := make([]string, len(c.Subcommands))
	for index, sub := range c.Subcommands {
		names[index] = sub.Name
	}
	return names
}

func (c *Command) subMetavar() string { return "{" + strings.Join(c.choices(), ",") + "}" }

// usageParts — части usage после prog: опции, затем позиционные и подкоманды (_format_usage
// с разбиением регулярным выражением part_regexp: части в скобках целиком, остальное по словам).
func (c *Command) usageParts() (options, positionals []string) {
	options = []string{"[-h]"}
	for _, action := range c.Actions {
		if !action.optional() {
			positionals = append(positionals, action.metavar())
			continue
		}
		part := action.invocation()
		if action.Required {
			options = append(options, strings.Fields(part)...)
		} else {
			options = append(options, "["+part+"]")
		}
	}
	if c.Dest != "" {
		positionals = append(positionals, c.subMetavar(), "...")
	}
	return options, positionals
}

// Usage — format_usage() с переносом длинной строки (ветка короткого prog).
func (c *Command) Usage() string {
	options, positionals := c.usageParts()
	const prefix = "usage: "
	line := c.Prog + " " + strings.Join(append(append([]string{}, options...), positionals...), " ")
	if runeLen(prefix)+runeLen(line) <= helpWidth {
		return prefix + line + "\n"
	}
	indent := strings.Repeat(" ", runeLen(prefix)+runeLen(c.Prog)+1)
	lines := getLines(append([]string{c.Prog}, options...), indent, prefix, true)
	if len(positionals) > 0 {
		lines = append(lines, getLines(positionals, indent, "", false)...)
	}
	return prefix + strings.Join(lines, "\n") + "\n"
}

// Help — print_help(): usage, описание и разделы positional arguments и options.
func (c *Command) Help() string {
	type row struct{ invocation, help string }
	positionals, options := []row{}, []row{{"-h, --help", "show this help message and exit"}}
	for _, action := range c.Actions {
		if action.optional() {
			options = append(options, row{action.invocation(), action.Help})
		} else {
			positionals = append(positionals, row{action.invocation(), action.Help})
		}
	}
	if c.Dest != "" {
		positionals = append(positionals, row{c.subMetavar(), ""})
	}
	longest := 0
	for _, item := range append(append([]row{}, positionals...), options...) {
		longest = max(longest, runeLen(item.invocation)+2)
	}
	position := min(longest+2, min(24, max(helpWidth-20, 4)))
	width := position - 4
	helpText := max(helpWidth-position, 11)
	var builder strings.Builder
	builder.WriteString(c.Usage())
	if c.Description != "" {
		builder.WriteString("\n" + strings.Join(fill(c.Description, helpWidth), "\n") + "\n")
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
	section("options", options)
	return builder.String()
}

func (c *Command) fail(message string) *ArgExit {
	return &ArgExit{Code: 2, Stderr: c.Usage() + c.Prog + ": error: " + message + "\n"}
}

// optionStrings — строки опций в порядке _option_string_actions: -h, --help, затем опции.
func (c *Command) optionStrings() []string {
	names := []string{"-h", helpName}
	for _, action := range c.Actions {
		if action.optional() {
			names = append(names, action.Name)
		}
	}
	return names
}

// actionIndex — индекс опции по строке: -1 для -h/--help.
func (c *Command) actionIndex(name string) (int, bool) {
	if name == "-h" || name == helpName {
		return -1, true
	}
	for index, action := range c.Actions {
		if action.optional() && action.Name == name {
			return index, true
		}
	}
	return 0, false
}

// parseOptional — _parse_optional (как у ArgParser): nil — строка-значение.
func (c *Command) parseOptional(arg string) (*option, string) {
	if arg == "" || arg[0] != '-' {
		return nil, ""
	}
	if index, ok := c.actionIndex(arg); ok {
		return &option{index: index, name: arg}, ""
	}
	if runeLen(arg) == 1 {
		return nil, ""
	}
	if name, value, hasSep := strings.Cut(arg, "="); hasSep {
		if index, ok := c.actionIndex(name); ok {
			return &option{index: index, name: name, sep: "=", explicit: &value}, ""
		}
	}
	tuples := []option{}
	if arg[1] == '-' {
		prefix, value, hasSep := strings.Cut(arg, "=")
		for _, name := range c.optionStrings() {
			if strings.HasPrefix(name, prefix) {
				index, _ := c.actionIndex(name)
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
		for _, name := range c.optionStrings() {
			index, _ := c.actionIndex(name)
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

func (c *Command) argumentName(index int) string {
	if index == -1 {
		return "-h/--help"
	}
	return c.Actions[index].Name
}

// ParseInt — int(text) Python для десятичной строки: пробелы по краям, знак, цифры Unicode и
// одиночные подчёркивания между цифрами. false — ValueError «invalid literal for int()».
func ParseIntText(text string) (Int, bool) {
	body := Strip(text)
	negative := false
	if body != "" && (body[0] == '+' || body[0] == '-') {
		negative = body[0] == '-'
		body = body[1:]
	}
	if body == "" || body[0] == '_' || strings.HasSuffix(body, "_") || strings.Contains(body, "__") {
		return Int{}, false
	}
	value := new(big.Int)
	ten := big.NewInt(10)
	for _, r := range body {
		if r == '_' {
			continue
		}
		digit := DigitValue(r)
		if digit < 0 {
			return Int{}, false
		}
		value.Mul(value, ten).Add(value, big.NewInt(int64(digit)))
	}
	if negative {
		value.Neg(value)
	}
	return IntFromBig(value), true
}

// ParseArgs — parse_args(args): значения по dest или завершение (справка либо ошибка).
func (c *Command) ParseArgs(args []string) (Namespace, *ArgExit) {
	result, extras, exit := c.parseKnown(args)
	if exit != nil {
		return nil, exit
	}
	if len(extras) > 0 {
		return nil, c.fail("unrecognized arguments: " + strings.Join(extras, " "))
	}
	return result, nil
}

// parseKnown — parse_known_args: значения и нераспознанные строки (свои и подкоманды).
func (c *Command) parseKnown(args []string) (Namespace, []string, *ArgExit) {
	result := Namespace{}
	for _, action := range c.Actions {
		switch {
		case action.Kind == StoreTrue:
			result[action.dest()] = false
		case action.Kind == AppendValue && action.Default == nil:
			result[action.dest()] = []string(nil)
		default:
			result[action.dest()] = action.Default
		}
	}
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
		parsed, ambiguous := c.parseOptional(args[index])
		if ambiguous != "" {
			return nil, nil, c.fail(ambiguous)
		}
		if parsed == nil {
			pattern[index] = 'A'
			continue
		}
		pattern[index] = 'O'
		options[index] = parsed
	}
	seen := map[string]bool{}
	extras := []string{}
	var subExtras []string
	// take — take_action: type=int, choices и запись значения; -h печатает справку.
	take := func(index int, values []string) *ArgExit {
		if index == -1 {
			return &ArgExit{Code: 0, Stdout: c.Help()}
		}
		action := c.Actions[index]
		seen[action.Name] = true
		if action.Kind == StoreTrue {
			result[action.dest()] = true
			return nil
		}
		value := any(values[0])
		if action.Int {
			number, ok := ParseIntText(values[0])
			if !ok {
				return c.fail("argument " + c.argumentName(index) + ": invalid int value: " + Repr(values[0]))
			}
			value = number
		}
		if len(action.Choices) > 0 {
			allowed := false
			for _, choice := range action.Choices {
				allowed = allowed || choice == values[0]
			}
			if !allowed {
				quoted := make([]string, len(action.Choices))
				for position, choice := range action.Choices {
					quoted[position] = Repr(choice)
				}
				return c.fail("argument " + c.argumentName(index) + ": invalid choice: " + Repr(values[0]) + " (choose from " + strings.Join(quoted, ", ") + ")")
			}
		}
		if action.Kind == AppendValue {
			list, _ := result[action.dest()].([]string)
			result[action.dest()] = append(append([]string(nil), list...), values[0])
			return nil
		}
		result[action.dest()] = value
		return nil
	}
	// Позиционные аргументы в порядке объявления; подкоманды — последним с шаблоном PARSER.
	remaining := []int{}
	for index, action := range c.Actions {
		if !action.optional() {
			remaining = append(remaining, index)
		}
	}
	subPending := c.Dest != ""
	// matchPositional — длина совпадения '(-*A-*)' (или PARSER '(-*A[-AO]*)') с начала шаблона; -1 — нет.
	matchPositional := func(start int, parser bool) int {
		position := start
		for position < len(args) && pattern[position] == '-' {
			position++
		}
		if position >= len(args) || pattern[position] != 'A' {
			return -1
		}
		position++
		if parser {
			return len(args) - start
		}
		for position < len(args) && pattern[position] == '-' {
			position++
		}
		return position - start
	}
	// consumePositionals — consume_positionals: _match_arguments_partial берёт наибольшее число
	// позиционных подряд; у обычных из значений убирается первое «--».
	consumePositionals := func(start int) (int, *ArgExit) {
		counts := []int{}
		position := start
		for _, index := range remaining {
			_ = index
			count := matchPositional(position, false)
			if count < 0 {
				break
			}
			counts = append(counts, count)
			position += count
		}
		parserCount := -1
		if subPending && len(counts) == len(remaining) {
			parserCount = matchPositional(position, true)
		}
		for number, count := range counts {
			values := []string{}
			removed := false
			for _, value := range args[start : start+count] {
				if value == "--" && !removed {
					removed = true
					continue
				}
				values = append(values, value)
			}
			if exit := take(remaining[number], values); exit != nil {
				return 0, exit
			}
			start += count
		}
		remaining = remaining[len(counts):]
		if parserCount >= 0 {
			subPending = false
			values := args[start : start+parserCount]
			start += parserCount
			name := values[0]
			sub := c.child(name)
			if sub == nil {
				quoted := make([]string, len(c.Subcommands))
				for position, choice := range c.choices() {
					quoted[position] = Repr(choice)
				}
				return 0, c.fail("argument " + c.Dest + ": invalid choice: " + Repr(name) + " (choose from " + strings.Join(quoted, ", ") + ")")
			}
			seen[c.Dest] = true
			result[c.Dest] = name
			parsed, rest, exit := sub.parseKnown(values[1:])
			if exit != nil {
				return 0, exit
			}
			for key, value := range parsed {
				result[key] = value
			}
			subExtras = append(subExtras, rest...)
		}
		return start, nil
	}
	// consumeOptional — consume_optional: опция (возможно, склейка коротких флагов) и значения.
	consumeOptional := func(start int) (int, *ArgExit) {
		current := *options[start]
		type item struct {
			index  int
			values []string
		}
		items := []item{}
		stop := start + 1
		for {
			if current.index == -2 {
				extras = append(extras, args[start])
				return start + 1, nil
			}
			takes := current.index >= 0 && c.Actions[current.index].takesValue()
			if current.explicit != nil {
				explicit := *current.explicit
				if !takes && current.name[1] != '-' && explicit != "" {
					if current.sep != "" || explicit[0] == '-' {
						return 0, c.fail("argument " + c.argumentName(current.index) + ": ignored explicit argument " + Repr(explicit))
					}
					items = append(items, item{index: current.index})
					first, size := utf8.DecodeRuneInString(explicit)
					next := "-" + string(first)
					if index, ok := c.actionIndex(next); ok {
						rest := explicit[size:]
						current = option{index: index, name: next}
						switch {
						case rest == "":
						case rest[0] == '=':
							value := rest[1:]
							current.sep, current.explicit = "=", &value
						default:
							current.explicit = &rest
						}
						continue
					}
					extras = append(extras, "-"+explicit)
					stop = start + 1
					break
				}
				if takes {
					items = append(items, item{index: current.index, values: []string{explicit}})
					stop = start + 1
					break
				}
				return 0, c.fail("argument " + c.argumentName(current.index) + ": ignored explicit argument " + Repr(explicit))
			}
			count := 0
			if takes {
				if start+1 < len(args) && pattern[start+1] == 'A' {
					count = 1
				} else {
					return 0, c.fail("argument " + c.argumentName(current.index) + ": expected one argument")
				}
			}
			stop = start + 1 + count
			items = append(items, item{index: current.index, values: args[start+1 : stop]})
			break
		}
		for _, entry := range items {
			if exit := take(entry.index, entry.values); exit != nil {
				return 0, exit
			}
		}
		return stop, nil
	}
	index := 0
	for index < len(args) {
		next := -1
		for position := index; position < len(args); position++ {
			if pattern[position] == 'O' && options[position] != nil {
				next = position
				break
			}
		}
		if next < 0 {
			break
		}
		if index != next {
			end, exit := consumePositionals(index)
			if exit != nil {
				return nil, nil, exit
			}
			if end > index {
				index = end
				continue
			}
		}
		extras = append(extras, args[index:next]...)
		stop, exit := consumeOptional(next)
		if exit != nil {
			return nil, nil, exit
		}
		index = stop
	}
	end, exit := consumePositionals(min(index, len(args)))
	if exit != nil {
		return nil, nil, exit
	}
	extras = append(extras, args[min(end, len(args)):]...)
	required := []string{}
	for _, action := range c.Actions {
		if (action.Required || !action.optional()) && !seen[action.Name] {
			required = append(required, action.Name)
		}
	}
	if c.Dest != "" && !seen[c.Dest] {
		required = append(required, c.Dest)
	}
	if len(required) > 0 {
		return nil, nil, c.fail("the following arguments are required: " + strings.Join(required, ", "))
	}
	return result, append(extras, subExtras...), nil
}
