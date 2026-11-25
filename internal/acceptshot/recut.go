package acceptshot

import (
	"context"
	"os"
	"path/filepath"

	"songframe/internal/assetpackage"
	"songframe/internal/mediacmd"
	"songframe/internal/sceneregistry"
	"songframe/internal/sceneviews"
	"songframe/internal/toolrt"
)

// Тексты отказов смены участка принятого плана.
const (
	textRecutNoKit      = ": у плана нет принятого комплекта."
	textRecutNotVideo   = ": участок меняется только у плана, принятого из видео генерации или своего видео."
	textRecutNoOriginal = ": в комплекте нет оригинала original.mp4."
)

// Recut — новый участок принятого плана shot из оригинала его комплекта (assets/shots/Mxx/
// original.mp4) без повторной загрузки и новой попытки. Рендер тот же, что у приёмки участка
// (planEdit, renderEdit) в текущее окно плана. В комплекте меняются только video.mp4 и рецепт
// участка в manifest.json (accepted_edit: ролик, кадры, интервал, скорость, удержания, рецепт
// пересборки); оригинал, опоры, промпт, сведения о получении видео и запись отпечатка постановки
// в production-status.json остаются. Прежний ролик не сохраняется: он пересобирается из того же
// оригинала по прежнему рецепту и есть в истории Git клипа. Журнал расхода не меняется.
//
// Ролик и манифест пишутся во временные файлы комплекта и ставятся на место переименованием;
// если манифест не встал, прежний ролик возвращается. Эффект поверх плана после смены ролика
// устаревает сам (его источник — SHA принятого видео) и ждёт на странице «Эффекты» с прежними
// параметрами.
func Recut(ctx context.Context, root, shot string, cut CutPreview) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	if err := sceneregistry.SameFPS(root, registry); err != nil {
		return nil, err
	}
	frames, err := windowFrames(registry, shot)
	if err != nil {
		return nil, err
	}
	fps := sceneregistry.FPS(registry.Value("fps"))
	kit := toolrt.JoinPath(root, "assets", "shots", shot)
	manifestPath := toolrt.JoinPath(kit, "manifest.json")
	if !toolrt.IsFile(manifestPath) {
		return nil, valueError(shot + textRecutNoKit)
	}
	if _, err := assetpackage.ValidatePackage(manifestPath, shot, root); err != nil {
		return nil, err
	}
	loaded, err := loadJSON(manifestPath)
	if err != nil {
		return nil, err
	}
	manifest := dict(loaded)
	edit := dict(manifest.Value("accepted_edit"))
	if !toolrt.Equal(manifest.Value("kind"), "generated_video") || edit == nil {
		return nil, valueError(shot + textRecutNotVideo)
	}
	original := toolrt.JoinPath(kit, "original.mp4")
	if !toolrt.IsFile(original) {
		return nil, valueError(shot + textRecutNoOriginal)
	}
	bounds := [2]toolrt.Int{toolrt.NewInt(cut.Start), toolrt.NewInt(cut.End)}
	speedText := cut.Speed
	if speedText == "" {
		speedText = "1"
	}
	options := Options{Cut: &bounds, Speed: speedText, HoldFirst: toolrt.NewInt(cut.HoldFirst), HoldLast: toolrt.NewInt(cut.HoldLast)}
	plan, err := planEdit(ctx, shot, original, frames, fps, root, options)
	if err != nil {
		return nil, err
	}
	partial := toolrt.JoinPath(kit, ".recut-video.mp4")
	_ = os.Remove(partial)
	if err := renderEdit(ctx, original, plan.filter, frames, partial, fps); err != nil {
		_ = os.Remove(partial)
		return nil, err
	}
	video, err := descriptor(kit, filepath.Base(partial))
	if err != nil {
		_ = os.Remove(partial)
		return nil, err
	}
	video.Set("path", "video.mp4")
	speed, err := speedRecord(plan, fps)
	if err != nil {
		_ = os.Remove(partial)
		return nil, err
	}
	versionOutput, err := run(ctx, mediacmd.FFmpeg(), "-version")
	if err != nil {
		_ = os.Remove(partial)
		return nil, err
	}
	versionText, err := toolrt.DecodeUTF8(versionOutput)
	if err != nil {
		_ = os.Remove(partial)
		return nil, err
	}
	count := toolrt.IntFromBig(frames.Big())
	edit.Set("video", video)
	edit.Set("fps", toolrt.NewInt(fps))
	edit.Set("frames", count)
	edit.Set("duration_seconds", intFloat(frames.Big())/float64(fps))
	edit.Set("source_interval_seconds", plan.intervalSeconds)
	edit.Set("speed", speed)
	edit.Set("hold_first_seconds", intFloat(plan.holdFirst)/float64(fps))
	edit.Set("hold_last_seconds", intFloat(plan.holdLast)/float64(fps))
	edit.Set("montage_source", toolrt.DeepCopy(video))
	if rebuild := dict(edit.Value("rebuild")); rebuild != nil {
		stage := toolrt.NewDict()
		stage.Set("input", "original.mp4")
		stage.Set("filter", plan.filter)
		stage.Set("frames", count)
		rebuild.Set("stages", []any{stage})
		if lines := toolrt.SplitLines(versionText); len(lines) > 0 {
			rebuild.Set("ffmpeg_version", lines[0])
		}
	}
	edit.Set("source_frame_interval_exclusive", []any{toolrt.IntFromBig(plan.start), toolrt.IntFromBig(plan.end)})
	manifestPartial := toolrt.JoinPath(kit, ".recut-manifest.json")
	if err := writeJSON(manifestPartial, manifest); err != nil {
		_ = os.Remove(partial)
		_ = os.Remove(manifestPartial)
		return nil, err
	}
	target := toolrt.JoinPath(kit, "video.mp4")
	previous := toolrt.JoinPath(kit, ".recut-previous.mp4")
	_ = os.Remove(previous)
	if err := os.Rename(target, previous); err != nil {
		_ = os.Remove(partial)
		_ = os.Remove(manifestPartial)
		return nil, toolrt.OSErrorFrom(err, target)
	}
	if err := os.Rename(partial, target); err != nil {
		_ = os.Rename(previous, target)
		_ = os.Remove(manifestPartial)
		return nil, toolrt.OSErrorFrom(err, target)
	}
	if err := os.Rename(manifestPartial, manifestPath); err != nil {
		_ = os.Rename(previous, target)
		_ = os.Remove(manifestPartial)
		return nil, toolrt.OSErrorFrom(err, manifestPath)
	}
	_ = os.Remove(previous)
	if _, err := assetpackage.ValidatePackage(manifestPath, shot, root); err != nil {
		return nil, err
	}
	if views := sceneviews.Run(root, []string{}); views.Code != 0 {
		return nil, toolrt.New("CalledProcessError", "команда завершилась с кодом "+toolrt.Str(toolrt.NewInt(int64(views.Code)))+": update_scene_views")
	}
	relative, _ := toolrt.RelativeTo(kit, root)
	result := toolrt.NewDict()
	result.Set("shot", shot)
	result.Set("target", relative)
	result.Set("frames", count)
	result.Set("video_sha256", video.Value("sha256"))
	return result, nil
}
