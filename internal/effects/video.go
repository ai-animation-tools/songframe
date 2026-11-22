package effects

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"

	"songframe/internal/mediacmd"
	"songframe/internal/process"
)

// VideoSource — кадры готового ролика по порядку (эффект поверх принятого плана). FFmpeg
// декодирует ролик в rgb24 размера size потоком через общий запуск процессов; Frame читает
// следующий кадр из потока, поэтому кадры берутся только подряд с нуля — как их просит Render.
// Ролик короче size.Frames или сбой декодирования дают ошибку Close, а недостающие кадры —
// повтор последнего, чтобы рендер дошёл до конца и не оставил FFmpeg кодирования ждать.
type VideoSource struct {
	size   Size
	reader *io.PipeReader
	buffer []byte
	next   int
	last   *Frame
	err    error
	cancel context.CancelFunc
	done   chan error
}

// decodeArgs — аргументы FFmpeg: первая видеодорожка path в rgb24 размера size, не больше
// size.Frames кадров, в stdout; filter — дополнительный фильтр перед масштабированием.
//
// Матрица YUV→RGB задана явно (bt601) — той же, которой Render кодирует RGB обратно
// (mediacmd.Encode без тегов цвета). Так нетронутые эффектом пиксели сохраняют значения YUV
// источника, как у чистого плана в аниматике, который FFmpeg перекодирует без перехода в RGB.
// С матрицей из тегов входа ролик с пометкой bt709 после круга заметно менял яркость и цвет.
func decodeArgs(path string, size Size, filter string, frames int) []string {
	scale := fmt.Sprintf("scale=%d:%d:flags=bicubic:in_color_matrix=bt601", size.Width, size.Height)
	if filter != "" {
		scale = filter + "," + scale
	}
	return []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-an",
		"-vf", scale, "-f", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", strconv.Itoa(frames), "pipe:1",
	}
}

// OpenVideo запускает декодирование ролика path. Close обязателен: он останавливает FFmpeg и
// возвращает ошибку декодирования.
func OpenVideo(ctx context.Context, path string, size Size) (*VideoSource, error) {
	if size.Width <= 0 || size.Height <= 0 || size.Frames <= 0 {
		return nil, fmt.Errorf("ролик %s: пустой размер %dx%d, кадров %d", path, size.Width, size.Height, size.Frames)
	}
	ctx, cancel := context.WithCancel(ctx)
	reader, writer := io.Pipe()
	source := &VideoSource{size: size, reader: reader, buffer: make([]byte, size.Width*size.Height*3), cancel: cancel, done: make(chan error, 1)}
	go func() {
		result, err := process.Run(ctx, process.Command{
			Path: mediacmd.FFmpeg(), Args: decodeArgs(path, size, "", size.Frames), StderrLimit: 16 << 10,
			OnOutput: func(data []byte, stderr bool) {
				if !stderr {
					// Читатель закрыт (рендер остановлен): дальше декодировать незачем.
					if _, err := writer.Write(data); err != nil {
						cancel()
					}
				}
			},
		})
		if err != nil {
			err = fmt.Errorf("FFmpeg: %w%s", err, stderrTail(result.Stderr))
			writer.CloseWithError(err)
		} else {
			writer.Close()
		}
		source.done <- err
	}()
	return source, nil
}

// Size — размер и длина ролика.
func (v *VideoSource) Size() Size { return v.size }

// Frame — следующий кадр ролика; t должен идти подряд с нуля.
func (v *VideoSource) Frame(t int) *Frame {
	if t != v.next && v.err == nil {
		v.err = fmt.Errorf("кадры ролика читаются подряд: запрошен %d, следующий %d", t, v.next)
	}
	v.next = t + 1
	if v.err == nil {
		if _, err := io.ReadFull(v.reader, v.buffer); err != nil {
			v.err = fmt.Errorf("в ролике меньше кадров, чем нужно (%d): %w", v.size.Frames, err)
		} else {
			v.last = FromRGB24(v.buffer, v.size.Width, v.size.Height)
		}
	}
	if v.last == nil {
		return NewFrame(v.size.Width, v.size.Height)
	}
	return v.last.Clone()
}

// Close останавливает декодирование и возвращает первую ошибку чтения или FFmpeg.
func (v *VideoSource) Close() error {
	v.cancel()
	v.reader.Close()
	err := <-v.done
	if v.err != nil {
		return v.err
	}
	// Остановка после того, как все кадры прочитаны, — не ошибка.
	if errors.Is(err, process.ErrCanceled) && v.next >= v.size.Frames {
		return nil
	}
	return err
}

// FromRGB24 — линейный кадр из байтов rgb24.
func FromRGB24(data []byte, width, height int) *Frame {
	f := NewFrame(width, height)
	for i := range f.Pix {
		f.Pix[i] = toLinear[data[i]]
	}
	return f
}

// DecodeFrame — кадр t ролика path в размере size (превью эффекта на одном кадре): FFmpeg
// выбирает кадр по номеру, без поиска по времени, поэтому номер точный.
func DecodeFrame(ctx context.Context, path string, size Size, t int) (*Frame, error) {
	if t < 0 {
		return nil, fmt.Errorf("номер кадра %d", t)
	}
	result, err := process.Run(ctx, process.Command{
		Path: mediacmd.FFmpeg(), Args: decodeArgs(path, size, fmt.Sprintf(`select=eq(n\,%d)`, t), 1),
		StdoutLimit: size.Width*size.Height*3 + 1, StderrLimit: 16 << 10,
	})
	if err != nil {
		return nil, fmt.Errorf("FFmpeg: %w%s", err, stderrTail(result.Stderr))
	}
	if len(result.Stdout) != size.Width*size.Height*3 {
		return nil, fmt.Errorf("в ролике нет кадра %d", t)
	}
	return FromRGB24(result.Stdout, size.Width, size.Height), nil
}
