// Package exportbundle — перенос tools/export_edit_bundle/export_edit_bundle.py замороженного
// оригинала (634fd94): пакет для монтажёра из реестра сцен, манифестов комплектов и разметки песни.
//
// Инструмент создаёт в пустой папке таблицу планов shots.csv, строки песни lyrics.csv, EDL
// timeline.edl, FCPXML timeline.fcpxml, машиночитаемый bundle.json и README.md для монтажёра; с
// --copy кладёт в media/ побайтовые копии исходников и переписывает пути относительно пакета.
// Проект инструмент только читает: assets и реестр не меняются.
//
// Сохраняется результат оригинала байт в байт: float-repr в CSV и JSON, round(v, 6), `:g`,
// `:05.1f`, таймкоды Fraction + Decimal (28 значащих цифр, затем половина вверх), csv с окончаниями
// \r\n и QUOTE_MINIMAL, quoteattr, Path.as_uri, порядок ключей bundle.json, порядок записи файлов
// (отказ на середине оставляет уже записанное), тексты argparse и отказов: ValueError печатается,
// OSError, KeyError и JSONDecodeError скрываются общей фразой, прочие исключения — трассировка.
// Отличие от оригинала: пути копий в bundle.json и CSV на Windows пишутся через «/» (оригинал
// отдавал str(Path) с обратными слэшами, и пакет не переносился между ОС).
//
// Значения проекта остаются значениями pycompat: данные неожиданной формы дают то же исключение,
// что и в Python. Копирование идёт потоком и прерывается отменой задания.
package exportbundle

import (
	"context"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// Тексты оригинала: отказы и скрытая ошибка.
const (
	textOutsideProject = "Пакет собирается вне папки проекта или в plan/batches."
	textFolderNotEmpty = "Папка пакета должна быть пустой."
	textFileMissing    = "Файл не найден: "
	textHidden         = "Ошибка данных проекта; сырой вывод скрыт."
)

// parser — argparse оригинала. Опция --out в оригинале обязательная (required=True), а
// pycompat.ArgParser знает только необязательные опции: разница достраивается в parseArgs.
var parser = pycompat.ArgParser{
	Prog:        "export_edit_bundle.py",
	Description: "Пакет для монтажёра: таблица планов, EDL, FCPXML, строки песни и исходники; @link README.md",
	Flags: []pycompat.Flag{
		{Name: "--out", Value: true, Help: "Пустая папка вне папки проекта или внутри plan/batches"},
		{Name: "--copy", Help: "Скопировать оригиналы, клипы, кадры, промпты, WAV, карточки и песню в media/"},
	},
}

// optionalOut и requiredOut — запись опции в usage: у pycompat и у оригинала.
const (
	optionalOut = "[--out OUT]"
	requiredOut = "--out OUT"
)

// parseArgs — parse_args оригинала: разобранные аргументы либо готовое завершение (справка, код 2).
func parseArgs(args []string) (pycompat.Args, *pytool.Output) {
	parsed, exit := pytool.Args(parser, args)
	required := func() *pytool.Output {
		usage := strings.Replace(parser.Usage(), optionalOut, requiredOut, 1)
		message := usage + parser.Prog + ": error: the following arguments are required: --out\n"
		return &pytool.Output{Code: 2, Stderr: pycompat.TextMode(message)}
	}
	if exit != nil {
		// Обязательную опцию argparse проверяет раньше, чем сообщает о лишних аргументах.
		if exit.Code == 2 && strings.Contains(exit.Stderr, ": error: unrecognized arguments: ") && !namesOut(args) {
			return pycompat.Args{}, required()
		}
		exit.Stdout = strings.Replace(exit.Stdout, optionalOut, requiredOut, 1)
		exit.Stderr = strings.Replace(exit.Stderr, optionalOut, requiredOut, 1)
		return pycompat.Args{}, exit
	}
	if len(parsed.Values["--out"]) == 0 {
		return pycompat.Args{}, required()
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

// Run — main() инструмента на разрешённом корне проекта root. Контекст прерывает копирование
// медиа (остановка задания). Результат — код, stdout и stderr процесса оригинала; остановленный
// запуск завершается без текста, как процесс, снятый сигналом.
func Run(ctx context.Context, root string, args []string) pytool.Output {
	parsed, exit := parseArgs(args)
	if exit != nil {
		return *exit
	}
	values := parsed.Values["--out"]
	var printer pytool.Printer
	err := run(ctx, root, values[len(values)-1], parsed.Bools["--copy"], &printer)
	switch {
	case err == nil:
		return printer.Exit(0)
	case ctx.Err() != nil:
		return pytool.Output{Code: 1}
	case pycompat.Is(err, pycompat.ValueError) && !pycompat.Is(err, pycompat.JSONDecodeError):
		return printer.Fail(err.Error())
	case pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError):
		return printer.Fail(textHidden)
	}
	return printer.Crash(err)
}

// run — тело try оригинала: сборка пакета и печать сводки, которую разбирает страница проекта.
func run(ctx context.Context, root, out string, copyMedia bool, printer *pytool.Printer) error {
	summary, err := export(ctx, root, out, copyMedia)
	if err != nil {
		return err
	}
	text, err := pytool.JSON(summary)
	if err != nil {
		return err
	}
	return printer.Print(text)
}

// export — export(target, root, copy): проверка папки, сбор данных, копии и запись файлов пакета в
// порядке оригинала. Папка создаётся до чтения проекта, поэтому отказ по данным оставляет её пустой.
func export(ctx context.Context, root, out string, copyMedia bool) (*pycompat.Dict, error) {
	root = pycompat.ResolvePath(root)
	target := pycompat.ResolvePath(out)
	batches := pycompat.ResolvePath(pycompat.JoinPath(root, "plan/batches"))
	if pycompat.IsRelativeTo(target, root) && !pycompat.IsRelativeTo(target, batches) {
		return nil, pycompat.New(pycompat.ValueError, textOutsideProject)
	}
	if pycompat.Exists(target) {
		entries, err := pycompat.IterDir(target)
		if err != nil {
			return nil, err
		}
		if len(entries) > 0 {
			return nil, pycompat.New(pycompat.ValueError, textFolderNotEmpty)
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
	if pycompat.IsRelativeTo(target, root) {
		place.portable = root
	}
	if copyMedia {
		if copied, err = copyAll(ctx, bundle, root, target); err != nil {
			return nil, err
		}
		place.root, place.portable = target, target
	}
	if err := writeCSV(rowsOf(bundle), pycompat.JoinPath(target, "shots.csv"), shotColumns); err != nil {
		return nil, err
	}
	if err := writeCSV(listOf(bundle, "lyrics"), pycompat.JoinPath(target, "lyrics.csv"), lyricColumns); err != nil {
		return nil, err
	}
	if err := writeEDL(bundle, pycompat.JoinPath(target, "timeline.edl")); err != nil {
		return nil, err
	}
	if err := writeFCPXML(bundle, pycompat.JoinPath(target, "timeline.fcpxml"), place); err != nil {
		return nil, err
	}
	document, err := pytool.JSON(bundle)
	if err != nil {
		return nil, err
	}
	if err := writeText(pycompat.JoinPath(target, "bundle.json"), document+"\n"); err != nil {
		return nil, err
	}
	if err := writeText(pycompat.JoinPath(target, "README.md"), readme(bundle, copied)); err != nil {
		return nil, err
	}
	shots := rowsOf(bundle)
	return pytool.Record(
		"target", target,
		"shots", pycompat.NewInt(int64(len(shots))),
		"videos", pycompat.NewInt(int64(videoCount(shots))),
		"copied_files", pycompat.NewInt(int64(copied)),
	), nil
}

// rowsOf — строки планов пакета.
func rowsOf(bundle *pycompat.Dict) []*pycompat.Dict { return listOf(bundle, "shots") }

// listOf — список словарей пакета по ключу (shots, lyrics): collect кладёт туда только словари.
func listOf(bundle *pycompat.Dict, key string) []*pycompat.Dict {
	items, _ := bundle.Value(key).([]any)
	rows := make([]*pycompat.Dict, len(items))
	for index, item := range items {
		rows[index] = item.(*pycompat.Dict)
	}
	return rows
}

// videoCount — число планов с принятым видео.
func videoCount(rows []*pycompat.Dict) int {
	count := 0
	for _, row := range rows {
		if row.Value("status") == "video" {
			count++
		}
	}
	return count
}
