package productionworkflow

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/mediafile"
)

// Опоры и материалы для задания видеопромпта. Видеопромпт описывает движение от первой опоры к
// последней, поэтому агент должен видеть сами опоры, а не их промпты: опора могла получиться иначе,
// чем её описали (куртка уже расстёгнута, взгляд в другую сторону, пропал предмет). Утверждённые
// опоры попытки и при стыке последний кадр сюжетного предшественника уходят уменьшенными
// JPEG-вложениями; остальное (изображения сущностей, опоры и монтаж принятых связанных планов)
// агент открывает сам по путям из materials — он работает в папке проекта только на чтение.

const (
	// promptFrameSide — наибольшая сторона вложения: композиция, поза, руки и предметы различимы,
	// а несколько опор остаются в бюджете вложений любого агента (docs/agent-image-limits.md).
	promptFrameSide = 960
	// promptFrameQuality — качество JPEG вложения.
	promptFrameQuality = 85
)

// promptAttachments — вложения и ключи контекста этапа prompt: attachedFrames (утверждённые опоры
// по порядку плана и последний кадр предшественника) и materials. Сбой подготовки вложения не
// останавливает задание: в attachedFrames такой кадр отмечен attached=false, а агент получает
// problem и смотрит файл по пути сам.
func (w *Workflow) promptAttachments(ctx context.Context, c *Context, shot string) (images []string, attached *dynvalue.Array, materials *dynvalue.Object) {
	images = []string{}
	attached = &dynvalue.Array{Items: []any{}}
	directory, dirErr := w.attachmentsDir(c.Project, shot)
	problem := ""
	fail := func(err error) {
		if problem == "" {
			problem = textPromptFramesFailed(err.Error())
		}
	}
	if dirErr != nil {
		fail(dirErr)
	}
	for _, item := range keyframes(c.Workflow) {
		if !dynvalue.Truthy(dynvalue.Get(item, "approved")) || !dynvalue.Truthy(dynvalue.Get(item, "path")) {
			continue
		}
		source, err := packageFile(c, dynvalue.Get(item, "path"))
		if err != nil {
			continue
		}
		id, _ := dynvalue.Get(item, "id").(string)
		entry := dynvalue.NewObject()
		entry.Set("id", id)
		entry.Set("role", dynvalue.Get(item, "role"))
		entry.Set("timeSeconds", dynvalue.Get(item, "time_seconds"))
		entry.Set("path", rel(c.Project, source))
		ok := false
		if dirErr == nil {
			target := filepath.Join(directory, "frame-"+id+".jpg")
			data, err := mediafile.ShrinkJPEG(source, promptFrameSide, promptFrameQuality)
			if err == nil {
				err = os.WriteFile(target, data, 0o666)
			}
			if err != nil {
				fail(err)
			} else {
				images = append(images, target)
				ok = true
			}
		}
		entry.Set("attached", ok)
		attached.Items = append(attached.Items, entry)
	}
	frames, _, err := shotFrames(c.Project, shot)
	if err != nil {
		fail(err)
	}
	// Стык с предшественником: его последний кадр — то, после чего идёт склейка.
	if index := slices.IndexFunc(frames, func(frame ShotFrame) bool { return frame.Reason == "state_from" && frame.Position == "last" }); index >= 0 {
		frame := frames[index]
		entry := dynvalue.NewObject()
		entry.Set("shot", frame.Shot)
		entry.Set("position", frame.Position)
		ok := false
		if dirErr == nil {
			target := filepath.Join(directory, frame.Shot+"-"+frame.Position+".jpg")
			if err := w.options.ExtractFrame(ctx, acceptedVideo(c.Project, frame.Shot), frame.Position, target, promptFrameSide); err != nil {
				fail(err)
			} else {
				images = append(images, target)
				ok = true
			}
		}
		entry.Set("attached", ok)
		attached.Items = append(attached.Items, entry)
	}
	materials = dynvalue.NewObject()
	sourcesList := []any{}
	for _, path := range c.AllowedPaths {
		if strings.HasPrefix(path, "source/") {
			sourcesList = append(sourcesList, path)
		}
	}
	materials.Set("sources", &dynvalue.Array{Items: sourcesList})
	shots := []any{}
	seen := map[string]bool{}
	for _, frame := range frames {
		if seen[frame.Shot] {
			continue
		}
		seen[frame.Shot] = true
		shots = append(shots, acceptedShotMaterials(c.Project, frame.Shot))
	}
	materials.Set("acceptedShots", &dynvalue.Array{Items: shots})
	materials.Set("problem", problem)
	return images, attached, materials
}

// acceptedShotMaterials — файлы принятого плана для просмотра агентом: опоры запроса
// (generation-input-N.*, по порядку входов) и монтаж видео.
func acceptedShotMaterials(project, shot string) *dynvalue.Object {
	folder := filepath.Join(project, "assets", "shots", shot)
	inputs := []any{}
	if matches, err := filepath.Glob(filepath.Join(folder, "generation-input-*")); err == nil {
		slices.Sort(matches)
		for _, match := range matches {
			if mediafile.IsImage(match) {
				inputs = append(inputs, rel(project, match))
			}
		}
	}
	value := dynvalue.NewObject()
	value.Set("shot", shot)
	value.Set("frames", &dynvalue.Array{Items: inputs})
	if video := acceptedVideo(project, shot); video != "" {
		value.Set("video", rel(project, video))
	} else {
		value.Set("video", nil)
	}
	return value
}
