package production

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"songframe/internal/acceptshot"
	"songframe/internal/dynvalue"
	"songframe/internal/jobs"
	"songframe/internal/mediacmd"
	"songframe/internal/montage"
	"songframe/internal/projectfile"
)

// CutPreview — предпросмотр монтажного участка в окне приёмки: участок оригинала с той же
// скоростью и удержаниями, что у будущей приёмки (acceptshot.RenderCut), под звук окна песни, и
// строки песни, попадающие в окно, для отметок на шкале плеера.
type CutPreview struct {
	// Path — абсолютный путь ролика предпросмотра в preview/ попытки (вне Git клипа, удаляется
	// вместе с попыткой); renderer открывает его через shell.fileUrl.
	Path string `json:"path"`
	// Frames — длина ролика в кадрах: ровно окно плана.
	Frames int `json:"frames"`
	// Audio — в ролик наложен участок песни окна плана; false — файла песни нет.
	Audio bool `json:"audio"`
	// Lines — строки песни, пересекающие окно, в секундах от начала окна (могут начинаться до
	// него или кончаться после).
	Lines []CutPreviewLine `json:"lines"`
	// LyricProblem — почему строк нет: разметки нет, трек сменился и т. п.
	LyricProblem *string `json:"lyricProblem"`
}

// CutPreviewLine — строка песни на шкале предпросмотра.
type CutPreviewLine struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// cutPreviewPrefix — начало имени ролика предпросмотра в preview/ попытки.
const cutPreviewPrefix = "cut-"

// CutPreviewFor рендерит предпросмотр участка options попытки packageDir. Ролик с теми же
// оригиналом, участком, окном и песней уже есть — он возвращается без рендера; прежние ролики
// предпросмотра попытки удаляются (занятый плеером файл остаётся до следующего раза). Проект и
// попытка не меняются: файл лежит в preview/ попытки, как сводка результата, и в токен результата
// не входит. Участок, который приёмка отклонит, отклоняется тем же текстом.
func CutPreviewFor(ctx context.Context, project, packageDir string, options AcceptOptions) (*CutPreview, error) {
	view, err := ReadPackage(project, packageDir)
	if err != nil {
		return nil, err
	}
	if view == nil || view.Request == nil || len(view.Request.Downloads) == 0 {
		return nil, errors.New(textCompleteResultRequired)
	}
	return renderCutPreview(ctx, project, view.Shot, view.Request.Downloads[0], filepath.Join(view.Dir, "preview"), options)
}

// renderCutPreview — предпросмотр участка options оригинала original плана shot в папке directory.
func renderCutPreview(ctx context.Context, project, shot, original, directory string, options AcceptOptions) (*CutPreview, error) {
	fps := projectfile.FPS(project)
	first, err := cutFrame(options.CutStart, fps)
	if err != nil {
		return nil, err
	}
	last, err := cutFrame(options.CutEnd, fps)
	if err != nil {
		return nil, err
	}
	if last <= first {
		return nil, errors.New(textAcceptEndInvalid)
	}
	holdFirst, holdLast := int64(options.HoldFirst), int64(options.HoldLast)
	if float64(holdFirst) != options.HoldFirst || float64(holdLast) != options.HoldLast || holdFirst < 0 || holdLast < 0 {
		return nil, errors.New(textCutPreviewHolds)
	}
	speed := options.Speed
	if speed == "" {
		speed = "1"
	}
	scene, track := sceneAndTrack(project, shot)
	if scene == nil {
		return nil, fmt.Errorf("%s: плана нет в сценарии", shot)
	}
	windowStart, windowEnd := dynvalue.ToNumber(dynvalue.Get(scene, "start_frame")), dynvalue.ToNumber(dynvalue.Get(scene, "end_frame_exclusive"))
	song := ""
	if track != "" {
		if candidate := filepath.Join(project, filepath.FromSlash(track)); fileExists(candidate) {
			song = candidate
		}
	}
	parts, err := speedParts(options, fps)
	if err != nil {
		return nil, err
	}
	if len(parts) > 0 {
		speed = "parts:" + speedPartsArg(parts)
	}
	key, err := cutPreviewKey(original, song, first, last, speed, holdFirst, holdLast, windowStart, windowEnd, fps)
	if err != nil {
		return nil, err
	}
	target := filepath.Join(directory, cutPreviewPrefix+key+".mp4")
	if !fileExists(target) {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return nil, err
		}
		silent := filepath.Join(directory, ".cut-"+key+"-video.mp4")
		_ = os.Remove(silent)
		cut := acceptshot.CutPreview{Start: int64(first), End: int64(last), Speed: options.Speed, SpeedParts: parts, HoldFirst: holdFirst, HoldLast: holdLast}
		if err := acceptshot.RenderCut(ctx, project, shot, original, cut, silent); err != nil {
			return nil, err
		}
		err := withSong(ctx, silent, song, windowStart/fps, (windowEnd-windowStart)/fps, target)
		_ = os.Remove(silent)
		if err != nil {
			return nil, err
		}
	}
	removeOtherPreviews(directory, filepath.Base(target))
	result := &CutPreview{Path: target, Frames: int(windowEnd - windowStart), Audio: song != "", Lines: []CutPreviewLine{}}
	lines, problem, err := montage.Lyrics(project, fps)
	if err != nil {
		return nil, err
	}
	result.LyricProblem = problem
	for _, line := range lines {
		if line.EndFrame <= windowStart || line.StartFrame >= windowEnd {
			continue
		}
		result.Lines = append(result.Lines, CutPreviewLine{Text: line.Text, Start: (line.StartFrame - windowStart) / fps, End: (line.EndFrame - windowStart) / fps})
	}
	return result, nil
}

// sceneAndTrack — план shot из plan/scenes.json и путь песни реестра (audio.path); nil — плана нет.
func sceneAndTrack(project, shot string) (any, string) {
	registry := readJSON(filepath.Join(project, "plan", "scenes.json"))
	track, _ := dynvalue.Get(dynvalue.Get(registry, "audio"), "path").(string)
	list, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	for _, scene := range list {
		if dynvalue.StrictEqual(dynvalue.Get(scene, "id"), shot) {
			return scene, track
		}
	}
	return nil, track
}

// cutPreviewKey — начало SHA-256 всего, от чего зависит ролик: оригинал и песня (путь, размер,
// время изменения), участок, скорость, удержания, окно и частота.
func cutPreviewKey(original, song string, first, last int, speed string, holdFirst, holdLast int64, windowStart, windowEnd, fps float64) (string, error) {
	hash := sha256.New()
	for _, path := range []string{original, song} {
		if path == "" {
			hash.Write([]byte("-\x00"))
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(hash, "%s\x00%d\x00%d\x00", path, info.Size(), info.ModTime().UnixNano())
	}
	fmt.Fprintf(hash, "%d:%d\x00%s\x00%d:%d\x00%s:%s\x00%s", first, last, speed, holdFirst, holdLast,
		strconv.FormatFloat(windowStart, 'f', -1, 64), strconv.FormatFloat(windowEnd, 'f', -1, 64), strconv.FormatFloat(fps, 'f', -1, 64))
	return hex.EncodeToString(hash.Sum(nil))[:16], nil
}

// withSong — ролик video с участком песни song от start секунд длиной length; без песни — копия
// ролика. Видео не перекодируется. Результат пишется во временный файл и переименовывается.
func withSong(ctx context.Context, video, song string, start, length float64, target string) error {
	partial := target + ".partial.mp4"
	_ = os.Remove(partial)
	args := []string{"-v", "error", "-nostdin", "-n", "-i", video}
	if song != "" {
		args = append(args, "-ss", strconv.FormatFloat(start, 'f', -1, 64), "-i", song, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
			"-t", strconv.FormatFloat(length, 'f', -1, 64))
	} else {
		args = append(args, "-map", "0:v:0", "-c:v", "copy")
	}
	if _, err := mediacmd.AnimaticRun(ctx, mediacmd.FFmpeg(), append(args, partial)...); err != nil {
		_ = os.Remove(partial)
		return err
	}
	if err := os.Rename(partial, target); err != nil {
		_ = os.Remove(partial)
		return err
	}
	return nil
}

// removeOtherPreviews удаляет прежние ролики предпросмотра участка, кроме keep. Ошибка удаления
// (файл держит плеер) не мешает показу нового.
func removeOtherPreviews(directory, keep string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if name != keep && strings.HasPrefix(name, cutPreviewPrefix) && strings.HasSuffix(name, ".mp4") {
			_ = os.Remove(filepath.Join(directory, name))
		}
	}
}

// fileExists — обычный файл по пути есть.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// Recut — задание «Участок Mxx»: принятый план получает новый участок из оригинала своего
// комплекта (acceptshot.Recut) без повторной загрузки, новой попытки и записи расхода. Пока идёт
// задание плана, второе не начинается.
func (s *Service) Recut(project, shot string, options AcceptOptions) (jobs.Info, error) {
	fps := projectfile.FPS(project)
	first, err := cutFrame(options.CutStart, fps)
	if err != nil {
		return jobs.Info{}, err
	}
	last, err := cutFrame(options.CutEnd, fps)
	if err != nil {
		return jobs.Info{}, err
	}
	if last <= first {
		return jobs.Info{}, errors.New(textAcceptEndInvalid)
	}
	holdFirst, holdLast := int64(options.HoldFirst), int64(options.HoldLast)
	if float64(holdFirst) != options.HoldFirst || float64(holdLast) != options.HoldLast || holdFirst < 0 || holdLast < 0 {
		return jobs.Info{}, errors.New(textCutPreviewHolds)
	}
	if !dynvalue.Exists(filepath.Join(project, "assets", "shots", shot, "manifest.json")) {
		return jobs.Info{}, errors.New(textRecutNoKit)
	}
	key := shotKey(project, shot)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running(s.shotJobs[key]) {
		return jobs.Info{}, errors.New(textRecutBusy)
	}
	parts, err := speedParts(options, fps)
	if err != nil {
		return jobs.Info{}, err
	}
	cut := acceptshot.CutPreview{Start: int64(first), End: int64(last), Speed: options.Speed, SpeedParts: parts, HoldFirst: holdFirst, HoldLast: holdLast}
	step := jobs.Step{
		Tool: "recut_shot", Label: textRecutStep,
		Run: func(ctx context.Context, step *jobs.StepContext) error {
			_, err := acceptshot.Recut(ctx, project, shot, cut)
			return err
		},
	}
	info, err := s.start(jobs.KindAccept, textRecutJob(shot), project, []jobs.Step{step})
	if err != nil {
		return jobs.Info{}, err
	}
	s.shotJobs[key] = info.ID
	return info, nil
}

// RecutPreview — предпросмотр нового участка принятого плана: тот же ролик, что даст Recut, из
// оригинала комплекта, под звук окна песни. Ролик пишется в каталог состояния приложения
// (Options.LocalDir) в папку этого плана проекта: в комплекте и в Git клипа он не появляется.
func (s *Service) RecutPreview(ctx context.Context, project, shot string, options AcceptOptions) (*CutPreview, error) {
	original := filepath.Join(project, "assets", "shots", shot, "original.mp4")
	if !fileExists(original) {
		return nil, errors.New(textRecutNoKit)
	}
	base := s.options.LocalDir
	if base == "" {
		base = os.TempDir()
	}
	sum := sha256.Sum256([]byte(dynvalue.Resolve(project) + "\x00" + shot))
	directory := filepath.Join(base, "recut-preview", hex.EncodeToString(sum[:])[:16])
	return renderCutPreview(ctx, project, shot, original, directory, options)
}
