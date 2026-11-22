package effects

import (
	"context"
	"fmt"
	"io"
	"strconv"

	"songframe/internal/mediacmd"
	"songframe/internal/process"
)

// Job — что отрендерить: источник кадров, цепочка эффектов, частота кадров и путь результата.
type Job struct {
	Source Source
	Chain  []Effect
	FPS    int64
	Output string
}

// RenderFrame — кадр t ролика: кадр источника, обработанный цепочкой эффектов.
func RenderFrame(source Source, chain []Effect, fps int64, t int) *Frame {
	size := source.Size()
	frame := source.Frame(t)
	ctx := &Context{Frame: t, Frames: size.Frames, FPS: float64(fps)}
	for _, effect := range chain {
		effect.Apply(ctx, frame)
	}
	return frame
}

// Render кодирует ролик в H.264 без звука (параметры mediacmd.Encode, как у аниматика):
// кадры считаются по порядку и идут потоком на вход FFmpeg через общий запуск процессов —
// без shell, с отменой через ctx и завершением потомков. progress (может быть nil) получает
// число готовых кадров после каждого кадра. При ошибке или отмене файл Output может остаться
// неполным: запись во временный путь и перенос — забота вызывающего.
func Render(ctx context.Context, job Job, progress func(done, total int)) error {
	size := job.Source.Size()
	if job.FPS <= 0 {
		return fmt.Errorf("частота кадров %d", job.FPS)
	}
	reader, writer := io.Pipe()
	args := []string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "rawvideo", "-pix_fmt", "rgb24",
		"-s", fmt.Sprintf("%dx%d", size.Width, size.Height),
		"-framerate", strconv.FormatInt(job.FPS, 10), "-i", "pipe:0",
		"-frames:v", strconv.Itoa(size.Frames),
	}
	args = append(args, mediacmd.Encode(job.FPS)...)
	args = append(args, job.Output)
	produced := make(chan error, 1)
	go func() {
		buffer := make([]byte, size.Width*size.Height*3)
		var err error
		for t := 0; t < size.Frames && err == nil; t++ {
			if ctx.Err() != nil {
				err = context.Cause(ctx)
				break
			}
			RenderFrame(job.Source, job.Chain, job.FPS, t).RGB24(buffer)
			if _, err = writer.Write(buffer); err == nil && progress != nil {
				progress(t+1, size.Frames)
			}
		}
		writer.CloseWithError(err)
		produced <- err
	}()
	result, runErr := process.Run(ctx, process.Command{
		Path: mediacmd.FFmpeg(), Args: args, Stdin: reader, StderrLimit: 16 << 10,
	})
	reader.CloseWithError(io.ErrClosedPipe) // FFmpeg вышел: генератор кадров не должен ждать
	frameErr := <-produced
	if runErr != nil {
		return fmt.Errorf("FFmpeg: %w%s", runErr, stderrTail(result.Stderr))
	}
	if frameErr != nil {
		return frameErr
	}
	return nil
}

func stderrTail(stderr []byte) string {
	if len(stderr) == 0 {
		return ""
	}
	return ": " + mediacmd.Tail(stderr, 2000)
}
