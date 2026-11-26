// Package shoteffects — эффекты поверх принятого плана (дождь, свет, зерно, наезд и реверс из internal/effects):
// рецепт и производный ролик плана рядом с комплектом и единственная точка выбора видео плана для
// монтажа.
//
// Файлы плана Mxx — в assets/effects/Mxx/. recipe.json хранит три группы сведений:
//   - источник: путь и SHA-256 принятого видео комплекта;
//   - цепочку эффектов: заданные пользователем значения, необязательный ветер дождя, версию эффекта
//     и полные значения параметров, с которыми сделан ролик;
//   - результат: частоту, число кадров, версию FFmpeg, путь и SHA-256 ролика video-<начало SHA>.mp4.
//
// У каждого ролика своё имя: новый результат не заменяет файл, который сейчас отдаёт плеер (в
// Windows открытый файл не заменить).
//
// Комплект assets/shots/Mxx, его платный оригинал и принятое video.mp4 эффект не меняет. Рецепт
// пишется только вместе с готовым роликом.
//
// Эффект свеж, пока совпадают:
//   - принятое видео комплекта;
//   - версии эффектов и параметры, пересчитанные по текущей точке съёмки;
//   - сам ролик.
//
// Устаревший эффект в монтаж не идёт: MontageVideo тогда отдаёт чистое видео комплекта, а страница
// эффектов объясняет причину.
//
// Наклон дождя без своего значения считается из ветра плана (направление на схеме локации, сила) и
// направления камеры точки съёмки (effects.ScreenAngle). Погоды на весь клип нет: у каждого плана
// свой дождь, единство соседних планов достигается копированием параметров.
package shoteffects

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/effects"
	"songframe/internal/filedigest"
	"songframe/internal/projectfs"
	"songframe/internal/viewframe"
)

// SchemaVersion — версия формата recipe.json.
const SchemaVersion = 1

// Кадр принятого монтажа всегда 1920×1080 (приёмка приводит к нему любой оригинал).
const (
	Width  = 1920
	Height = 1080
)

const (
	recipeName   = "recipe.json"
	outputPrefix = "video-"
	// temporaryPattern — незаконченный ролик рендера: у каждого рендера своё имя, поэтому два
	// рендера одного плана не пишут в один файл и не публикуют чужой недописанный ролик.
	temporaryPattern = "render-*.tmp.mp4"
)

// Wind — ветер дождя плана: направление, куда дует, в градусах против часовой стрелки от востока
// (как heading точки съёмки), и горизонтальная скорость в долях скорости падения.
type Wind struct {
	Direction float64 `json:"direction"`
	Strength  float64 `json:"strength"`
}

// Step — эффект цепочки, как его задаёт пользователь: идентификатор, заданные значения (остальные —
// по умолчанию) и ветер для эффекта, наклон которого зависит от ветра.
type Step struct {
	Effect string             `json:"effect"`
	Given  map[string]float64 `json:"given"`
	Wind   *Wind              `json:"wind,omitempty"`
}

// AppliedStep — шаг рецепта после применения: версия эффекта и полные значения параметров.
type AppliedStep struct {
	Step
	Version int                `json:"version"`
	Params  map[string]float64 `json:"params"`
}

// File — файл проекта: путь от корня проекта (через /) и SHA-256.
type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// Recipe — assets/effects/Mxx/recipe.json.
type Recipe struct {
	SchemaVersion int           `json:"schema_version"`
	Shot          string        `json:"shot"`
	Source        File          `json:"source"`
	Steps         []AppliedStep `json:"steps"`
	FPS           int64         `json:"fps"`
	Frames        int           `json:"frames"`
	FFmpeg        string        `json:"ffmpeg_version"`
	Output        File          `json:"output"`
}

// Video — видео плана для монтажа: путь от корня проекта, абсолютный путь, SHA-256 и взят ли ролик
// с эффектом.
type Video struct {
	Path     string
	Absolute string
	SHA256   string
	Effect   bool
}

// kit — принятое видео комплекта плана.
type kit struct {
	video  File
	fps    int64
	frames int
}

// checkShot отвергает идентификатор, который не годится именем папки.
func checkShot(shot string) error {
	if shot == "" || shot == "." || shot == ".." || strings.ContainsAny(shot, `/\:`) {
		return errors.New(textShotInvalid(shot))
	}
	return nil
}

// folder — папка эффектов плана.
func folder(root, shot string) string { return filepath.Join(root, "assets", "effects", shot) }

// readKit — принятое видео из assets/shots/Mxx/manifest.json. Байты видео здесь не сверяются:
// это делают потребители и freshness по SHA-256 из манифеста.
func readKit(root, shot string) (kit, error) {
	if err := checkShot(shot); err != nil {
		return kit{}, err
	}
	data, err := os.ReadFile(filepath.Join(root, "assets", "shots", shot, "manifest.json"))
	if errors.Is(err, os.ErrNotExist) {
		return kit{}, errors.New(textNoKit(shot))
	}
	if err != nil {
		return kit{}, err
	}
	var manifest struct {
		Shot         string `json:"shot"`
		AcceptedEdit *struct {
			Video *struct {
				Path   string `json:"path"`
				SHA256 string `json:"sha256"`
			} `json:"video"`
			FPS    int64 `json:"fps"`
			Frames int   `json:"frames"`
		} `json:"accepted_edit"`
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.Shot != shot || manifest.AcceptedEdit == nil ||
		manifest.AcceptedEdit.Video == nil || manifest.AcceptedEdit.FPS <= 0 || manifest.AcceptedEdit.Frames <= 0 ||
		!filepath.IsLocal(filepath.FromSlash(manifest.AcceptedEdit.Video.Path)) || manifest.AcceptedEdit.Video.SHA256 == "" {
		return kit{}, errors.New(textKitBroken(shot))
	}
	edit := manifest.AcceptedEdit
	return kit{
		video:  File{Path: "assets/shots/" + shot + "/" + filepath.ToSlash(filepath.Clean(filepath.FromSlash(edit.Video.Path))), SHA256: edit.Video.SHA256},
		fps:    edit.FPS,
		frames: edit.Frames,
	}, nil
}

// cameraAngles — направление и наклон камеры первого кадра плана по точке съёмки из
// plan/scenes.json и росту из кастинга; ok=false — у плана нет направления камеры.
func cameraAngles(root, shot string) (heading, tilt float64, ok bool, err error) {
	registry, found := dynvalue.ReadJSONFile(filepath.Join(root, "plan", "scenes.json"))
	if !found {
		return 0, 0, false, errors.New(textShotMissing(shot))
	}
	scenes, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	for _, scene := range scenes {
		if dynvalue.Get(scene, "id") != shot {
			continue
		}
		value := dynvalue.Get(scene, "viewpoint")
		if value == dynvalue.Undefined || value == nil {
			return 0, 0, false, nil
		}
		viewpoint, err := viewframe.ParseViewpoint(value)
		if err != nil {
			return 0, 0, false, nil
		}
		heading, ok := viewpoint.LookHeading(viewframe.PhaseStart)
		if !ok {
			return 0, 0, false, nil
		}
		return heading, viewpoint.Pitch(viewframe.PhaseStart, viewframe.ReadCast(cast.Read(root).Value)), true, nil
	}
	return 0, 0, false, errors.New(textShotMissing(shot))
}

// Apply — шаги с полными значениями параметров: заданные значения проверяются схемой эффекта,
// наклон без своего значения считается из ветра и камеры плана (без ветра — по умолчанию,
// вертикальный дождь) и ограничивается диапазоном параметра.
func Apply(root, shot string, steps []Step) ([]AppliedStep, error) {
	if len(steps) == 0 {
		return nil, errors.New(textNoSteps)
	}
	result := make([]AppliedStep, 0, len(steps))
	camera := struct {
		heading, tilt float64
		ok, read      bool
	}{}
	for _, step := range steps {
		kind, found := effects.Lookup(step.Effect)
		if !found {
			return nil, errors.New(textUnknownEffect(step.Effect))
		}
		given := make(map[string]float64, len(step.Given)+1)
		for name, value := range step.Given {
			given[name] = value
		}
		if step.Wind != nil {
			if kind.WindAngle == "" {
				return nil, errors.New(textWindNoEffect(kind.Title))
			}
			wind := *step.Wind
			if !finite(wind.Direction) || !finite(wind.Strength) || wind.Direction < 0 || wind.Direction > 360 || wind.Strength < 0 || wind.Strength > 3 {
				return nil, errors.New(textWindRange(kind.Title))
			}
			if _, own := given[kind.WindAngle]; !own {
				if !camera.read {
					var err error
					if camera.heading, camera.tilt, camera.ok, err = cameraAngles(root, shot); err != nil {
						return nil, err
					}
					camera.read = true
				}
				if !camera.ok {
					return nil, errors.New(textNoViewpoint)
				}
				given[kind.WindAngle] = windAngle(kind, effects.ScreenAngle(wind.Direction, wind.Strength, camera.heading, camera.tilt))
			}
		}
		params, err := effects.Resolve(kind.Params, given)
		if err != nil {
			return nil, errors.New(textEffectFailed(kind.Title, err))
		}
		result = append(result, AppliedStep{Step: step, Version: kind.Version, Params: params})
	}
	return result, nil
}

// windAngle — наклон из ветра в диапазоне параметра, с точностью 0,1°: дробные доли градуса на
// глаз неразличимы, а округление делает значение устойчивым к погрешности тригонометрии.
func windAngle(kind effects.Kind, angle float64) float64 {
	for _, spec := range kind.Params {
		if spec.Name == kind.WindAngle {
			angle = math.Max(spec.Min, math.Min(spec.Max, angle))
		}
	}
	return math.Round(angle*10) / 10
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

// sameParams — дают ли сохранённые значения рецепта тот же результат, что текущие полные значения
// шага. Параметр, которого в рецепте нет, совпадает, если у шага он по умолчанию: новый параметр
// эффекта добавляется со значением, которое повторяет прежний результат (иначе меняется версия
// эффекта), поэтому рецепт, сделанный до него, остаётся свежим.
func sameParams(step AppliedStep, stored map[string]float64) bool {
	kind, ok := effects.Lookup(step.Effect)
	if !ok {
		return false
	}
	defaults := make(map[string]float64, len(kind.Params))
	for _, spec := range kind.Params {
		defaults[spec.Name] = spec.Default
	}
	for name := range stored {
		if _, known := step.Params[name]; !known {
			return false
		}
	}
	for name, value := range step.Params {
		saved, found := stored[name]
		if !found {
			saved, found = defaults[name]
		}
		if !found || saved != value {
			return false
		}
	}
	return true
}

// AcceptedVideo — принятое видео комплекта плана без эффекта: абсолютный путь, частота и число
// кадров из accepted_edit манифеста. Нужен там, где эффект плана попасть не должен: кадры принятого
// видео для референсов и опор соседних планов.
func AcceptedVideo(root, shot string) (string, int64, int, error) {
	current, err := readKit(root, shot)
	if err != nil {
		return "", 0, 0, err
	}
	return filepath.Join(root, filepath.FromSlash(current.video.Path)), current.fps, current.frames, nil
}

// readRecipe — recipe.json плана; found=false — эффекта нет.
func readRecipe(root, shot string) (Recipe, bool, error) {
	data, err := os.ReadFile(filepath.Join(folder(root, shot), recipeName))
	if errors.Is(err, os.ErrNotExist) {
		return Recipe{}, false, nil
	}
	if err != nil {
		return Recipe{}, false, err
	}
	var recipe Recipe
	if json.Unmarshal(data, &recipe) != nil || recipe.SchemaVersion != SchemaVersion || recipe.Shot != shot || len(recipe.Steps) == 0 {
		return Recipe{}, true, errors.New(textRecipeBroken)
	}
	return recipe, true, nil
}

// stale — почему эффект плана не годится для монтажа; "" — свеж.
func stale(root string, recipe Recipe, current kit) string {
	if recipe.Source != current.video || recipe.FPS != current.fps || recipe.Frames != current.frames {
		return textSourceChanged
	}
	steps := make([]Step, 0, len(recipe.Steps))
	for _, step := range recipe.Steps {
		steps = append(steps, step.Step)
	}
	applied, err := Apply(root, recipe.Shot, steps)
	if err != nil {
		return err.Error()
	}
	for index, step := range applied {
		if step.Version != recipe.Steps[index].Version || !sameParams(step, recipe.Steps[index].Params) {
			return textParamsChanged
		}
	}
	name := filepath.FromSlash(recipe.Output.Path)
	expected := filepath.ToSlash(filepath.Join("assets", "effects", recipe.Shot)) + "/" + outputPrefix
	if !strings.HasPrefix(recipe.Output.Path, expected) || !filepath.IsLocal(name) {
		return textRecipeBroken
	}
	if digest, ok := filedigest.File(filepath.Join(root, name)); !ok || digest != recipe.Output.SHA256 {
		return textOutputChanged
	}
	return ""
}

// MontageVideo — видео плана для монтажа (аниматик, пробы стыков, выгрузка монтажёру): свежий
// ролик с эффектом или чистое принятое видео комплекта. Кадры для опор соседних планов и ручной
// монтаж берут чистое видео комплекта сами: эффект — последний слой поверх принятого плана.
// Сверку чистого видео с комплектом (SHA-256, частота, кадры) потребители делают сами до вызова;
// ошибка здесь (нет или повреждён комплект) для них значит лишь, что эффекта в монтаже нет.
func MontageVideo(root, shot string) (Video, error) {
	current, err := readKit(root, shot)
	if err != nil {
		return Video{}, err
	}
	clean := Video{Path: current.video.Path, Absolute: filepath.Join(root, filepath.FromSlash(current.video.Path)), SHA256: current.video.SHA256}
	recipe, found, err := readRecipe(root, shot)
	if !found || err != nil || stale(root, recipe, current) != "" {
		return clean, nil
	}
	return Video{Path: recipe.Output.Path, Absolute: filepath.Join(root, filepath.FromSlash(recipe.Output.Path)), SHA256: recipe.Output.SHA256, Effect: true}, nil
}

// State — эффект плана для показа: шаги применённого рецепта, путь ролика с эффектом (абсолютный,
// для медиасервера) и почему он устарел ("" — свеж и идёт в монтаж). Applied=false — эффекта нет.
type State struct {
	Shot    string        `json:"shot"`
	FPS     int64         `json:"fps"`
	Frames  int           `json:"frames"`
	Source  string        `json:"source"`
	Applied bool          `json:"applied"`
	Steps   []AppliedStep `json:"steps"`
	Output  string        `json:"output"`
	Version string        `json:"version"`
	Stale   string        `json:"stale"`
}

// Read — эффект плана shot. Комплект обязателен: эффект бывает только у принятого плана.
func Read(root, shot string) (State, error) {
	current, err := readKit(root, shot)
	if err != nil {
		return State{}, err
	}
	state := State{Shot: shot, FPS: current.fps, Frames: current.frames, Source: filepath.Join(root, filepath.FromSlash(current.video.Path)), Steps: []AppliedStep{}}
	recipe, found, err := readRecipe(root, shot)
	if !found {
		return state, nil
	}
	state.Applied = true
	if err != nil {
		state.Stale = err.Error()
		return state, nil
	}
	state.Steps = recipe.Steps
	state.Output = filepath.Join(root, filepath.FromSlash(recipe.Output.Path))
	state.Version = recipe.Output.SHA256
	state.Stale = stale(root, recipe, current)
	return state, nil
}

// Render накладывает цепочку steps на принятое видео плана и сохраняет результат. Ролик пишется во
// временный файл и получает своё имя только целиком, рецепт — после него; прежние ролики плана
// удаляются, занятый плеером — при следующем рендере. log получает строки хода работы.
func Render(ctx context.Context, root, shot string, steps []Step, log func(string)) (State, error) {
	current, err := readKit(root, shot)
	if err != nil {
		return State{}, err
	}
	applied, err := Apply(root, shot, steps)
	if err != nil {
		return State{}, err
	}
	source := filepath.Join(root, filepath.FromSlash(current.video.Path))
	if digest, ok := filedigest.File(source); !ok || digest != current.video.SHA256 {
		return State{}, errors.New(textKitVideoChanged(shot))
	}
	chainSteps := make([]effects.Step, 0, len(applied))
	for _, step := range applied {
		chainSteps = append(chainSteps, effects.Step{ID: step.Effect, Params: step.Params})
	}
	size := effects.Size{Width: Width, Height: Height, Frames: current.frames}
	chain, err := effects.Build(chainSteps, size)
	if err != nil {
		return State{}, err
	}
	version, err := effects.FFmpegVersion(ctx)
	if err != nil {
		return State{}, err
	}
	directory := folder(root, shot)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return State{}, err
	}
	file, err := os.CreateTemp(directory, temporaryPattern)
	if err != nil {
		return State{}, err
	}
	output := file.Name()
	file.Close()
	video, err := openSource(ctx, source, size, effects.Reversed(chainSteps))
	if err != nil {
		_ = os.Remove(output)
		return State{}, err
	}
	step := max(1, current.frames/10)
	renderErr := effects.Render(ctx, effects.Job{Source: video, Chain: chain, FPS: current.fps, Output: output}, func(done, total int) {
		if log != nil && (done%step == 0 || done == total) {
			log(textProgress(done, total))
		}
	})
	if closeErr := video.Close(); renderErr == nil {
		renderErr = closeErr
	}
	if renderErr != nil {
		_ = os.Remove(output)
		return State{}, renderErr
	}
	digest, ok := filedigest.File(output)
	if !ok {
		return State{}, fmt.Errorf("не прочитать %s", output)
	}
	name := outputPrefix + digest[:12] + ".mp4"
	target := filepath.Join(directory, name)
	if existing, ok := filedigest.File(target); ok && existing == digest {
		_ = os.Remove(output)
	} else if err := os.Rename(output, target); err != nil {
		return State{}, err
	}
	recipe := Recipe{
		SchemaVersion: SchemaVersion, Shot: shot, Source: current.video, Steps: applied,
		FPS: current.fps, Frames: current.frames, FFmpeg: version,
		Output: File{Path: "assets/effects/" + shot + "/" + name, SHA256: digest},
	}
	data, _ := json.MarshalIndent(recipe, "", "  ")
	if err := projectfs.WriteFile(filepath.Join(directory, recipeName), append(data, '\n'), 0o644); err != nil {
		return State{}, err
	}
	removeOld(directory, name)
	return Read(root, shot)
}

// videoSource — кадры принятого видео для рендера; Close останавливает FFmpeg.
type videoSource interface {
	effects.Source
	Close() error
}

// openSource — принятое видео по порядку или задом наперёд, если в цепочке есть «Реверс»: кадры
// переставляются до всех эффектов, и остальные ложатся на развёрнутое видео.
func openSource(ctx context.Context, path string, size effects.Size, reversed bool) (videoSource, error) {
	if reversed {
		return effects.OpenVideoReversed(ctx, path, size)
	}
	return effects.OpenVideo(ctx, path, size)
}

// removeOld удаляет прежние ролики плана, кроме keep; занятый плеером файл остаётся до следующего
// раза.
func removeOld(directory, keep string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), outputPrefix) && entry.Name() != keep {
			_ = os.Remove(filepath.Join(directory, entry.Name()))
		}
	}
}

// Remove убирает эффект плана: монтаж снова берёт чистое видео комплекта. Сначала удаляется ролик
// рецепта: если его держит плеер (в Windows открытый файл не удалить), эффект остаётся как был и
// возвращается ошибка. Затем рецепт и прежние ролики; папка плана удаляется, когда опустела.
func Remove(root, shot string) error {
	if err := checkShot(shot); err != nil {
		return err
	}
	directory := folder(root, shot)
	if recipe, found, err := readRecipe(root, shot); found && err == nil {
		name := filepath.Base(filepath.FromSlash(recipe.Output.Path))
		if strings.HasPrefix(name, outputPrefix) {
			if err := os.Remove(filepath.Join(directory, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return errors.New(textRemoveBusy)
			}
		}
	}
	if err := os.Remove(filepath.Join(directory, recipeName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	removeOld(directory, "")
	// Незаконченные ролики прерванных рендеров (сбой приложения); идущий рендер плана сервис
	// страницы не даёт совместить со снятием эффекта.
	if leftovers, err := filepath.Glob(filepath.Join(directory, temporaryPattern)); err == nil {
		for _, path := range leftovers {
			_ = os.Remove(path)
		}
	}
	if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
		if entries, _ := os.ReadDir(directory); len(entries) > 0 {
			return errors.New(textRemoveBusy)
		}
	}
	return nil
}
