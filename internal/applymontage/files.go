package applymontage

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	"songframe/internal/assetpackage"
	"songframe/internal/toolrt"
)

// Файловые операции транзакции монтажа: замена файла одним rename, SHA-256 или nil для
// отсутствующего файла и копия проекта в staging. Ошибки Go превращаются в OSError toolrt,
// чтобы CLI показывал общий скрытый текст.

// JSONBytes — JSON значения с отступом 2, без экранирования не-ASCII и с переводом строки в
// конце, в UTF-8.
func JSONBytes(value any) ([]byte, error) {
	text, err := toolrt.DumpsJSON(value, toolrt.Indented)
	if err != nil {
		return nil, err
	}
	return toolrt.EncodeUTF8(text + "\n")
}

// ReplaceBytes заменяет файл path данными data: они пишутся во временный «.<имя>.montage-tmp»
// рядом с целью, сбрасываются на диск и заменяют файл одним rename. Временный файл удаляется
// при любом исходе. Журнал транзакции пишется так же до публикации.
func ReplaceBytes(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return toolrt.OSErrorFrom(err, filepath.Dir(path))
	}
	temporary := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".montage-tmp")
	defer os.Remove(temporary)
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return toolrt.OSErrorFrom(err, temporary)
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return toolrt.OSErrorFrom(err, temporary)
	}
	if err := os.Rename(temporary, path); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}

// sha — SHA-256 содержимого файла.
func sha(path string) (string, error) { return assetpackage.FileSHA256(path) }

// DigestOrNone — SHA-256 обычного файла path или nil, если файла нет.
func DigestOrNone(path string) (any, error) {
	if !toolrt.IsFile(path) {
		return nil, nil
	}
	return sha(path)
}

// CopyFile копирует source в target: только байты, права нового файла по umask.
func CopyFile(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	if err := os.WriteFile(target, data, 0o666); err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	return nil
}

// CopyWithStat копирует байты, права и время изменения источника.
func CopyWithStat(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	_, err = io.Copy(output, input)
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	_ = os.Chmod(target, info.Mode().Perm())
	_ = os.Chtimes(target, info.ModTime(), info.ModTime())
	return nil
}

// mediaSuffixes — входы, которые staging только читает (CopyInput): их достаточно связать
// жёсткой ссылкой, а не копировать гигабайты видео.
var mediaSuffixes = map[string]bool{".mp4": true, ".mp3": true, ".wav": true}

// CopyInput переносит вход в staging: большие медиа — жёсткая ссылка (если ФС позволяет),
// прочие файлы — копия с метаданными. Копии нужны потому, что штатное обновление представлений
// переписывает Markdown и карточки на месте: ссылка изменила бы файл настоящего проекта.
func CopyInput(source, target string) error {
	if mediaSuffixes[strings.ToLower(filepath.Ext(source))] {
		if err := os.Link(source, target); err == nil {
			return nil
		}
	}
	return CopyWithStat(source, target)
}

// ignoredNames — имена, которые copyTree пропускает на любом уровне дерева.
var ignoredNames = map[string]bool{"montage-history": true, ".cache": true}

// copyTree копирует дерево с разыменованием символьных ссылок (файл — через CopyInput, каталог —
// рекурсивно), пропуская ignoredNames. Права каталогов копируются.
func copyTree(source, target string) error {
	info, err := os.Stat(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	if err := os.MkdirAll(target, 0o777); err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	for _, entry := range entries {
		if ignoredNames[entry.Name()] {
			continue
		}
		from, to := filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())
		stat, err := os.Stat(from)
		if err != nil {
			return toolrt.OSErrorFrom(err, from)
		}
		if stat.IsDir() {
			err = copyTree(from, to)
		} else {
			err = CopyInput(from, to)
		}
		if err != nil {
			return err
		}
	}
	_ = os.Chmod(target, info.Mode().Perm())
	return nil
}

// stageProject копирует в stage plan, assets и source проекта (без истории монтажа и
// кэша) и ROADMAP.md, если он есть. Отсутствующая папка — FileNotFoundError.
func stageProject(root, stage string) error {
	for _, folder := range []string{"plan", "assets", "source"} {
		if err := copyTree(filepath.Join(root, folder), filepath.Join(stage, folder)); err != nil {
			return err
		}
	}
	roadmap := filepath.Join(root, "ROADMAP.md")
	if toolrt.IsFile(roadmap) {
		return CopyWithStat(roadmap, filepath.Join(stage, "ROADMAP.md"))
	}
	return nil
}

// PublishFile — файл staging source заменяет файл проекта target, отсутствие
// файла в staging удаляет его в проекте. Отдельная функция — точка подмены тестов отката.
func PublishFile(source, target string) error {
	if toolrt.IsFile(source) {
		data, err := os.ReadFile(source)
		if err != nil {
			return toolrt.OSErrorFrom(err, source)
		}
		return ReplaceBytes(target, data)
	}
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return toolrt.OSErrorFrom(err, target)
	}
	return nil
}
