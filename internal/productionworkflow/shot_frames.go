package productionworkflow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediacmd"
	"songframe/internal/projectfs"
)

// Кадры других планов для сверки непрерывности описания. Врезка непрерывности передаёт состояние
// словами, а совпадение планировки, позы и света по словам не проверить: агенту описания нужны
// сами кадры уже принятых планов, а провайдеру изображений — те же кадры референсами опор.
//
// Нужен ли кадр, по реестру однозначно не определить: state_from — сюжетная связь, а не
// визуальная (жёсткая склейка в другое место тоже имеет предшественника), а упоминание плана в
// continuity бывает и контрастом. Поэтому приложение отбирает кандидатов строгими правилами
// (shotFrames), а решение, использовать ли кадр, принимает агент по тексту continuity.
//
// Кадры берутся из принятого монтажа плана (assets/shots/<план>/video.mp4 — ровно окно на шкале
// клипа): последний кадр — тот, после которого идёт склейка. Агенту описания уходят уменьшенные
// JPEG-вложения из каталога состояния; в пакет попытки (<пакет>/continuity/<план>-<first|last>.png)
// полноразмерный кадр извлекается только при применении описания, если его назвала опора.

// shotFramesLimit — сколько кадров других планов получает одно задание описания.
const shotFramesLimit = 6

// attachmentSide — наибольшая сторона вложения агенту в пикселях: кадр достаточно подробен для
// сверки и остаётся в бюджете вложений любого агента (docs/agent-image-limits.md).
const attachmentSide = 960

// frameTimeout — предел одного запуска FFmpeg на кадр.
const frameTimeout = 2 * time.Minute

// shotMention — ID плана в тексте continuity (производный план — с суффиксом .N).
var shotMention = regexp.MustCompile(`M\d{2}(?:\.\d+)?`)

// shotFrameFile — имя кадра в папке continuity пакета.
var shotFrameFile = regexp.MustCompile(`^(M\d{2}(?:\.\d+)?)-(first|last)\.png$`)

// ShotFrame — кадр другого плана: Shot — ID плана, Position — first или last, Reason — откуда
// связь: state_from (сюжетный предшественник) или continuity (план назван в тексте).
type ShotFrame struct {
	Shot     string
	Position string
	Reason   string
}

// path — путь кадра от проекта внутри пакета target.
func (f ShotFrame) path(project, target string) string {
	return rel(project, filepath.Join(target, "continuity", f.Shot+"-"+f.Position+".png"))
}

// acceptedVideo — принятый монтаж плана shot; "" — план не принят.
func acceptedVideo(project, shot string) string {
	folder := filepath.Join(project, "assets", "shots", shot)
	video := filepath.Join(folder, "video.mp4")
	if info, err := os.Stat(video); err != nil || !info.Mode().IsRegular() || !dynvalue.Exists(filepath.Join(folder, "manifest.json")) {
		return ""
	}
	return video
}

// shotFrames — кадры других планов для описания плана shot и ID связанных планов, которые ещё не
// приняты (кадров у них нет). Правила отбора:
//   - сюжетный предшественник state_from (без поля — предыдущий план реестра, null — нет):
//     фаза after — последний кадр, before — первый, same — оба;
//   - планы, названные в continuity, только более ранние на шкале (ссылки вперёд описывают то, чего
//     ещё нет): первый и последний кадры;
//   - только принятые планы, без повторов, не больше shotFramesLimit, предшественник первым.
func shotFrames(project, shot string) ([]ShotFrame, []string, error) {
	scenes, err := readJSON(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		return nil, nil, err
	}
	list, _ := dynvalue.AsArray(dynvalue.Get(scenes, "scenes"))
	index := slices.IndexFunc(list, func(item any) bool { return dynvalue.Get(item, "id") == shot })
	if index < 0 {
		return []ShotFrame{}, []string{}, nil
	}
	scene := list[index]
	start := map[string]float64{}
	for _, item := range list {
		if id, ok := dynvalue.Get(item, "id").(string); ok {
			start[id] = dynvalue.ToNumber(dynvalue.Get(item, "start_frame"))
		}
	}
	frames, missing := []ShotFrame{}, []string{}
	add := func(source, reason string, positions ...string) {
		if _, known := start[source]; !known || source == shot {
			return
		}
		if acceptedVideo(project, source) == "" {
			if !slices.Contains(missing, source) {
				missing = append(missing, source)
			}
			return
		}
		for _, position := range positions {
			frame := ShotFrame{Shot: source, Position: position, Reason: reason}
			if len(frames) < shotFramesLimit && !slices.ContainsFunc(frames, func(item ShotFrame) bool {
				return item.Shot == frame.Shot && item.Position == frame.Position
			}) {
				frames = append(frames, frame)
			}
		}
	}
	from := dynvalue.Get(scene, "state_from")
	switch {
	case from == dynvalue.Undefined:
		if index > 0 {
			if previous, ok := dynvalue.Get(list[index-1], "id").(string); ok {
				add(previous, "state_from", "last")
			}
		}
	case dynvalue.IsRecord(from):
		source, _ := dynvalue.Get(from, "scene").(string)
		switch dynvalue.Get(from, "phase") {
		case "before":
			add(source, "state_from", "first")
		case "same":
			add(source, "state_from", "first", "last")
		default:
			add(source, "state_from", "last")
		}
	default:
		if source, ok := from.(string); ok {
			add(source, "state_from", "last")
		}
	}
	if text, ok := dynvalue.Get(scene, "continuity").(string); ok {
		for _, bounds := range shotMention.FindAllStringIndex(text, -1) {
			// Следующая цифра означает другой, более длинный номер, а не упоминание плана.
			if bounds[1] < len(text) && text[bounds[1]] >= '0' && text[bounds[1]] <= '9' {
				continue
			}
			source := text[bounds[0]:bounds[1]]
			if begin, known := start[source]; known && begin < start[shot] {
				add(source, "continuity", "first", "last")
			}
		}
	}
	return frames, missing, nil
}

// extractFrame — кадр position принятого монтажа video в файл target (формат по расширению: PNG
// без потерь или JPEG). side > 0 — уменьшение до этой наибольшей стороны без увеличения.
// Последний кадр берётся с конца файла: FFmpeg перезаписывает target каждым кадром последней
// секунды, и остаётся последний.
func extractFrame(ctx context.Context, video, position, target string, side int) error {
	args := []string{"-v", "error", "-nostdin", "-y"}
	if position == "last" {
		args = append(args, "-sseof", "-1")
	}
	args = append(args, "-i", video)
	if side > 0 {
		box := dynvalue.ToString(float64(side))
		args = append(args, "-vf", "scale="+box+":"+box+":force_original_aspect_ratio=decrease")
	}
	if position == "last" {
		args = append(args, "-update", "1")
	} else {
		args = append(args, "-frames:v", "1")
	}
	if strings.HasSuffix(target, ".jpg") {
		args = append(args, "-q:v", "3")
	}
	args = append(args, target)
	ctx, cancel := context.WithTimeout(ctx, frameTimeout)
	defer cancel()
	result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), args...)
	if err != nil {
		return err
	}
	if result.Code != 0 || !dynvalue.Exists(target) {
		return errors.New(dynvalue.Trim(mediacmd.Tail(result.Stderr, 600)))
	}
	return nil
}

// attachmentsDir — папка вложений кадров задания описания плана shot в каталоге состояния.
// Одна на план: у плана одновременно не больше одного предложения, а агент читает вложения по
// пути, пока работает (Codex получает пути, а не байты).
func (w *Workflow) attachmentsDir(project, shot string) (string, error) {
	base := w.options.LocalDir
	if base == "" {
		base = os.TempDir()
	}
	sum := sha256.Sum256([]byte(project + "\x00" + shot))
	directory := filepath.Join(base, "production-shot-frames", hex.EncodeToString(sum[:8]))
	if err := os.RemoveAll(directory); err != nil {
		return "", err
	}
	return directory, os.MkdirAll(directory, 0o777)
}

// shotFrameAttachments — вложения задания описания: уменьшенные JPEG кадров по порядку frames.
// attached[i] — кадр i приложен. Сбой FFmpeg не останавливает задание: агент получает problem и
// пишет описание по тексту, как без кадров.
func (w *Workflow) shotFrameAttachments(ctx context.Context, project, shot string, frames []ShotFrame) (images []string, attached []bool, problem string) {
	attached = make([]bool, len(frames))
	if len(frames) == 0 {
		return []string{}, attached, ""
	}
	directory, err := w.attachmentsDir(project, shot)
	if err != nil {
		return []string{}, attached, textShotFramesFailed(err.Error())
	}
	for index, frame := range frames {
		target := filepath.Join(directory, frame.Shot+"-"+frame.Position+".jpg")
		if err := w.options.ExtractFrame(ctx, acceptedVideo(project, frame.Shot), frame.Position, target, attachmentSide); err != nil {
			return images, attached, textShotFramesFailed(err.Error())
		}
		images = append(images, target)
		attached[index] = true
	}
	return images, attached, ""
}

// shotFramesTree — ключ continuityFrames контекста задания: кадры с путями в пакете target,
// признаком вложения, непринятые связанные планы и проблема извлечения.
func shotFramesTree(project, target string, frames []ShotFrame, attached []bool, missing []string, problem string) *dynvalue.Object {
	items := make([]any, len(frames))
	for index, frame := range frames {
		item := dynvalue.NewObject()
		item.Set("shot", frame.Shot)
		item.Set("position", frame.Position)
		item.Set("reason", frame.Reason)
		item.Set("path", frame.path(project, target))
		item.Set("attached", attached[index])
		items[index] = item
	}
	value := dynvalue.NewObject()
	value.Set("frames", &dynvalue.Array{Items: items})
	value.Set("missing", stringsArray(missing))
	value.Set("problem", problem)
	return value
}

// isShotFramePath — путь кадра другого плана в папке continuity пакета (<пакет>/continuity/
// <план>-<first|last>.png). Какой именно пакет, проверяет allowedPaths задания.
func isShotFramePath(path string) bool {
	folder, name := filepath.Split(filepath.FromSlash(path))
	return filepath.Base(filepath.Clean(folder)) == "continuity" && shotFrameFile.MatchString(name)
}

// placeShotFrames — полноразмерные кадры других планов, которые назвали опоры плана keyframes
// (референсом или источником копии copyOf), в папке continuity пакета target. Файл с теми же
// байтами не перезаписывается. Путь кадра проверен при разборе ответа (allowedPaths задания),
// поэтому здесь разбирается только имя.
func (w *Workflow) placeShotFrames(ctx context.Context, project, target string, keyframes []any) error {
	folder := rel(project, filepath.Join(target, "continuity")) + "/"
	placed := map[string]bool{}
	for _, frame := range keyframes {
		references, _ := dynvalue.AsArray(dynvalue.Get(frame, "referencePaths"))
		paths := slices.Clone(references)
		if source, ok := dynvalue.Get(frame, "copyOf").(string); ok {
			paths = append(paths, source)
		}
		for _, reference := range paths {
			text, _ := reference.(string)
			name, inside := strings.CutPrefix(text, folder)
			match := shotFrameFile.FindStringSubmatch(name)
			if !inside || match == nil || placed[name] {
				continue
			}
			placed[name] = true
			video := acceptedVideo(project, match[1])
			if video == "" {
				return errors.New(textShotFrameUnavailable(match[1]))
			}
			if err := w.placeShotFrame(ctx, video, match[2], filepath.Join(target, "continuity", name)); err != nil {
				return errors.New(textShotFrameFailed(match[1], err.Error()))
			}
		}
	}
	return nil
}

// placeShotFrame — кадр во временный файл, затем атомарная запись в target, если байты другие.
func (w *Workflow) placeShotFrame(ctx context.Context, video, position, target string) error {
	directory, err := os.MkdirTemp("", "songframe-shot-frame-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	temporary := filepath.Join(directory, "frame.png")
	if err := w.options.ExtractFrame(ctx, video, position, temporary, 0); err != nil {
		return err
	}
	data, err := os.ReadFile(temporary)
	if err != nil {
		return err
	}
	if current, err := os.ReadFile(target); err == nil && bytes.Equal(current, data) {
		return nil
	}
	return projectfs.WriteFile(target, data, 0)
}

// shotFrameKind — вид подписи референса «кадр другого плана» в задании опор провайдера-агента.
const shotFrameKind = "shot_frame"

// addShotFrameEntities — подписи кадров других планов для задания опор провайдера-агента в
// entities (путь от проекта → подпись): ID — план, Name — понятное имя, Kind — shotFrameKind.
// Кадры ищутся среди referencePaths плана опор пакета.
func addShotFrameEntities(c *Context, entities map[string]mediaapi.ReferenceEntity) map[string]mediaapi.ReferenceEntity {
	if c.PackageDir == "" || c.FramePrompts == nil {
		return entities
	}
	folder := rel(c.Project, filepath.Join(c.PackageDir, "continuity")) + "/"
	for _, frame := range c.FramePrompts.Items {
		references, _ := dynvalue.AsArray(dynvalue.Get(frame, "referencePaths"))
		for _, reference := range references {
			text, _ := reference.(string)
			name, inside := strings.CutPrefix(text, folder)
			if match := shotFrameFile.FindStringSubmatch(name); inside && match != nil {
				entities[text] = mediaapi.ReferenceEntity{ID: match[1], Name: textShotFrameName(match[1], match[2]), Kind: shotFrameKind}
			}
		}
	}
	return entities
}
