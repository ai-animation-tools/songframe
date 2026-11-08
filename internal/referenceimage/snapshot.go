package referenceimage

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"songframe/internal/cast"
	"songframe/internal/projectfs"
)

// link — создание жёсткой ссылки; точка подмены для теста резерва копированием.
var link = os.Link

// snapshot — резерв source/ и plan/cast.json на время сохранения исходников с кастингом.
//
// Файлы резерва — жёсткие ссылки на те же данные, а не копии трека и изображений, и
// только при невозможности ссылки (другой том, ФС без ссылок) — копии. Ссылка корректна, потому
// что sourceedit и cast никогда не пишут в существующий файл на месте: замена идёт через
// временный файл и rename, удаление — unlink, поэтому прежние данные под ссылкой резерва не
// меняются. Старые байты кастинга хранятся в памяти и дополнительно в резерве (plan/cast.json),
// чтобы при неудачном откате папка резерва содержала оба документа.
type snapshot struct {
	project string
	// dir — временная папка резерва: source/ и plan/cast.json.
	dir string
	// sourceExisted — была ли папка source/ до сохранения (первое сохранение её создаёт).
	sourceExisted bool
	// cast — прежние байты plan/cast.json.
	cast []byte
}

// takeSnapshot создаёт резерв. Ошибка удаляет недоделанный резерв; проект при этом не меняется.
func takeSnapshot(project string) (*snapshot, error) {
	castBytes, err := os.ReadFile(cast.Path(project))
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "songframe-source-save-")
	if err != nil {
		return nil, err
	}
	s := &snapshot{project: project, dir: dir, cast: castBytes}
	if err := s.fill(); err != nil {
		s.remove()
		return nil, err
	}
	return s, nil
}

// fill раскладывает резерв: копию кастинга и дерево source/ из ссылок или копий.
func (s *snapshot) fill() error {
	if err := os.MkdirAll(filepath.Join(s.dir, "plan"), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(s.dir, "plan", "cast.json"), s.cast, 0o600); err != nil {
		return err
	}
	source := filepath.Join(s.project, "source")
	info, err := os.Lstat(source)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	s.sourceExisted = true
	return place(source, filepath.Join(s.dir, "source"), info)
}

// restore возвращает source/ и plan/cast.json к состоянию резерва. Меняются только отличающиеся
// записи: файлы, оставшиеся той же жёсткой ссылкой, не трогаются, новые удаляются, заменённые и
// удалённые возвращаются. Итоговое дерево совпадает с резервом; при неудаче резерв остаётся целым.
func (s *snapshot) restore() error {
	source := filepath.Join(s.project, "source")
	if s.sourceExisted {
		if err := syncTree(filepath.Join(s.dir, "source"), source); err != nil {
			return err
		}
	} else if err := os.RemoveAll(source); err != nil {
		return err
	}
	path := cast.Path(s.project)
	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, s.cast) {
		return nil
	}
	// Мимо шлюза записи: откат восстанавливает прежнее состояние, а не публикует новое.
	return projectfs.WriteFile(path, s.cast, 0)
}

// remove удаляет резерв после успешного сохранения или отката; nil-резерв допустим.
func (s *snapshot) remove() {
	if s != nil {
		_ = os.RemoveAll(s.dir)
	}
}

// syncTree приводит current к want (оба — пути одного вида записи или current отсутствует).
// Совпадающие файлы (os.SameFile — та же ссылка) и символические ссылки с тем же целевым путём
// остаются, лишние записи current удаляются, недостающие и отличающиеся создаются заново.
func syncTree(want, current string) error {
	wantInfo, err := os.Lstat(want)
	if err != nil {
		return err
	}
	currentInfo, err := os.Lstat(current)
	if errors.Is(err, fs.ErrNotExist) {
		return place(want, current, wantInfo)
	}
	if err != nil {
		return err
	}
	switch {
	case wantInfo.IsDir() && currentInfo.IsDir():
		return syncDir(want, current, wantInfo, currentInfo)
	case wantInfo.Mode().IsRegular() && os.SameFile(wantInfo, currentInfo):
		return nil
	case wantInfo.Mode()&fs.ModeSymlink != 0 && currentInfo.Mode()&fs.ModeSymlink != 0:
		wantTarget, err := os.Readlink(want)
		if err != nil {
			return err
		}
		if currentTarget, err := os.Readlink(current); err == nil && currentTarget == wantTarget {
			return nil
		}
	}
	if err := os.RemoveAll(current); err != nil {
		return err
	}
	return place(want, current, wantInfo)
}

// syncDir согласует содержимое двух папок и возвращает папке прежние права, если они менялись.
func syncDir(want, current string, wantInfo, currentInfo fs.FileInfo) error {
	entries, err := os.ReadDir(current)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		_, err := os.Lstat(filepath.Join(want, entry.Name()))
		if errors.Is(err, fs.ErrNotExist) {
			if err := os.RemoveAll(filepath.Join(current, entry.Name())); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	wanted, err := os.ReadDir(want)
	if err != nil {
		return err
	}
	for _, entry := range wanted {
		if err := syncTree(filepath.Join(want, entry.Name()), filepath.Join(current, entry.Name())); err != nil {
			return err
		}
	}
	if currentInfo.Mode().Perm() != wantInfo.Mode().Perm() {
		return os.Chmod(current, wantInfo.Mode().Perm())
	}
	return nil
}

// place создаёт to по образцу from (info — его Lstat): папку с содержимым и правами образца,
// символическую ссылку с тем же целевым путём или файл — жёсткой ссылкой либо копией.
func place(from, to string, info fs.FileInfo) error {
	mode := info.Mode()
	switch {
	case mode.IsDir():
		// Права ставятся после заполнения: папка без права записи иначе не приняла бы содержимое.
		if err := os.Mkdir(to, 0o700); err != nil {
			return err
		}
		entries, err := os.ReadDir(from)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			child, err := os.Lstat(filepath.Join(from, entry.Name()))
			if err != nil {
				return err
			}
			if err := place(filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name()), child); err != nil {
				return err
			}
		}
		return os.Chmod(to, mode.Perm())
	case mode&fs.ModeSymlink != 0:
		target, err := os.Readlink(from)
		if err != nil {
			return err
		}
		return os.Symlink(target, to)
	}
	if err := link(from, to); err == nil {
		return nil
	}
	return copyFile(from, to, mode.Perm())
}

// copyFile копирует данные и права файла; запасной путь, когда жёсткая ссылка невозможна.
func copyFile(from, to string, perm fs.FileMode) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(target, source)
	if closeErr := target.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(to, perm)
	}
	if err != nil {
		_ = os.Remove(to)
	}
	return err
}
