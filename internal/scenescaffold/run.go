package scenescaffold

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/castregistry"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// Output — результат запуска инструмента: код завершения и потоки (общий тип инструментов
// tools.run, pytool.Output).
type Output = pytool.Output

// Parser — разбор аргументов в семантике argparse: имя программы, описание и флаги в порядке
// объявления (от них зависят строка usage и справка, зафиксированные эталонами).
var Parser = pycompat.ArgParser{
	Prog:        "scene_scaffold.py",
	Description: "Каркас plan/scenes.json из трактовки, разметки и кастинга.",
	Flags: []pycompat.Flag{
		{Name: "--force", Help: "Перезаписать существующий реестр сцен"},
		{Name: "--dry-run", Help: "Показать планы, файл не писать"},
		{Name: "--json"},
	},
}

// failure — исход исключения. Внутри try main() (caught) ValueError, OSError и KeyError инструмент
// печатает текстом (parser.exit(1, f"{error}\n")); остальные исключения и любые исключения записи и
// вывода (вне try) завершают процесс трассировкой с кодом 1.
func failure(err error, caught bool) Output {
	if caught && pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError) {
		return Output{Code: 1, Stderr: pycompat.TextMode(err.Error() + "\n")}
	}
	if _, isPython := err.(*pycompat.Exception); !isPython {
		// Ошибка Go-окружения (шлюз записи и т.п.): текст как есть, код как у отказа инструмента.
		return Output{Code: 1, Stderr: pycompat.TextMode(err.Error() + "\n")}
	}
	return Output{Code: 1, Stderr: pycompat.TextMode(pycompat.Traceback(err))}
}

// prepare — тело try в main(): чтение входов проекта и построение реестра.
func prepare(root string, force, dryRun bool) (*pycompat.Dict, error) {
	treatment, _ := pycompat.ReadJSON(filepath.Join(root, filepath.FromSlash(TreatmentPath)))
	timingValue, _ := pycompat.ReadJSON(filepath.Join(root, filepath.FromSlash(TimingPath)))
	if _, ok := treatment.(*pycompat.Dict); !ok {
		return nil, pycompat.Raise(pycompat.ValueError, "Нет %s: сначала трактовка (первый проход сценария).", TreatmentPath)
	}
	timing, ok := timingValue.(*pycompat.Dict)
	if !ok || !pycompat.Truthy(timing.Value("lines")) {
		return nil, pycompat.Raise(pycompat.ValueError, "Нет разметки %s: сначала этап таймингов.", TimingPath)
	}
	// Конец шкалы равен декодированной длительности: сборка аниматика сверяет звук с ней, а
	// длительность контейнера MP3 больше на долю секунды из-за заполнения последнего кадра.
	var durationValue any = pycompat.NewInt(0)
	for _, key := range []string{"duration_decoded", "duration_container"} {
		if value := timing.Value(key); pycompat.Truthy(value) {
			durationValue = value
			break
		}
	}
	duration, err := pycompat.Float(durationValue)
	if err != nil {
		return nil, err
	}
	if duration == 0 {
		return nil, pycompat.Raise(pycompat.ValueError, "В разметке нет длительности трека.")
	}
	textLines := []string{}
	if textPath := filepath.Join(root, filepath.FromSlash(TextPath)); pycompat.IsFile(textPath) {
		text, err := pycompat.ReadText(textPath)
		if err != nil {
			return nil, err
		}
		textLines = pycompat.SplitLines(text)
	}
	cast, err := castregistry.Load(root)
	if err != nil {
		return nil, err
	}
	if cast == nil {
		return nil, pycompat.Raise(pycompat.ValueError, "Нет plan/cast.json: создайте кастинг (cast_registry init или страница «Кастинг»).")
	}
	existingValue, _ := pycompat.ReadJSON(filepath.Join(root, filepath.FromSlash(ScenesPath)))
	existing, isDict := existingValue.(*pycompat.Dict)
	if isDict && !force && !dryRun {
		return nil, pycompat.Raise(pycompat.ValueError, "%s уже существует: добавьте --force, чтобы заменить его каркасом (постановка будет потеряна).", ScenesPath)
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	return BuildScenes(treatment, timing, textLines, cast, duration, existing, initial)
}

// write — запись plan/scenes.json: json.dumps(indent=2, ensure_ascii=False) + "\n". Замена
// атомарная и проходит шлюз записи проекта, права прежнего файла сохраняются, новый создаётся
// 0666 с umask. Строка, не кодируемая в UTF-8 (одиночный суррогат), отклоняется до записи, и
// прежний файл остаётся целым.
func write(root string, data *pycompat.Dict) error {
	encoded, err := pycompat.EncodeIndented(data)
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
	if err := projectfs.WriteFile(path, []byte(pycompat.TextMode(string(encoded))), perm); err != nil {
		return err
	}
	return nil
}

// report — вывод в stdout после построения: --json — краткий отчёт (или весь каркас при
// --dry-run), иначе таблица планов и итог.
func report(data *pycompat.Dict, dryRun, asJSON bool) (string, error) {
	scenes := data.Value("scenes").([]any)
	sequences := data.Value("sequences").([]any)
	if asJSON {
		var result any = data
		if !dryRun {
			references := []any{}
			for _, key := range data.Value("references").(*pycompat.Dict).Keys() {
				references = append(references, key)
			}
			summary := pycompat.NewDict()
			summary.Set("written", true)
			summary.Set("scenes", pycompat.NewInt(int64(len(scenes))))
			summary.Set("sequences", pycompat.NewInt(int64(len(sequences))))
			summary.Set("references", references)
			result = summary
		}
		text, err := pycompat.DumpsJSON(result, pycompat.DumpOptions{})
		return text + "\n", err
	}
	var builder strings.Builder
	for _, item := range scenes {
		scene := item.(*pycompat.Dict)
		start, _ := scene.Value("start_frame").(pycompat.Int).Int64()
		end, _ := scene.Value("end_frame_exclusive").(pycompat.Int).Int64()
		startSeconds, _ := trueDiv(start, FPS)
		endSeconds, _ := trueDiv(end, FPS)
		fmt.Fprintf(&builder, "%s %7.2f–%7.2f [%s] %s\n", scene.Value("id"), startSeconds, endSeconds,
			pycompat.Str(scene.Value("sequence")), scene.Value("original"))
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
		return Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
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
		_, err = pycompat.EncodeUTF8(stdout)
	}
	if err != nil {
		return failure(err, false)
	}
	return Output{Code: 0, Stdout: pycompat.TextMode(stdout)}
}
