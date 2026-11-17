package scenescaffold

import (
	"fmt"
	"path/filepath"
	"strings"

	"songframe/internal/castregistry"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Output — результат запуска инструмента: код завершения и потоки (общий тип инструментов
// tools.run, toolcli.Output).
type Output = toolcli.Output

// Parser — разбор аргументов toolrt.ArgParser: имя программы, описание и флаги в порядке
// объявления (от них зависят строка usage и справка, зафиксированные эталонами).
var Parser = toolrt.ArgParser{
	Prog:        "scene_scaffold",
	Description: "Каркас планов по частям plan/scenes.json, разметке и кастингу; файлы не пишет.",
	Flags: []toolrt.Flag{
		{Name: "--json", Help: "Вывести весь каркас сценария JSON"},
	},
}

// failure — исход исключения. Исключения ValueError, OSError и KeyError основной части (caught)
// инструмент печатает одной строкой с кодом 1; остальные исключения и любые исключения записи и
// вывода (caught=false) завершают процесс необработанной ошибкой (toolrt.Unhandled) с кодом 1.
func failure(err error, caught bool) Output {
	if caught && toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError) {
		return Output{Code: 1, Stderr: toolrt.TextMode(err.Error() + "\n")}
	}
	if _, isToolError := err.(*toolrt.Exception); !isToolError {
		// Ошибка Go-окружения (шлюз записи и т.п.): текст как есть, код как у отказа инструмента.
		return Output{Code: 1, Stderr: toolrt.TextMode(err.Error() + "\n")}
	}
	return Output{Code: 1, Stderr: toolrt.TextMode(toolrt.Unhandled(err))}
}

// prepare — основная часть Run: чтение входов проекта и построение каркаса (её ValueError, OSError
// и KeyError печатаются текстом).
func prepare(root string) (*toolrt.Dict, error) {
	document, _ := toolrt.ReadJSON(filepath.Join(root, filepath.FromSlash(ScenesPath)))
	timingValue, _ := toolrt.ReadJSON(filepath.Join(root, filepath.FromSlash(TimingPath)))
	if _, ok := document.(*toolrt.Dict); !ok {
		return nil, toolrt.Raise(toolrt.ValueError, "Нет %s: сначала части сценария (первый проход сценария).", ScenesPath)
	}
	timing, ok := timingValue.(*toolrt.Dict)
	if !ok || !toolrt.Truthy(timing.Value("lines")) {
		return nil, toolrt.Raise(toolrt.ValueError, "Нет разметки %s: сначала этап таймингов.", TimingPath)
	}
	// Конец шкалы равен декодированной длительности: сборка аниматика сверяет звук с ней, а
	// длительность контейнера MP3 больше на долю секунды из-за заполнения последнего кадра.
	var durationValue any = toolrt.NewInt(0)
	for _, key := range []string{"duration_decoded", "duration_container"} {
		if value := timing.Value(key); toolrt.Truthy(value) {
			durationValue = value
			break
		}
	}
	duration, err := toolrt.Float(durationValue)
	if err != nil {
		return nil, err
	}
	if duration == 0 {
		return nil, toolrt.Raise(toolrt.ValueError, "В разметке нет длительности трека.")
	}
	textLines := []string{}
	if textPath := filepath.Join(root, filepath.FromSlash(TextPath)); toolrt.IsFile(textPath) {
		text, err := toolrt.ReadText(textPath)
		if err != nil {
			return nil, err
		}
		textLines = toolrt.SplitLines(text)
	}
	cast, err := castregistry.Load(root)
	if err != nil {
		return nil, err
	}
	if cast == nil {
		return nil, toolrt.Raise(toolrt.ValueError, "Нет plan/cast.json: создайте кастинг (cast_registry init или страница «Кастинг»).")
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	fps, err := sceneregistry.ProjectFPS(root)
	if err != nil {
		return nil, err
	}
	rate, _ := fps.Int64()
	return BuildScenes(document, timing, textLines, cast, duration, initial, rate)
}

// report — вывод в stdout после построения: --json — весь каркас, иначе таблица планов и итог.
func report(data *toolrt.Dict, asJSON bool) (string, error) {
	scenes := data.Value("scenes").([]any)
	sequences := data.Value("sequences").([]any)
	if asJSON {
		text, err := toolrt.DumpsJSON(data, toolrt.DumpOptions{})
		return text + "\n", err
	}
	var builder strings.Builder
	for _, item := range scenes {
		scene := item.(*toolrt.Dict)
		start, _ := scene.Value("start_frame").(toolrt.Int).Int64()
		end, _ := scene.Value("end_frame_exclusive").(toolrt.Int).Int64()
		fps := sceneregistry.FPS(data.Value("fps"))
		startSeconds, _ := trueDiv(start, fps)
		endSeconds, _ := trueDiv(end, fps)
		fmt.Fprintf(&builder, "%s %7.2f–%7.2f [%s] %s\n", scene.Value("id"), startSeconds, endSeconds,
			toolrt.Str(scene.Value("sequence")), scene.Value("original"))
	}
	fmt.Fprintf(&builder, "\nПланов: %d, частей: %d.\n", len(scenes), len(sequences))
	return builder.String(), nil
}

// Run — запуск инструмента на проекте root (путь уже разрешён вызывающим): разбор аргументов
// (--json, -h), построение каркаса и вывод; файлы проекта не меняются. Коды: 0 — успех или
// справка, 1 — отказ с текстом в stderr, 2 — ошибка аргументов.
func Run(root string, args []string) Output {
	flags, exit := Parser.Parse(args)
	if exit != nil {
		return Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	data, err := prepare(root)
	if err != nil {
		return failure(err, true)
	}
	stdout, err := report(data, flags["--json"])
	if err == nil {
		_, err = toolrt.EncodeUTF8(stdout)
	}
	if err != nil {
		return failure(err, false)
	}
	return Output{Code: 0, Stdout: toolrt.TextMode(stdout)}
}
