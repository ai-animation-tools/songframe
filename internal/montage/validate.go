package montage

import (
	"errors"
	"path/filepath"

	"songframe/internal/dynvalue"
)

// checkedDraft — черновик после validate: сам объект, имя, музыка и участки по порядку.
type checkedDraft struct {
	object *dynvalue.Object
	name   string
	audio  *dynvalue.Object
	clips  []*dynvalue.Object
}

// validate проверяет черновик монтажа. Незавершённый черновик
// (complete=false) проверяется структурно: снимок SHA, переносимые пути (с checkFiles — и наличие
// файлов), кадровые границы, неповторяющиеся сцены и фрагменты, длина участка в пределах известной
// длины исходника. Полный (complete) дополнительно требует сцены текущего реестра, равенство длины
// видеодорожки участку музыки, текущий трек и участок внутри песни. Возвращается первая ошибка;
// порядок проверок зафиксирован эталоном.
func validate(project string, value any, complete bool, view *View, checkFiles bool) (checkedDraft, error) {
	object, ok := dynvalue.AsObject(value)
	if !ok {
		return checkedDraft{}, errors.New(textInvalidDraft)
	}
	name, nameOK := object.Value("name").(string)
	audio, audioOK := dynvalue.AsObject(object.Value("audio"))
	clips, clipsOK := dynvalue.AsArray(object.Value("clips"))
	if !dynvalue.StrictEqual(object.Value("schema_version"), 1.0) || !nameOK || !audioOK || !clipsOK {
		return checkedDraft{}, errors.New(textInvalidDraft)
	}
	scenesSha, shaOK := object.Value("base_scenes_sha256").(string)
	snapshot, snapshotOK := dynvalue.AsObject(object.Value("base_manifest_sha256"))
	if !shaOK || !sha256Pattern.MatchString(scenesSha) || !snapshotOK {
		return checkedDraft{}, errors.New(textSnapshotMissing)
	}
	for _, scene := range snapshot.Keys() {
		sha, ok := snapshot.Value(scene).(string)
		if !shotPattern.MatchString(scene) || !ok || !sha256Pattern.MatchString(sha) {
			return checkedDraft{}, errors.New(textInvalidManifestSnapshot(scene))
		}
	}
	if _, err := projectPath(project, audio.Value("path"), checkFiles); err != nil {
		return checkedDraft{}, err
	}
	start, end := audio.Value("start_frame"), audio.Value("end_frame_exclusive")
	if !isFrame(start) || !isFrame(end) || end.(float64) < start.(float64) {
		return checkedDraft{}, errors.New(textInvalidAudioBounds)
	}
	result := checkedDraft{object: object, name: name, audio: audio}
	scenes, ids := map[string]bool{}, map[string]bool{}
	total := 0.0
	for _, item := range clips {
		clip, ok := dynvalue.AsObject(item)
		var id, scene string
		if ok {
			id, _ = clip.Value("id").(string)
			scene, _ = clip.Value("scene").(string)
		}
		_, idString := dynvalue.Get(item, "id").(string)
		_, sceneString := dynvalue.Get(item, "scene").(string)
		if !ok || !idString || id == "" || ids[id] || !sceneString || !shotPattern.MatchString(scene) || scenes[scene] {
			return checkedDraft{}, errors.New(textDuplicateClip)
		}
		ids[id], scenes[scene] = true, true
		kind := clip.Value("kind")
		if !dynvalue.StrictEqual(kind, "video") && !dynvalue.StrictEqual(kind, "card") {
			return checkedDraft{}, errors.New(textUnknownClipKind(scene))
		}
		if _, err := projectPath(project, clip.Value("path"), checkFiles); err != nil {
			return checkedDraft{}, err
		}
		first, last := clip.Value("source_start_frame"), clip.Value("source_end_frame_exclusive")
		if !isFrame(first) || !isFrame(last) || last.(float64) <= first.(float64) {
			return checkedDraft{}, errors.New(textInvalidClipBounds(scene))
		}
		frames := clip.Value("source_frames")
		if frames != nil && (!isFrame(frames) || frames.(float64) == 0) {
			return checkedDraft{}, errors.New(textInvalidSourceLength(scene))
		}
		if kind == "card" && first.(float64) != 0 {
			return checkedDraft{}, errors.New(textInvalidCardStart(scene))
		}
		path := clip.Value("path")
		limit := frames
		if view != nil {
			for _, source := range view.Sources {
				if dynvalue.StrictEqual(path, source.Path) && source.Scene == scene && dynvalue.StrictEqual(kind, source.Kind) {
					if source.Frames != nil {
						limit = *source.Frames
					}
					break
				}
			}
		}
		// При сохранении известная длина проверяется и при source_frames=null. Изменённый комплект
		// не подменяет метаданные старого черновика: его всё ещё можно открыть и сохранить.
		if checkFiles && view == nil && kind == "video" {
			known, err := manifestLimit(project, scene, path, snapshot, gridFPS(project, view))
			if err != nil {
				return checkedDraft{}, err
			}
			if known != nil {
				limit = *known
			}
		}
		if bound, ok := number(limit); ok && kind == "video" && last.(float64) > bound {
			return checkedDraft{}, errors.New(textSourceBoundsExceeded(scene))
		}
		if complete {
			found := false
			for _, item := range view.Scenes {
				found = found || item.ID == scene
			}
			if !found {
				return checkedDraft{}, errors.New(textSceneMissing(scene))
			}
		}
		total += last.(float64) - first.(float64)
		if !dynvalue.IsSafeInteger(total) {
			return checkedDraft{}, errors.New(textTotalLengthExceeded)
		}
		result.clips = append(result.clips, clip)
	}
	if complete {
		if len(clips) == 0 || total != end.(float64)-start.(float64) {
			return checkedDraft{}, errors.New(textLengthMismatch)
		}
		if view.TrackPath == nil || !dynvalue.StrictEqual(audio.Value("path"), *view.TrackPath) {
			return checkedDraft{}, errors.New(textAudioChanged)
		}
		if view.Duration != nil && dynvalue.IsFinite(*view.Duration) && end.(float64) > secondsToFrames(*view.Duration, view.FPS) {
			return checkedDraft{}, errors.New(textAudioBoundsExceeded)
		}
	}
	return result, nil
}

// gridFPS — частота кадров шкалы черновика: из вида, если он передан, иначе из реестра сцен.
func gridFPS(project string, view *View) float64 {
	if view != nil {
		return view.FPS
	}
	return readRegistry(project).fps
}

// manifestLimit — известная длина выбранного видео по текущему манифесту сцены, если снимок
// черновика совпадает с ним: original (по original_media) или принятый клип (frames) в кадрах
// частоты fps. Иначе nil.
func manifestLimit(project, scene string, path any, snapshot *dynvalue.Object, fps float64) (*float64, error) {
	dir := filepath.Join(project, "assets", "shots", scene)
	manifestPath := filepath.Join(dir, "manifest.json")
	if !dynvalue.Exists(manifestPath) {
		return nil, nil
	}
	digest, err := fileHash(manifestPath)
	if err != nil {
		return nil, err
	}
	if !dynvalue.StrictEqual(snapshot.Value(scene), digest) {
		return nil, nil
	}
	manifest, err := readObject(manifestPath, labelSceneMaterials)
	if err != nil {
		return nil, err
	}
	generation, edit := section(manifest, "generation"), section(manifest, "accepted_edit")
	var editFrames *float64
	if value, ok := number(edit.Value("frames")); ok && isFrame(value) {
		editFrames = &value
	}
	var limit *float64
	for _, candidate := range []struct {
		descriptor any
		frames     *float64
	}{{generation.Value("original"), originalFrames(generation.Value("original_media"), fps)}, {edit.Value("video"), editFrames}} {
		descriptor, ok := dynvalue.AsObject(candidate.descriptor)
		if !ok {
			continue
		}
		name, ok := descriptor.Value("path").(string)
		if !ok {
			continue
		}
		base := dir
		if dynvalue.StrictEqual(descriptor.Value("root"), "source") {
			base = filepath.Join(project, "source")
		}
		if dynvalue.StrictEqual(path, portable(project, join(base, name))) && candidate.frames != nil {
			limit = candidate.frames
		}
	}
	return limit, nil
}
