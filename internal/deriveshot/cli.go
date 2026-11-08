package deriveshot

import (
	"context"

	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// textHidden — текст CLI для ошибок, кроме ValueError: журнал транзакции остаётся в проекте, сырой
// вывод FFmpeg и пути ОС не показываются.
const textHidden = "Ошибка файлов или медиа производного плана."

// Parser — разбор аргументов derive_shot: подкоманды build, accept и recover, у всех --json.
func Parser() *toolrt.Command {
	jsonFlag := toolrt.Action{Name: "--json", Kind: toolrt.StoreTrue}
	return &toolrt.Command{
		Prog:        "derive_shot",
		Description: "Локально собирает производный план и принимает подтверждённые байты; @link README.md.",
		Dest:        "command",
		Subcommands: []*toolrt.Command{
			{Name: "build", Actions: []toolrt.Action{
				{Name: "--shot", Required: true},
				{Name: "--recipe", Required: true},
				{Name: "--work-dir", Required: true},
				jsonFlag,
			}},
			{Name: "accept", Actions: []toolrt.Action{
				{Name: "--work-dir", Required: true},
				{Name: "--confirm", Required: true},
				{Name: "--replace", Kind: toolrt.StoreTrue},
				jsonFlag,
			}},
			{Name: "recover", Actions: []toolrt.Action{jsonFlag}},
		},
	}
}

// Run — инструмент derive_shot на корне проекта. ValueError печатается своим текстом, остальные
// ожидаемые ошибки — скрытым textHidden, прочие — трассировкой; --json превращает отказ в
// {"status": "error", "message": …} на stdout.
func Run(ctx context.Context, root string, argv []string) toolcli.Output {
	args, exit := Parser().ParseArgs(argv)
	if exit != nil {
		return toolcli.Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	root = toolrt.ResolvePath(root)
	defer enter(root)()
	printer := &toolcli.Printer{}
	result, err := func() (*toolrt.Dict, error) {
		switch args["command"] {
		case "build":
			return build(ctx, args["shot"].(string), args["recipe"].(string), args["work_dir"].(string), root)
		case "accept":
			replace, _ := args["replace"].(bool)
			return accept(ctx, args["work_dir"].(string), args["confirm"].(string), replace, root)
		}
		return Recover(root)
	}()
	if err == nil {
		text, failure := toolcli.JSON(result)
		if failure == nil {
			failure = printer.Print(text)
		}
		if failure == nil {
			return printer.Exit(0)
		}
		err = failure
	}
	if !toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError, toolrt.TypeError, "StopIteration", "CalledProcessError") {
		return printer.Crash(err)
	}
	message := textHidden
	if toolrt.Is(err, toolrt.ValueError) {
		message = err.Error()
	}
	if asJSON, _ := args["json"].(bool); !asJSON {
		return printer.Fail(message)
	}
	text, failure := toolrt.DumpsJSON(toolcli.Record("status", "error", "message", message), toolrt.DumpOptions{})
	if failure == nil {
		failure = printer.Print(text)
	}
	if failure != nil {
		return printer.Crash(failure)
	}
	return printer.Exit(1)
}
