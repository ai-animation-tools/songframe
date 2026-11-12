// Package mediacmd запускает FFmpeg/ffprobe для медиаинструментов: cut_speech, contact_sheet,
// build_review, build_animatic и рендер участка accept_shot.
//
// Каждый инструмент сам составляет текст ошибки из хвоста stderr, и тексты различаются, поэтому
// пакет отдаёт сырой исход (код, stdout, stderr), а формулировку оставляет инструменту. Общими
// здесь являются только поиск программ (пара менеджера компонентов или имена из PATH), исход
// незапустившейся программы (исключение toolrt FileNotFoundError) и параметры кодирования и probe
// build_animatic, которые использует и accept_shot.
//
// Запуск идёт через internal/process: без shell и окна консоли, с отменой через context и
// завершением потомков. Пакет не владеет состоянием, кроме подменяемой функции Programs.
package mediacmd

import (
	"context"
	"errors"
	"strconv"
	"syscall"

	"songframe/internal/process"
	"songframe/internal/toolrt"
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

// Encode — параметры кодирования build_animatic: H.264 без звука на шкале fps кадров/с проекта,
// общие для сегментов аниматика и рендера принятого участка. Список входит в рецепт кэша
// фрагментов, поэтому изменение меняет байты результата и версию рецепта.
func Encode(fps int64) []string {
	return []string{
		"-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p",
		"-r", strconv.FormatInt(fps, 10), "-video_track_timescale", "15360", "-map_metadata", "-1",
	}
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

// Result — исход программы: код завершения и захваченные потоки stdout и stderr (в пределах
// Limits).
type Result struct {
	Code   int
	Stdout []byte
	Stderr []byte
}

// Run запускает program с аргументами и захватывает stdout и stderr. Ненулевой код — не
// ошибка, а Result.Code. Ошибка — только незапустившаяся программа (NotFound) и остановка через
// context (process.ErrCanceled/ErrTimeout). stdin программы пуст.
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
			// Завершение сигналом: код отрицательный, текст ошибки строит инструмент.
			out.Code = -1
		}
		return out, nil
	}
	return out, err
}

// NotFound — исключение toolrt FileNotFoundError «нет такого файла или каталога: '<путь>'»
// для программы, которую не удалось запустить; текст зафиксирован эталонами инструментов.
func NotFound(program string) error {
	return toolrt.OSErrorFrom(syscall.ENOENT, program)
}

// Tail — последние limit кодовых точек вывода после декодирования UTF-8 с заменой неверных
// последовательностей на U+FFFD (toolrt.DecodeReplace).
func Tail(data []byte, limit int) string {
	runes := []rune(toolrt.DecodeReplace(data))
	if len(runes) > limit {
		runes = runes[len(runes)-limit:]
	}
	return string(runes)
}

// AnimaticRun — запуск для build_animatic: stdout программы; ненулевой код — исключение toolrt
// ValueError с последними 1200 знаками stderr. Его же зовёт accept_shot.
func AnimaticRun(ctx context.Context, program string, args ...string) ([]byte, error) {
	result, err := Run(ctx, program, args...)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, toolrt.New(toolrt.ValueError, "Команда обработки медиа завершилась с ошибкой: "+Tail(result.Stderr, 1200))
	}
	return result.Stdout, nil
}

// AnimaticProbe — ffprobe файла для build_animatic: JSON потоков, формата и глав как словарь
// toolrt.Dict (порядок ключей и различие int/float сохраняются).
func AnimaticProbe(ctx context.Context, path string) (*toolrt.Dict, error) {
	data, err := AnimaticRun(ctx, FFprobe(), "-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	return LoadProbe(data)
}

// LoadProbe разбирает вывод ffprobe: строгий UTF-8 и JSON toolrt.LoadsJSON. Если JSON — не
// объект, возвращается nil без ошибки: какое исключение поднять, решает вызывающий.
func LoadProbe(data []byte) (*toolrt.Dict, error) {
	text, err := toolrt.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	value, err := toolrt.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	result, _ := value.(*toolrt.Dict)
	return result, nil
}
