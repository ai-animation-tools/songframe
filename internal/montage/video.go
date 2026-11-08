package montage

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
)

// reviewVideo — готовая проба ручного монтажа от корня проекта.
var reviewVideo = regexp.MustCompile(`^plan/batches/review-manual-[\w-]+/review\.mp4$`)

// workFolders — папки рабочих материалов проекта, куда нельзя сохранять копию пробы.
var workFolders = regexp.MustCompile(`^(source|assets|plan)(/|\\|$)`)

// VideoPath — montageVideoPath(project, video): абсолютный путь готовой пробы
// plan/batches/review-manual-…/review.mp4, если рядом есть рецепт build_review с video_sha256 и
// положительным total_frames. Экспорт копирует только завершённую пробу.
func VideoPath(project, video string) (string, error) {
	path := jscompat.Resolve(project, video)
	name := filepath.ToSlash(jscompat.Relative(jscompat.Resolve(project), path))
	if !reviewVideo.MatchString(name) || !jscompat.Exists(path) {
		return "", errors.New(textExportVideoMissing)
	}
	recipe := path[:len(path)-4] + ".json"
	data, err := os.ReadFile(recipe)
	if err != nil {
		return "", errors.New(textExportRecipeMissing)
	}
	manifest, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
	if err != nil {
		return "", errors.New(textExportRecipeMissing)
	}
	sha, err := jscompat.Prop(manifest, "video_sha256")
	if err != nil {
		return "", err
	}
	frames, _ := jscompat.Prop(manifest, "total_frames")
	if !jscompat.Truthy(sha) || !(jscompat.ToNumber(frames) > 0) {
		return "", errors.New(textExportUnconfirmed)
	}
	return path, nil
}

// extname — path.extname: суффикс после последней точки имени; имя с единственной ведущей
// точкой («.mp4») расширения не имеет.
func extname(path string) string {
	base := filepath.Base(path)
	index := strings.LastIndex(base, ".")
	if index <= 0 || strings.Trim(base, ".") == "" {
		return ""
	}
	return base[index:]
}

// CopyVideo — copyMontageVideo(project, video, destination): копия готовой пробы в выбранный файл
// (с суффиксом .mp4, если его нет). Назначение внутри source, assets или plan проекта отклоняется:
// там хранятся рабочие материалы. Копия пишется во временный файл рядом и переименовывается, чтобы
// ошибка не оставила обрезанный MP4. Возвращает абсолютный путь назначения.
func CopyVideo(project, video, destination string) (string, error) {
	source, err := VideoPath(project, video)
	if err != nil {
		return "", err
	}
	if strings.ToLower(extname(destination)) != ".mp4" {
		destination += ".mp4"
	}
	target := jscompat.Resolve(destination)
	root, err := jscompat.Realpath(project)
	if err != nil {
		return "", err
	}
	actual := ""
	if jscompat.Exists(target) {
		if actual, err = jscompat.Realpath(target); err != nil {
			return "", err
		}
	} else {
		parent, err := jscompat.Realpath(filepath.Dir(target))
		if err != nil {
			return "", err
		}
		actual = filepath.Join(parent, filepath.Base(target))
	}
	name := jscompat.Relative(root, actual)
	inside := name != ".." && !strings.HasPrefix(name, ".."+string(filepath.Separator)) && !jscompat.IsAbs(name)
	if inside && workFolders.MatchString(name) {
		return "", errors.New(textExportDestination)
	}
	temporary := target + "." + RandomUUID() + ".tmp"
	defer os.Remove(temporary)
	if err := copyFile(source, temporary); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, target); err != nil {
		return "", jscompat.FsError("rename", temporary, err)
	}
	return target, nil
}

// copyFile — fs.copyFile: байты и права источника; ошибка — текст node:fs.
func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return jscompat.FsError("copyfile", source, err)
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return jscompat.FsError("copyfile", source, err)
	}
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return jscompat.FsError("copyfile", source, err)
	}
	_, err = io.Copy(output, input)
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return jscompat.FsError("copyfile", source, err)
	}
	return nil
}
