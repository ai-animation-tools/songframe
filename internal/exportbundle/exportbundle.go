// Package exportbundle собирает пакет для монтажёра из реестра сцен, манифестов комплектов и
// разметки песни (инструмент export_edit_bundle).
//
// Инструмент создаёт в пустой папке таблицу планов shots.csv, строки песни lyrics.csv, EDL
// timeline.edl, FCPXML timeline.fcpxml, машиночитаемый bundle.json и README.md для монтажёра; с
// --copy кладёт в media/ побайтовые копии исходников и переписывает пути относительно пакета.
// Проект инструмент только читает: assets и реестр не меняются.
//
// Эталон testdata/golden/export-edit-bundle фиксирует байты пакета: запись float (toolrt.FloatRepr)
// в CSV и JSON, округление до шести знаков, краткие и дополненные нулями записи чисел, таймкоды
// через точные дроби и десятичное деление (28 значащих цифр, затем половина вверх), CSV с
// окончаниями \r\n и кавычками только по необходимости, кавычки атрибутов XML, URI файлов,
// порядок ключей bundle.json, порядок записи файлов (отказ на середине оставляет уже
// записанное), тексты разбора аргументов и отказов: ValueError печатается, OSError, KeyError и
// JSONDecodeError скрываются общей фразой, прочие исключения — трассировка.
// Пути копий в bundle.json и CSV пишутся через «/» на любой ОС, чтобы пакет переносился между
// Linux и Windows.
//
// Значения проекта остаются значениями toolrt: данные неожиданной формы дают исключение toolrt
// с типом и текстом, зафиксированными эталоном. Копирование идёт потоком и прерывается отменой
// задания.
package exportbundle

import (
	"context"
	"strings"

	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Тексты отказов и скрытой ошибки.
const (
	textOutsideProject = "Пакет собирается вне папки проекта или в plan/batches."
	textFolderNotEmpty = "Папка пакета должна быть пустой."
	textFileMissing    = "Файл не найден: "
	textHidden         = "Ошибка данных проекта; сырой вывод скрыт."
)

// parser — разбор аргументов export_edit_bundle. Опция --out обязательна, а toolrt.ArgParser
// знает только необязательные опции: разница достраивается в parseArgs.
var parser = toolrt.ArgParser{
	Prog:        "export_edit_bundle",
	Description: "Пакет для монтажёра: таблица планов, EDL, FCPXML, строки песни и исходники; @link README.md",
	Flags: []toolrt.Flag{
		{Name: "--out", Value: true, Help: "Пустая папка вне папки проекта или внутри plan/batches"},
		{Name: "--copy", Help: "Скопировать оригиналы, клипы, кадры, промпты, WAV, карточки и песню в media/"},
	},
}

// optionalOut и requiredOut — запись опции в usage: как её пишет toolrt и как она выводится.
const (
	optionalOut = "[--out OUT]"
	requiredOut = "--out OUT"
)

// parseArgs — разобранные аргументы либо готовое завершение (справка, код 2).
func parseArgs(args []string) (toolrt.Args, *toolcli.Output) {
	parsed, exit := toolcli.Args(parser, args)
	required := func() *toolcli.Output {
		usage := strings.Replace(parser.Usage(), optionalOut, requiredOut, 1)
		message := usage + parser.Prog + ": error: the following arguments are required: --out\n"
		return &toolcli.Output{Code: 2, Stderr: toolrt.TextMode(message)}
	}
	if exit != nil {
		// Об отсутствии обязательной опции сообщается раньше, чем о лишних аргументах.
		if exit.Code == 2 && strings.Contains(exit.Stderr, ": error: unrecognized arguments: ") && !namesOut(args) {
			return toolrt.Args{}, required()
		}
		exit.Stdout = strings.Replace(exit.Stdout, optionalOut, requiredOut, 1)
		exit.Stderr = strings.Replace(exit.Stderr, optionalOut, requiredOut, 1)
		return toolrt.Args{}, exit
	}
	if len(parsed.Values["--out"]) == 0 {
		return toolrt.Args{}, required()
	}
	return parsed, nil
}

// namesOut — встречается ли среди аргументов (до «--») опция --out: полностью, с «=значением» или
// однозначным префиксом. Нужна только для порядка ошибок, когда разбор отказал лишними аргументами.
func namesOut(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			return false
		}
		name, _, _ := strings.Cut(arg, "=")
		if len(name) > 2 && strings.HasPrefix("--out", name) {
			return true
		}
	}
	return false
}

// Run — запуск инструмента на разрешённом корне проекта root. Контекст прерывает копирование
// медиа (остановка задания). Результат — код, stdout и stderr инструмента; остановленный
// запуск завершается без текста, как процесс, снятый сигналом.
func Run(ctx context.Context, root string, args []string) toolcli.Output {
	parsed, exit := parseArgs(args)
	if exit != nil {
		return *exit
	}
	values := parsed.Values["--out"]
	var printer toolcli.Printer
	err := run(ctx, root, values[len(values)-1], parsed.Bools["--copy"], &printer)
	switch {
	case err == nil:
		return printer.Exit(0)
	case ctx.Err() != nil:
		return toolcli.Output{Code: 1}
	case toolrt.Is(err, toolrt.ValueError) && !toolrt.Is(err, toolrt.JSONDecodeError):
		return printer.Fail(err.Error())
	case toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError):
		return printer.Fail(textHidden)
	}
	return printer.Crash(err)
}

// run — сборка пакета и печать сводки, которую разбирает страница проекта.
func run(ctx context.Context, root, out string, copyMedia bool, printer *toolcli.Printer) error {
	summary, err := export(ctx, root, out, copyMedia)
	if err != nil {
		return err
	}
	text, err := toolcli.JSON(summary)
	if err != nil {
		return err
	}
	return printer.Print(text)
}

// export проверяет папку, собирает данные, копирует медиа и записывает файлы пакета в порядке,
// зафиксированном эталоном. Папка создаётся до чтения проекта, поэтому отказ по данным оставляет
// её пустой.
func export(ctx context.Context, root, out string, copyMedia bool) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	target := toolrt.ResolvePath(out)
	batches := toolrt.ResolvePath(toolrt.JoinPath(root, "plan/batches"))
	if toolrt.IsRelativeTo(target, root) && !toolrt.IsRelativeTo(target, batches) {
		return nil, toolrt.New(toolrt.ValueError, textOutsideProject)
	}
	if toolrt.Exists(target) {
		entries, err := toolrt.IterDir(target)
		if err != nil {
			return nil, err
		}
		if len(entries) > 0 {
			return nil, toolrt.New(toolrt.ValueError, textFolderNotEmpty)
		}
	}
	if err := makeDirs(target); err != nil {
		return nil, err
	}
	bundle, err := collect(root)
	if err != nil {
		return nil, err
	}
	copied := 0
	place := mediaPlace{root: root, bundle: target}
	if toolrt.IsRelativeTo(target, root) {
		place.portable = root
	}
	if copyMedia {
		if copied, err = copyAll(ctx, bundle, root, target); err != nil {
			return nil, err
		}
		place.root, place.portable = target, target
	}
	if err := writeCSV(rowsOf(bundle), toolrt.JoinPath(target, "shots.csv"), shotColumns); err != nil {
		return nil, err
	}
	if err := writeCSV(listOf(bundle, "lyrics"), toolrt.JoinPath(target, "lyrics.csv"), lyricColumns); err != nil {
		return nil, err
	}
	if err := writeEDL(bundle, toolrt.JoinPath(target, "timeline.edl")); err != nil {
		return nil, err
	}
	if err := writeFCPXML(bundle, toolrt.JoinPath(target, "timeline.fcpxml"), place); err != nil {
		return nil, err
	}
	document, err := toolcli.JSON(bundle)
	if err != nil {
		return nil, err
	}
	if err := writeText(toolrt.JoinPath(target, "bundle.json"), document+"\n"); err != nil {
		return nil, err
	}
	if err := writeText(toolrt.JoinPath(target, "README.md"), readme(bundle, copied)); err != nil {
		return nil, err
	}
	shots := rowsOf(bundle)
	return toolcli.Record(
		"target", target,
		"shots", toolrt.NewInt(int64(len(shots))),
		"videos", toolrt.NewInt(int64(videoCount(shots))),
		"copied_files", toolrt.NewInt(int64(copied)),
	), nil
}

// rowsOf — строки планов пакета.
func rowsOf(bundle *toolrt.Dict) []*toolrt.Dict { return listOf(bundle, "shots") }

// listOf — список словарей пакета по ключу (shots, lyrics): collect кладёт туда только словари.
func listOf(bundle *toolrt.Dict, key string) []*toolrt.Dict {
	items, _ := bundle.Value(key).([]any)
	rows := make([]*toolrt.Dict, len(items))
	for index, item := range items {
		rows[index] = item.(*toolrt.Dict)
	}
	return rows
}

// videoCount — число планов с принятым видео.
func videoCount(rows []*toolrt.Dict) int {
	count := 0
	for _, row := range rows {
		if row.Value("status") == "video" {
			count++
		}
	}
	return count
}
