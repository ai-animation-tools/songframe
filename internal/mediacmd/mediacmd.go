// Package mediacmd запускает FFmpeg/ffprobe для медиаинструментов: cut_speech, contact_sheet,
// build_review, build_animatic и рендер участка accept_shot.
//
// Каждый инструмент сам составляет текст ошибки из хвоста stderr, и тексты различаются, поэтому
// пакет отдаёт сырой исход (код, stdout, stderr), а формулировку оставляет инструменту. Общими
// здесь являются только поиск программ (пара менеджера компонентов или имена из PATH), исход
// незапустившейся программы (FileNotFoundError, как у subprocess) и параметры кодирования и probe
// build_animatic, которые использует и accept_shot.
//
// Запуск идёт через internal/process: без shell и окна консоли, с отменой через context и
// завершением потомков. Пакет не владеет состоянием, кроме подменяемой функции Programs.
package mediacmd

import (
	"context"
	"errors"
	"strconv"

	"songframe-go/internal/process"
	"songframe-go/internal/pycompat"
)

// Programs — пути FFmpeg и ffprobe. Приложение подставляет пару менеджера компонентов (main.go);
// пустой путь означает голое имя, которое ищется в PATH. Тесты подменяют функцию.
var Programs = func() (ffmpeg, ffprobe string) { return "", "" }

// FFmpeg — путь FFmpeg или имя «ffmpeg» для поиска в PATH.
func FFmpeg() string {
	if path, _ := Programs(); path != "" {
		return path
	}
	return "ffmpeg"
}

// FFprobe — путь ffprobe или имя «ffprobe» для поиска в PATH.
func FFprobe() string {
	if _, path := Programs(); path != "" {
		return path
	}
	return "ffprobe"
}

// FPS — шкала монтажа приложения (FPS build_animatic/build_review).
const FPS = 30

// Encode — ENCODE build_animatic: параметры H.264 без звука на шкале 30 к/с, общие для сегментов
// аниматика и рендера принятого участка. Изменение меняет байты результата и версию рецепта.
var Encode = []string{
	"-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p",
	"-r", strconv.Itoa(FPS), "-video_track_timescale", "15360", "-map_metadata", "-1",
}

// Limits — сколько последних байт stdout и stderr сохранить. Нулевое поле — значение по умолчанию.
type Limits struct {
	Stdout, Stderr int
}

// Значения по умолчанию: JSON ffprobe и строка версии — килобайты, а PCM целой песни (cut_speech)
// — десятки мегабайт, поэтому stdout ограничен с запасом; stderr нужен только для хвоста ошибки.
const (
	defaultStdout = 1 << 30
	defaultStderr = 256 << 10
)

// Result — исход программы, как CompletedProcess(capture_output=True): код и полные потоки.
type Result struct {
	Code   int
	Stdout []byte
	Stderr []byte
}

// Run — subprocess.run([program, *args], capture_output=True) без check: ненулевой код — не
// ошибка, а Result.Code. Ошибка — только незапустившаяся программа (FileNotFoundError с текстом
// Python) и остановка через context (process.ErrCanceled/ErrTimeout). stdin пуст, как DEVNULL.
func Run(ctx context.Context, program string, args ...string) (Result, error) {
	return RunLimits(ctx, Limits{}, program, args...)
}

// RunLimits — Run с явными пределами захвата вывода.
func RunLimits(ctx context.Context, limits Limits, program string, args ...string) (Result, error) {
	if limits.Stdout <= 0 {
		limits.Stdout = defaultStdout
	}
	if limits.Stderr <= 0 {
		limits.Stderr = defaultStderr
	}
	result, err := process.Run(ctx, process.Command{Path: program, Args: args, StdoutLimit: limits.Stdout, StderrLimit: limits.Stderr})
	out := Result{Code: result.Code, Stdout: result.Stdout, Stderr: result.Stderr}
	if err == nil {
		return out, nil
	}
	var start *process.StartError
	if errors.As(err, &start) {
		return out, NotFound(program)
	}
	var exit *process.ExitError
	if errors.As(err, &exit) {
		if out.Code == 0 {
			// Посторонний сигнал: у subprocess код отрицательный, текст ошибки строит инструмент.
			out.Code = -1
		}
		return out, nil
	}
	return out, err
}

// NotFound — FileNotFoundError subprocess для программы, которой нет.
func NotFound(program string) error {
	return pycompat.New(pycompat.FileNotFoundError, "[Errno 2] No such file or directory: "+pycompat.Repr(program))
}

// Tail — stderr.decode(errors="replace")[-limit:]: последние limit кодовых точек хвоста вывода с
// заменой неверного UTF-8 по правилам CPython.
func Tail(data []byte, limit int) string {
	runes := []rune(pycompat.DecodeReplace(data))
	if len(runes) > limit {
		runes = runes[len(runes)-limit:]
	}
	return string(runes)
}

// AnimaticRun — run(args) build_animatic: stdout программы; ненулевой код — ValueError с
// последними 1200 знаками stderr. Его же зовёт accept_shot.
func AnimaticRun(ctx context.Context, program string, args ...string) ([]byte, error) {
	result, err := Run(ctx, program, args...)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, pycompat.New(pycompat.ValueError, "Команда обработки медиа завершилась с ошибкой: "+Tail(result.Stderr, 1200))
	}
	return result.Stdout, nil
}

// AnimaticProbe — probe(path) build_animatic: JSON ffprobe потоков, формата и глав как значение
// pycompat (порядок ключей и int/float сохраняются, как у json.loads).
func AnimaticProbe(ctx context.Context, path string) (*pycompat.Dict, error) {
	data, err := AnimaticRun(ctx, FFprobe(), "-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	return LoadProbe(data)
}

// LoadProbe — json.loads(bytes) вывода ffprobe: строгий UTF-8 и JSON Python. Если JSON — не
// объект, возвращается nil без ошибки: какое исключение поднять, решает вызывающий.
func LoadProbe(data []byte) (*pycompat.Dict, error) {
	text, err := pycompat.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	value, err := pycompat.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	result, _ := value.(*pycompat.Dict)
	return result, nil
}
