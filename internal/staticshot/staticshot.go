// Package staticshot — производство плана «Статичный кадр» (scene.static_shot): после утверждения
// опор попытки план собирается локально из опор-состояний (internal/effects) вместо видеопромпта и
// платного запроса, а принятый предпросмотр становится комплектом assets/shots/Mxx вида
// static_video.
//
// Файлы попытки: static/recipe.json — моменты смены и параметры сборки, которые поправил
// пользователь (без файла — значения по опорам и по умолчанию); static/preview-<начало SHA>.mp4 —
// последний предпросмотр; static/preview.json — квитанция предпросмотра: имя файла, частота,
// SHA-256 рецепта, опор и ролика, версия сборки.
// Предпросмотр свеж, пока квитанция совпадает с текущими рецептом и опорами: принять можно только
// свежий. Комплект хранит собранный ролик (original.mp4 — сборка целиком, video.mp4 — принятый
// монтаж того же размера), копии опор-состояний и рецепт в generation.static; платного оригинала
// у такого плана нет.
package staticshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"songframe/internal/acceptshot"
	"songframe/internal/assetpackage"
	"songframe/internal/effects"
	"songframe/internal/projectfs"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Kind — вид комплекта статичного кадра в manifest.json.
const Kind = assetpackage.StaticKind

// Размер кадра сборки — кадр проекта, как у принятого монтажа видео сервиса.
const (
	Width  = 1920
	Height = 1080
)

const (
	recipeFile = "static/recipe.json"
	// previewPrefix — предпросмотр static/preview-<начало SHA>.mp4: у каждой сборки своё имя, чтобы
	// новая сборка не заменяла файл, который сейчас отдаёт плеер (в Windows открытый файл не
	// заменить); прежние удаляются после записи квитанции, занятые — при следующей сборке.
	previewPrefix = "static/preview-"
	receiptFile   = "static/preview.json"
)

// RecipeState — состояние рецепта: опора попытки и первый кадр плана, с которого она видна.
type RecipeState struct {
	Frame     string `json:"frame"`
	FromFrame int    `json:"from_frame"`
}

// Recipe — что пользователь задаёт на шаге «Сборка»: моменты смены и параметры статичного кадра
// (effects.StaticParams). Отсутствующий параметр — значение по умолчанию.
type Recipe struct {
	SchemaVersion int                `json:"schema_version"`
	States        []RecipeState      `json:"states"`
	Params        map[string]float64 `json:"params"`
}

// State — состояние для показа: опора, её время из описания, кадр смены, путь файла (абсолютный,
// для медиасервера) и утверждена ли опора.
type State struct {
	Frame       string  `json:"frame"`
	TimeSeconds float64 `json:"timeSeconds"`
	FromFrame   int     `json:"fromFrame"`
	Path        string  `json:"path"`
	Approved    bool    `json:"approved"`
	sha256      string
	relative    string
}

// Preview — последний предпросмотр попытки: путь ролика, совпадает ли он с текущими рецептом и
// опорами, и версия файла (SHA-256 из квитанции) — интерфейс добавляет её к адресу, чтобы
// пересобранный по тому же пути ролик не показывался из кэша.
type Preview struct {
	Path    string `json:"path"`
	Fresh   bool   `json:"fresh"`
	Version string `json:"version"`
}

// View — шаг «Сборка» попытки статичного плана.
type View struct {
	Shot   string              `json:"shot"`
	FPS    int64               `json:"fps"`
	Frames int                 `json:"frames"`
	States []State             `json:"states"`
	Params map[string]float64  `json:"params"`
	Specs  []effects.ParamSpec `json:"specs"`
	// Problem — почему собрать нельзя (не все опоры утверждены, неверный рецепт); "" — можно.
	Problem string   `json:"problem"`
	Preview *Preview `json:"preview"`
	// Saved — рецепт попытки сохранён пользователем (иначе значения по опорам и по умолчанию).
	Saved bool `json:"saved"`
	// JobID — идущее задание сборки или приёмки этой попытки; заполняет сервис производства, чтобы
	// открытая заново панель продолжила следить за ним. "" — задания нет.
	JobID string `json:"jobId"`
}

// packagePath — папка попытки: абсолютная или от проекта, только внутри plan/batches проекта.
func packagePath(root, packageDir string) (string, error) {
	path := packageDir
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, filepath.FromSlash(packageDir))
	}
	path = filepath.Clean(path)
	batches := filepath.Join(root, "plan", "batches")
	// Проект может быть открыт по ссылке, а папка попытки — передана уже разыменованной.
	if real, err := filepath.EvalSymlinks(batches); err == nil {
		batches = real
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if relative, err := filepath.Rel(batches, path); err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return "", errors.New(textPackageOutside)
	}
	return path, nil
}

// fileSHA — SHA-256 файла.
func fileSHA(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

// planWindow — частота и длина плана shot по сценарию; план должен быть статичным кадром.
func planWindow(root, shot string) (*toolrt.Dict, int64, int, error) {
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, 0, 0, err
	}
	scenes, _ := registry.Value("scenes").([]any)
	for _, raw := range scenes {
		scene, ok := raw.(*toolrt.Dict)
		if !ok || !toolrt.Equal(scene.Value("id"), shot) {
			continue
		}
		if scene.Value("static_shot") != true {
			return nil, 0, 0, errors.New(textNotStatic(shot))
		}
		start, _ := strconv.Atoi(toolrt.Str(scene.Value("start_frame")))
		end, _ := strconv.Atoi(toolrt.Str(scene.Value("end_frame_exclusive")))
		if end <= start {
			return nil, 0, 0, errors.New(textWindowInvalid(shot))
		}
		return registry, sceneregistry.FPS(registry.Value("fps")), end - start, nil
	}
	return nil, 0, 0, errors.New(textShotMissing(shot))
}

// attempt — workflow.json попытки и её план (shot).
func attempt(directory string) (*toolrt.Dict, string, error) {
	value, err := toolrt.LoadJSONFile(filepath.Join(directory, "workflow.json"))
	if err != nil {
		return nil, "", err
	}
	workflow, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, "", errors.New(textWorkflowInvalid)
	}
	shot, _ := workflow.Value("shot").(string)
	return workflow, shot, nil
}

// Read — шаг «Сборка» попытки packageDir проекта root.
func Read(root, packageDir string) (View, error) {
	directory, err := packagePath(root, packageDir)
	if err != nil {
		return View{}, err
	}
	workflow, shot, err := attempt(directory)
	if err != nil {
		return View{}, err
	}
	_, fps, frames, err := planWindow(root, shot)
	if err != nil {
		return View{}, err
	}
	view := View{Shot: shot, FPS: fps, Frames: frames, States: []State{}, Specs: effects.StaticParams}
	keyframes, _ := workflow.Value("keyframes").([]any)
	for _, raw := range keyframes {
		frame, ok := raw.(*toolrt.Dict)
		if !ok {
			continue
		}
		id, _ := frame.Value("id").(string)
		seconds, _ := strconv.ParseFloat(toolrt.Str(frame.Value("time_seconds")), 64)
		state := State{Frame: id, TimeSeconds: seconds, FromFrame: int(math.Round(seconds * float64(fps))), Approved: frame.Value("approved") == true}
		if path, ok := frame.Value("path").(string); ok && path != "" {
			state.relative = path
			state.Path = filepath.Join(directory, filepath.FromSlash(path))
		}
		if digest, ok := frame.Value("sha256").(string); ok {
			state.sha256 = digest
		}
		view.States = append(view.States, state)
	}
	recipe, saved, err := readRecipe(directory)
	if err != nil {
		return View{}, err
	}
	view.Saved = saved
	given := map[string]float64{}
	if saved {
		given = recipe.Params
		if sameFrames(recipe.States, view.States) {
			for index := range view.States {
				view.States[index].FromFrame = recipe.States[index].FromFrame
			}
		}
	}
	params, err := effects.Resolve(effects.StaticParams, given)
	if err != nil {
		view.Problem = err.Error()
		params, _ = effects.Resolve(effects.StaticParams, nil)
	}
	view.Params = params
	if view.Problem == "" {
		view.Problem = problem(view)
	}
	if view.Problem == "" {
		view.Problem = sizeProblem(view.States)
	}
	if stored := readReceipt(directory); stored != nil {
		if path := previewPath(directory, stored); path != "" {
			view.Preview = &Preview{Path: path, Fresh: fresh(directory, view), Version: stored.VideoSHA256}
		}
	}
	return view, nil
}

// sameFrames — рецепт относится к тем же опорам в том же порядке.
func sameFrames(states []RecipeState, current []State) bool {
	if len(states) != len(current) {
		return false
	}
	for index, state := range states {
		if state.Frame != current[index].Frame {
			return false
		}
	}
	return true
}

// problem — почему план пока не собрать: нужны базовая опора и хотя бы одно состояние, все
// утверждены, K01 с кадра 0, смены строго по возрастанию внутри плана.
func problem(view View) string {
	if len(view.States) < 2 {
		return textStatesRequired
	}
	for index, state := range view.States {
		switch {
		case !state.Approved || state.Path == "":
			return textFramesNotApproved
		case index == 0 && state.FromFrame != 0:
			return textBaseFromZero
		case index > 0 && (state.FromFrame <= view.States[index-1].FromFrame || state.FromFrame >= view.Frames):
			return textStateOrder(state.Frame, view.Frames)
		}
	}
	return ""
}

// sizeProblem — опоры-состояния должны совпадать с базовой по размеру: маска смены сравнивает
// кадры попиксельно. Своя картинка другого размера получает понятную причину до сборки.
// Декодеры PNG, JPEG и WebP регистрирует internal/effects.
func sizeProblem(states []State) string {
	var base image.Config
	for index, state := range states {
		file, err := os.Open(state.Path)
		if err != nil {
			return textFrameUnreadable(state.Frame)
		}
		config, _, err := image.DecodeConfig(file)
		file.Close()
		if err != nil {
			return textFrameUnreadable(state.Frame)
		}
		if index == 0 {
			base = config
		} else if config.Width != base.Width || config.Height != base.Height {
			return textFrameSize(state.Frame, config.Width, config.Height, states[0].Frame, base.Width, base.Height)
		}
	}
	return ""
}

// readRecipe — сохранённый рецепт попытки; false — файла нет.
func readRecipe(directory string) (Recipe, bool, error) {
	data, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(recipeFile)))
	if errors.Is(err, os.ErrNotExist) {
		return Recipe{}, false, nil
	}
	if err != nil {
		return Recipe{}, false, err
	}
	var recipe Recipe
	if err := json.Unmarshal(data, &recipe); err != nil || recipe.SchemaVersion != 1 {
		return Recipe{}, false, errors.New(textRecipeInvalid)
	}
	return recipe, true, nil
}

// effective — рецепт, по которому будет собран план: текущие опоры с кадрами смены и параметры.
func effective(view View) Recipe {
	recipe := Recipe{SchemaVersion: 1, Params: view.Params}
	for _, state := range view.States {
		recipe.States = append(recipe.States, RecipeState{Frame: state.Frame, FromFrame: state.FromFrame})
	}
	return recipe
}

// SaveRecipe записывает моменты смены и параметры попытки. Опоры — те же, что в попытке, в том же
// порядке; параметры проверяются по диапазонам. Предпросмотр после этого устаревает сам.
func SaveRecipe(root, packageDir string, recipe Recipe) (View, error) {
	view, err := Read(root, packageDir)
	if err != nil {
		return View{}, err
	}
	if !sameFrames(recipe.States, view.States) {
		return View{}, errors.New(textRecipeFrames)
	}
	if _, err := effects.Resolve(effects.StaticParams, recipe.Params); err != nil {
		return View{}, err
	}
	for index := range view.States {
		view.States[index].FromFrame = recipe.States[index].FromFrame
	}
	if message := problem(view); message != "" && message != textFramesNotApproved {
		return View{}, errors.New(message)
	}
	recipe.SchemaVersion = 1
	if recipe.Params == nil {
		recipe.Params = map[string]float64{}
	}
	directory, _ := packagePath(root, packageDir)
	data, err := json.MarshalIndent(recipe, "", "  ")
	if err != nil {
		return View{}, err
	}
	if err := projectfs.WriteFile(filepath.Join(directory, filepath.FromSlash(recipeFile)), append(data, '\n'), 0o644); err != nil {
		return View{}, err
	}
	return Read(root, packageDir)
}

// receipt — квитанция предпросмотра: по ней видно, собран ли он из текущих рецепта и опор.
type receipt struct {
	// Video — файл предпросмотра от папки попытки (static/preview-<начало SHA>.mp4).
	Video        string            `json:"video"`
	FPS          int64             `json:"fps"`
	Version      int               `json:"version"`
	Recipe       string            `json:"recipe_sha256"`
	Frames       map[string]string `json:"frames"`
	FFmpeg       string            `json:"ffmpeg_version"`
	VideoSHA256  string            `json:"video_sha256"`
	OutputFrames int               `json:"output_frames"`
}

// recipeDigest — SHA-256 компактного JSON рецепта.
func recipeDigest(recipe Recipe) string {
	data, _ := json.Marshal(recipe)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// expected — квитанция, которую дала бы сборка текущих рецепта и опор (без полей результата).
func expected(view View) receipt {
	frames := map[string]string{}
	for _, state := range view.States {
		frames[state.Frame] = state.sha256
	}
	return receipt{FPS: view.FPS, Version: effects.StaticVersion, Recipe: recipeDigest(effective(view)), Frames: frames, OutputFrames: view.Frames}
}

// previewPath — абсолютный путь предпросмотра квитанции; "" — имя не из static/ или файла нет.
func previewPath(directory string, stored *receipt) string {
	name := stored.Video
	if !strings.HasPrefix(name, previewPrefix) || strings.ContainsAny(strings.TrimPrefix(name, previewPrefix), `/\`) {
		return ""
	}
	path := filepath.Join(directory, filepath.FromSlash(name))
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return ""
	}
	return path
}

// readReceipt — квитанция предпросмотра; nil — её нет или она повреждена.
func readReceipt(directory string) *receipt {
	data, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(receiptFile)))
	if err != nil {
		return nil
	}
	var value receipt
	if json.Unmarshal(data, &value) != nil {
		return nil
	}
	return &value
}

// fresh — предпросмотр собран из текущих рецепта и опор и не изменён после сборки.
func fresh(directory string, view View) bool {
	stored := readReceipt(directory)
	if stored == nil || view.Problem != "" {
		return false
	}
	want := expected(view)
	if stored.FPS != want.FPS || stored.Version != want.Version || stored.Recipe != want.Recipe || stored.OutputFrames != want.OutputFrames ||
		len(stored.Frames) != len(want.Frames) {
		return false
	}
	for id, digest := range want.Frames {
		if stored.Frames[id] != digest {
			return false
		}
	}
	path := previewPath(directory, stored)
	if path == "" {
		return false
	}
	digest, _, err := fileSHA(path)
	return err == nil && digest == stored.VideoSHA256
}

// Build собирает предпросмотр попытки packageDir: опоры-состояния по рецепту в ролик длиной плана
// в кадре проекта. log получает строки хода сборки. Ролик пишется во временный файл и переносится
// на место предпросмотра только целиком; квитанция — после него.
func Build(ctx context.Context, root, packageDir string, log func(string)) (View, error) {
	view, err := Read(root, packageDir)
	if err != nil {
		return View{}, err
	}
	if view.Problem != "" {
		return View{}, errors.New(view.Problem)
	}
	directory, _ := packagePath(root, packageDir)
	base, err := effects.LoadImage(view.States[0].Path)
	if err != nil {
		return View{}, err
	}
	states := []effects.State{}
	for _, state := range view.States {
		image, err := effects.LoadImage(state.Path)
		if err != nil {
			return View{}, err
		}
		states = append(states, effects.State{Image: image, From: state.FromFrame})
	}
	size := effects.Size{Width: Width, Height: Height, Frames: view.Frames}
	shot, err := effects.NewStaticShot(base, states, view.Params, size)
	if err != nil {
		return View{}, err
	}
	version, err := effects.FFmpegVersion(ctx)
	if err != nil {
		return View{}, err
	}
	folder := filepath.Join(directory, "static")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return View{}, err
	}
	temporary := filepath.Join(folder, "render.tmp.mp4")
	_ = os.Remove(temporary)
	step := max(1, view.Frames/10)
	err = effects.Render(ctx, effects.Job{Source: shot, FPS: view.FPS, Output: temporary}, func(done, total int) {
		if log != nil && (done%step == 0 || done == total) {
			log(textProgress(done, total))
		}
	})
	if err != nil {
		_ = os.Remove(temporary)
		return View{}, err
	}
	stored := expected(view)
	stored.FFmpeg = version
	if stored.VideoSHA256, _, err = fileSHA(temporary); err != nil {
		return View{}, err
	}
	stored.Video = previewPrefix + stored.VideoSHA256[:12] + ".mp4"
	output := filepath.Join(directory, filepath.FromSlash(stored.Video))
	// Те же байты уже лежат под этим именем (повторная сборка): файл не трогается.
	if digest, _, err := fileSHA(output); err == nil && digest == stored.VideoSHA256 {
		_ = os.Remove(temporary)
	} else if err := os.Rename(temporary, output); err != nil {
		return View{}, err
	}
	data, _ := json.MarshalIndent(stored, "", "  ")
	if err := projectfs.WriteFile(filepath.Join(directory, filepath.FromSlash(receiptFile)), append(data, '\n'), 0o644); err != nil {
		return View{}, err
	}
	// Прежние предпросмотры больше не нужны; занятый плеером останется до следующей сборки.
	if entries, err := os.ReadDir(folder); err == nil {
		for _, entry := range entries {
			name := "static/" + entry.Name()
			if strings.HasPrefix(name, previewPrefix) && name != stored.Video {
				_ = os.Remove(filepath.Join(folder, entry.Name()))
			}
		}
	}
	return Read(root, packageDir)
}

// descriptor — описатель файла комплекта {path, sha256, bytes}.
func descriptor(directory, name string) (*toolrt.Dict, error) {
	digest, size, err := fileSHA(filepath.Join(directory, name))
	if err != nil {
		return nil, err
	}
	return toolcli.Record("path", name, "sha256", digest, "bytes", toolrt.NewInt(size)), nil
}

// copyFile — копия файла с правами 0644.
func copyFile(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(target, data, 0o644)
}

// AcceptOptions — параметры приёмки: Replace разрешает заменить принятый комплект (прежний уходит в
// assets/replaced), Clean удаляет попытки плана после приёмки, как у обычного плана.
type AcceptOptions struct {
	Replace bool
	Clean   bool
}

// Accept переносит свежий предпросмотр попытки в комплект assets/shots/<shot> вида static_video:
// сборка в staging, прежний комплект — в assets/replaced, отпечаток принятия, проверка комплекта.
func Accept(ctx context.Context, root, packageDir string, options AcceptOptions) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	view, err := Read(root, packageDir)
	if err != nil {
		return nil, err
	}
	directory, _ := packagePath(root, packageDir)
	if view.Preview == nil {
		return nil, errors.New(textPreviewMissing)
	}
	if !view.Preview.Fresh {
		return nil, errors.New(textPreviewStale)
	}
	shot := view.Shot
	registry, _, _, err := planWindow(root, shot)
	if err != nil {
		return nil, err
	}
	workflow, _, err := attempt(directory)
	if err != nil {
		return nil, err
	}
	target := filepath.Join(root, "assets", "shots", shot)
	if _, err := os.Stat(target); err == nil && !options.Replace {
		return nil, errors.New(textReplaceRequired(shot))
	}
	sceneDigest, currentDigest, err := acceptshot.AcceptanceFingerprint(registry, shot, workflow, root)
	if err != nil {
		return nil, err
	}
	status, err := sceneregistry.ReadProductionStatus(root)
	if err != nil {
		return nil, err
	}
	if _, err := sceneregistry.AcceptedFingerprints(status); err != nil {
		return nil, err
	}
	stored := readReceipt(directory)
	staging := filepath.Join(filepath.Dir(target), ".accept-"+shot)
	if err := os.RemoveAll(staging); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return nil, err
	}
	manifest, err := stage(root, staging, directory, workflow, view, stored)
	if err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	data, err := toolrt.DumpsJSON(manifest, toolrt.DumpOptions{Indent: 2})
	if err == nil {
		err = os.WriteFile(filepath.Join(staging, "manifest.json"), []byte(data+"\n"), 0o644)
	}
	if err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	var replaced any
	if _, err := os.Stat(target); err == nil {
		archive, err := acceptshot.RetireKit(root, shot)
		if err != nil {
			_ = os.RemoveAll(staging)
			return nil, err
		}
		replaced, _ = toolrt.RelativeTo(archive, root)
	}
	if err := os.Rename(staging, target); err != nil {
		return nil, toolrt.OSErrorFrom(err, staging)
	}
	// Сразу после переноса: комплект без отпечатка считается принятым по прежней постановке.
	if err := sceneregistry.WriteAcceptedFingerprints(root, toolcli.Record(shot, sceneDigest), true); err != nil {
		return nil, err
	}
	if _, err := assetpackage.ValidatePackage(filepath.Join(target, "manifest.json"), shot, root); err != nil {
		return nil, err
	}
	warnings := []any{}
	if sceneDigest != currentDigest {
		warnings = append(warnings, textSceneChanged(shot))
	}
	relative, _ := toolrt.RelativeTo(target, root)
	video := manifest.Value("accepted_edit").(*toolrt.Dict).Value("video").(*toolrt.Dict)
	result := toolcli.Record("shot", shot, "target", relative, "frames", toolrt.NewInt(int64(view.Frames)),
		"video_sha256", video.Value("sha256"), "scene_sha256", sceneDigest, "replaced", replaced, "cleaned", []any{}, "warnings", warnings)
	if options.Clean {
		cleaned, err := acceptshot.CleanWork(root, shot, directory)
		if err != nil {
			return nil, err
		}
		result.Set("cleaned", cleaned)
	}
	return result, nil
}

// stage копирует в staging ролик, опоры-состояния и сведения подготовки (описание, промпты опор,
// референсы) и возвращает манифест комплекта.
func stage(root, staging, directory string, workflow *toolrt.Dict, view View, stored *receipt) (*toolrt.Dict, error) {
	preview := view.Preview.Path
	for _, name := range []string{"original.mp4", "video.mp4"} {
		if err := copyFile(preview, filepath.Join(staging, name)); err != nil {
			return nil, err
		}
	}
	inputs := []any{}
	states := []any{}
	for index, state := range view.States {
		name := fmt.Sprintf("state-%02d%s", index+1, strings.ToLower(filepath.Ext(state.Path)))
		if err := copyFile(state.Path, filepath.Join(staging, name)); err != nil {
			return nil, err
		}
		input, err := descriptor(staging, name)
		if err != nil {
			return nil, err
		}
		input.Set("role", textStateRole(index))
		inputs = append(inputs, input)
		states = append(states, toolcli.Record("frame", state.Frame, "path", name, "from_frame", toolrt.NewInt(int64(state.FromFrame))))
	}
	original, err := descriptor(staging, "original.mp4")
	if err != nil {
		return nil, err
	}
	video, err := descriptor(staging, "video.mp4")
	if err != nil {
		return nil, err
	}
	preparation, err := acceptshot.StaticPreparation(root, directory, workflow, view.Shot, staging, inputs)
	if err != nil {
		return nil, err
	}
	params := toolrt.NewDict()
	for _, spec := range effects.StaticParams {
		params.Set(spec.Name, view.Params[spec.Name])
	}
	fps, frames := view.FPS, int64(view.Frames)
	rate := strconv.FormatInt(fps, 10)
	seconds := float64(frames) / float64(fps)
	// Сведения ролика как у обычной приёмки (поля ffprobe): размер, частота, длительность, кадры.
	media := toolcli.Record("width", toolrt.NewInt(Width), "height", toolrt.NewInt(Height), "r_frame_rate", rate+"/1",
		"duration", strconv.FormatFloat(seconds, 'f', 6, 64), "nb_frames", strconv.FormatInt(frames, 10))
	filter := "fps=" + rate + ",trim=start_frame=0:end_frame=" + strconv.FormatInt(frames, 10) + ",setpts=N/(" + rate + "*TB),setsar=1"
	return toolcli.Record(
		"schema_version", toolrt.NewInt(1),
		"shot", view.Shot,
		"kind", Kind,
		"generation", toolcli.Record(
			"source_shot", view.Shot,
			"original", original,
			"original_media", media,
			"inputs", inputs,
			"preparation", preparation,
			"static", toolcli.Record("version", toolrt.NewInt(effects.StaticVersion), "states", states, "params", params, "ffmpeg_version", stored.FFmpeg),
			"lipsync", false,
			"audio", nil,
		),
		"accepted_edit", toolcli.Record(
			"video", video,
			"fps", toolrt.NewInt(fps),
			"frames", toolrt.NewInt(frames),
			"duration_seconds", seconds,
			"source_interval_seconds", []any{0.0, seconds},
			"source_interval_end_exclusive", true,
			"source_frame_grid_fps", toolrt.NewInt(fps),
			"still_source_time_seconds", nil,
			"speed", toolcli.Record("factor", 1.0, "ratio", "1", "selected_source_seconds", seconds, "motion_output_seconds", seconds, "duration_change_seconds", 0.0),
			"hold_first_seconds", 0.0,
			"hold_last_seconds", 0.0,
			"audio_policy", "Звука нет: статичный кадр собран из опор.",
			"montage_source", video,
			"rebuild", toolcli.Record(
				"stages", []any{toolcli.Record("input", "original.mp4", "filter", filter, "frames", toolrt.NewInt(frames))},
				"source", original,
				"ffmpeg_version", stored.FFmpeg,
				"note", textRebuildNote,
			),
			"source_frame_interval_exclusive", []any{toolrt.NewInt(0), toolrt.NewInt(frames)},
			"source_fps", rate+"/1",
			"fps_conversion", "Исходная частота кадров совпадает со шкалой.",
		),
	), nil
}
