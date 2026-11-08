// Package pyargparse — argparse CPython 3.12 с подкомандами для CLI платной попытки
// (prog media_request.py, cost_check.py): parser.add_subparsers(dest=..., required=True), у подкоманд —
// опции store_true, с одним значением или nargs="+", required=True, choices, type=float и одна
// взаимоисключающая группа (в том числе required=True).
//
// Зачем отдельно от pycompat.ArgParser: у того нет подкоманд, обязательных опций и типов, а
// приложение и журнал задания показывают stderr инструмента. Здесь воспроизводятся те же
// тексты и коды: usage с переносом HelpFormatter (ширина 78), «the following arguments are
// required», «invalid float value», «invalid choice», «expected one argument», «ambiguous option»,
// «not allowed with argument», «one of the arguments … is required» и «unrecognized arguments»
// (лишние аргументы подкоманды сообщает верхний парсер со своим usage, как parse_known_args
// подпарсера). Справка (-h) собирается pycompat.ArgParser.Help() с usage этого пакета.
//
// Не воспроизводятся редкие формы: склейка коротких флагов кроме -h, «--» внутри аргументов
// подкоманды (все аргументы после него считаются лишними), длинное имя программы (> 58 символов).
package pyargparse

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"songframe-go/internal/pycompat"
)

// Option — опция подкоманды.
type Option struct {
	// Name — длинное имя с «--».
	Name string
	// Help — строка справки; пустая — без описания.
	Help string
	// Flag — action="store_true".
	Flag bool
	// Plus — nargs="+".
	Plus bool
	// Required — required=True: без опции — ошибка разбора.
	Required bool
	// Choices — допустимые значения; пусто — любые.
	Choices []string
	// Float — type=float: значение проверяется float() Python при разборе.
	Float bool
}

// Command — подпарсер sub.add_parser(Name). Exclusive — имена опций одной взаимоисключающей
// группы (идут в Options подряд), ExclusiveRequired — группа required=True.
type Command struct {
	Name              string
	Options           []Option
	Exclusive         []string
	ExclusiveRequired bool
}

// Parser — ArgumentParser(description=…) с обязательными подкомандами.
type Parser struct {
	// Prog — имя скрипта (media_request.py).
	Prog string
	// Description — docstring модуля.
	Description string
	// Dest — dest подкоманд (action): так называется отсутствующий аргумент в ошибке.
	Dest     string
	Commands []Command
}

// Result — разобранные аргументы: подкоманда, флаги, значения и числа type=float.
type Result struct {
	Action string
	Bools  map[string]bool
	Values map[string][]string
	Floats map[string]float64
}

// Value — первое значение опции; ok=false — опция не задана.
func (r Result) Value(name string) (string, bool) {
	values, ok := r.Values[name]
	if !ok || len(values) == 0 {
		return "", false
	}
	return values[0], true
}

// Float — число опции type=float либо fallback (default=…).
func (r Result) Float(name string, fallback float64) float64 {
	if value, ok := r.Floats[name]; ok {
		return value
	}
	return fallback
}

// Exit — завершение разбора: справка (код 0, stdout) или ошибка (код 2, stderr).
type Exit struct {
	Code   int
	Stdout string
	Stderr string
}

// textWidth — ширина HelpFormatter без терминала: COLUMNS 80 − 2.
const textWidth = 78

func runeLen(text string) int { return utf8.RuneCountInString(text) }

// metavar — DEST в верхнем регистре или {choices}.
func (o Option) metavar() string {
	if len(o.Choices) > 0 {
		return "{" + strings.Join(o.Choices, ",") + "}"
	}
	return strings.ToUpper(strings.ReplaceAll(strings.TrimPrefix(o.Name, "--"), "-", "_"))
}

// usageText — вызов опции в usage без скобок: «--x», «--x X», «--x X [X ...]».
func (o Option) usageText() string {
	switch {
	case o.Flag:
		return o.Name
	case o.Plus:
		return o.Name + " " + o.metavar() + " [" + o.metavar() + " ...]"
	}
	return o.Name + " " + o.metavar()
}

// partPattern — part_regexp HelpFormatter._format_usage: на эти части делится usage при переносе.
var partPattern = regexp.MustCompile(`\(.*?\)+(?:\s|$)|\[.*?\]+(?:\s|$)|\S+`)

// parts — findall part_regexp (без завершающего пробела совпадения: в RE2 нет просмотра вперёд).
func parts(text string) []string {
	found := partPattern.FindAllString(text, -1)
	for index, part := range found {
		found[index] = strings.TrimRight(part, " ")
	}
	return found
}

// getLines — get_lines из _format_usage: жадная укладка частей по ширине.
func getLines(items []string, indent string, prefix *string) []string {
	lines := []string{}
	line := []string{}
	length := runeLen(indent) - 1
	if prefix != nil {
		length = runeLen(*prefix) - 1
	}
	for _, part := range items {
		if length+1+runeLen(part) > textWidth && len(line) > 0 {
			lines = append(lines, indent+strings.Join(line, " "))
			line = nil
			length = runeLen(indent) - 1
		}
		line = append(line, part)
		length += runeLen(part) + 1
	}
	if len(line) > 0 {
		lines = append(lines, indent+strings.Join(line, " "))
	}
	if prefix != nil && len(lines) > 0 {
		lines[0] = lines[0][len(indent):]
	}
	return lines
}

// usage — format_usage(): «usage: prog опции позиционные\n» с переносом.
func usage(prog string, optional, positional string) string {
	const prefix = "usage: "
	full := strings.TrimSpace(prog + " " + strings.TrimSpace(optional+" "+positional))
	if runeLen(prefix)+runeLen(full) <= textWidth {
		return prefix + full + "\n"
	}
	indent := strings.Repeat(" ", runeLen(prefix)+runeLen(prog)+1)
	head := prefix
	optParts, posParts := parts(optional), parts(positional)
	var lines []string
	switch {
	case len(optParts) > 0:
		lines = getLines(append([]string{prog}, optParts...), indent, &head)
		lines = append(lines, getLines(posParts, indent, nil)...)
	case len(posParts) > 0:
		lines = getLines(append([]string{prog}, posParts...), indent, &head)
	default:
		lines = []string{prog}
	}
	return prefix + strings.Join(lines, "\n") + "\n"
}

// choicesText — metavar подкоманд «{a,b,…}».
func (p Parser) choicesText() string {
	names := make([]string, len(p.Commands))
	for index, command := range p.Commands {
		names[index] = command.Name
	}
	return "{" + strings.Join(names, ",") + "}"
}

// Usage — usage верхнего парсера.
func (p Parser) Usage() string { return usage(p.Prog, "[-h]", p.choicesText()+" ...") }

// fail — parser.error(message) верхнего парсера.
func (p Parser) fail(message string) *Exit {
	return &Exit{Code: 2, Stderr: p.Usage() + p.Prog + ": error: " + message + "\n"}
}

// help — print_help() верхнего парсера.
func (p Parser) help() *Exit {
	legacy := pycompat.ArgParser{Prog: p.Prog, Description: p.Description, Positionals: []pycompat.Positional{{Name: p.choicesText()}}}
	return &Exit{Code: 0, Stdout: p.Usage() + strings.TrimPrefix(legacy.Help(), legacy.Usage())}
}

// prog — имя подпарсера: «media_request.py submit».
func (p Parser) prog(command Command) string { return p.Prog + " " + command.Name }

// inGroup — опция входит во взаимоисключающую группу подкоманды.
func (c Command) inGroup(name string) bool {
	for _, member := range c.Exclusive {
		if member == name {
			return true
		}
	}
	return false
}

// Usage — usage подкоманды: обязательные опции без скобок, группа required — в круглых скобках.
func (p Parser) commandUsage(command Command) string {
	items := []string{"[-h]"}
	group := []string{}
	for index, option := range command.Options {
		if command.inGroup(option.Name) {
			group = append(group, option.usageText())
			if index+1 == len(command.Options) || !command.inGroup(command.Options[index+1].Name) {
				if command.ExclusiveRequired {
					items = append(items, "("+strings.Join(group, " | ")+")")
				} else {
					items = append(items, "["+strings.Join(group, " | ")+"]")
				}
				group = nil
			}
			continue
		}
		if option.Required {
			items = append(items, option.usageText())
		} else {
			items = append(items, "["+option.usageText()+"]")
		}
	}
	return usage(p.prog(command), strings.Join(items, " "), "")
}

// commandFail — parser.error подпарсера.
func (p Parser) commandFail(command Command, message string) *Exit {
	return &Exit{Code: 2, Stderr: p.commandUsage(command) + p.prog(command) + ": error: " + message + "\n"}
}

// commandHelp — print_help() подпарсера.
func (p Parser) commandHelp(command Command) *Exit {
	legacy := pycompat.ArgParser{Prog: p.prog(command)}
	for _, option := range command.Options {
		flag := pycompat.Flag{Name: option.Name, Help: option.Help, Value: !option.Flag && !option.Plus, Plus: option.Plus, Choices: option.Choices}
		legacy.Flags = append(legacy.Flags, flag)
	}
	return &Exit{Code: 0, Stdout: p.commandUsage(command) + strings.TrimPrefix(legacy.Help(), legacy.Usage())}
}

// Parse — parse_args(args): подкоманда и её аргументы либо завершение.
func (p Parser) Parse(args []string) (Result, *Exit) {
	extras := []string{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			// После «--» всё — значения: первое из них и есть подкоманда.
			if index+1 < len(args) {
				return p.dispatch(args[index+1], args[index+2:], extras)
			}
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" || negativeNumber.MatchString(arg) {
			return p.dispatch(arg, args[index+1:], extras)
		}
		if arg == "-h" || (strings.HasPrefix(arg, "--") && strings.HasPrefix("--help", arg) && len(arg) > 2) || strings.HasPrefix(arg, "-h") && !strings.HasPrefix(arg, "--") {
			return Result{}, p.help()
		}
		if strings.Contains(arg, " ") {
			return p.dispatch(arg, args[index+1:], extras)
		}
		extras = append(extras, arg)
	}
	return Result{}, p.fail("the following arguments are required: " + p.Dest)
}

// dispatch — действие подкоманд: проверка выбора, разбор подпарсера, лишние аргументы.
func (p Parser) dispatch(name string, rest []string, extras []string) (Result, *Exit) {
	for _, command := range p.Commands {
		if command.Name != name {
			continue
		}
		result, more, exit := p.parseCommand(command, rest)
		if exit != nil {
			return Result{}, exit
		}
		extras = append(extras, more...)
		if len(extras) > 0 {
			return Result{}, p.fail("unrecognized arguments: " + strings.Join(extras, " "))
		}
		result.Action = name
		return result, nil
	}
	quoted := make([]string, len(p.Commands))
	for index, command := range p.Commands {
		quoted[index] = pycompat.Repr(command.Name)
	}
	return Result{}, p.fail("argument " + p.Dest + ": invalid choice: " + pycompat.Repr(name) + " (choose from " + strings.Join(quoted, ", ") + ")")
}

// negativeNumber — _negative_number_matcher: такие строки — значения, а не опции.
var negativeNumber = regexp.MustCompile(`^-\d+$|^-\d*\.\d+$`)

// token — разобранная строка аргумента подпарсера: kind 'A' (значение), 'O' (опция), '-' («--»).
// option — индекс опции (-1 — справка, -2 — неизвестная), explicit — значение после «=».
type token struct {
	kind     byte
	option   int
	name     string
	explicit *string
}

// classify — _parse_optional подпарсера; ambiguous — текст ошибки неоднозначного префикса.
func classify(command Command, arg string) (token, string) {
	if arg == "" || arg[0] != '-' || arg == "-" {
		return token{kind: 'A'}, ""
	}
	find := func(name string) int {
		if name == "-h" || name == "--help" {
			return -1
		}
		for index, option := range command.Options {
			if option.Name == name {
				return index
			}
		}
		return -3
	}
	if index := find(arg); index != -3 {
		return token{kind: 'O', option: index, name: arg}, ""
	}
	if name, value, ok := strings.Cut(arg, "="); ok {
		if index := find(name); index != -3 {
			return token{kind: 'O', option: index, name: name, explicit: &value}, ""
		}
	}
	names := []string{"-h", "--help"}
	for _, option := range command.Options {
		names = append(names, option.Name)
	}
	matches := []token{}
	if strings.HasPrefix(arg, "--") {
		prefix, value, hasValue := strings.Cut(arg, "=")
		for _, name := range names {
			if strings.HasPrefix(name, prefix) {
				match := token{kind: 'O', option: find(name), name: name}
				if hasValue {
					explicit := value
					match.explicit = &explicit
				}
				matches = append(matches, match)
			}
		}
	} else if strings.HasPrefix(arg, "-h") {
		explicit := arg[2:]
		matches = append(matches, token{kind: 'O', option: -1, name: "-h", explicit: &explicit})
	}
	if len(matches) > 1 {
		found := make([]string, len(matches))
		for index, match := range matches {
			found[index] = match.name
		}
		return token{}, "ambiguous option: " + arg + " could match " + strings.Join(found, ", ")
	}
	if len(matches) == 1 {
		return matches[0], ""
	}
	if negativeNumber.MatchString(arg) || strings.Contains(arg, " ") {
		return token{kind: 'A'}, ""
	}
	return token{kind: 'O', option: -2, name: arg}, ""
}

// parseCommand — parse_known_args подпарсера: значения и лишние аргументы.
func (p Parser) parseCommand(command Command, args []string) (Result, []string, *Exit) {
	result := Result{Bools: map[string]bool{}, Values: map[string][]string{}, Floats: map[string]float64{}}
	tokens := make([]token, len(args))
	for index, arg := range args {
		if arg == "--" {
			for rest := index; rest < len(args); rest++ {
				tokens[rest] = token{kind: '-'}
			}
			break
		}
		item, ambiguous := classify(command, arg)
		if ambiguous != "" {
			return result, nil, p.commandFail(command, ambiguous)
		}
		tokens[index] = item
	}
	extras := []string{}
	seen := map[string]bool{}
	argumentName := func(index int) string {
		if index == -1 {
			return "-h/--help"
		}
		return command.Options[index].Name
	}
	// take — take_action: тип, choices, конфликт группы и запись значения; -h — справка.
	take := func(index int, values []string) *Exit {
		if index == -1 {
			return p.commandHelp(command)
		}
		option := command.Options[index]
		seen[option.Name] = true
		if option.Float {
			number, err := pycompat.FloatFromString(values[0])
			if err != nil {
				return p.commandFail(command, "argument "+option.Name+": invalid float value: "+pycompat.Repr(values[0]))
			}
			result.Floats[option.Name] = number
		}
		if len(option.Choices) > 0 {
			for _, value := range values {
				allowed := false
				for _, choice := range option.Choices {
					allowed = allowed || choice == value
				}
				if !allowed {
					quoted := make([]string, len(option.Choices))
					for position, choice := range option.Choices {
						quoted[position] = pycompat.Repr(choice)
					}
					return p.commandFail(command, "argument "+option.Name+": invalid choice: "+pycompat.Repr(value)+" (choose from "+strings.Join(quoted, ", ")+")")
				}
			}
		}
		if command.inGroup(option.Name) {
			for _, other := range command.Exclusive {
				if other != option.Name && seen["group:"+other] {
					return p.commandFail(command, "argument "+option.Name+": not allowed with argument "+other)
				}
			}
			seen["group:"+option.Name] = true
		}
		if option.Flag {
			result.Bools[option.Name] = true
		} else {
			result.Values[option.Name] = append([]string(nil), values...)
		}
		return nil
	}
	for index := 0; index < len(args); {
		item := tokens[index]
		if item.kind != 'O' {
			// Позиционных аргументов у подкоманд нет: значение вне опции и всё после «--» — лишние.
			extras = append(extras, args[index])
			index++
			continue
		}
		if item.option == -2 {
			extras = append(extras, args[index])
			index++
			continue
		}
		takes := item.option >= 0 && !command.Options[item.option].Flag
		if item.explicit != nil {
			if takes {
				if exit := take(item.option, []string{*item.explicit}); exit != nil {
					return result, nil, exit
				}
				index++
				continue
			}
			return result, nil, p.commandFail(command, "argument "+argumentName(item.option)+": ignored explicit argument "+pycompat.Repr(*item.explicit))
		}
		count := 0
		if takes {
			plus := command.Options[item.option].Plus
			for position := index + 1; position < len(args) && tokens[position].kind == 'A'; position++ {
				count++
				if !plus {
					break
				}
			}
			if count == 0 {
				message := "expected one argument"
				if plus {
					message = "expected at least one argument"
				}
				return result, nil, p.commandFail(command, "argument "+argumentName(item.option)+": "+message)
			}
		}
		if exit := take(item.option, args[index+1:index+1+count]); exit != nil {
			return result, nil, exit
		}
		index += 1 + count
	}
	missing := []string{}
	for _, option := range command.Options {
		if option.Required && !seen[option.Name] {
			missing = append(missing, option.Name)
		}
	}
	if len(missing) > 0 {
		return result, nil, p.commandFail(command, "the following arguments are required: "+strings.Join(missing, ", "))
	}
	if command.ExclusiveRequired {
		given := false
		for _, name := range command.Exclusive {
			given = given || seen[name]
		}
		if !given {
			return result, nil, p.commandFail(command, "one of the arguments "+strings.Join(command.Exclusive, " ")+" is required")
		}
	}
	return result, extras, nil
}
