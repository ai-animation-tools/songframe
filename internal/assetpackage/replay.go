package assetpackage

import (
	"context"
	"io"
	"os"
	"path/filepath"

	"songframe/internal/process"
	"songframe/internal/toolrt"
)

// textReplayTarget, textReplayCopy и textReplayFilter — тексты отказов Replay.
const (
	textReplayTarget = "Нужен новый выходной файл вне assets."
	textReplayCopy   = "Копия принятого монтажа не совпадает с оригиналом."
	textReplayFilter = "Не удалось воспроизвести сохранённый монтажный фильтр."
)

// Replay воспроизводит принятый монтаж комплекта path в новый файл destination вне assets.
// Штатный режим копирует принятые
// байты и сверяет SHA; fromOriginal повторяет этапы фильтров rebuild.stages из оригинала
// генерации программой ffmpeg (путь ffmpeg) во временной папке. Комплект проверяется
// ValidatePackage без сверки кода плана. Ошибки — исключения toolrt с фиксированными
// текстами; незапустившийся ffmpeg — FileNotFoundError (NotFound).
func Replay(ctx context.Context, path, destination string, fromOriginal bool, root, ffmpeg string) error {
	pack, err := ValidatePackage(path, "", root)
	if err != nil {
		return err
	}
	destination = toolrt.ResolvePath(destination)
	if toolrt.Exists(destination) || toolrt.IsRelativeTo(destination, toolrt.ResolvePath(toolrt.JoinPath(root, "assets"))) {
		return toolrt.New(toolrt.ValueError, textReplayTarget)
	}
	edit, err := item(pack, "accepted_edit")
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if !fromOriginal {
		video, err := item(edit, "video")
		if err != nil {
			return err
		}
		name, err := item(video, "path")
		if err != nil {
			return err
		}
		source, err := LocalFile(directory, name)
		if err != nil {
			return err
		}
		if err := copyNew(source, destination); err != nil {
			return err
		}
		digest, err := FileSHA256(destination)
		if err != nil {
			return err
		}
		if !toolrt.Equal(digest, video.(*toolrt.Dict).Value("sha256")) {
			return toolrt.New(toolrt.ValueError, textReplayCopy)
		}
		return nil
	}
	folder, err := os.MkdirTemp("", "asset-replay-")
	if err != nil {
		return toolrt.OSErrorFrom(err, os.TempDir())
	}
	defer os.RemoveAll(folder)
	rebuild, err := item(edit, "rebuild")
	if err != nil {
		return err
	}
	stagesValue, err := item(rebuild, "stages")
	if err != nil {
		return err
	}
	stages, err := toolrt.Iter(stagesValue)
	if err != nil {
		return err
	}
	fps, err := item(edit, "fps")
	if err != nil {
		return err
	}
	previous := ""
	for number, stage := range stages {
		usePrevious, err := toolrt.DictGet(stage, "use_previous", nil)
		if err != nil {
			return err
		}
		source := previous
		if !toolrt.Truthy(usePrevious) {
			input, err := item(stage, "input")
			if err != nil {
				return err
			}
			if source, err = LocalFile(directory, input); err != nil {
				return err
			}
		}
		filter, err := item(stage, "filter")
		if err != nil {
			return err
		}
		frames, err := item(stage, "frames")
		if err != nil {
			return err
		}
		target := filepath.Join(folder, toolrt.NewInt(int64(number)).String()+".mp4")
		args := []string{"-v", "error", "-nostdin", "-n", "-threads", "2", "-i", source, "-vf", toolrt.Str(filter),
			"-frames:v", toolrt.Str(frames), "-an", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18",
			"-pix_fmt", "yuv420p", "-r", toolrt.Str(fps), target}
		if _, err := process.Run(ctx, process.Command{Path: ffmpeg, Args: args, Name: "ffmpeg"}); err != nil {
			if _, ok := err.(*process.StartError); ok {
				return NotFound(ffmpeg)
			}
			return toolrt.New(toolrt.ValueError, textReplayFilter)
		}
		previous = target
	}
	if previous == "" {
		return toolrt.Raise(toolrt.AttributeError, "'NoneType' object has no attribute 'open'")
	}
	return copyNew(previous, destination)
}

// copyNew копирует source в новый файл destination; существующий файл — FileExistsError.
func copyNew(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return toolrt.OSErrorFrom(err, destination)
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return toolrt.OSErrorFrom(err, destination)
	}
	if err := output.Close(); err != nil {
		return toolrt.OSErrorFrom(err, destination)
	}
	return nil
}

// NotFound — FileNotFoundError для программы, которую не удалось запустить (текст
// зафиксирован эталоном).
func NotFound(program string) error {
	return toolrt.New(toolrt.FileNotFoundError, "[Errno 2] No such file or directory: "+toolrt.Repr(program))
}
