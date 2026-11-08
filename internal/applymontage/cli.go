package applymontage

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// Parser — разбор аргументов apply_montage. Группа --spec/--recover обязательна;
// pycompat.ArgParser знает только необязательные группы, поэтому обязательность и скобки usage
// проверяет Run.
var Parser = pycompat.ArgParser{
	Prog:        "apply_montage.py",
	Description: "Применяет явный ручной монтаж к принятым сценам; @link README.md.",
	Flags: []pycompat.Flag{
		{Name: "--spec", Value: true, Help: "MontageDraft JSON с относительными путями проекта"},
		{Name: "--recover", Help: "Только восстановить прерванную публикацию"},
		{Name: "--no-views", Help: "Не обновлять производные представления"},
	},
	Exclusive: []string{"--spec", "--recover"},
}

// usage — строка использования с обязательной группой в круглых скобках.
const usage = "usage: apply_montage.py [-h] (--spec SPEC | --recover) [--no-views]\n"

// help — текст справки --help.
const help = usage + `
Применяет явный ручной монтаж к принятым сценам; @link README.md.

options:
  -h, --help   show this help message and exit
  --spec SPEC  MontageDraft JSON с относительными путями проекта
  --recover    Только восстановить прерванную публикацию
  --no-views   Не обновлять производные представления
`

// textHidden — текст CLI для всех ошибок, кроме точного ValueError: журнал транзакции остаётся
// в plan/montage-history, сырой вывод FFmpeg и пути ОС не показываются.
const textHidden = "Ошибка файлов монтажа или медиа; журнал в plan/montage-history."

// isAbsolute — Path.is_absolute() для пути --spec.
func isAbsolute(path string) bool { return filepath.IsAbs(path) }

// asException — errors.As для исключения Python (точный тип для `type(error) is ValueError`).
func asException(err error, target **pycompat.Exception) bool { return errors.As(err, target) }

func argError(message string) pytool.Output {
	return pytool.Output{Code: 2, Stderr: pycompat.TextMode(usage + "apply_montage.py: error: " + message + "\n")}
}

// Run — инструмент apply_montage на разрешённом корне проекта: --recover откатывает прерванные
// публикации и печатает {"status": "recovered"}; --spec читает MontageDraft (относительный путь —
// от корня проекта) и применяет его. Точный ValueError печатается своим текстом, остальные
// ожидаемые ошибки — скрытым textHidden, прочие — трассировкой.
func Run(ctx context.Context, root string, args []string) pytool.Output {
	parsed, exit := Parser.ParseArgs(args)
	if exit != nil {
		if exit.Code == 0 {
			return pytool.Output{Code: 0, Stdout: pycompat.TextMode(help)}
		}
		return pytool.Output{Code: exit.Code, Stderr: pycompat.TextMode(strings.Replace(exit.Stderr, Parser.Usage(), usage, 1))}
	}
	spec, hasSpec := parsed.Values["--spec"]
	if !hasSpec && !parsed.Bools["--recover"] {
		return argError("one of the arguments --spec --recover is required")
	}
	printer := &pytool.Printer{}
	result, err := func() (*pycompat.Dict, error) {
		if parsed.Bools["--recover"] {
			if err := Recover(root); err != nil {
				return nil, err
			}
			return pytool.Record("status", "recovered"), nil
		}
		path := spec[0]
		if !isAbsolute(path) {
			path = join(root, path)
		}
		draft, err := pycompat.LoadJSONFile(path)
		if err != nil {
			return nil, err
		}
		return Apply(ctx, draft, root, !parsed.Bools["--no-views"])
	}()
	if err != nil {
		var exception *pycompat.Exception
		switch {
		case asException(err, &exception) && exception.Type == pycompat.ValueError:
			return printer.Fail(err.Error())
		case pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError, pycompat.TypeError, "StopIteration", "CalledProcessError"):
			return printer.Fail(textHidden)
		default:
			return printer.Crash(err)
		}
	}
	text, err := pytool.JSON(result)
	if err != nil {
		return printer.Crash(err)
	}
	if err := printer.Print(text); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}
