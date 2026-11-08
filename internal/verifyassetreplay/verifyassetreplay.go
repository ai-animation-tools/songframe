// Package verifyassetreplay проверяет воспроизведение всех принятых комплектов планов из индекса
// assets/shots/manifest.json (инструмент verify_asset_replay).
//
// Для каждого плана комплект проверяется ValidatePackage, принятый монтаж копируется
// (assetpackage.Replay) и заново собирается из оригинала генерации; у пересобранного файла
// ffprobe сверяет число кадров, 30 к/с и 1920×1080, а три кадра (первый, средний, последний)
// сравниваются с принятым монтажом по RMS яркости и цветности (YUV 320×180) — порог 12. Отчёт JSON
// пишется вне папки проекта. Проект инструмент не меняет: копии и пересборки лежат во временной
// папке «accepted-replay-*», удаляемой по завершении.
//
// Коды выхода, stdout и последняя строка трассировки зафиксированы эталоном
// testdata/golden/verify-asset-replay. Планы проверяются двумя параллельными работниками, но
// строки о них печатаются в порядке индекса, чтобы вывод был детерминированным.
package verifyassetreplay

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"songframe-go/internal/assetpackage"
	"songframe-go/internal/process"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
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
	// assertionError — встроенный AssertionError Python: assert без текста даёт пустой str().
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

// Parser — аргументы инструмента в стиле argparse: обязательный --report и необязательный --preserved.
func Parser() *pycompat.Command {
	return &pycompat.Command{
		Name:        "verify_asset_replay.py",
		Prog:        "verify_asset_replay.py",
		Description: textDescription,
		Actions: []pycompat.Action{
			{Name: "--report", Kind: pycompat.StoreValue, Required: true},
			{Name: "--preserved", Kind: pycompat.StoreValue},
		},
	}
}

// outcome — результат проверки одного плана: запись отчёта (result), отказ проверки
// (AssertionError или ValueError — failure) либо необработанное исключение (err).
type outcome struct {
	result  *pycompat.Dict
	failure error
	err     error
}

// Run — инструмент verify_asset_replay на корне проекта root (уже выбранном tools.Run).
func Run(root string, argv []string) pytool.Output {
	args, exit := Parser().ParseArgs(argv)
	if exit != nil {
		return pytool.Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
	}
	out := &pytool.Printer{}
	if err := run(context.Background(), root, args, out); err != nil {
		return out.Crash(err)
	}
	return out.Exit(0)
}

// run — работа Run: любая возвращённая ошибка — необработанное исключение (трассировка, код 1).
func run(ctx context.Context, root string, args pycompat.Namespace, out *pytool.Printer) error {
	report := pycompat.ResolvePath(args["report"].(string))
	if pycompat.IsRelativeTo(report, root) {
		return pycompat.New(pycompat.ValueError, textReportInside)
	}
	registry, err := pycompat.LoadJSONFile(filepath.Join(root, "assets/shots/manifest.json"))
	if err != nil {
		return err
	}
	shotsValue, err := pycompat.Item(registry, "shots")
	if err != nil {
		return err
	}
	shots, err := pycompat.Iter(shotsValue)
	if err != nil {
		return err
	}
	temporary, err := os.MkdirTemp("", "accepted-replay-")
	if err != nil {
		return pycompat.OSErrorFrom(err, os.TempDir())
	}
	defer os.RemoveAll(temporary)

	outcomes := verifyAll(ctx, root, shots, temporary)
	results := []*pycompat.Dict{}
	failures := []any{}
	for index, item := range outcomes {
		sid := pycompat.Str(shots[index])
		switch {
		case item.err != nil:
			return item.err
		case item.failure != nil:
			failures = append(failures, pytool.Record("shot", shots[index], "error", item.failure.Error()))
			if err := out.Print(sid + " проверка не пройдена"); err != nil {
				return err
			}
		default:
			results = append(results, item.result)
			rms := item.result.Value("sampled_yuv_rms").(float64)
			if err := out.Print(sid + " воспроизведён RMS=" + pycompat.FormatFixed(rms, 3)); err != nil {
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
		preserved = pycompat.NewInt(int64(count))
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
	data, err := pycompat.EncodeIndented(pytool.Record(
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
		return pycompat.OSErrorFrom(err, report)
	}
	if len(failures) > 0 {
		return pycompat.New(assertionError, pycompat.Repr(failures))
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
				case pycompat.IsAny(err, assertionError, pycompat.ValueError):
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
func verify(ctx context.Context, root string, shot any, temporary string) (*pycompat.Dict, error) {
	sid, ok := shot.(string)
	if !ok {
		return nil, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(shot))
	}
	path := filepath.Join(root, "assets/shots", sid, "manifest.json")
	pack, err := assetpackage.ValidatePackage(path, sid, root)
	if err != nil {
		return nil, err
	}
	edit, err := pycompat.Item(pack, "accepted_edit")
	if err != nil {
		return nil, err
	}
	copied := filepath.Join(temporary, sid+"-copy.mp4")
	rendered := filepath.Join(temporary, sid+"-rebuilt.mp4")
	if err := assetpackage.Replay(ctx, path, copied, false, root, FFmpeg); err != nil {
		return nil, err
	}
	video, err := pycompat.Item(edit, "video")
	if err != nil {
		return nil, err
	}
	digest, err := assetpackage.FileSHA256(copied)
	if err != nil {
		return nil, err
	}
	expectedDigest, err := pycompat.Item(video, "sha256")
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(digest, expectedDigest) {
		return nil, pycompat.New(assertionError, "")
	}
	if err := assetpackage.Replay(ctx, path, rendered, true, root, FFmpeg); err != nil {
		return nil, err
	}
	meta, err := probe(ctx, rendered)
	if err != nil {
		return nil, err
	}
	frames, err := pycompat.Item(edit, "frames")
	if err != nil {
		return nil, err
	}
	if err := checkMeta(sid, meta, frames); err != nil {
		return nil, err
	}
	count, ok := frames.(pycompat.Int)
	if !ok {
		return nil, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for //: '%s' and 'int'", pycompat.TypeName(frames))
	}
	total, ok := count.Int64()
	if !ok {
		return nil, pycompat.New(pycompat.OverflowError, "Python int too large to convert to C long")
	}
	indices := sampleIndices(total)
	name, err := pycompat.Item(video, "path")
	if err != nil {
		return nil, err
	}
	original := filepath.Join(filepath.Dir(path), pycompat.Str(name))
	a, err := sample(ctx, original, indices)
	if err != nil {
		return nil, err
	}
	b, err := sample(ctx, rendered, indices)
	if err != nil {
		return nil, err
	}
	if len(a) != len(b) || len(a) == 0 {
		return nil, pycompat.New(assertionError, sid)
	}
	rms := difference(a, b)
	if !(rms < rmsLimit) {
		return nil, pycompat.New(assertionError, "("+pycompat.Repr(sid)+", "+pycompat.Repr(rms)+")")
	}
	sampled := make([]any, len(indices))
	for index, value := range indices {
		sampled[index] = pycompat.NewInt(value)
	}
	return pytool.Record(
		"shot", sid,
		"accepted_copy_sha256_matches", true,
		"rebuild_frames", frames,
		"resolution", []any{pycompat.NewInt(1920), pycompat.NewInt(1080)},
		"fps", pycompat.NewInt(30),
		"sampled_frame_indices", sampled,
		"sampled_yuv_rms", rms,
	), nil
}

// checkMeta — assert (int(nb_frames), r_frame_rate, width, height) == (frames, "30/1", 1920, 1080),
// (sid, meta): текст отказа — repr кортежа с полным словарём потока.
func checkMeta(sid string, meta, frames any) error {
	values := make([]any, 4)
	for index, key := range []string{"nb_frames", "r_frame_rate", "width", "height"} {
		value, err := pycompat.Item(meta, key)
		if err != nil {
			return err
		}
		values[index] = value
	}
	switch number := values[0].(type) {
	case string:
		parsed, ok := pycompat.ParseIntText(number)
		if !ok {
			return pycompat.New(pycompat.ValueError, "invalid literal for int() with base 10: "+pycompat.Repr(number))
		}
		values[0] = parsed
	case pycompat.Int:
	default:
		return pycompat.Raise(pycompat.TypeError, "int() argument must be a string, a bytes-like object or a real number, not '%s'", pycompat.TypeName(number))
	}
	expected := []any{frames, "30/1", pycompat.NewInt(1920), pycompat.NewInt(1080)}
	for index := range values {
		if !pycompat.Equal(values[index], expected[index]) {
			return pycompat.New(assertionError, "("+pycompat.Repr(sid)+", "+pycompat.Repr(meta)+")")
		}
	}
	return nil
}

// sampleIndices — sorted({0, frames // 2, frames - 1}) с делением вниз, как в Python.
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
// точная, деление на длину — одно округление, как у int / int в Python; math.Sqrt совпадает с
// pow(x, 0.5) Python (оба корректно округлены).
func difference(a, b []byte) float64 {
	var sum int64
	for index := range a {
		delta := int64(a[index]) - int64(b[index])
		sum += delta * delta
	}
	return math.Sqrt(float64(sum) / float64(len(a)))
}

// execute запускает программу и возвращает её stdout; ненулевой код — ValueError,
// незапустившаяся программа — FileNotFoundError subprocess.run.
func execute(ctx context.Context, program string, args []string) ([]byte, error) {
	result, err := process.Run(ctx, process.Command{Path: program, Args: args, StdoutLimit: outputLimit})
	if err != nil {
		if _, ok := err.(*process.StartError); ok {
			return nil, assetpackage.NotFound(program)
		}
		return nil, pycompat.New(pycompat.ValueError, textRunFailed)
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
	text, err := pycompat.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	parsed, err := pycompat.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	streams, err := pycompat.Item(parsed, "streams")
	if err != nil {
		return nil, err
	}
	return pycompat.GetItem(streams, pycompat.NewInt(0))
}

// sample — кадры indices файла path, уменьшенные до 320×180, сырыми байтами yuv420p.
func sample(ctx context.Context, path string, indices []int64) ([]byte, error) {
	parts := make([]string, len(indices))
	for index, value := range indices {
		parts[index] = "eq(n\\," + pycompat.NewInt(value).String() + ")"
	}
	return execute(ctx, FFmpeg, []string{"-v", "error", "-threads", "2", "-i", path,
		"-vf", "select=" + strings.Join(parts, "+") + ",scale=320:180", "-fps_mode", "vfr",
		"-pix_fmt", "yuv420p", "-f", "rawvideo", "-"})
}

// checkPreserved — проверка снимка --preserved: все файлы snapshot["media"] (пути от корня
// проекта) сохранили SHA-256. Несовпадение — AssertionError без текста, ошибки чтения — исключения.
func checkPreserved(root, path string) (int, error) {
	snapshot, err := pycompat.LoadJSONFile(pycompat.ResolvePath(path))
	if err != nil {
		return 0, err
	}
	media, err := pycompat.Item(snapshot, "media")
	if err != nil {
		return 0, err
	}
	dict, ok := media.(*pycompat.Dict)
	if !ok {
		return 0, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'items'", pycompat.TypeName(media))
	}
	for _, name := range dict.Keys() {
		digest, err := assetpackage.FileSHA256(filepath.Join(root, name))
		if err != nil {
			return 0, err
		}
		if !pycompat.Equal(digest, dict.Value(name)) {
			return 0, pycompat.New(assertionError, "")
		}
	}
	return dict.Len(), nil
}

// sortShots — sorted(results, key=lambda x: float(x["shot"][1:])): устойчивая сортировка по
// числу после первой буквы кода плана.
func sortShots(results []*pycompat.Dict) error {
	keys := make([]float64, len(results))
	for index, result := range results {
		runes := []rune(result.Value("shot").(string))
		if len(runes) > 0 {
			runes = runes[1:]
		}
		key, err := pycompat.FloatFromString(string(runes))
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
	sorted := make([]*pycompat.Dict, len(results))
	for index, position := range order {
		sorted[index] = results[position]
	}
	copy(results, sorted)
	return nil
}
