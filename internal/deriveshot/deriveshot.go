// Package deriveshot — перенос tools/derive_shot оригинала: локальная сборка производного плана из
// принятого клипа другого плана без платной генерации и приёмка показанных байтов.
//
// build применяет рецепт (trim, fit, still или repeat) к текущему accepted_edit обычного плана,
// указанного в derived_from: кадры кодируются общим рецептом accept_shot, рядом собирается
// предпросмотр с участком песни, а рабочая папка plan/derived/<план>/<id> публикуется одним rename и
// больше не меняется. result_token связывает контекст, рецепт и точные байты: приёмка без него
// невозможна, а изменившийся источник, постановка, музыка или файл результата требуют новой пробы.
//
// accept собирает новый комплект в копии проекта plan/derived-history/<id>/staging вместе со
// статусом производства и представлениями, ведёт журнал journal.json с резервами и публикует папку
// комплекта и документы; прерванная публикация откатывается (Recover), а изменённый после сбоя файл
// останавливает откат. Восстановление того же журнала при открытии проекта выполняет
// internal/derivedworkflow. Вывод CLI (Run) — тексты, коды и JSON оригинала.
package deriveshot

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"songframe-go/internal/applymontage"
	"songframe-go/internal/assetpackage"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// History — папка журналов приёмок производных планов от корня проекта (HISTORY оригинала).
const History = "plan/derived-history"

// fps — кадровая сетка производных планов.
var fps = pycompat.NewInt(30)

// Тексты оригинала (ValueError, печатаются как есть).
const (
	textRelative      = "Нужен относительный путь внутри проекта."
	textRecipeObject  = "Рецепт должен быть объектом JSON."
	textRecipeFields  = "Рецепт требует ровно поля выбранного режима trim, fit, still или repeat."
	textRecipeBounds  = "Выбранный участок выходит за текущий принятый клип источника."
	textNotDerived    = "Выберите производный план с derived_from.shot."
	textLipsync       = "Производный план с липсинком нельзя собрать локально: синхронность губ не гарантируется."
	textBadSource     = "Источником должен быть обычный план без derived_from."
	textAcceptSource  = "Сначала примите источник по текущей постановке на сетке 30 FPS."
	textNewWorkDir    = "Для новой пробы нужна новая рабочая папка plan/derived/Mxx/<id>."
	textChangedBuild  = "Источник, постановка, музыка или рецепт изменились при сборке. Соберите новую пробу."
	textBadConfirm    = "Подтверждение не соответствует показанному результату. Соберите новую пробу."
	textChangedResult = "Источник, постановка или музыка изменились после пробы. Соберите новую пробу."
	textChangedRecipe = "Рецепт изменился после пробы. Соберите новую пробу."
	textChangedParams = "Параметры сборки изменились после пробы."
	textChangedKit    = "Комплект источника изменился после пробы. Соберите новую пробу."
	textChangedFile   = "Файл результата изменился после пробы: "
)

func valueError(message string) error { return pycompat.New(pycompat.ValueError, message) }

// Точки подмены для тестов сбоев (patch.object в test_derive_shot оригинала): рендер кандидата,
// публикация папки и файла, итоговая проверка комплекта, откат. В работе не меняются.
var (
	renderEdit        = applymontage.RenderEdit
	publishDirectory  = moveDirectory
	publishFile       = applymontage.PublishFile
	validatePublished = assetpackage.ValidatePackage
	restoreHook       = restore
)

// NewID — uuid4().hex транзакции приёмки. Тесты эталонов подменяют его ID оригинала; имя временной
// папки сборки берётся из randomHex, чтобы не расходовать эту очередь.
var NewID = randomHex

// randomHex — uuid4().hex.
func randomHex() string {
	data := make([]byte, 16)
	_, _ = rand.Read(data)
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	return hex.EncodeToString(data)
}

// active — число выполняющихся команд инструмента по разрешённому корню проекта. Оригинал не
// откатывал журнал при открытии проекта, пока идёт задание этого проекта: живая публикация не
// является прерванной. Инструмент работает в процессе приложения, поэтому признак ведёт сам пакет.
var active struct {
	sync.Mutex
	counts map[string]int
}

// Active сообщает, выполняется ли сейчас команда инструмента над проектом root в этом процессе.
// Тогда восстановление при открытии проекта (internal/derivedworkflow) пропускается.
func Active(root string) bool {
	root = pycompat.ResolvePath(root)
	active.Lock()
	defer active.Unlock()
	return active.counts[root] > 0
}

// enter отмечает начало команды над проектом и возвращает функцию завершения.
func enter(root string) func() {
	active.Lock()
	if active.counts == nil {
		active.counts = map[string]int{}
	}
	active.counts[root]++
	active.Unlock()
	return func() {
		active.Lock()
		defer active.Unlock()
		if active.counts[root]--; active.counts[root] == 0 {
			delete(active.counts, root)
		}
	}
}

// pathText — Path(value): только строка, иначе TypeError (скрытый текст CLI).
func pathText(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "expected str, bytes or os.PathLike object, not %s", pycompat.TypeName(value))
	}
	return text, nil
}

// projectPath — project_path(root, value, prefix): пути рецепта и результата переносимы и остаются
// в выбранном проекте. Пустой prefix — без проверки папки.
func projectPath(root string, value any, prefix string) (string, error) {
	name, err := pathText(value)
	if err != nil {
		return "", err
	}
	path := pycompat.ResolvePath(pycompat.JoinPath(root, name))
	escape := false
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		escape = escape || part == ".."
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") || escape || !pycompat.IsRelativeTo(path, root) {
		return "", valueError(textRelative)
	}
	if prefix != "" && !pycompat.IsRelativeTo(path, pycompat.JoinPath(root, prefix)) {
		return "", valueError("Рабочая папка должна находиться в " + prefix + ".")
	}
	return path, nil
}

// readJSON — json.loads(path.read_text(encoding="utf-8")).
func readJSON(path string) (any, error) {
	text, err := pycompat.ReadText(path)
	if err != nil {
		return nil, err
	}
	return pycompat.LoadsJSON(text)
}

// relative — path.relative_to(root).as_posix().
func relative(path, root string) (string, error) {
	name, err := pycompat.RelativeTo(path, root)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(name), nil
}

// attributeError — AttributeError вызова метода dict у значения другого типа: необработанное
// исключение оригинала (трассировка, код 1).
func attributeError(value any, method string) error {
	return pycompat.New("AttributeError", "'"+pycompat.TypeName(value)+"' object has no attribute '"+method+"'")
}

// dictOf — значение как словарь для вызова метода method.
func dictOf(value any, method string) (*pycompat.Dict, error) {
	if dict, ok := value.(*pycompat.Dict); ok {
		return dict, nil
	}
	return nil, attributeError(value, method)
}

// wholeNumber — значение как целое Python для кадровых формул; другие типы рецепт и реестр не
// пропускают, поэтому отказ — TypeError.
func wholeNumber(value any) (pycompat.Int, error) {
	if number, ok := value.(pycompat.Int); ok {
		return number, nil
	}
	return pycompat.Int{}, pycompat.Raise(pycompat.TypeError, "expected int, not %s", pycompat.TypeName(value))
}

// recipeFields — обязательный набор полей каждого режима рецепта.
var recipeFields = map[string][]string{
	"trim":   {"mode", "start_frame"},
	"fit":    {"mode", "start_frame", "end_frame_exclusive"},
	"still":  {"mode", "frame"},
	"repeat": {"mode", "start_frame", "end_frame_exclusive"},
}

// sameKeys — set(recipe) == fields.
func sameKeys(recipe *pycompat.Dict, fields []string) bool {
	if recipe.Len() != len(fields) {
		return false
	}
	for _, field := range fields {
		if !recipe.Has(field) {
			return false
		}
	}
	return true
}

// cutPlan — итог recipe_plan: фильтр FFmpeg, выбранный полуоткрытый интервал кадров источника и
// отношение скорости.
type cutPlan struct {
	filter      string
	first, last pycompat.Int
	factor      *big.Rat
}

// recipePlan — recipe_plan(recipe, frames, source_frames): все интервалы явные, fit дублирует или
// выбирает кадры, repeat повторяет только заданный цикл. Порядок проверок — оригинала: он задаёт,
// какое сообщение увидит пользователь при нескольких ошибках сразу.
func recipePlan(recipe, framesValue, sourceFrames any) (*cutPlan, error) {
	data, ok := recipe.(*pycompat.Dict)
	if !ok {
		return nil, valueError(textRecipeObject)
	}
	modeValue := data.Value("mode")
	if _, err := pycompat.HashKey(modeValue); err != nil {
		return nil, err // `mode in fields` для списка или словаря — TypeError.
	}
	mode, _ := modeValue.(string)
	fields, known := recipeFields[mode]
	if !known || !sameKeys(data, fields) {
		return nil, valueError(textRecipeFields)
	}
	for _, key := range data.Keys() {
		if number, whole := data.Value(key).(pycompat.Int); key != "mode" && (!whole || number.Sign() < 0) {
			return nil, valueError(key + " должен быть целым неотрицательным числом кадров.")
		}
	}
	frames, err := wholeNumber(framesValue)
	if err != nil {
		return nil, err
	}
	still := mode == "still"
	var first, last pycompat.Int
	if still {
		first = data.Value("frame").(pycompat.Int)
	} else {
		first = data.Value("start_frame").(pycompat.Int)
	}
	switch mode {
	case "still":
		last = pycompat.IntFromBig(new(big.Int).Add(first.Big(), big.NewInt(1)))
	case "trim":
		last = pycompat.IntFromBig(new(big.Int).Add(first.Big(), frames.Big()))
	default:
		last = data.Value("end_frame_exclusive").(pycompat.Int)
	}
	inside := first.Big().Cmp(last.Big()) < 0
	if inside {
		if inside, err = pycompat.LessEqual(last, sourceFrames); err != nil {
			return nil, err
		}
	}
	if !inside {
		return nil, valueError(textRecipeBounds)
	}
	length := pycompat.IntFromBig(new(big.Int).Sub(last.Big(), first.Big()))
	stages := []string{"fps=30", "trim=start_frame=" + first.String() + ":end_frame=" + last.String(), "setpts=PTS-STARTPTS"}
	factor := big.NewRat(1, 1)
	switch mode {
	case "fit":
		factor = new(big.Rat).SetFrac(length.Big(), frames.Big())
		stages = append(stages, "setpts=PTS*"+frames.String()+"/"+length.String(), "fps=30:round=near")
	case "still", "repeat":
		if still {
			factor = new(big.Rat)
		}
		stages = append(stages, "loop=loop=-1:size="+length.String()+":start=0", "trim=end_frame="+frames.String(), "setpts=N/(30*TB)")
	}
	stages = append(stages, "scale=1920:1080:force_original_aspect_ratio=decrease", "pad=1920:1080:(ow-iw)/2:(oh-ih)/2", "setsar=1")
	return &cutPlan{filter: strings.Join(stages, ","), first: first, last: last, factor: factor}, nil
}

// sourceContext — итог snapshot: контекст пробы current и прочитанные вместе с ним реестр, сцена,
// комплект источника и путь его текущего принятого клипа.
type sourceContext struct {
	current  *pycompat.Dict
	registry *pycompat.Dict
	scene    *pycompat.Dict
	pkg      *pycompat.Dict
	source   string
}

// lookup — scenes.get(key): непривязываемый ключ — TypeError, неизвестный — nil.
func lookup(scenes map[string]*pycompat.Dict, key any) (*pycompat.Dict, error) {
	if _, err := pycompat.HashKey(key); err != nil {
		return nil, err
	}
	name, _ := key.(string)
	return scenes[name], nil
}

// snapshot — snapshot(shot, root): источник — только актуальный accepted_edit обычного плана из
// derived_from. Значение current сравнивается целиком при сборке и приёмке.
func snapshot(shot any, root string) (*sourceContext, error) {
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	list, err := pycompat.Iter(registry.Value("scenes"))
	if err != nil {
		return nil, err
	}
	scenes := map[string]*pycompat.Dict{}
	for _, item := range list {
		id, err := pycompat.Item(item, "id")
		if err != nil {
			return nil, err
		}
		if name, ok := id.(string); ok {
			scenes[name], _ = item.(*pycompat.Dict)
		}
	}
	scene, err := lookup(scenes, shot)
	if err != nil {
		return nil, err
	}
	var origin *pycompat.Dict
	if scene != nil {
		origin, _ = scene.Value("derived_from").(*pycompat.Dict)
	}
	if origin == nil {
		return nil, valueError(textNotDerived)
	}
	if pycompat.Truthy(scene.Value("lipsync")) {
		return nil, valueError(textLipsync)
	}
	sourceShot := origin.Value("shot")
	sourceScene, err := lookup(scenes, sourceShot)
	if err != nil {
		return nil, err
	}
	if sourceScene == nil || pycompat.Truthy(sourceScene.Value("derived_from")) {
		return nil, valueError(textBadSource)
	}
	if !pycompat.Equal(registry.Value("fps"), fps) {
		return nil, valueError(textAcceptSource)
	}
	acceptance, err := sceneregistry.ProjectShotAcceptance(root, registry)
	if err != nil {
		return nil, err
	}
	sourceName := sourceShot.(string)
	if acceptance.States.Value(sourceName) != sceneregistry.Completed {
		return nil, valueError(textAcceptSource)
	}
	manifest := pycompat.JoinPath(root, "assets/shots", sourceName, "manifest.json")
	pkg, err := assetpackage.ValidatePackage(manifest, sourceName, root)
	if err != nil {
		return nil, err
	}
	edit, err := pycompat.Item(pkg, "accepted_edit")
	if err != nil {
		return nil, err
	}
	video, err := pycompat.Item(edit, "video")
	if err != nil {
		return nil, err
	}
	descriptor, err := dictOf(video, "get")
	if err != nil {
		return nil, err
	}
	source, err := assetpackage.DescriptorFile(filepath.Dir(manifest), descriptor, root)
	if err != nil {
		return nil, err
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	fingerprints, err := sceneregistry.SceneFingerprints(registry, initial)
	if err != nil {
		return nil, err
	}
	// Музыка относится к показанной пробе: замена трека не меняет постановку, но прежнее
	// подтверждение уже не описывает актуальный музыкальный контекст.
	track, err := pycompat.GetItem(registry.Value("audio"), "path")
	if err != nil {
		return nil, err
	}
	song, err := projectPath(root, track, "")
	if err != nil {
		return nil, err
	}
	sourceDigest, err := assetpackage.FileSHA256(source)
	if err != nil {
		return nil, err
	}
	sourceFingerprint, err := pycompat.Item(fingerprints, sourceName)
	if err != nil {
		return nil, err
	}
	targetFingerprint, err := pycompat.Item(fingerprints, shot.(string))
	if err != nil {
		return nil, err
	}
	frames, err := pycompat.Sub(scene.Value("end_frame_exclusive"), scene.Value("start_frame"))
	if err != nil {
		return nil, err
	}
	songDigest, err := applymontage.DigestOrNone(song)
	if err != nil {
		return nil, err
	}
	current := pytool.Record(
		"shot", shot,
		"source_shot", sourceShot,
		"source_scene_sha256", sourceFingerprint,
		"source_accepted_video_sha256", sourceDigest,
		"target_scene_sha256", targetFingerprint,
		"target_frames", frames,
		"audio_source", pytool.Record("path", track, "sha256", songDigest),
	)
	return &sourceContext{current: current, registry: registry, scene: scene, pkg: pkg, source: source}, nil
}

// tokenFor — token_for(preview, build): SHA-256 канонического JSON связывает контекст, рецепт и
// точные принятые и показанные байты.
func tokenFor(preview *pycompat.Dict, receipt any) (string, error) {
	shown := preview.Clone()
	shown.Delete("result_token")
	text, err := pycompat.DumpsJSON(pytool.Record("preview", shown, "build", receipt), pycompat.DumpOptions{SortKeys: true, Compact: true})
	if err != nil {
		return "", err
	}
	data, err := pycompat.EncodeUTF8(text)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// ffmpegVersion — первая строка `ffmpeg -version`.
func ffmpegVersion(ctx context.Context) (string, error) {
	output, err := applymontage.Media(ctx, mediacmd.FFmpeg(), "-version")
	if err != nil {
		return "", err
	}
	text, err := pycompat.DecodeUTF8(output)
	if err != nil {
		return "", err
	}
	lines := pycompat.SplitLines(text)
	if len(lines) == 0 {
		return "", pycompat.New("IndexError", "list index out of range")
	}
	return lines[0], nil
}

// seconds — str(frames / FPS) аргумента времени FFmpeg.
func seconds(frames any) (string, error) {
	value, err := pycompat.TrueDiv(frames, fps)
	if err != nil {
		return "", err
	}
	return pycompat.FloatRepr(value), nil
}

// buildPreview — кандидат с участком песни; без файла песни предпросмотр равен кандидату.
func buildPreview(ctx context.Context, root string, state *sourceContext, temporary string) error {
	track, err := pycompat.GetItem(state.registry.Value("audio"), "path")
	if err != nil {
		return err
	}
	song, err := projectPath(root, track, "")
	if err != nil {
		return err
	}
	candidate, preview := filepath.Join(temporary, "candidate.mp4"), filepath.Join(temporary, "preview.mp4")
	if !pycompat.IsFile(song) {
		return applymontage.CopyFile(candidate, preview)
	}
	start, err := seconds(state.scene.Value("start_frame"))
	if err != nil {
		return err
	}
	length, err := seconds(state.current.Value("target_frames"))
	if err != nil {
		return err
	}
	_, err = applymontage.Media(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-n", "-i", candidate, "-ss", start, "-i", song,
		"-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", length, preview)
	return err
}

// build — build(shot, recipe, work_dir, root): собирает пробу во временной папке рядом с целью и
// публикует её одним rename. Опубликованная папка больше не меняется, даже при приёмке. Контекст
// сверяется после рендера: пока шло кодирование, источник, музыка или рецепт могли измениться.
func build(ctx context.Context, shot, recipe, workDir, root string) (*pycompat.Dict, error) {
	state, err := snapshot(shot, root)
	if err != nil {
		return nil, err
	}
	recipePath, err := projectPath(root, recipe, "")
	if err != nil {
		return nil, err
	}
	base := "plan/derived/" + shot
	directory, err := projectPath(root, workDir, base)
	if err != nil {
		return nil, err
	}
	if filepath.Dir(directory) != pycompat.JoinPath(root, base) || pycompat.Exists(directory) {
		return nil, valueError(textNewWorkDir)
	}
	selected, err := readJSON(recipePath)
	if err != nil {
		return nil, err
	}
	sourceFrames, err := acceptedFrames(state.pkg)
	if err != nil {
		return nil, err
	}
	plan, err := recipePlan(selected, state.current.Value("target_frames"), sourceFrames)
	if err != nil {
		return nil, err
	}
	recipeName, err := relative(recipePath, root)
	if err != nil {
		return nil, err
	}
	recipeDigest, err := assetpackage.FileSHA256(recipePath)
	if err != nil {
		return nil, err
	}
	sourceName := state.current.Value("source_shot").(string)
	manifestDigest, err := assetpackage.FileSHA256(pycompat.JoinPath(root, "assets/shots", sourceName, "manifest.json"))
	if err != nil {
		return nil, err
	}
	version, err := ffmpegVersion(ctx)
	if err != nil {
		return nil, err
	}
	receipt := pytool.Record(
		"recipe_path", recipeName,
		"recipe_sha256", recipeDigest,
		"filter", plan.filter,
		"target_start_frame", state.scene.Value("start_frame"),
		"target_end_frame_exclusive", state.scene.Value("end_frame_exclusive"),
		"source_manifest_sha256", manifestDigest,
		"ffmpeg_version", version,
	)
	if err := os.MkdirAll(filepath.Dir(directory), 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, filepath.Dir(directory))
	}
	temporary := filepath.Join(filepath.Dir(directory), "."+filepath.Base(directory)+".building-"+randomHex())
	if err := os.Mkdir(temporary, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, temporary)
	}
	defer os.RemoveAll(temporary)
	frames, err := wholeNumber(state.current.Value("target_frames"))
	if err != nil {
		return nil, err
	}
	if err := renderEdit(ctx, state.source, plan.filter, frames, filepath.Join(temporary, "candidate.mp4")); err != nil {
		return nil, err
	}
	if err := buildPreview(ctx, root, state, temporary); err != nil {
		return nil, err
	}
	video, err := applymontage.Descriptor(temporary, "candidate.mp4")
	if err != nil {
		return nil, err
	}
	shown, err := applymontage.Descriptor(temporary, "preview.mp4")
	if err != nil {
		return nil, err
	}
	preview := pytool.Record("schema_version", pycompat.NewInt(1))
	for _, key := range state.current.Keys() {
		preview.Set(key, state.current.Value(key))
	}
	preview.Set("recipe", selected)
	preview.Set("video", video)
	preview.Set("preview", shown)
	token, err := tokenFor(preview, receipt)
	if err != nil {
		return nil, err
	}
	preview.Set("result_token", token)
	again, err := snapshot(shot, root)
	if err != nil {
		return nil, err
	}
	digest, err := assetpackage.FileSHA256(recipePath)
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(again.current, state.current) || digest != recipeDigest {
		return nil, valueError(textChangedBuild)
	}
	for _, item := range []struct {
		name  string
		value any
	}{{"recipe.json", selected}, {"build.json", receipt}, {"preview.json", preview}} {
		data, err := applymontage.JSONBytes(item.value)
		if err != nil {
			return nil, err
		}
		if err := applymontage.ReplaceBytes(filepath.Join(temporary, item.name), data); err != nil {
			return nil, err
		}
	}
	if err := os.Rename(temporary, directory); err != nil {
		return nil, pycompat.OSErrorFrom(err, temporary)
	}
	name, err := relative(directory, root)
	if err != nil {
		return nil, err
	}
	result := preview.Clone()
	result.Set("status", "built")
	result.Set("work_dir", name)
	return result, nil
}

// acceptedFrames — package["accepted_edit"]["frames"].
func acceptedFrames(pkg *pycompat.Dict) (any, error) {
	edit, err := pycompat.Item(pkg, "accepted_edit")
	if err != nil {
		return nil, err
	}
	return pycompat.Item(edit, "frames")
}

// checkedResult — итог checked_result: показанная проба и её актуальный контекст.
type checkedResult struct {
	preview *pycompat.Dict
	receipt any
	state   *sourceContext
	plan    *cutPlan
}

// checkResult — checked_result(directory, confirm, root): подтверждение действует только для тех
// же контекста, рецепта, параметров, комплекта источника и файлов результата, что показаны.
func checkResult(directory, confirm, root string) (*checkedResult, error) {
	previewValue, err := readJSON(filepath.Join(directory, "preview.json"))
	if err != nil {
		return nil, err
	}
	receipt, err := readJSON(filepath.Join(directory, "build.json"))
	if err != nil {
		return nil, err
	}
	preview, err := dictOf(previewValue, "get")
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(preview.Value("schema_version"), pycompat.NewInt(1)) || !pycompat.Equal(preview.Value("result_token"), confirm) {
		return nil, valueError(textBadConfirm)
	}
	token, err := tokenFor(preview, receipt)
	if err != nil {
		return nil, err
	}
	if token != confirm {
		return nil, valueError(textBadConfirm)
	}
	shot, err := pycompat.Item(preview, "shot")
	if err != nil {
		return nil, err
	}
	state, err := snapshot(shot, root)
	if err != nil {
		return nil, err
	}
	for _, key := range state.current.Keys() {
		if !pycompat.Equal(preview.Value(key), state.current.Value(key)) {
			return nil, valueError(textChangedResult)
		}
	}
	recipeName, err := pycompat.Item(receipt, "recipe_path")
	if err != nil {
		return nil, err
	}
	recipePath, err := projectPath(root, recipeName, "")
	if err != nil {
		return nil, err
	}
	digest, err := assetpackage.FileSHA256(recipePath)
	if err != nil {
		return nil, err
	}
	recorded, err := pycompat.Item(receipt, "recipe_sha256")
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(digest, recorded) {
		return nil, valueError(textChangedRecipe)
	}
	saved, err := readJSON(filepath.Join(directory, "recipe.json"))
	if err != nil {
		return nil, err
	}
	recipe, err := pycompat.Item(preview, "recipe")
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(saved, recipe) {
		return nil, valueError(textChangedRecipe)
	}
	sourceFrames, err := acceptedFrames(state.pkg)
	if err != nil {
		return nil, err
	}
	plan, err := recipePlan(recipe, state.current.Value("target_frames"), sourceFrames)
	if err != nil {
		return nil, err
	}
	for _, item := range []struct {
		key   string
		value any
	}{{"filter", plan.filter}, {"target_start_frame", state.scene.Value("start_frame")}, {"target_end_frame_exclusive", state.scene.Value("end_frame_exclusive")}} {
		value, err := pycompat.Item(receipt, item.key)
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(value, item.value) {
			return nil, valueError(textChangedParams)
		}
	}
	manifest := pycompat.JoinPath(root, "assets/shots", state.current.Value("source_shot").(string), "manifest.json")
	if digest, err = assetpackage.FileSHA256(manifest); err != nil {
		return nil, err
	}
	if recorded, err = pycompat.Item(receipt, "source_manifest_sha256"); err != nil {
		return nil, err
	}
	if !pycompat.Equal(digest, recorded) {
		return nil, valueError(textChangedKit)
	}
	for _, item := range [][2]string{{"video", "candidate.mp4"}, {"preview", "preview.mp4"}} {
		shown, err := pycompat.Item(preview, item[0])
		if err != nil {
			return nil, err
		}
		actual, err := applymontage.Descriptor(directory, item[1])
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(shown, actual) {
			return nil, valueError(textChangedFile + item[1])
		}
	}
	return &checkedResult{preview: preview, receipt: receipt, state: state, plan: plan}, nil
}
