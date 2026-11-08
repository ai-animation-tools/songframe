package deriveshot

import (
	"context"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// textHidden — текст CLI для ошибок, кроме ValueError: журнал транзакции остаётся в проекте, сырой
// вывод FFmpeg и пути ОС не показываются.
const textHidden = "Ошибка файлов или медиа производного плана."

// Parser — argparse derive_shot.py: подкоманды build, accept и recover, у всех --json.
func Parser() *pycompat.Command {
	jsonFlag := pycompat.Action{Name: "--json", Kind: pycompat.StoreTrue}
	return &pycompat.Command{
		Prog:        "derive_shot.py",
		Description: "Локально собирает производный план и принимает подтверждённые байты; @link README.md.",
		Dest:        "command",
		Subcommands: []*pycompat.Command{
			{Name: "build", Actions: []pycompat.Action{
				{Name: "--shot", Required: true},
				{Name: "--recipe", Required: true},
				{Name: "--work-dir", Required: true},
				jsonFlag,
			}},
			{Name: "accept", Actions: []pycompat.Action{
				{Name: "--work-dir", Required: true},
				{Name: "--confirm", Required: true},
				{Name: "--replace", Kind: pycompat.StoreTrue},
				jsonFlag,
			}},
			{Name: "recover", Actions: []pycompat.Action{jsonFlag}},
		},
	}
}

// Run — main() derive_shot.py на корне проекта. ValueError печатается своим текстом, остальные
// ожидаемые ошибки — скрытым textHidden, прочие — трассировкой; --json превращает отказ в
// {"status": "error", "message": …} на stdout.
func Run(ctx context.Context, root string, argv []string) pytool.Output {
	args, exit := Parser().ParseArgs(argv)
	if exit != nil {
		return pytool.Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
	}
	root = pycompat.ResolvePath(root)
	defer enter(root)()
	printer := &pytool.Printer{}
	result, err := func() (*pycompat.Dict, error) {
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
		text, failure := pytool.JSON(result)
		if failure == nil {
			failure = printer.Print(text)
		}
		if failure == nil {
			return printer.Exit(0)
		}
		err = failure
	}
	if !pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError, pycompat.TypeError, "StopIteration", "CalledProcessError") {
		return printer.Crash(err)
	}
	message := textHidden
	if pycompat.Is(err, pycompat.ValueError) {
		message = err.Error()
	}
	if asJSON, _ := args["json"].(bool); !asJSON {
		return printer.Fail(message)
	}
	text, failure := pycompat.DumpsJSON(pytool.Record("status", "error", "message", message), pycompat.DumpOptions{})
	if failure == nil {
		failure = printer.Print(text)
	}
	if failure != nil {
		return printer.Crash(failure)
	}
	return printer.Exit(1)
}
