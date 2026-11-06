package exportbundle

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/pycompat"
)

// makeDirs — mkdir(parents=True, exist_ok=True) с правами по умолчанию (0o777 и umask).
func makeDirs(path string) error {
	if err := os.MkdirAll(path, 0o777); err != nil {
		return pycompat.OSErrorFrom(err, path)
	}
	return nil
}

// contextReader — источник копирования, останавливающийся при отмене задания между блоками.
type contextReader struct {
	ctx    context.Context
	source io.Reader
}

// Read — чтение очередного блока, если задание не отменено.
func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(buffer)
}

// copyFile — shutil.copyfile(source, destination): содержимое потоком (ссылка на файл разыменована),
// права цели — по умолчанию. Копия файла на самого себя — ошибка SameFileError (подкласс OSError):
// иначе открытие цели обнулило бы исходник.
func copyFile(ctx context.Context, source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	defer input.Close()
	from, err := input.Stat()
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	if to, err := os.Stat(destination); err == nil && os.SameFile(from, to) {
		return pycompat.New(pycompat.OSError, pycompat.Repr(source)+" and "+pycompat.Repr(destination)+" are the same file")
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return pycompat.OSErrorFrom(err, destination)
	}
	_, err = io.Copy(output, contextReader{ctx, input})
	if closed := output.Close(); err == nil {
		err = closed
	}
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		return pycompat.OSErrorFrom(err, destination)
	}
	return nil
}

// copier — состояние copy_media: уже скопированные пути проекта и их пути в пакете.
type copier struct {
	ctx          context.Context
	root, target string
	copied       map[string]any
}

// parentOf — Path.parent: строкой, без разбора «..», который filepath.Dir схлопнул бы лексически
// и тогда папка media/ при пути «../x» не создавалась бы.
func parentOf(path string) string {
	return strings.TrimSuffix(strings.TrimSuffix(path, pycompat.PathName(path)), string(filepath.Separator))
}

// take — take(path): копирует файл проекта в media/ и возвращает путь внутри пакета. Повтор того же
// пути не копирует заново, пустой путь возвращается как есть. Путь пишется через «/» на любой ОС:
// пакет передают между машинами монтажёра.
func (c *copier) take(path any) (any, error) {
	key, err := pycompat.HashKey(path)
	if err != nil {
		return nil, err
	}
	if !pycompat.Truthy(path) {
		return path, nil
	}
	if known, ok := c.copied[key]; ok {
		return known, nil
	}
	text, ok := path.(string)
	if !ok {
		_, err := pathJoin(c.root, path)
		return nil, err
	}
	source := pycompat.JoinPath(c.root, text)
	if !pycompat.IsFile(source) {
		return nil, pycompat.New(pycompat.ValueError, textFileMissing+text)
	}
	destination := pycompat.JoinPath(c.target, "media", text)
	if err := makeDirs(parentOf(destination)); err != nil {
		return nil, err
	}
	if err := copyFile(c.ctx, source, destination); err != nil {
		return nil, err
	}
	relative, err := pycompat.RelativeTo(destination, c.target)
	if err != nil {
		return nil, err
	}
	result := filepath.ToSlash(relative)
	c.copied[key] = result
	return result, nil
}

// copyAll — copy_media: песня, референсы и файлы планов копируются в media/, пути в bundle
// переписываются на относительные к пакету. Возвращает число разных скопированных файлов.
func copyAll(ctx context.Context, bundle *pycompat.Dict, root, target string) (int, error) {
	c := &copier{ctx: ctx, root: root, target: target, copied: map[string]any{}}
	song, err := c.take(bundle.Value("song"))
	if err != nil {
		return 0, err
	}
	bundle.Set("song", song)
	references, ok := bundle.Value("references").(*pycompat.Dict)
	if !ok {
		return 0, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'items'", pycompat.TypeName(bundle.Value("references")))
	}
	for _, key := range references.Keys() {
		reference := references.Value(key)
		path, err := pycompat.GetItem(reference, "path")
		if err != nil {
			return 0, err
		}
		taken, err := c.take(path)
		if err != nil {
			return 0, err
		}
		reference.(*pycompat.Dict).Set("path", taken)
	}
	for _, row := range rowsOf(bundle) {
		for _, key := range []string{"original", "accepted_clip", "rebuild_input", "prompt", "request", "speech_wav", "audio_recipe", "card"} {
			if value := row.Value(key); pycompat.Truthy(value) {
				taken, err := c.take(value)
				if err != nil {
					return 0, err
				}
				row.Set(key, taken)
			}
		}
		inputs, _ := row.Value("inputs").([]any)
		taken := make([]any, 0, len(inputs))
		for _, input := range inputs {
			path, err := c.take(input)
			if err != nil {
				return 0, err
			}
			taken = append(taken, path)
		}
		row.Set("inputs", taken)
	}
	return len(c.copied), nil
}
