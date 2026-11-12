// Package deriveshot локально собирает производный план из принятого клипа другого плана без
// платной генерации и принимает показанные байты (инструмент derive_shot).
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
// internal/derivedworkflow. Вывод CLI (Run) — тексты, коды и JSON зафиксированы эталоном
// testdata/golden/derive-shot.
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

	"songframe/internal/applymontage"
	"songframe/internal/assetpackage"
	"songframe/internal/mediacmd"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// History — папка журналов приёмок производных планов от корня проекта.
const History = "plan/derived-history"

// Тексты отказов (ValueError, печатаются как есть).
const (
	textRelative      = "Нужен относительный путь внутри проекта."
	textRecipeObject  = "Рецепт должен быть объектом JSON."
	textRecipeFields  = "Рецепт требует ровно поля выбранного режима trim, fit, still или repeat."
	textRecipeBounds  = "Выбранный участок выходит за текущий принятый клип источника."
	textNotDerived    = "Выберите производный план с derived_from.shot."
	textLipsync       = "Производный план с липсинком нельзя собрать локально: синхронность губ не гарантируется."
	textBadSource     = "Источником должен быть обычный план без derived_from."
	textNewWorkDir    = "Для новой пробы нужна новая рабочая папка plan/derived/Mxx/<id>."
	textChangedBuild  = "Источник, постановка, музыка или рецепт изменились при сборке. Соберите новую пробу."
	textBadConfirm    = "Подтверждение не соответствует показанному результату. Соберите новую пробу."
	textChangedResult = "Источник, постановка или музыка изменились после пробы. Соберите новую пробу."
	textChangedRecipe = "Рецепт изменился после пробы. Соберите новую пробу."
	textChangedParams = "Параметры сборки изменились после пробы."
	textChangedKit    = "Комплект источника изменился после пробы. Соберите новую пробу."
	textChangedFile   = "Файл результата изменился после пробы: "
)

// textAcceptSource — источник не принят по текущей постановке на сетке частоты проекта fps.
func textAcceptSource(fps toolrt.Int) string {
	return "Сначала примите источник по текущей постановке на сетке " + fps.String() + " FPS."
}

func valueError(message string) error { return toolrt.New(toolrt.ValueError, message) }

// Точки подмены для тестов сбоев: рендер кандидата,
// публикация папки и файла, итоговая проверка комплекта, откат. В работе не меняются.
var (
	renderEdit        = applymontage.RenderEdit
	publishDirectory  = moveDirectory
	publishFile       = applymontage.PublishFile
	validatePublished = assetpackage.ValidatePackage
	restoreHook       = restore
)

// NewID — uuid4().hex транзакции приёмки. Тесты эталонов подменяют его ID из эталона; имя временной
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

// active — число выполняющихся команд инструмента по разрешённому корню проекта. Пока идёт
// задание этого проекта, журнал при открытии проекта не откатывается: живая публикация не
// является прерванной. Инструмент работает в процессе приложения, поэтому признак ведёт сам пакет.
var active struct {
	sync.Mutex
	counts map[string]int
}

// Active сообщает, выполняется ли сейчас команда инструмента над проектом root в этом процессе.
// Тогда восстановление при открытии проекта (internal/derivedworkflow) пропускается.
func Active(root string) bool {
	root = toolrt.ResolvePath(root)
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

// pathText — путь из значения JSON: только строка, иначе TypeError (скрытый текст CLI).
func pathText(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "путь должен быть строкой, получено: %s", toolrt.TypeName(value))
	}
	return text, nil
}

// projectPath проверяет, что пути рецепта и результата переносимы и остаются
// в выбранном проекте. Пустой prefix — без проверки папки.
func projectPath(root string, value any, prefix string) (string, error) {
	name, err := pathText(value)
	if err != nil {
		return "", err
	}
	path := toolrt.ResolvePath(toolrt.JoinPath(root, name))
	escape := false
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		escape = escape || part == ".."
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") || escape || !toolrt.IsRelativeTo(path, root) {
		return "", valueError(textRelative)
	}
	if prefix != "" && !toolrt.IsRelativeTo(path, toolrt.JoinPath(root, prefix)) {
		return "", valueError("Рабочая папка должна находиться в " + prefix + ".")
	}
	return path, nil
}

// readJSON — JSON-документ файла в UTF-8 (строгий разбор toolrt.LoadsJSON).
func readJSON(path string) (any, error) {
	text, err := toolrt.ReadText(path)
	if err != nil {
		return nil, err
	}
	return toolrt.LoadsJSON(text)
}

// relative — путь path относительно root через «/»; путь вне root — ValueError.
func relative(path, root string) (string, error) {
	name, err := toolrt.RelativeTo(path, root)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(name), nil
}

// attributeError — AttributeError вызова метода у значения другого вида: необработанная ошибка
// (код 1). Метод списка extend ожидает список, остальные методы (get, update, setdefault) — объект.
func attributeError(value any, method string) error {
	expected := "объект"
	if method == "extend" {
		expected = "список"
	}
	return toolrt.New(toolrt.AttributeError, "ожидается "+expected+", получено: "+toolrt.TypeName(value))
}

// dictOf — значение как словарь для вызова метода method.
func dictOf(value any, method string) (*toolrt.Dict, error) {
	if dict, ok := value.(*toolrt.Dict); ok {
		return dict, nil
	}
	return nil, attributeError(value, method)
}

// wholeNumber — значение как целое toolrt.Int для кадровых формул; другие типы рецепт и реестр не
// пропускают, поэтому отказ — TypeError.
func wholeNumber(value any) (toolrt.Int, error) {
	if number, ok := value.(toolrt.Int); ok {
		return number, nil
	}
	return toolrt.Int{}, toolrt.Raise(toolrt.TypeError, "ожидается целое число, получено: %s", toolrt.TypeName(value))
}

// recipeFields — обязательный набор полей каждого режима рецепта.
var recipeFields = map[string][]string{
	"trim":   {"mode", "start_frame"},
	"fit":    {"mode", "start_frame", "end_frame_exclusive"},
	"still":  {"mode", "frame"},
	"repeat": {"mode", "start_frame", "end_frame_exclusive"},
}

// sameKeys — множество ключей рецепта совпадает с fields.
func sameKeys(recipe *toolrt.Dict, fields []string) bool {
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

// cutPlan — итог recipePlan: фильтр FFmpeg, выбранный полуоткрытый интервал кадров источника и
// отношение скорости.
type cutPlan struct {
	filter      string
	first, last toolrt.Int
	factor      *big.Rat
}

// recipePlan — план кадров рецепта: все интервалы явные, fit дублирует или выбирает кадры,
// repeat повторяет только заданный цикл. Порядок проверок зафиксирован эталоном: он задаёт,
// какое сообщение увидит пользователь при нескольких ошибках сразу.
func recipePlan(recipe, framesValue, sourceFrames any, fps toolrt.Int) (*cutPlan, error) {
	data, ok := recipe.(*toolrt.Dict)
	if !ok {
		return nil, valueError(textRecipeObject)
	}
	modeValue := data.Value("mode")
	if _, err := toolrt.HashKey(modeValue); err != nil {
		return nil, err // `mode in fields` для списка или словаря — TypeError.
	}
	mode, _ := modeValue.(string)
	fields, known := recipeFields[mode]
	if !known || !sameKeys(data, fields) {
		return nil, valueError(textRecipeFields)
	}
	for _, key := range data.Keys() {
		if number, whole := data.Value(key).(toolrt.Int); key != "mode" && (!whole || number.Sign() < 0) {
			return nil, valueError(key + " должен быть целым неотрицательным числом кадров.")
		}
	}
	frames, err := wholeNumber(framesValue)
	if err != nil {
		return nil, err
	}
	still := mode == "still"
	var first, last toolrt.Int
	if still {
		first = data.Value("frame").(toolrt.Int)
	} else {
		first = data.Value("start_frame").(toolrt.Int)
	}
	switch mode {
	case "still":
		last = toolrt.IntFromBig(new(big.Int).Add(first.Big(), big.NewInt(1)))
	case "trim":
		last = toolrt.IntFromBig(new(big.Int).Add(first.Big(), frames.Big()))
	default:
		last = data.Value("end_frame_exclusive").(toolrt.Int)
	}
	inside := first.Big().Cmp(last.Big()) < 0
	if inside {
		if inside, err = toolrt.LessEqual(last, sourceFrames); err != nil {
			return nil, err
		}
	}
	if !inside {
		return nil, valueError(textRecipeBounds)
	}
	length := toolrt.IntFromBig(new(big.Int).Sub(last.Big(), first.Big()))
	rate := fps.String()
	stages := []string{"fps=" + rate, "trim=start_frame=" + first.String() + ":end_frame=" + last.String(), "setpts=PTS-STARTPTS"}
	factor := big.NewRat(1, 1)
	switch mode {
	case "fit":
		factor = new(big.Rat).SetFrac(length.Big(), frames.Big())
		stages = append(stages, "setpts=PTS*"+frames.String()+"/"+length.String(), "fps="+rate+":round=near")
	case "still", "repeat":
		if still {
			factor = new(big.Rat)
		}
		stages = append(stages, "loop=loop=-1:size="+length.String()+":start=0", "trim=end_frame="+frames.String(), "setpts=N/("+rate+"*TB)")
	}
	stages = append(stages, "scale=1920:1080:force_original_aspect_ratio=decrease", "pad=1920:1080:(ow-iw)/2:(oh-ih)/2", "setsar=1")
	return &cutPlan{filter: strings.Join(stages, ","), first: first, last: last, factor: factor}, nil
}

// sourceContext — итог snapshot: контекст пробы current и прочитанные вместе с ним реестр, сцена,
// комплект источника и путь его текущего принятого клипа.
type sourceContext struct {
	// fps — частота кадров проекта: сетка источника и производного плана.
	fps      toolrt.Int
	current  *toolrt.Dict
	registry *toolrt.Dict
	scene    *toolrt.Dict
	pkg      *toolrt.Dict
	source   string
}

// lookup — сцена по коду key: нехешируемый ключ — TypeError, неизвестный — nil.
func lookup(scenes map[string]*toolrt.Dict, key any) (*toolrt.Dict, error) {
	if _, err := toolrt.HashKey(key); err != nil {
		return nil, err
	}
	name, _ := key.(string)
	return scenes[name], nil
}

// snapshot — контекст источника плана shot: только актуальный accepted_edit обычного плана из
// derived_from. Значение current сравнивается целиком при сборке и приёмке.
func snapshot(shot any, root string) (*sourceContext, error) {
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	list, err := toolrt.Iter(registry.Value("scenes"))
	if err != nil {
		return nil, err
	}
	scenes := map[string]*toolrt.Dict{}
	for _, item := range list {
		id, err := toolrt.Item(item, "id")
		if err != nil {
			return nil, err
		}
		if name, ok := id.(string); ok {
			scenes[name], _ = item.(*toolrt.Dict)
		}
	}
	scene, err := lookup(scenes, shot)
	if err != nil {
		return nil, err
	}
	var origin *toolrt.Dict
	if scene != nil {
		origin, _ = scene.Value("derived_from").(*toolrt.Dict)
	}
	if origin == nil {
		return nil, valueError(textNotDerived)
	}
	if toolrt.Truthy(scene.Value("lipsync")) {
		return nil, valueError(textLipsync)
	}
	sourceShot := origin.Value("shot")
	sourceScene, err := lookup(scenes, sourceShot)
	if err != nil {
		return nil, err
	}
	if sourceScene == nil || toolrt.Truthy(sourceScene.Value("derived_from")) {
		return nil, valueError(textBadSource)
	}
	if err := sceneregistry.SameFPS(root, registry); err != nil {
		return nil, err
	}
	fps := toolrt.NewInt(sceneregistry.FPS(registry.Value("fps")))
	acceptance, err := sceneregistry.ProjectShotAcceptance(root, registry)
	if err != nil {
		return nil, err
	}
	sourceName := sourceShot.(string)
	if acceptance.States.Value(sourceName) != sceneregistry.Completed {
		return nil, valueError(textAcceptSource(fps))
	}
	manifest := toolrt.JoinPath(root, "assets/shots", sourceName, "manifest.json")
	pkg, err := assetpackage.ValidatePackage(manifest, sourceName, root)
	if err != nil {
		return nil, err
	}
	edit, err := toolrt.Item(pkg, "accepted_edit")
	if err != nil {
		return nil, err
	}
	video, err := toolrt.Item(edit, "video")
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
	track, err := toolrt.GetItem(registry.Value("audio"), "path")
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
	sourceFingerprint, err := toolrt.Item(fingerprints, sourceName)
	if err != nil {
		return nil, err
	}
	targetFingerprint, err := toolrt.Item(fingerprints, shot.(string))
	if err != nil {
		return nil, err
	}
	frames, err := toolrt.Sub(scene.Value("end_frame_exclusive"), scene.Value("start_frame"))
	if err != nil {
		return nil, err
	}
	songDigest, err := applymontage.DigestOrNone(song)
	if err != nil {
		return nil, err
	}
	current := toolcli.Record(
		"shot", shot,
		"source_shot", sourceShot,
		"source_scene_sha256", sourceFingerprint,
		"source_accepted_video_sha256", sourceDigest,
		"target_scene_sha256", targetFingerprint,
		"target_frames", frames,
		"audio_source", toolcli.Record("path", track, "sha256", songDigest),
	)
	return &sourceContext{fps: fps, current: current, registry: registry, scene: scene, pkg: pkg, source: source}, nil
}

// tokenFor — result_token пробы: SHA-256 канонического JSON (preview без токена и build.json)
// связывает контекст, рецепт и точные принятые и показанные байты.
func tokenFor(preview *toolrt.Dict, receipt any) (string, error) {
	shown := preview.Clone()
	shown.Delete("result_token")
	text, err := toolrt.DumpsJSON(toolcli.Record("preview", shown, "build", receipt), toolrt.DumpOptions{SortKeys: true, Compact: true})
	if err != nil {
		return "", err
	}
	data, err := toolrt.EncodeUTF8(text)
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
	text, err := toolrt.DecodeUTF8(output)
	if err != nil {
		return "", err
	}
	lines := toolrt.SplitLines(text)
	if len(lines) == 0 {
		return "", toolrt.New(toolrt.IndexError, "индекс за пределами списка")
	}
	return lines[0], nil
}

// seconds — время frames / fps строкой (toolrt.Str) для аргумента FFmpeg.
func seconds(frames any, fps toolrt.Int) (string, error) {
	value, err := toolrt.TrueDiv(frames, fps)
	if err != nil {
		return "", err
	}
	return toolrt.FloatRepr(value), nil
}

// buildPreview — кандидат с участком песни; без файла песни предпросмотр равен кандидату.
func buildPreview(ctx context.Context, root string, state *sourceContext, temporary string) error {
	track, err := toolrt.GetItem(state.registry.Value("audio"), "path")
	if err != nil {
		return err
	}
	song, err := projectPath(root, track, "")
	if err != nil {
		return err
	}
	candidate, preview := filepath.Join(temporary, "candidate.mp4"), filepath.Join(temporary, "preview.mp4")
	if !toolrt.IsFile(song) {
		return applymontage.CopyFile(candidate, preview)
	}
	start, err := seconds(state.scene.Value("start_frame"), state.fps)
	if err != nil {
		return err
	}
	length, err := seconds(state.current.Value("target_frames"), state.fps)
	if err != nil {
		return err
	}
	_, err = applymontage.Media(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-n", "-i", candidate, "-ss", start, "-i", song,
		"-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", length, preview)
	return err
}

// build — собирает пробу плана shot во временной папке рядом с целью workDir и
// публикует её одним rename. Опубликованная папка больше не меняется, даже при приёмке. Контекст
// сверяется после рендера: пока шло кодирование, источник, музыка или рецепт могли измениться.
func build(ctx context.Context, shot, recipe, workDir, root string) (*toolrt.Dict, error) {
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
	if filepath.Dir(directory) != toolrt.JoinPath(root, base) || toolrt.Exists(directory) {
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
	plan, err := recipePlan(selected, state.current.Value("target_frames"), sourceFrames, state.fps)
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
	manifestDigest, err := assetpackage.FileSHA256(toolrt.JoinPath(root, "assets/shots", sourceName, "manifest.json"))
	if err != nil {
		return nil, err
	}
	version, err := ffmpegVersion(ctx)
	if err != nil {
		return nil, err
	}
	receipt := toolcli.Record(
		"recipe_path", recipeName,
		"recipe_sha256", recipeDigest,
		"filter", plan.filter,
		"target_start_frame", state.scene.Value("start_frame"),
		"target_end_frame_exclusive", state.scene.Value("end_frame_exclusive"),
		"source_manifest_sha256", manifestDigest,
		"ffmpeg_version", version,
	)
	if err := os.MkdirAll(filepath.Dir(directory), 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, filepath.Dir(directory))
	}
	temporary := filepath.Join(filepath.Dir(directory), "."+filepath.Base(directory)+".building-"+randomHex())
	if err := os.Mkdir(temporary, 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, temporary)
	}
	defer os.RemoveAll(temporary)
	frames, err := wholeNumber(state.current.Value("target_frames"))
	if err != nil {
		return nil, err
	}
	if err := renderEdit(ctx, state.source, plan.filter, frames, filepath.Join(temporary, "candidate.mp4"), sceneregistry.FPS(state.fps)); err != nil {
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
	preview := toolcli.Record("schema_version", toolrt.NewInt(1))
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
	if !toolrt.Equal(again.current, state.current) || digest != recipeDigest {
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
		return nil, toolrt.OSErrorFrom(err, temporary)
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

// acceptedFrames — поле accepted_edit.frames комплекта; без поля — KeyError.
func acceptedFrames(pkg *toolrt.Dict) (any, error) {
	edit, err := toolrt.Item(pkg, "accepted_edit")
	if err != nil {
		return nil, err
	}
	return toolrt.Item(edit, "frames")
}

// checkedResult — итог checkResult: показанная проба и её актуальный контекст.
type checkedResult struct {
	preview *toolrt.Dict
	receipt any
	state   *sourceContext
	plan    *cutPlan
}

// checkResult — проверка пробы directory перед приёмкой: подтверждение confirm действует только для тех
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
	if !toolrt.Equal(preview.Value("schema_version"), toolrt.NewInt(1)) || !toolrt.Equal(preview.Value("result_token"), confirm) {
		return nil, valueError(textBadConfirm)
	}
	token, err := tokenFor(preview, receipt)
	if err != nil {
		return nil, err
	}
	if token != confirm {
		return nil, valueError(textBadConfirm)
	}
	shot, err := toolrt.Item(preview, "shot")
	if err != nil {
		return nil, err
	}
	state, err := snapshot(shot, root)
	if err != nil {
		return nil, err
	}
	for _, key := range state.current.Keys() {
		if !toolrt.Equal(preview.Value(key), state.current.Value(key)) {
			return nil, valueError(textChangedResult)
		}
	}
	recipeName, err := toolrt.Item(receipt, "recipe_path")
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
	recorded, err := toolrt.Item(receipt, "recipe_sha256")
	if err != nil {
		return nil, err
	}
	if !toolrt.Equal(digest, recorded) {
		return nil, valueError(textChangedRecipe)
	}
	saved, err := readJSON(filepath.Join(directory, "recipe.json"))
	if err != nil {
		return nil, err
	}
	recipe, err := toolrt.Item(preview, "recipe")
	if err != nil {
		return nil, err
	}
	if !toolrt.Equal(saved, recipe) {
		return nil, valueError(textChangedRecipe)
	}
	sourceFrames, err := acceptedFrames(state.pkg)
	if err != nil {
		return nil, err
	}
	plan, err := recipePlan(recipe, state.current.Value("target_frames"), sourceFrames, state.fps)
	if err != nil {
		return nil, err
	}
	for _, item := range []struct {
		key   string
		value any
	}{{"filter", plan.filter}, {"target_start_frame", state.scene.Value("start_frame")}, {"target_end_frame_exclusive", state.scene.Value("end_frame_exclusive")}} {
		value, err := toolrt.Item(receipt, item.key)
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(value, item.value) {
			return nil, valueError(textChangedParams)
		}
	}
	manifest := toolrt.JoinPath(root, "assets/shots", state.current.Value("source_shot").(string), "manifest.json")
	if digest, err = assetpackage.FileSHA256(manifest); err != nil {
		return nil, err
	}
	if recorded, err = toolrt.Item(receipt, "source_manifest_sha256"); err != nil {
		return nil, err
	}
	if !toolrt.Equal(digest, recorded) {
		return nil, valueError(textChangedKit)
	}
	for _, item := range [][2]string{{"video", "candidate.mp4"}, {"preview", "preview.mp4"}} {
		shown, err := toolrt.Item(preview, item[0])
		if err != nil {
			return nil, err
		}
		actual, err := applymontage.Descriptor(directory, item[1])
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(shown, actual) {
			return nil, valueError(textChangedFile + item[1])
		}
	}
	return &checkedResult{preview: preview, receipt: receipt, state: state, plan: plan}, nil
}
