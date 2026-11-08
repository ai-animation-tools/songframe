// Package toolcli — общий каркас CLI-инструментов: результат запуска (код, stdout, stderr),
// печать строк со строгим кодированием UTF-8, завершение ошибкой аргументов, сообщением или
// необработанным исключением. Инструменты выполняются в процессе приложения, но наружу (renderer
// и журнал задания) отдают вывод отдельного процесса — тексты, коды и переводы строк
// зафиксированы эталонами.
package toolcli

import (
	"strings"

	"songframe/internal/toolrt"
)

// Output — результат запуска инструмента: код завершения и тексты потоков stdout и stderr.
type Output struct {
	Code   int
	Stdout string
	Stderr string
}

// Printer — stdout инструмента: Print добавляет строку и перевод строки. Текст с одиночным
// суррогатом не кодируется в UTF-8: Print возвращает UnicodeEncodeError и ничего не добавляет, а
// уже напечатанное раньше остаётся в выводе.
type Printer struct {
	builder strings.Builder
}

// Print — печать строки: текст и «\n».
func (p *Printer) Print(text string) error {
	if _, err := toolrt.EncodeUTF8(text); err != nil {
		return err
	}
	p.builder.WriteString(text + "\n")
	return nil
}

// String — всё напечатанное в текстовом режиме ОС.
func (p *Printer) String() string { return toolrt.TextMode(p.builder.String()) }

// Exit — завершение с кодом и уже напечатанным stdout.
func (p *Printer) Exit(code int) Output { return Output{Code: code, Stdout: p.String()} }

// Fail — завершение сообщением: текст и перевод строки в stderr, код 1.
func (p *Printer) Fail(message string) Output {
	return Output{Code: 1, Stdout: p.String(), Stderr: toolrt.TextMode(message + "\n")}
}

// Crash — необработанное исключение: трассировка (заголовок и последняя строка «Тип: текст»)
// в stderr, код 1. Ошибка Go-окружения (не *toolrt.Exception) выводится текстом как есть.
func (p *Printer) Crash(err error) Output {
	if _, isException := err.(*toolrt.Exception); !isException {
		return Output{Code: 1, Stdout: p.String(), Stderr: toolrt.TextMode(err.Error() + "\n")}
	}
	return Output{Code: 1, Stdout: p.String(), Stderr: toolrt.TextMode(toolrt.Traceback(err))}
}

// Args — разобранные аргументы либо готовое завершение (справка, ошибка аргументов).
func Args(parser toolrt.ArgParser, args []string) (toolrt.Args, *Output) {
	parsed, exit := parser.ParseArgs(args)
	if exit != nil {
		return toolrt.Args{}, &Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	return parsed, nil
}

// JSON — значение для печати в формате JSON-файлов инструментов (отступ 2, символы вне ASCII
// как есть), без завершающего перевода строки.
func JSON(value any) (string, error) {
	return toolrt.DumpsJSON(value, toolrt.DumpOptions{Indent: 2, Pretty: true})
}

// Record — словарь из пар ключ-значение в порядке перечисления.
func Record(pairs ...any) *toolrt.Dict {
	result := toolrt.NewDict()
	for index := 0; index+1 < len(pairs); index += 2 {
		result.Set(pairs[index].(string), pairs[index+1])
	}
	return result
}

// Strings — список строк как список значений модели toolrt.
func Strings(items []string) []any {
	result := make([]any, len(items))
	for index, item := range items {
		result[index] = item
	}
	return result
}
