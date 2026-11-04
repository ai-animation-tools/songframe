// Package pytool — общий каркас CLI-инструментов, перенесённых с Python: результат процесса
// (код, stdout, stderr), print() с кодированием UTF-8 и завершение необработанным исключением
// или parser.exit. Инструменты выполняются в процессе приложения, но наружу отдают ровно то,
// что видел бы вызывающий процесс Python оригинала (renderer и журнал задания).
package pytool

import (
	"strings"

	"songframe-go/internal/pycompat"
)

// Output — результат запуска инструмента: код завершения и потоки, как у процесса Python.
type Output struct {
	Code   int
	Stdout string
	Stderr string
}

// Printer — sys.stdout инструмента: print() добавляет строку и перевод строки. Текст с
// одиночным суррогатом не кодируется в UTF-8: Print возвращает UnicodeEncodeError, а уже
// напечатанное раньше остаётся в выводе, как у буферизованного stdout Python.
type Printer struct {
	builder strings.Builder
}

// Print — print(text): текст и «\n».
func (p *Printer) Print(text string) error {
	if _, err := pycompat.EncodeUTF8(text); err != nil {
		return err
	}
	p.builder.WriteString(text + "\n")
	return nil
}

// String — всё напечатанное в текстовом режиме ОС.
func (p *Printer) String() string { return pycompat.TextMode(p.builder.String()) }

// Exit — завершение с кодом и уже напечатанным stdout.
func (p *Printer) Exit(code int) Output { return Output{Code: code, Stdout: p.String()} }

// Fail — parser.exit(1, message + "\n"): текст в stderr, код 1.
func (p *Printer) Fail(message string) Output {
	return Output{Code: 1, Stdout: p.String(), Stderr: pycompat.TextMode(message + "\n")}
}

// Crash — необработанное исключение: трассировка (заголовок и последняя строка «Тип: текст»)
// в stderr, код 1. Ошибка Go-окружения (не исключение Python) выводится текстом как есть.
func (p *Printer) Crash(err error) Output {
	if _, isPython := err.(*pycompat.Exception); !isPython {
		return Output{Code: 1, Stdout: p.String(), Stderr: pycompat.TextMode(err.Error() + "\n")}
	}
	return Output{Code: 1, Stdout: p.String(), Stderr: pycompat.TextMode(pycompat.Traceback(err))}
}

// Args — результат argparse либо готовое завершение (справка, ошибка аргументов).
func Args(parser pycompat.ArgParser, args []string) (pycompat.Args, *Output) {
	parsed, exit := parser.ParseArgs(args)
	if exit != nil {
		return pycompat.Args{}, &Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
	}
	return parsed, nil
}

// JSON — json.dumps(value, ensure_ascii=False, indent=2) для print().
func JSON(value any) (string, error) {
	return pycompat.DumpsJSON(value, pycompat.DumpOptions{Indent: 2, Pretty: true})
}

// Record — упорядоченный словарь из пар ключ-значение (литерал dict Python).
func Record(pairs ...any) *pycompat.Dict {
	result := pycompat.NewDict()
	for index := 0; index+1 < len(pairs); index += 2 {
		result.Set(pairs[index].(string), pairs[index+1])
	}
	return result
}

// Strings — список строк как список значений Python.
func Strings(items []string) []any {
	result := make([]any, len(items))
	for index, item := range items {
		result[index] = item
	}
	return result
}
