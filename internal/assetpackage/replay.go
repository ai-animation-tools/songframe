package assetpackage

import (
	"context"
	"io"
	"os"
	"path/filepath"

	"songframe-go/internal/process"
	"songframe-go/internal/pycompat"
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
// ValidatePackage без сверки кода плана. Ошибки — исключения Python (pycompat) с фиксированными
// текстами; незапустившийся ffmpeg — FileNotFoundError, как у subprocess.run.
func Replay(ctx context.Context, path, destination string, fromOriginal bool, root, ffmpeg string) error {
	pack, err := ValidatePackage(path, "", root)
	if err != nil {
		return err
	}
	destination = pycompat.ResolvePath(destination)
	if pycompat.Exists(destination) || pycompat.IsRelativeTo(destination, pycompat.ResolvePath(pycompat.JoinPath(root, "assets"))) {
		return pycompat.New(pycompat.ValueError, textReplayTarget)
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
		if !pycompat.Equal(digest, video.(*pycompat.Dict).Value("sha256")) {
			return pycompat.New(pycompat.ValueError, textReplayCopy)
		}
		return nil
	}
	folder, err := os.MkdirTemp("", "asset-replay-")
	if err != nil {
		return pycompat.OSErrorFrom(err, os.TempDir())
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
	stages, err := pycompat.Iter(stagesValue)
	if err != nil {
		return err
	}
	fps, err := item(edit, "fps")
	if err != nil {
		return err
	}
	previous := ""
	for number, stage := range stages {
		usePrevious, err := pycompat.DictGet(stage, "use_previous", nil)
		if err != nil {
			return err
		}
		source := previous
		if !pycompat.Truthy(usePrevious) {
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
		target := filepath.Join(folder, pycompat.NewInt(int64(number)).String()+".mp4")
		args := []string{"-v", "error", "-nostdin", "-n", "-threads", "2", "-i", source, "-vf", pycompat.Str(filter),
			"-frames:v", pycompat.Str(frames), "-an", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18",
			"-pix_fmt", "yuv420p", "-r", pycompat.Str(fps), target}
		if _, err := process.Run(ctx, process.Command{Path: ffmpeg, Args: args, Name: "ffmpeg"}); err != nil {
			if _, ok := err.(*process.StartError); ok {
				return NotFound(ffmpeg)
			}
			return pycompat.New(pycompat.ValueError, textReplayFilter)
		}
		previous = target
	}
	if previous == "" {
		return pycompat.Raise(pycompat.AttributeError, "'NoneType' object has no attribute 'open'")
	}
	return copyNew(previous, destination)
}

// copyNew — open("xb") и shutil.copyfileobj: новый файл, существующий — FileExistsError.
func copyNew(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return pycompat.OSErrorFrom(err, destination)
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return pycompat.OSErrorFrom(err, destination)
	}
	if err := output.Close(); err != nil {
		return pycompat.OSErrorFrom(err, destination)
	}
	return nil
}

// NotFound — FileNotFoundError subprocess.run для программы, которую не удалось запустить.
func NotFound(program string) error {
	return pycompat.New(pycompat.FileNotFoundError, "[Errno 2] No such file or directory: "+pycompat.Repr(program))
}
