// Package toolsubcmd — разбор аргументов с обязательной подкомандой для CLI платной попытки
// (prog media_request, cost_check): у подкоманд — логические флаги, опции с одним или
// несколькими значениями, обязательные опции, списки допустимых значений, дробные значения и
// одна взаимоисключающая группа (в том числе обязательная).
//
// Зачем отдельно от toolrt.ArgParser: у того нет подкоманд, обязательных опций и типов, а
// приложение и журнал задания показывают stderr инструмента. Тексты и коды завершения
// зафиксированы эталонами: usage с переносом по ширине 78, «the following arguments are
// required», «invalid float value», «invalid choice», «expected one argument», «ambiguous option»,
// «not allowed with argument», «one of the arguments … is required» и «unrecognized arguments»
// (лишние аргументы подкоманды сообщает верхний парсер со своим usage). Справка (-h) собирается
// toolrt.ArgParser.Help() с usage этого пакета.
//
// Не поддерживаются редкие формы: склейка коротких флагов кроме -h, «--» внутри аргументов
// подкоманды (все аргументы после него считаются лишними), длинное имя программы (> 58 символов).
package toolsubcmd

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"songframe/internal/toolrt"
)

// Option — опция подкоманды.
type Option struct {
	// Name — длинное имя с «--».
	Name string
	// Help — строка справки; пустая — без описания.
	Help string
	// Flag — логический флаг без значения.
	Flag bool
	// Plus — одно или несколько значений подряд.
	Plus bool
	// Required — обязательная опция: без неё — ошибка разбора.
	Required bool
	// Choices — допустимые значения; пусто — любые.
	Choices []string
	// Float — значение — дробное число (toolrt.FloatFromString), проверяется при разборе.
	Float bool
}

// Command — подкоманда Name со своими опциями. Exclusive — имена опций одной взаимоисключающей
// группы (идут в Options подряд), ExclusiveRequired — одна из опций группы обязательна.
type Command struct {
	Name              string
	Options           []Option
	Exclusive         []string
	ExclusiveRequired bool
}

// Parser — верхний парсер с описанием и обязательной подкомандой.
type Parser struct {
	// Prog — имя скрипта (media_request).
	Prog string
	// Description — описание инструмента в справке -h.
	Description string
	// Dest — имя аргумента подкоманды (action): так он называется в ошибках.
	Dest     string
	Commands []Command
}

// Result — разобранные аргументы: подкоманда, флаги, значения и дробные числа опций Float.
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

// Float — число опции Float либо fallback, если опция не задана.
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

// textWidth — ширина usage и справки: 80 колонок минус поле 2; от терминала не зависит.
const textWidth = 78

func runeLen(text string) int { return utf8.RuneCountInString(text) }

// metavar — имя значения: {choices} либо имя опции без «--» в верхнем регистре с «_».
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

// partPattern — части usage при переносе: группа в круглых или квадратных скобках целиком,
// остальное по словам.
var partPattern = regexp.MustCompile(`\(.*?\)+(?:\s|$)|\[.*?\]+(?:\s|$)|\S+`)

// parts — все части partPattern без завершающего пробела совпадения (в RE2 нет просмотра
// вперёд, поэтому пробел входит в совпадение и снимается здесь).
func parts(text string) []string {
	found := partPattern.FindAllString(text, -1)
	for index, part := range found {
		found[index] = strings.TrimRight(part, " ")
	}
	return found
}

// getLines — жадная укладка частей usage по ширине с отступом indent; с prefix первая строка
// начинается сразу после него.
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

// usage — «usage: prog опции позиционные\n» с переносом длинной строки.
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

// fail — ошибка верхнего парсера: usage и «prog: error: текст» в stderr, код 2.
func (p Parser) fail(message string) *Exit {
	return &Exit{Code: 2, Stderr: p.Usage() + p.Prog + ": error: " + message + "\n"}
}

// help — справка -h верхнего парсера.
func (p Parser) help() *Exit {
	formatter := toolrt.ArgParser{Prog: p.Prog, Description: p.Description, Positionals: []toolrt.Positional{{Name: p.choicesText()}}}
	return &Exit{Code: 0, Stdout: p.Usage() + strings.TrimPrefix(formatter.Help(), formatter.Usage())}
}

// prog — имя подкоманды в usage и ошибках: «media_request submit».
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

// commandUsage — usage подкоманды: обязательные опции без скобок, группа required — в круглых скобках.
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

// commandFail — ошибка подкоманды со своим usage и prog, код 2.
func (p Parser) commandFail(command Command, message string) *Exit {
	return &Exit{Code: 2, Stderr: p.commandUsage(command) + p.prog(command) + ": error: " + message + "\n"}
}

// commandHelp — справка -h подкоманды.
func (p Parser) commandHelp(command Command) *Exit {
	formatter := toolrt.ArgParser{Prog: p.prog(command)}
	for _, option := range command.Options {
		flag := toolrt.Flag{Name: option.Name, Help: option.Help, Value: !option.Flag && !option.Plus, Plus: option.Plus, Choices: option.Choices}
		formatter.Flags = append(formatter.Flags, flag)
	}
	return &Exit{Code: 0, Stdout: p.commandUsage(command) + strings.TrimPrefix(formatter.Help(), formatter.Usage())}
}

// Parse — разбор args: подкоманда и её аргументы либо завершение.
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

// dispatch — выбор подкоманды: проверка имени, разбор её аргументов, ошибка за лишние.
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
		quoted[index] = toolrt.Repr(command.Name)
	}
	return Result{}, p.fail("argument " + p.Dest + ": invalid choice: " + toolrt.Repr(name) + " (choose from " + strings.Join(quoted, ", ") + ")")
}

// negativeNumber — отрицательное число (целое или с дробной частью): такие строки — значения,
// а не опции.
var negativeNumber = regexp.MustCompile(`^-\d+$|^-\d*\.\d+$`)

// token — разобранная строка аргумента подкоманды: kind 'A' (значение), 'O' (опция), '-' («--»).
// option — индекс опции (-1 — справка, -2 — неизвестная), explicit — значение после «=».
type token struct {
	kind     byte
	option   int
	name     string
	explicit *string
}

// classify — классификация строки аргумента подкоманды (как у toolrt.ArgParser); ambiguous —
// текст ошибки неоднозначного префикса.
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

// parseCommand — разбор аргументов подкоманды: значения и лишние аргументы (их сообщает
// верхний парсер).
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
	// take — применение опции: тип, choices, конфликт группы и запись значения; -h — справка.
	take := func(index int, values []string) *Exit {
		if index == -1 {
			return p.commandHelp(command)
		}
		option := command.Options[index]
		seen[option.Name] = true
		if option.Float {
			number, err := toolrt.FloatFromString(values[0])
			if err != nil {
				return p.commandFail(command, "argument "+option.Name+": invalid float value: "+toolrt.Repr(values[0]))
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
						quoted[position] = toolrt.Repr(choice)
					}
					return p.commandFail(command, "argument "+option.Name+": invalid choice: "+toolrt.Repr(value)+" (choose from "+strings.Join(quoted, ", ")+")")
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
			return result, nil, p.commandFail(command, "argument "+argumentName(item.option)+": ignored explicit argument "+toolrt.Repr(*item.explicit))
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
