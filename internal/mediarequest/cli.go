package mediarequest

import (
	"context"
	"errors"

	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/pyargparse"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// Parser — argparse media_request.py оригинала (описание — docstring модуля).
var Parser = pyargparse.Parser{
	Prog:        "media_request.py",
	Description: "Попытка генерации у выбранного провайдера: возможности, подготовка, отправка и получение; @link README.md",
	Dest:        "action",
	Commands: []pyargparse.Command{
		{Name: "capabilities", Options: []pyargparse.Option{
			{Name: "--provider", Required: true},
			{Name: "--kind", Required: true, Choices: []string{"image", "video"}},
			{Name: "--json", Flag: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "login", Options: []pyargparse.Option{
			{Name: "--provider", Required: true},
			{Name: "--no-browser", Flag: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "auth-status", Options: []pyargparse.Option{
			{Name: "--provider", Required: true},
			{Name: "--json", Flag: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "prepare", Options: []pyargparse.Option{
			{Name: "--request", Required: true},
			{Name: "--work-dir", Required: true},
		}},
		{Name: "watch", Options: []pyargparse.Option{
			{Name: "--work-dir", Required: true, Plus: true},
			{Name: "--max-minutes", Float: true},
			{Name: "--interval", Float: true},
			{Name: "--timeout", Float: true},
		}},
		{Name: "attach", Options: []pyargparse.Option{
			{Name: "--work-dir", Required: true},
			{Name: "--file", Required: true, Plus: true},
		}},
		{Name: "submit", Options: []pyargparse.Option{
			{Name: "--work-dir", Required: true},
			{Name: "--timeout", Float: true},
			{Name: "--confirm", Required: true},
		}},
		{Name: "resume", Options: []pyargparse.Option{
			{Name: "--work-dir", Required: true},
			{Name: "--timeout", Float: true},
			{Name: "--generation-id"},
			{Name: "--wait-seconds", Float: true},
			{Name: "--interval", Float: true},
		}},
		{Name: "status", Options: []pyargparse.Option{{Name: "--work-dir", Required: true}}},
		{Name: "not-created", Options: []pyargparse.Option{{Name: "--work-dir", Required: true}}},
	},
}

// ProjectFreeActions — действия без проекта (PROJECT_FREE_ACTIONS оригинала): вход к провайдеру
// выполняется со страницы «Среда» без выбранного клипа.
var ProjectFreeActions = map[string]bool{"login": true, "auth-status": true}

// textHidden — общий отказ: пути, ответы сервиса и сетевые ошибки могут содержать секреты.
const textHidden = "Ошибка локальных данных или файлов; сырой вывод скрыт."

// Run — main() media_request.py на проекте root: разбор аргументов, действие и вывод JSON.
// Ошибка — код 1 и одна строка в stderr: текст ValueError/NotSubmitted как есть, прочие
// ожидаемые отказы (KeyError, TypeError, OSError и подклассы ValueError) — общий текст без
// сырого вывода; неожиданное исключение — трассировка, как у Python. report получает строки
// watch по мере смены статусов (nil — только в stdout результата); строки попадают и в stdout.
func Run(ctx context.Context, root string, args []string, report func(string)) pytool.Output {
	parsed, exit := Parser.Parse(args)
	if exit != nil {
		return pytool.Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
	}
	printer := &pytool.Printer{}
	output, err := run(ctx, root, parsed, printer, report)
	if err != nil {
		if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
			return pytool.Output{Code: 1, Stdout: printer.String(), Stderr: pycompat.TextMode(err.Error() + "\n")}
		}
		return failure(printer, err)
	}
	return output
}

// failure — except (ValueError, KeyError, TypeError, OSError) оригинала.
func failure(printer *pytool.Printer, err error) pytool.Output {
	var exception *pycompat.Exception
	switch {
	case mediaapi.IsNotSubmitted(err):
		return printer.Fail(err.Error())
	case errors.As(err, &exception) && exception.Type == pycompat.ValueError:
		return printer.Fail(err.Error())
	case pycompat.IsAny(err, pycompat.ValueError, pycompat.KeyError, pycompat.TypeError, pycompat.OSError):
		return printer.Fail(textHidden)
	case errors.As(err, &exception):
		return printer.Crash(err)
	}
	// Ошибка Go вне модели Python (например, адаптера): сырой текст может содержать секреты.
	return printer.Fail(textHidden)
}

// printJSON — print(json.dumps(value, ensure_ascii=False, indent=2)).
func printJSON(printer *pytool.Printer, value any) error {
	text, err := pytool.JSON(value)
	if err != nil {
		return err
	}
	return printer.Print(text)
}

// adapterFunction — provider_function(provider, name): необязательная возможность адаптера.
func adapterFunction(provider string) (mediaadapters.Adapter, error) {
	return mediaadapters.Lookup(provider)
}

// run — тело try оригинала: действие и печать результата.
func run(ctx context.Context, root string, args pyargparse.Result, printer *pytool.Printer, report func(string)) (pytool.Output, error) {
	value := func(name string) string { text, _ := args.Value(name); return text }
	var result *pycompat.Dict
	var err error
	switch args.Action {
	case "capabilities":
		reportValue, err := Capabilities(ctx, value("--provider"), value("--kind"), args.Float("--timeout", 60))
		if err != nil {
			return pytool.Output{}, err
		}
		if args.Bools["--json"] {
			if err := printJSON(printer, reportValue); err != nil {
				return pytool.Output{}, err
			}
			return printer.Exit(0), nil
		}
		return printCapabilities(printer, reportValue)
	case "login":
		service, err := adapterFunction(value("--provider"))
		if err != nil {
			return pytool.Output{}, err
		}
		loginer, ok := service.(mediaapi.Loginer)
		if !ok {
			return pytool.Output{}, unsupported(value("--provider"))
		}
		answer := loginer.Login(ctx, mediaapi.LoginOptions{OpenBrowser: !args.Bools["--no-browser"], Timeout: mediaapi.Seconds(args.Float("--timeout", 300))})
		text, err := pycompat.DumpsJSON(pytool.Record("ok", answer.OK, "message", answer.Message), pycompat.DumpOptions{})
		if err != nil {
			return pytool.Output{}, err
		}
		if err := printer.Print(text); err != nil {
			return pytool.Output{}, err
		}
		if !answer.OK {
			return printer.Exit(1), nil
		}
		return printer.Exit(0), nil
	case "auth-status":
		service, err := adapterFunction(value("--provider"))
		if err != nil {
			return pytool.Output{}, err
		}
		reader, ok := service.(mediaapi.AuthStatusReader)
		if !ok {
			return pytool.Output{}, unsupported(value("--provider"))
		}
		answer := reader.AuthStatus(ctx, mediaapi.Seconds(args.Float("--timeout", 30)))
		text := answer.Status
		if args.Bools["--json"] {
			record := pytool.Record("status", answer.Status)
			if answer.Message != "" {
				record.Set("message", answer.Message)
			}
			if text, err = pycompat.DumpsJSON(record, pycompat.DumpOptions{}); err != nil {
				return pytool.Output{}, err
			}
		} else if answer.Message != "" {
			text = answer.Message
		}
		if err := printer.Print(text); err != nil {
			return pytool.Output{}, err
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
			return pytool.Output{}, err
		}
		document := pycompat.NewDict()
		unfinished := false
		for _, entry := range entries {
			document.Set(entry.Path, entry.State)
			status, _ := entry.State.Value("status").(string)
			unfinished = unfinished || !Terminal[status]
		}
		if err := printJSON(printer, document); err != nil {
			return pytool.Output{}, err
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
		return pytool.Output{}, err
	}
	if err := printJSON(printer, result); err != nil {
		return pytool.Output{}, err
	}
	return printer.Exit(0), nil
}

// printCapabilities — текстовый вывод capabilities: «команда: модели» и «команда: проблема».
func printCapabilities(printer *pytool.Printer, report *pycompat.Dict) (pytool.Output, error) {
	reports, err := item(report, "reports")
	if err != nil {
		return pytool.Output{}, err
	}
	entries, err := pycompat.Iter(reports)
	if err != nil {
		return pytool.Output{}, err
	}
	for _, entry := range entries {
		command, err := item(entry, "command")
		if err != nil {
			return pytool.Output{}, err
		}
		models, err := item(entry, "models")
		if err != nil {
			return pytool.Output{}, err
		}
		names, err := pycompat.Iter(models)
		if err != nil {
			return pytool.Output{}, err
		}
		joined := ""
		for index, name := range names {
			text, ok := name.(string)
			if !ok {
				return pytool.Output{}, pycompat.Raise(pycompat.TypeError, "sequence item %d: expected str instance, %s found", index, pycompat.TypeName(name))
			}
			if index > 0 {
				joined += ", "
			}
			joined += text
		}
		if joined == "" {
			joined = "—"
		}
		if err := printer.Print(pycompat.Str(command) + ": " + joined); err != nil {
			return pytool.Output{}, err
		}
	}
	problems, err := item(report, "problems")
	if err != nil {
		return pytool.Output{}, err
	}
	entries, err = pycompat.Iter(problems)
	if err != nil {
		return pytool.Output{}, err
	}
	for _, entry := range entries {
		command, err := item(entry, "command")
		if err != nil {
			return pytool.Output{}, err
		}
		message, err := item(entry, "message")
		if err != nil {
			return pytool.Output{}, err
		}
		if err := printer.Print(pycompat.Str(command) + ": " + pycompat.Str(message)); err != nil {
			return pytool.Output{}, err
		}
	}
	return printer.Exit(0), nil
}
