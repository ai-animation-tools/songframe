// Package verifyassetreplay проверяет воспроизведение всех принятых комплектов планов из индекса
// assets/shots/manifest.json (инструмент verify_asset_replay).
//
// Для каждого плана комплект проверяется ValidatePackage, принятый монтаж копируется
// (assetpackage.Replay) и заново собирается из оригинала генерации; у пересобранного файла
// ffprobe сверяет число кадров, частоту проекта и 1920×1080, а три кадра (первый, средний, последний)
// сравниваются с принятым монтажом по RMS яркости и цветности (YUV 320×180) — порог 12. Отчёт JSON
// пишется вне папки проекта. Проект инструмент не меняет: копии и пересборки лежат во временной
// папке «accepted-replay-*», удаляемой по завершении.
//
// Коды выхода, stdout и строка необработанной ошибки в stderr зафиксированы эталоном
// testdata/golden/verify-asset-replay. Планы проверяются двумя параллельными работниками, но
// строки о них печатаются в порядке индекса, чтобы вывод был детерминированным.
package verifyassetreplay

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"songframe/internal/sceneregistry"
	"sort"
	"strconv"
	"strings"
	"sync"

	"songframe/internal/assetpackage"
	"songframe/internal/process"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// FFmpeg и FFprobe — программы проверки. По умолчанию голое имя, которое общий запуск процессов
// ищет в PATH; приложение может подставить пути установленных компонентов до вызова.
var (
	FFmpeg  = "ffmpeg"
	FFprobe = "ffprobe"
)

// Тексты справки, отказов и отчёта; зафиксированы эталоном.
const (
	textDescription  = "Проверяет воспроизведение принятых комплектов; @link README.md"
	textReportInside = "Отчёт проверки нужно сохранить вне папки проекта."
	textRunFailed    = "Ошибка технической проверки воспроизведения."
	textDone         = "Проверка всех принятых комплектов завершена."
	textNote         = "Проверены все хеши, точное копирование, повтор фильтров, размер и длина; " +
		"визуальное сравнение ограничено тремя кадрами каждого плана."
	// assertionError — тип исключения отказа сверки; без текста оно печатается как «Ошибка: внутренняя
	// проверка не прошла» (toolrt.Unhandled).
	assertionError = "AssertionError"
	// rmsLimit — допустимая разница повторного H.264: проверяются кадровые границы и
	// преобразования, а не новая художественная приёмка.
	rmsLimit = 12
	// workers — число параллельных проверок планов: каждый ffmpeg и так берёт 2 потока.
	workers = 2
	// outputLimit — сколько stdout программы хранить: rawvideo трёх кадров 320×180 yuv420p —
	// около 260 КБ, JSON ffprobe — меньше килобайта.
	outputLimit = 64 << 20
)

// Parser — аргументы инструмента (toolrt.Command): обязательный --report и необязательный --preserved.
func Parser() *toolrt.Command {
	return &toolrt.Command{
		Name:        "verify_asset_replay",
		Prog:        "verify_asset_replay",
		Description: textDescription,
		Actions: []toolrt.Action{
			{Name: "--report", Kind: toolrt.StoreValue, Required: true},
			{Name: "--preserved", Kind: toolrt.StoreValue},
		},
	}
}

// outcome — результат проверки одного плана: запись отчёта (result), отказ проверки
// (AssertionError или ValueError — failure) либо необработанное исключение (err).
type outcome struct {
	result  *toolrt.Dict
	failure error
	err     error
}

// Run — инструмент verify_asset_replay на корне проекта root (уже выбранном tools.Run).
func Run(root string, argv []string) toolcli.Output {
	args, exit := Parser().ParseArgs(argv)
	if exit != nil {
		return toolcli.Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	out := &toolcli.Printer{}
	if err := run(context.Background(), root, args, out); err != nil {
		return out.Crash(err)
	}
	return out.Exit(0)
}

// run — работа Run: любая возвращённая ошибка — необработанная ошибка (toolrt.Unhandled, код 1).
func run(ctx context.Context, root string, args toolrt.Namespace, out *toolcli.Printer) error {
	report := toolrt.ResolvePath(args["report"].(string))
	if toolrt.IsRelativeTo(report, root) {
		return toolrt.New(toolrt.ValueError, textReportInside)
	}
	registry, err := toolrt.LoadJSONFile(filepath.Join(root, "assets/shots/manifest.json"))
	if err != nil {
		return err
	}
	shotsValue, err := toolrt.Item(registry, "shots")
	if err != nil {
		return err
	}
	shots, err := toolrt.Iter(shotsValue)
	if err != nil {
		return err
	}
	temporary, err := os.MkdirTemp("", "accepted-replay-")
	if err != nil {
		return toolrt.OSErrorFrom(err, os.TempDir())
	}
	defer os.RemoveAll(temporary)

	outcomes := verifyAll(ctx, root, shots, temporary)
	results := []*toolrt.Dict{}
	failures := []any{}
	for index, item := range outcomes {
		sid := toolrt.Str(shots[index])
		switch {
		case item.err != nil:
			return item.err
		case item.failure != nil:
			failures = append(failures, toolcli.Record("shot", shots[index], "error", item.failure.Error()))
			if err := out.Print(sid + " проверка не пройдена"); err != nil {
				return err
			}
		default:
			results = append(results, item.result)
			rms := item.result.Value("sampled_yuv_rms").(float64)
			if err := out.Print(sid + " воспроизведён RMS=" + toolrt.FormatFixed(rms, 3)); err != nil {
				return err
			}
		}
	}

	var preserved any
	if path, ok := args["preserved"].(string); ok {
		count, err := checkPreserved(root, path)
		if err != nil {
			return err
		}
		preserved = toolrt.NewInt(int64(count))
	}
	if err := sortShots(results); err != nil {
		return err
	}
	status := "passed"
	if len(failures) > 0 {
		status = "failed"
	}
	shotList := make([]any, len(results))
	for index, result := range results {
		shotList[index] = result
	}
	data, err := toolrt.EncodeIndented(toolcli.Record(
		"status", status,
		"failures", failures,
		"shots", shotList,
		"preserved_media_checked", preserved,
		"animatic_rebuilt", false,
		"note", textNote,
	))
	if err != nil {
		return err
	}
	// Отчёт лежит вне проекта и не является проектным JSON: обычная запись без атомарной замены.
	if err := os.WriteFile(report, data, 0o666); err != nil {
		return toolrt.OSErrorFrom(err, report)
	}
	if len(failures) > 0 {
		return toolrt.New(assertionError, toolrt.Repr(failures))
	}
	return out.Print(textDone)
}

// verifyAll проверяет планы workers параллельными работниками и возвращает исходы в порядке
// индекса. Каждый план пишет только свои файлы «<sid>-copy.mp4» и «<sid>-rebuilt.mp4».
func verifyAll(ctx context.Context, root string, shots []any, temporary string) []outcome {
	outcomes := make([]outcome, len(shots))
	jobs := make(chan int)
	var group sync.WaitGroup
	for range workers {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range jobs {
				result, err := verify(ctx, root, shots[index], temporary)
				switch {
				case err == nil:
					outcomes[index] = outcome{result: result}
				case toolrt.IsAny(err, assertionError, toolrt.ValueError):
					outcomes[index] = outcome{failure: err}
				default:
					outcomes[index] = outcome{err: err}
				}
			}
		}()
	}
	for index := range shots {
		jobs <- index
	}
	close(jobs)
	group.Wait()
	return outcomes
}

// verify — копия и пересборка принятого монтажа плана sid, сверка параметров потока и трёх
// кадров. Отказы — AssertionError/ValueError с фиксированными текстами.
func verify(ctx context.Context, root string, shot any, temporary string) (*toolrt.Dict, error) {
	sid, ok := shot.(string)
	if !ok {
		return nil, toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(shot))
	}
	path := filepath.Join(root, "assets/shots", sid, "manifest.json")
	pack, err := assetpackage.ValidatePackage(path, sid, root)
	if err != nil {
		return nil, err
	}
	edit, err := toolrt.Item(pack, "accepted_edit")
	if err != nil {
		return nil, err
	}
	copied := filepath.Join(temporary, sid+"-copy.mp4")
	rendered := filepath.Join(temporary, sid+"-rebuilt.mp4")
	if err := assetpackage.Replay(ctx, path, copied, false, root, FFmpeg); err != nil {
		return nil, err
	}
	video, err := toolrt.Item(edit, "video")
	if err != nil {
		return nil, err
	}
	digest, err := assetpackage.FileSHA256(copied)
	if err != nil {
		return nil, err
	}
	expectedDigest, err := toolrt.Item(video, "sha256")
	if err != nil {
		return nil, err
	}
	if !toolrt.Equal(digest, expectedDigest) {
		return nil, toolrt.New(assertionError, "")
	}
	if err := assetpackage.Replay(ctx, path, rendered, true, root, FFmpeg); err != nil {
		return nil, err
	}
	meta, err := probe(ctx, rendered)
	if err != nil {
		return nil, err
	}
	frames, err := toolrt.Item(edit, "frames")
	if err != nil {
		return nil, err
	}
	// Частота пересборки — частота принятого монтажа (она равна частоте проекта, это проверяет
	// ValidatePackage вместе с реестром).
	fps := sceneregistry.FPS(edit.(*toolrt.Dict).Value("fps"))
	if err := checkMeta(sid, meta, frames, fps); err != nil {
		return nil, err
	}
	count, ok := frames.(toolrt.Int)
	if !ok {
		return nil, toolrt.Raise(toolrt.TypeError, "операция «//» неприменима: %s и целое число", toolrt.TypeName(frames))
	}
	total, ok := count.Int64()
	if !ok {
		return nil, toolrt.New(toolrt.OverflowError, "слишком большое число")
	}
	indices := sampleIndices(total)
	name, err := toolrt.Item(video, "path")
	if err != nil {
		return nil, err
	}
	original := filepath.Join(filepath.Dir(path), toolrt.Str(name))
	a, err := sample(ctx, original, indices)
	if err != nil {
		return nil, err
	}
	b, err := sample(ctx, rendered, indices)
	if err != nil {
		return nil, err
	}
	if len(a) != len(b) || len(a) == 0 {
		return nil, toolrt.New(assertionError, sid)
	}
	rms := difference(a, b)
	if !(rms < rmsLimit) {
		return nil, toolrt.New(assertionError, "("+toolrt.Repr(sid)+", "+toolrt.Repr(rms)+")")
	}
	sampled := make([]any, len(indices))
	for index, value := range indices {
		sampled[index] = toolrt.NewInt(value)
	}
	return toolcli.Record(
		"shot", sid,
		"accepted_copy_sha256_matches", true,
		"rebuild_frames", frames,
		"resolution", []any{toolrt.NewInt(1920), toolrt.NewInt(1080)},
		"fps", toolrt.NewInt(fps),
		"sampled_frame_indices", sampled,
		"sampled_yuv_rms", rms,
	), nil
}

// checkMeta — сверка nb_frames (целое или строка с целым), r_frame_rate, width и height потока с
// (frames, "<fps>/1", 1920, 1080); текст отказа — repr пары (sid, meta) с полным словарём потока.
func checkMeta(sid string, meta, frames any, fps int64) error {
	values := make([]any, 4)
	for index, key := range []string{"nb_frames", "r_frame_rate", "width", "height"} {
		value, err := toolrt.Item(meta, key)
		if err != nil {
			return err
		}
		values[index] = value
	}
	switch number := values[0].(type) {
	case string:
		parsed, ok := toolrt.ParseIntText(number)
		if !ok {
			return toolrt.New(toolrt.ValueError, "не целое число: "+toolrt.Repr(number))
		}
		values[0] = parsed
	case toolrt.Int:
	default:
		return toolrt.Raise(toolrt.TypeError, "ожидается число или строка, получено: %s", toolrt.TypeName(number))
	}
	expected := []any{frames, strconv.FormatInt(fps, 10) + "/1", toolrt.NewInt(1920), toolrt.NewInt(1080)}
	for index := range values {
		if !toolrt.Equal(values[index], expected[index]) {
			return toolrt.New(assertionError, "("+toolrt.Repr(sid)+", "+toolrt.Repr(meta)+")")
		}
	}
	return nil
}

// sampleIndices — различные номера кадров 0, frames/2 (деление с округлением вниз) и frames−1 по возрастанию.
func sampleIndices(frames int64) []int64 {
	half := frames / 2
	if frames < 0 && frames%2 != 0 {
		half--
	}
	set := map[int64]bool{0: true, half: true, frames - 1: true}
	result := make([]int64, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

// difference — корень среднего квадрата разницы байтов a и b (длины равны). Сумма целая и
// точная, деление на длину — одно округление, math.Sqrt корректно округлён, поэтому значение
// воспроизводимо до бита.
func difference(a, b []byte) float64 {
	var sum int64
	for index := range a {
		delta := int64(a[index]) - int64(b[index])
		sum += delta * delta
	}
	return math.Sqrt(float64(sum) / float64(len(a)))
}

// execute запускает программу и возвращает её stdout; ненулевой код — ValueError,
// незапустившаяся программа — FileNotFoundError.
func execute(ctx context.Context, program string, args []string) ([]byte, error) {
	result, err := process.Run(ctx, process.Command{Path: program, Args: args, StdoutLimit: outputLimit})
	if err != nil {
		if _, ok := err.(*process.StartError); ok {
			return nil, assetpackage.NotFound(program)
		}
		return nil, toolrt.New(toolrt.ValueError, textRunFailed)
	}
	return result.Stdout, nil
}

// probe — JSON ffprobe первого видеопотока: ширина, высота, число кадров, частота, длительность.
func probe(ctx context.Context, path string) (any, error) {
	data, err := execute(ctx, FFprobe, []string{"-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height,nb_frames,r_frame_rate,duration", "-of", "json", path})
	if err != nil {
		return nil, err
	}
	text, err := toolrt.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	parsed, err := toolrt.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	streams, err := toolrt.Item(parsed, "streams")
	if err != nil {
		return nil, err
	}
	return toolrt.GetItem(streams, toolrt.NewInt(0))
}

// sample — кадры indices файла path, уменьшенные до 320×180, сырыми байтами yuv420p.
func sample(ctx context.Context, path string, indices []int64) ([]byte, error) {
	parts := make([]string, len(indices))
	for index, value := range indices {
		parts[index] = "eq(n\\," + toolrt.NewInt(value).String() + ")"
	}
	return execute(ctx, FFmpeg, []string{"-v", "error", "-threads", "2", "-i", path,
		"-vf", "select=" + strings.Join(parts, "+") + ",scale=320:180", "-fps_mode", "vfr",
		"-pix_fmt", "yuv420p", "-f", "rawvideo", "-"})
}

// checkPreserved — проверка снимка --preserved: все файлы snapshot["media"] (пути от корня
// проекта) сохранили SHA-256. Несовпадение — AssertionError без текста, ошибки чтения — исключения.
func checkPreserved(root, path string) (int, error) {
	snapshot, err := toolrt.LoadJSONFile(toolrt.ResolvePath(path))
	if err != nil {
		return 0, err
	}
	media, err := toolrt.Item(snapshot, "media")
	if err != nil {
		return 0, err
	}
	dict, ok := media.(*toolrt.Dict)
	if !ok {
		return 0, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(media))
	}
	for _, name := range dict.Keys() {
		digest, err := assetpackage.FileSHA256(filepath.Join(root, name))
		if err != nil {
			return 0, err
		}
		if !toolrt.Equal(digest, dict.Value(name)) {
			return 0, toolrt.New(assertionError, "")
		}
	}
	return dict.Len(), nil
}

// sortShots — устойчивая сортировка по
// числу после первой буквы кода плана.
func sortShots(results []*toolrt.Dict) error {
	keys := make([]float64, len(results))
	for index, result := range results {
		runes := []rune(result.Value("shot").(string))
		if len(runes) > 0 {
			runes = runes[1:]
		}
		key, err := toolrt.FloatFromString(string(runes))
		if err != nil {
			return err
		}
		keys[index] = key
	}
	order := make([]int, len(results))
	for index := range order {
		order[index] = index
	}
	sort.SliceStable(order, func(i, j int) bool { return keys[order[i]] < keys[order[j]] })
	sorted := make([]*toolrt.Dict, len(results))
	for index, position := range order {
		sorted[index] = results[position]
	}
	copy(results, sorted)
	return nil
}
