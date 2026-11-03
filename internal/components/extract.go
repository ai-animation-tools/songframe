package components

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/ulikunitz/xz"
)

// extraction ограничивает запись новым staging: ссылки создаются после обычных файлов.
// Files и Preserve задают единственный устанавливаемый состав; лишние бинарники не копируются.
type extraction struct {
	ctx       context.Context
	directory string
	artifact  Artifact
	seen      map[string]bool
	links     map[string]string
	bytes     int64
}

// extractArtifact поддерживает только форматы встроенного manifest без shell и системного архиватора.
func extractArtifact(ctx context.Context, name, directory string, a Artifact) error {
	e := extraction{ctx: ctx, directory: directory, artifact: a, seen: map[string]bool{}, links: map[string]string{}}
	if a.Format == "file" {
		if len(a.Files) != 1 {
			return fmt.Errorf("одиночный пакет должен содержать ровно один файл")
		}
		f, err := os.Open(name)
		if err != nil {
			return err
		}
		defer f.Close()
		return e.write(a.Files[0].Path, f, a.Bytes, 0600)
	}
	if a.Format == "zip" {
		z, err := zip.OpenReader(name)
		if err != nil {
			return err
		}
		defer z.Close()
		for _, file := range z.File {
			relative, err := e.relative(file.Name)
			if err != nil {
				return err
			}
			if file.FileInfo().IsDir() {
				continue
			}
			if file.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("неподдержанная ссылка ZIP: %s", file.Name)
			}
			if relative == "" || !e.wanted(relative) {
				continue
			}
			reader, err := file.Open()
			if err != nil {
				return err
			}
			err = e.write(relative, reader, int64(file.UncompressedSize64), file.Mode())
			reader.Close()
			if err != nil {
				return err
			}
		}
	} else {
		f, err := os.Open(name)
		if err != nil {
			return err
		}
		defer f.Close()
		var reader io.Reader = contextReader{ctx, f}
		switch a.Format {
		case "tar.gz":
			gz, err := gzip.NewReader(reader)
			if err != nil {
				return err
			}
			defer gz.Close()
			reader = gz
		case "tar.xz":
			compressed, err := xz.NewReader(reader)
			if err != nil {
				return err
			}
			reader = compressed
		default:
			return fmt.Errorf("неподдержанный формат архива: %s", a.Format)
		}
		tr := tar.NewReader(contextReader{ctx, reader})
		for {
			header, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			relative, err := e.relative(header.Name)
			if err != nil {
				return err
			}
			if header.Typeflag == tar.TypeDir {
				continue
			}
			if relative == "" || !e.wanted(relative) {
				continue
			}
			switch header.Typeflag {
			case tar.TypeReg, tar.TypeRegA:
				if err = e.write(relative, tr, header.Size, os.FileMode(header.Mode)); err != nil {
					return err
				}
			case tar.TypeSymlink:
				expected := ""
				for _, file := range a.Files {
					if file.Path == relative && file.Type == "symlink" {
						expected = file.Target
					}
				}
				if expected == "" || expected != header.Linkname || !safeArchivePath(path.Join(path.Dir(relative), header.Linkname)) {
					return fmt.Errorf("неверная ссылка архива: %s", header.Name)
				}
				if e.seen[relative] {
					return fmt.Errorf("повторный путь архива: %s", relative)
				}
				e.seen[relative] = true
				e.links[relative] = header.Linkname
			default:
				return fmt.Errorf("неподдержанный тип записи архива: %s", header.Name)
			}
		}
	}
	for relative, target := range e.links {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(directory, filepath.FromSlash(relative))), 0700); err != nil {
			return err
		}
		if err := os.Symlink(target, filepath.Join(directory, filepath.FromSlash(relative))); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// safeArchivePath отвергает абсолютные, платформенные и выходящие за корень имена до очистки пути.
func safeArchivePath(name string) bool {
	if name == "" || strings.ContainsAny(name, `\:`) || strings.ContainsRune(name, 0) || strings.HasPrefix(name, "/") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return false
		}
	}
	return true
}

// relative снимает только заявленный корень; запись соседних корней является ошибкой архива.
func (e *extraction) relative(name string) (string, error) {
	if !safeArchivePath(name) {
		return "", fmt.Errorf("путь архива выходит за каталог компонента: %s", name)
	}
	name = path.Clean(name)
	if name == e.artifact.Root {
		return "", nil
	}
	if e.artifact.Root != "" {
		prefix := e.artifact.Root + "/"
		if !strings.HasPrefix(name, prefix) {
			return "", fmt.Errorf("неверный корень архива: %s", name)
		}
		name = strings.TrimPrefix(name, prefix)
	}
	return name, nil
}

// wanted сохраняет точные обязательные файлы и лицензионные деревья вида doc/**.
func (e *extraction) wanted(name string) bool {
	for _, file := range e.artifact.Files {
		if file.Path == name {
			return true
		}
	}
	for _, pattern := range e.artifact.Preserve {
		if pattern == name {
			return true
		}
		if strings.HasSuffix(pattern, "/**") && strings.HasPrefix(name, strings.TrimSuffix(pattern, "**")) {
			return true
		}
	}
	return false
}

// write пишет только новый обычный файл с ограничением распакованного объёма и Sync перед публикацией.
func (e *extraction) write(name string, reader io.Reader, size int64, mode os.FileMode) error {
	if err := e.ctx.Err(); err != nil {
		return err
	}
	if !safeArchivePath(name) || e.seen[name] {
		return fmt.Errorf("небезопасный или повторный путь архива: %s", name)
	}
	e.seen[name] = true
	if size < 0 || size > e.artifact.UnpackedBytes-e.bytes {
		return fmt.Errorf("распакованный архив превысил закреплённый объём")
	}
	e.bytes += size
	destination := filepath.Join(e.directory, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	permission := os.FileMode(0600)
	if mode&0111 != 0 {
		permission = 0700
	}
	f, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, permission)
	if err != nil {
		return err
	}
	count, err := io.CopyBuffer(f, io.LimitReader(contextReader{e.ctx, reader}, size+1), make([]byte, 256*1024))
	if err == nil && count != size {
		err = fmt.Errorf("неверный размер файла архива: %s", name)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	return err
}
