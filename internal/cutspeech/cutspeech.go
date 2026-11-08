// Package cutspeech вырезает точный WAV липсинка и его рецепт audio-recipe.json из исходной
// песни проекта (инструмент cut_speech).
//
// Действие cut находит план в реестре сцен, выбирает строки plan/audio/timing.json, пересекающие
// его окно, предлагает границы среза по ним (или берёт явные --start/--end), декодирует всю песню
// FFmpeg в PCM s16le 44,1 кГц стерео и вырезает участок по номерам сэмплов без фильтров. Рядом с
// speech.wav пишется рецепт: источник с SHA-256, интервал в секундах и сэмплах, параметры PCM,
// SHA-256 результата и строки разметки. Действие verify повторяет срез по рецепту в памяти и
// сверяет SHA-256, а при наличии сохранённого WAV — ещё и его PCM.
//
// Коды выхода, stdout, stderr, байты WAV (как у модуля wave Python) и JSON рецепта
// зафиксированы эталоном testdata/golden/cut-speech. Владельцы: файлы пишет только cut (в папку
// --out), песня и разметка только читаются; FFmpeg запускается через общий mediacmd с отменой по
// context.
//
// Отрицательное начало среза — отказ ValueError без записи: иначе срез отсчитывался бы от конца
// PCM и записал бы пустой или чужой участок.
package cutspeech

import (
	"context"
	"errors"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// Параметры PCM принятых рецептов и имена файлов результата.
const (
	sampleRate  = 44100
	channels    = 2
	sampleWidth = 2
	speechName  = "speech.wav"
	recipeName  = "audio-recipe.json"
	processing  = "Декодирование полного MP3 в PCM s16le, затем срез по номерам сэмплов; " +
		"без фильтров, нормализации и изменения скорости."
)

// Тексты отказов и описания инструмента.
const (
	textDescription   = "Точный WAV липсинка и его рецепт из исходной песни по разметке или заданным границам; @link README.md"
	textHidden        = "Ошибка файлов или аудио; сырой вывод скрыт."
	textNoLines       = "В окне плана нет строк разметки; задайте границы явно через --start и --end."
	textEmptyInterval = "Конец среза должен быть больше начала."
	textNegativeStart = "Начало среза не может быть меньше нуля."
	textTargetExists  = "Файл WAV уже существует; выберите другую папку или имя."
	textDecodeFailed  = "Не удалось декодировать песню: "
	textSourceMissing = "Исходная песня не найдена: "
	textConfirm       = "Границы строк — оценки разметки; подтвердите их на слух до генерации."
)

// Parser — разбор аргументов cut_speech: подкоманды cut и verify. Значения по умолчанию:
// --lead/--tail — float 0.5, --min-seconds — целое 0.
func Parser() *pycompat.Command {
	return &pycompat.Command{
		Prog:        "cut_speech.py",
		Description: textDescription,
		Dest:        "action",
		Subcommands: []*pycompat.Command{
			{Name: "cut", Actions: []pycompat.Action{
				{Name: "shot"},
				{Name: "--out", Required: true, Help: "Папка для speech.wav и audio-recipe.json"},
				{Name: "--start", Float: true, Help: "Начало среза, с; по умолчанию по разметке"},
				{Name: "--end", Float: true, Help: "Конец среза, с, исключительно"},
				{Name: "--lead", Float: true, Default: 0.5, Help: "Запас до первой строки при выборе по разметке"},
				{Name: "--tail", Float: true, Default: 0.5, Help: "Запас после последней строки"},
				{Name: "--min-seconds", Float: true, Default: pycompat.NewInt(0), Help: "Минимальная длина среза, например под длительность запроса"},
				{Name: "--json", Kind: pycompat.StoreTrue},
			}},
			{Name: "verify", Actions: []pycompat.Action{{Name: "recipe"}}},
		},
	}
}

// Run — инструмент cut_speech на корне проекта root (уже выбранном tools.Run). Ошибки ValueError
// (кроме JSONDecodeError) печатаются своим текстом, OSError, KeyError и битый JSON — общим
// текстом без сырого вывода, прочие исключения — трассировкой; везде код 1. verify без
// совпадения SHA и PCM завершается кодом 1 после печати отчёта. Отмена context останавливает
// FFmpeg; тогда результат — код 1 с текстом отмены (tools.RunContext заменит код на null).
func Run(ctx context.Context, root string, argv []string) pytool.Output {
	args, exit := Parser().ParseArgs(argv)
	if exit != nil {
		return pytool.Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
	}
	out := &pytool.Printer{}
	var stderr strings.Builder
	code, err := run(ctx, root, args, out, &stderr)
	switch {
	case err == nil:
	case ctx.Err() != nil:
		stderr.WriteString(err.Error() + "\n")
		code = 1
	case pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError):
		message := textHidden
		if pycompat.Is(err, pycompat.ValueError) && !pycompat.Is(err, pycompat.JSONDecodeError) {
			message = err.Error()
		}
		stderr.WriteString(message + "\n")
		code = 1
	default:
		var exception *pycompat.Exception
		if errors.As(err, &exception) {
			stderr.WriteString(pycompat.Traceback(err))
		} else {
			stderr.WriteString(err.Error() + "\n")
		}
		code = 1
	}
	return pytool.Output{Code: code, Stdout: out.String(), Stderr: pycompat.TextMode(stderr.String())}
}

// run выполняет действие: код выхода (1 — несовпадение verify) либо исключение.
func run(ctx context.Context, root string, args pycompat.Namespace, out *pytool.Printer, stderr *strings.Builder) (int, error) {
	if args["action"] == "verify" {
		recipePath := args["recipe"].(string)
		result, err := verify(ctx, root, recipePath)
		if err != nil {
			return 0, err
		}
		text, err := pytool.JSON(result)
		if err != nil {
			return 0, err
		}
		if err := out.Print(text); err != nil {
			return 0, err
		}
		if !pycompat.Truthy(result.Value("match")) && !pycompat.Truthy(result.Value("pcm_match")) {
			return 1, nil
		}
		return 0, nil
	}
	shot := args["shot"].(string)
	outDir := args["out"].(string)
	found, err := speechLines(root, shot)
	if err != nil {
		return 0, err
	}
	if !found.lipsync {
		stderr.WriteString("Предупреждение: у " + shot + " в реестре lipsync=false.\n")
	}
	start, end := args["start"], args["end"]
	if start == nil || end == nil {
		if start, end, err = propose(found.lines, args["lead"], args["tail"], args["min_seconds"]); err != nil {
			return 0, err
		}
	}
	recipe, err := cut(ctx, root, found.source, start, end, outDir, shot, found.lines)
	if err != nil {
		return 0, err
	}
	if args["json"] == true {
		text, err := pytool.JSON(recipe)
		if err != nil {
			return 0, err
		}
		return 0, out.Print(text)
	}
	return 0, printSummary(out, shot, outDir, found, recipe)
}

// printSummary — текстовый вывод cut: окно, срез, найденные строки с текстом и пометками и
// напоминание проверить границы на слух.
func printSummary(out *pytool.Printer, shot, outDir string, found speech, recipe *pycompat.Dict) error {
	interval := recipe.Value("source_interval_seconds").([]any)
	first := recipe.Value("start_sample").(pycompat.Int).Big()
	last := recipe.Value("end_sample_exclusive").(pycompat.Int).Big()
	count := pycompat.IntFromBig(last.Sub(last, first))
	output := recipe.Value("output").(*pycompat.Dict)
	line := shot + ": окно " + pycompat.FormatFixed(found.window[0], 3) + "–" + pycompat.FormatFixed(found.window[1], 3) +
		" с; срез " + pycompat.FormatFixed(interval[0].(float64), 3) + "–" + pycompat.FormatFixed(interval[1].(float64), 3) +
		" с (" + count.String() + " сэмплов), " + pycompat.Str(output.Value("path")) + " в " + outDir
	if err := out.Print(line); err != nil {
		return err
	}
	for _, item := range found.lines {
		text := "?"
		if value := item.Value("text"); pycompat.Truthy(value) {
			text = pycompat.Str(value)
		}
		note := ""
		if value := item.Value("note"); pycompat.Truthy(value) {
			note = pycompat.Str(value)
		}
		if err := out.Print("  строка " + pycompat.Str(item.Value("source_line")) + ": " + pycompat.Str(item.Value("start")) + "–" +
			pycompat.Str(item.Value("end")) + " с — " + text + "; " + note); err != nil {
			return err
		}
	}
	return out.Print(textConfirm)
}
