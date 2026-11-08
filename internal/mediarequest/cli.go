package mediarequest

import (
	"context"
	"errors"

	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
	"songframe/internal/toolsubcmd"
)

// Parser — подкоманды и опции инструмента media_request (разбор и тексты справки и ошибок —
// toolsubcmd).
var Parser = toolsubcmd.Parser{
	Prog:        "media_request",
	Description: "Попытка генерации у выбранного провайдера: возможности, подготовка, отправка и получение; @link README.md",
	Dest:        "action",
	Commands: []toolsubcmd.Command{
		{Name: "capabilities", Options: []toolsubcmd.Option{
			{Name: "--provider", Required: true},
			{Name: "--kind", Required: true, Choices: []string{"image", "video"}},
			{Name: "--json", Flag: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "login", Options: []toolsubcmd.Option{
			{Name: "--provider", Required: true},
			{Name: "--no-browser", Flag: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "auth-status", Options: []toolsubcmd.Option{
			{Name: "--provider", Required: true},
			{Name: "--json", Flag: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "prepare", Options: []toolsubcmd.Option{
			{Name: "--request", Required: true},
			{Name: "--work-dir", Required: true},
		}},
		{Name: "watch", Options: []toolsubcmd.Option{
			{Name: "--work-dir", Required: true, Plus: true},
			{Name: "--max-minutes", Float: true},
			{Name: "--interval", Float: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "attach", Options: []toolsubcmd.Option{
			{Name: "--work-dir", Required: true},
			{Name: "--file", Required: true, Plus: true},
		}},
		{Name: "submit", Options: []toolsubcmd.Option{
			{Name: "--work-dir", Required: true},
			{Name: "--timeout", Float: true},
			{Name: "--confirm", Required: true},
		}},
		{Name: "resume", Options: []toolsubcmd.Option{
			{Name: "--work-dir", Required: true},
			{Name: "--timeout", Float: true},
			{Name: "--generation-id"},
			{Name: "--wait-seconds", Float: true},
			{Name: "--interval", Float: true},
		}},
		{Name: "status", Options: []toolsubcmd.Option{{Name: "--work-dir", Required: true}}},
		{Name: "not-created", Options: []toolsubcmd.Option{{Name: "--work-dir", Required: true}}},
	},
}

// ProjectFreeActions — действия без проекта: вход к провайдеру
// выполняется со страницы «Среда» без выбранного клипа.
var ProjectFreeActions = map[string]bool{"login": true, "auth-status": true}

// textHidden — общий отказ: пути, ответы сервиса и сетевые ошибки могут содержать секреты.
const textHidden = "Ошибка локальных данных или файлов; сырой вывод скрыт."

// Run выполняет media_request на проекте root: разбор аргументов, действие и вывод JSON.
// Ошибка — код 1 и одна строка в stderr: текст ValueError/NotSubmitted как есть, прочие
// ожидаемые отказы (KeyError, TypeError, OSError и подклассы ValueError) — общий текст без
// сырого вывода; неожиданное исключение toolrt — необработанная ошибка (toolcli.Printer.Crash). report
// получает строки watch по мере смены статусов (nil — только в stdout результата); строки
// попадают и в stdout.
func Run(ctx context.Context, root string, args []string, report func(string)) toolcli.Output {
	parsed, exit := Parser.Parse(args)
	if exit != nil {
		return toolcli.Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	printer := &toolcli.Printer{}
	output, err := run(ctx, root, parsed, printer, report)
	if err != nil {
		if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
			return toolcli.Output{Code: 1, Stdout: printer.String(), Stderr: toolrt.TextMode(err.Error() + "\n")}
		}
		return failure(printer, err)
	}
	return output
}

// failure — ответ на ожидаемые отказы (исключения toolrt ValueError, KeyError, TypeError, OSError).
func failure(printer *toolcli.Printer, err error) toolcli.Output {
	var exception *toolrt.Exception
	switch {
	case mediaapi.IsNotSubmitted(err):
		return printer.Fail(err.Error())
	case errors.As(err, &exception) && exception.Type == toolrt.ValueError:
		return printer.Fail(err.Error())
	case toolrt.IsAny(err, toolrt.ValueError, toolrt.KeyError, toolrt.TypeError, toolrt.OSError):
		return printer.Fail(textHidden)
	case errors.As(err, &exception):
		return printer.Crash(err)
	}
	// Ошибка вне модели исключений toolrt (например, адаптера): сырой текст может содержать секреты.
	return printer.Fail(textHidden)
}

// printJSON печатает значение строкой JSON toolcli.JSON: отступ два пробела, не-ASCII символы
// без экранирования.
func printJSON(printer *toolcli.Printer, value any) error {
	text, err := toolcli.JSON(value)
	if err != nil {
		return err
	}
	return printer.Print(text)
}

// adapterFunction — необязательная возможность адаптера.
func adapterFunction(provider string) (mediaadapters.Adapter, error) {
	return mediaadapters.Lookup(provider)
}

// run — действие и печать результата; ошибки разбирает Run.
func run(ctx context.Context, root string, args toolsubcmd.Result, printer *toolcli.Printer, report func(string)) (toolcli.Output, error) {
	value := func(name string) string { text, _ := args.Value(name); return text }
	var result *toolrt.Dict
	var err error
	switch args.Action {
	case "capabilities":
		reportValue, err := Capabilities(ctx, value("--provider"), value("--kind"), args.Float("--timeout", 60))
		if err != nil {
			return toolcli.Output{}, err
		}
		if args.Bools["--json"] {
			if err := printJSON(printer, reportValue); err != nil {
				return toolcli.Output{}, err
			}
			return printer.Exit(0), nil
		}
		return printCapabilities(printer, reportValue)
	case "login":
		service, err := adapterFunction(value("--provider"))
		if err != nil {
			return toolcli.Output{}, err
		}
		loginer, ok := service.(mediaapi.Loginer)
		if !ok {
			return toolcli.Output{}, unsupported(value("--provider"))
		}
		answer := loginer.Login(ctx, mediaapi.LoginOptions{OpenBrowser: !args.Bools["--no-browser"], Timeout: mediaapi.Seconds(args.Float("--timeout", 300))})
		text, err := toolrt.DumpsJSON(toolcli.Record("ok", answer.OK, "message", answer.Message), toolrt.DumpOptions{})
		if err != nil {
			return toolcli.Output{}, err
		}
		if err := printer.Print(text); err != nil {
			return toolcli.Output{}, err
		}
		if !answer.OK {
			return printer.Exit(1), nil
		}
		return printer.Exit(0), nil
	case "auth-status":
		service, err := adapterFunction(value("--provider"))
		if err != nil {
			return toolcli.Output{}, err
		}
		reader, ok := service.(mediaapi.AuthStatusReader)
		if !ok {
			return toolcli.Output{}, unsupported(value("--provider"))
		}
		answer := reader.AuthStatus(ctx, mediaapi.Seconds(args.Float("--timeout", 30)))
		text := answer.Status
		if args.Bools["--json"] {
			record := toolcli.Record("status", answer.Status)
			if answer.Message != "" {
				record.Set("message", answer.Message)
			}
			if text, err = toolrt.DumpsJSON(record, toolrt.DumpOptions{}); err != nil {
				return toolcli.Output{}, err
			}
		} else if answer.Message != "" {
			text = answer.Message
		}
		if err := printer.Print(text); err != nil {
			return toolcli.Output{}, err
		}
		return printer.Exit(0), nil
	case "watch":
		lines := func(line string) {
			_ = printer.Print(line)
			if report != nil {
				report(line)
			}
		}
		entries, err := Watch(ctx, root, args.Values["--work-dir"], args.Float("--max-minutes", 15), args.Float("--interval", 20), args.Float("--timeout", 60), lines)
		if err != nil {
			return toolcli.Output{}, err
		}
		document := toolrt.NewDict()
		unfinished := false
		for _, entry := range entries {
			document.Set(entry.Path, entry.State)
			status, _ := entry.State.Value("status").(string)
			unfinished = unfinished || !Terminal[status]
		}
		if err := printJSON(printer, document); err != nil {
			return toolcli.Output{}, err
		}
		if unfinished {
			return printer.Exit(2), nil
		}
		return printer.Exit(0), nil
	case "prepare":
		result, err = Prepare(root, value("--request"), value("--work-dir"))
	case "submit":
		result, err = Submit(ctx, root, value("--work-dir"), value("--confirm"), args.Float("--timeout", 60))
	case "attach":
		result, err = Attach(root, value("--work-dir"), args.Values["--file"])
	case "not-created":
		result, err = NotCreated(root, value("--work-dir"))
	case "resume":
		result, err = Resume(ctx, root, value("--work-dir"), value("--generation-id"), args.Float("--wait-seconds", 0), args.Float("--interval", 15), args.Float("--timeout", 60))
	default:
		result, err = Status(root, value("--work-dir"))
	}
	if err != nil {
		return toolcli.Output{}, err
	}
	if err := printJSON(printer, result); err != nil {
		return toolcli.Output{}, err
	}
	return printer.Exit(0), nil
}

// printCapabilities — текстовый вывод capabilities: «команда: модели» и «команда: проблема».
func printCapabilities(printer *toolcli.Printer, report *toolrt.Dict) (toolcli.Output, error) {
	reports, err := item(report, "reports")
	if err != nil {
		return toolcli.Output{}, err
	}
	entries, err := toolrt.Iter(reports)
	if err != nil {
		return toolcli.Output{}, err
	}
	for _, entry := range entries {
		command, err := item(entry, "command")
		if err != nil {
			return toolcli.Output{}, err
		}
		models, err := item(entry, "models")
		if err != nil {
			return toolcli.Output{}, err
		}
		names, err := toolrt.Iter(models)
		if err != nil {
			return toolcli.Output{}, err
		}
		joined := ""
		for index, name := range names {
			text, ok := name.(string)
			if !ok {
				return toolcli.Output{}, toolrt.Raise(toolrt.TypeError, "элемент %d: ожидается строка, получено: %s", index, toolrt.TypeName(name))
			}
			if index > 0 {
				joined += ", "
			}
			joined += text
		}
		if joined == "" {
			joined = "—"
		}
		if err := printer.Print(toolrt.Str(command) + ": " + joined); err != nil {
			return toolcli.Output{}, err
		}
	}
	problems, err := item(report, "problems")
	if err != nil {
		return toolcli.Output{}, err
	}
	entries, err = toolrt.Iter(problems)
	if err != nil {
		return toolcli.Output{}, err
	}
	for _, entry := range entries {
		command, err := item(entry, "command")
		if err != nil {
			return toolcli.Output{}, err
		}
		message, err := item(entry, "message")
		if err != nil {
			return toolcli.Output{}, err
		}
		if err := printer.Print(toolrt.Str(command) + ": " + toolrt.Str(message)); err != nil {
			return toolcli.Output{}, err
		}
	}
	return printer.Exit(0), nil
}
