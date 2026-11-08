package scenescaffold

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"songframe/internal/castregistry"
	"songframe/internal/projectfs"
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
	Description: "Каркас plan/scenes.json из трактовки, разметки и кастинга.",
	Flags: []toolrt.Flag{
		{Name: "--force", Help: "Перезаписать существующий реестр сцен"},
		{Name: "--dry-run", Help: "Показать планы, файл не писать"},
		{Name: "--json"},
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

// prepare — основная часть Run: чтение входов проекта и построение реестра (её ValueError, OSError
// и KeyError печатаются текстом).
func prepare(root string, force, dryRun bool) (*toolrt.Dict, error) {
	treatment, _ := toolrt.ReadJSON(filepath.Join(root, filepath.FromSlash(TreatmentPath)))
	timingValue, _ := toolrt.ReadJSON(filepath.Join(root, filepath.FromSlash(TimingPath)))
	if _, ok := treatment.(*toolrt.Dict); !ok {
		return nil, toolrt.Raise(toolrt.ValueError, "Нет %s: сначала трактовка (первый проход сценария).", TreatmentPath)
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
	existingValue, _ := toolrt.ReadJSON(filepath.Join(root, filepath.FromSlash(ScenesPath)))
	existing, isDict := existingValue.(*toolrt.Dict)
	if isDict && !force && !dryRun {
		return nil, toolrt.Raise(toolrt.ValueError, "%s уже существует: добавьте --force, чтобы заменить его каркасом (постановка будет потеряна).", ScenesPath)
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	return BuildScenes(treatment, timing, textLines, cast, duration, existing, initial)
}

// write — запись plan/scenes.json: JSON с отступом два пробела, не-ASCII без экранирования, перевод
// строки в конце (toolrt.EncodeIndented). Замена
// атомарная и проходит шлюз записи проекта, права прежнего файла сохраняются, новый создаётся
// 0666 с umask. Строка, не кодируемая в UTF-8 (одиночный суррогат), отклоняется до записи, и
// прежний файл остаётся целым.
func write(root string, data *toolrt.Dict) error {
	encoded, err := toolrt.EncodeIndented(data)
	if err != nil {
		return err
	}
	if err := projectfs.CheckWrite(root); err != nil {
		return err
	}
	path := filepath.Join(root, filepath.FromSlash(ScenesPath))
	perm := os.FileMode(0o666)
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	if err := projectfs.WriteFile(path, []byte(toolrt.TextMode(string(encoded))), perm); err != nil {
		return err
	}
	return nil
}

// report — вывод в stdout после построения: --json — краткий отчёт (или весь каркас при
// --dry-run), иначе таблица планов и итог.
func report(data *toolrt.Dict, dryRun, asJSON bool) (string, error) {
	scenes := data.Value("scenes").([]any)
	sequences := data.Value("sequences").([]any)
	if asJSON {
		var result any = data
		if !dryRun {
			references := []any{}
			for _, key := range data.Value("references").(*toolrt.Dict).Keys() {
				references = append(references, key)
			}
			summary := toolrt.NewDict()
			summary.Set("written", true)
			summary.Set("scenes", toolrt.NewInt(int64(len(scenes))))
			summary.Set("sequences", toolrt.NewInt(int64(len(sequences))))
			summary.Set("references", references)
			result = summary
		}
		text, err := toolrt.DumpsJSON(result, toolrt.DumpOptions{})
		return text + "\n", err
	}
	var builder strings.Builder
	for _, item := range scenes {
		scene := item.(*toolrt.Dict)
		start, _ := scene.Value("start_frame").(toolrt.Int).Int64()
		end, _ := scene.Value("end_frame_exclusive").(toolrt.Int).Int64()
		startSeconds, _ := trueDiv(start, FPS)
		endSeconds, _ := trueDiv(end, FPS)
		fmt.Fprintf(&builder, "%s %7.2f–%7.2f [%s] %s\n", scene.Value("id"), startSeconds, endSeconds,
			toolrt.Str(scene.Value("sequence")), scene.Value("original"))
	}
	fmt.Fprintf(&builder, "\nПланов: %d, частей: %d.", len(scenes), len(sequences))
	if !dryRun {
		builder.WriteString(" Записано: " + ScenesPath)
	}
	builder.WriteString("\n")
	return builder.String(), nil
}

// Run — запуск инструмента на проекте root (путь уже разрешён вызывающим): разбор
// аргументов (--force, --dry-run, --json, -h), построение, запись plan/scenes.json (кроме
// --dry-run) и вывод. Коды: 0 — успех или справка, 1 — отказ с текстом в stderr, 2 — ошибка
// аргументов.
func Run(root string, args []string) Output {
	flags, exit := Parser.Parse(args)
	if exit != nil {
		return Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	force, dryRun, asJSON := flags["--force"], flags["--dry-run"], flags["--json"]
	data, err := prepare(root, force, dryRun)
	if err != nil {
		return failure(err, true)
	}
	if !dryRun {
		if err := write(root, data); err != nil {
			return failure(err, false)
		}
	}
	stdout, err := report(data, dryRun, asJSON)
	if err == nil {
		_, err = toolrt.EncodeUTF8(stdout)
	}
	if err != nil {
		return failure(err, false)
	}
	return Output{Code: 0, Stdout: toolrt.TextMode(stdout)}
}
