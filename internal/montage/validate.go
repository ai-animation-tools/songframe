package montage

import (
	"errors"
	"path/filepath"

	"songframe-go/internal/jscompat"
)

// checkedDraft — черновик после validate: сам объект, имя, музыка и участки по порядку.
type checkedDraft struct {
	object *jscompat.Object
	name   string
	audio  *jscompat.Object
	clips  []*jscompat.Object
}

// validate — Montage.validate(project, value, complete, view, checkFiles). Незавершённый черновик
// (complete=false) проверяется структурно: снимок SHA, переносимые пути (с checkFiles — и наличие
// файлов), кадровые границы, неповторяющиеся сцены и фрагменты, длина участка в пределах известной
// длины исходника. Полный (complete) дополнительно требует сцены текущего реестра, равенство длины
// видеодорожки участку музыки, текущий трек и участок внутри песни. Первая ошибка — текст оригинала.
func validate(project string, value any, complete bool, view *View, checkFiles bool) (checkedDraft, error) {
	object, ok := jscompat.AsObject(value)
	if !ok {
		return checkedDraft{}, errors.New(textInvalidDraft)
	}
	name, nameOK := object.Value("name").(string)
	audio, audioOK := jscompat.AsObject(object.Value("audio"))
	clips, clipsOK := jscompat.AsArray(object.Value("clips"))
	if !jscompat.StrictEqual(object.Value("schema_version"), 1.0) || !nameOK || !audioOK || !clipsOK {
		return checkedDraft{}, errors.New(textInvalidDraft)
	}
	scenesSha, shaOK := object.Value("base_scenes_sha256").(string)
	snapshot, snapshotOK := jscompat.AsObject(object.Value("base_manifest_sha256"))
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
		clip, ok := jscompat.AsObject(item)
		var id, scene string
		if ok {
			id, _ = clip.Value("id").(string)
			scene, _ = clip.Value("scene").(string)
		}
		_, idString := jscompat.Get(item, "id").(string)
		_, sceneString := jscompat.Get(item, "scene").(string)
		if !ok || !idString || id == "" || ids[id] || !sceneString || !shotPattern.MatchString(scene) || scenes[scene] {
			return checkedDraft{}, errors.New(textDuplicateClip)
		}
		ids[id], scenes[scene] = true, true
		kind := clip.Value("kind")
		if !jscompat.StrictEqual(kind, "video") && !jscompat.StrictEqual(kind, "card") {
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
				if jscompat.StrictEqual(path, source.Path) && source.Scene == scene && jscompat.StrictEqual(kind, source.Kind) {
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
			known, err := manifestLimit(project, scene, path, snapshot)
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
		if !jscompat.IsSafeInteger(total) {
			return checkedDraft{}, errors.New(textTotalLengthExceeded)
		}
		result.clips = append(result.clips, clip)
	}
	if complete {
		if len(clips) == 0 || total != end.(float64)-start.(float64) {
			return checkedDraft{}, errors.New(textLengthMismatch)
		}
		if view.TrackPath == nil || !jscompat.StrictEqual(audio.Value("path"), *view.TrackPath) {
			return checkedDraft{}, errors.New(textAudioChanged)
		}
		if view.Duration != nil && jscompat.IsFinite(*view.Duration) && end.(float64) > secondsToFrames(*view.Duration) {
			return checkedDraft{}, errors.New(textAudioBoundsExceeded)
		}
	}
	return result, nil
}

// manifestLimit — известная длина выбранного видео по текущему манифесту сцены, если снимок
// черновика совпадает с ним: original (по original_media) или принятый клип (frames). Иначе nil.
func manifestLimit(project, scene string, path any, snapshot *jscompat.Object) (*float64, error) {
	dir := filepath.Join(project, "assets", "shots", scene)
	manifestPath := filepath.Join(dir, "manifest.json")
	if !jscompat.Exists(manifestPath) {
		return nil, nil
	}
	digest, err := fileHash(manifestPath)
	if err != nil {
		return nil, err
	}
	if !jscompat.StrictEqual(snapshot.Value(scene), digest) {
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
	}{{generation.Value("original"), originalFrames(generation.Value("original_media"))}, {edit.Value("video"), editFrames}} {
		descriptor, ok := jscompat.AsObject(candidate.descriptor)
		if !ok {
			continue
		}
		name, ok := descriptor.Value("path").(string)
		if !ok {
			continue
		}
		base := dir
		if jscompat.StrictEqual(descriptor.Value("root"), "source") {
			base = filepath.Join(project, "source")
		}
		if jscompat.StrictEqual(path, portable(project, join(base, name))) && candidate.frames != nil {
			limit = candidate.frames
		}
	}
	return limit, nil
}
