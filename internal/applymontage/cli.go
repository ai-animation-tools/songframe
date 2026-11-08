package applymontage

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Parser — разбор аргументов apply_montage. Группа --spec/--recover обязательна;
// toolrt.ArgParser знает только необязательные группы, поэтому обязательность и скобки usage
// проверяет Run.
var Parser = toolrt.ArgParser{
	Prog:        "apply_montage",
	Description: "Применяет явный ручной монтаж к принятым сценам; @link README.md.",
	Flags: []toolrt.Flag{
		{Name: "--spec", Value: true, Help: "MontageDraft JSON с относительными путями проекта"},
		{Name: "--recover", Help: "Только восстановить прерванную публикацию"},
		{Name: "--no-views", Help: "Не обновлять производные представления"},
	},
	Exclusive: []string{"--spec", "--recover"},
}

// usage — строка использования с обязательной группой в круглых скобках.
const usage = "использование: apply_montage [-h] (--spec SPEC | --recover) [--no-views]\n"

// help — текст справки --help.
const help = usage + `
Применяет явный ручной монтаж к принятым сценам; @link README.md.

параметры:
  -h, --help   показать справку и выйти
  --spec SPEC  MontageDraft JSON с относительными путями проекта
  --recover    Только восстановить прерванную публикацию
  --no-views   Не обновлять производные представления
`

// textHidden — текст CLI для всех ошибок, кроме точного ValueError: журнал транзакции остаётся
// в plan/montage-history, сырой вывод FFmpeg и пути ОС не показываются.
const textHidden = "Ошибка файлов монтажа или медиа; журнал в plan/montage-history."

// isAbsolute — абсолютен ли путь --spec по правилам ОС.
func isAbsolute(path string) bool { return filepath.IsAbs(path) }

// asException извлекает исключение toolrt из цепочки ошибок: по его точному типу Run отличает
// ValueError, который печатается своим текстом.
func asException(err error, target **toolrt.Exception) bool { return errors.As(err, target) }

func argError(message string) toolcli.Output {
	return toolcli.Output{Code: 2, Stderr: toolrt.TextMode(usage + "apply_montage: ошибка: " + message + "\n")}
}

// Run — инструмент apply_montage на разрешённом корне проекта: --recover откатывает прерванные
// публикации и печатает {"status": "recovered"}; --spec читает MontageDraft (относительный путь —
// от корня проекта) и применяет его. Точный ValueError печатается своим текстом, остальные
// ожидаемые ошибки — скрытым textHidden, прочие — необработанной ошибкой (toolcli.Printer.Crash).
func Run(ctx context.Context, root string, args []string) toolcli.Output {
	parsed, exit := Parser.ParseArgs(args)
	if exit != nil {
		if exit.Code == 0 {
			return toolcli.Output{Code: 0, Stdout: toolrt.TextMode(help)}
		}
		return toolcli.Output{Code: exit.Code, Stderr: toolrt.TextMode(strings.Replace(exit.Stderr, Parser.Usage(), usage, 1))}
	}
	spec, hasSpec := parsed.Values["--spec"]
	if !hasSpec && !parsed.Bools["--recover"] {
		return argError("нужен один из аргументов: --spec --recover")
	}
	printer := &toolcli.Printer{}
	result, err := func() (*toolrt.Dict, error) {
		if parsed.Bools["--recover"] {
			if err := Recover(root); err != nil {
				return nil, err
			}
			return toolcli.Record("status", "recovered"), nil
		}
		path := spec[0]
		if !isAbsolute(path) {
			path = join(root, path)
		}
		draft, err := toolrt.LoadJSONFile(path)
		if err != nil {
			return nil, err
		}
		return Apply(ctx, draft, root, !parsed.Bools["--no-views"])
	}()
	if err != nil {
		var exception *toolrt.Exception
		switch {
		case asException(err, &exception) && exception.Type == toolrt.ValueError:
			return printer.Fail(err.Error())
		case toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError, toolrt.TypeError, "StopIteration", "CalledProcessError"):
			return printer.Fail(textHidden)
		default:
			return printer.Crash(err)
		}
	}
	text, err := toolcli.JSON(result)
	if err != nil {
		return printer.Crash(err)
	}
	if err := printer.Print(text); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}
