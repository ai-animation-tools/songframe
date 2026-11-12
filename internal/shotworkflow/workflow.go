package shotworkflow

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe/internal/assetpackage"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaproviders"
	"songframe/internal/sceneregistry"
	"songframe/internal/shotstatus"
	"songframe/internal/toolrt"
)

// workflowTool — команды инструмента над одним проектом. root — разрешённый корень проекта;
// каждая команда заново читает workflow.json и записывает его атомарно.
type workflowTool struct {
	root string
}

// get — значение ключа или fallback: у не-словаря — AttributeError.
func get(value any, key string, fallback any) (any, error) {
	return toolrt.DictGet(value, key, fallback)
}

// item — обязательное значение ключа: нет ключа — KeyError, не-словарь — TypeError.
func item(value any, key string) (any, error) { return toolrt.GetItem(value, key) }

// setItem — присваивание значения ключу: возможно только словарю, иначе TypeError.
func setItem(value any, key string, new any) error {
	dict, ok := value.(*toolrt.Dict)
	if !ok {
		if _, isList := value.([]any); isList {
			return toolrt.Raise(toolrt.TypeError, "индекс списка должен быть целым числом, получено: строка")
		}
		return toolrt.Raise(toolrt.TypeError, "нельзя изменить элемент: %s", toolrt.TypeName(value))
	}
	dict.Set(key, new)
	return nil
}

// pathPart — путь value внутри directory: часть пути должна быть строкой, иначе TypeError.
func pathPart(directory string, value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(value))
	}
	return toolrt.JoinPath(directory, text), nil
}

// sha — SHA-256 файла (OSError при ошибке открытия).
func sha(path string) (string, error) { return assetpackage.FileSHA256(path) }

// tempDir — временная папка ОС с разыменованными ссылками, где тоже разрешены пакеты.
func tempDir() string { return toolrt.ResolvePath(os.TempDir()) }

// resolveFrom — абсолютный путь как есть, относительный — от root; затем ссылки разыменовываются.
func resolveFrom(root, value string) string {
	if filepath.IsAbs(value) {
		return toolrt.ResolvePath(value)
	}
	return toolrt.ResolvePath(toolrt.JoinPath(root, value))
}

// packageDir — папка пакета внутри plan/batches, plan/awaiting
// или временной папки ОС; сами корни и защищённые папки (assets, source, plan/animatic) запрещены.
func (t *workflowTool) packageDir(value string, exist bool) (string, error) {
	root := toolrt.ResolvePath(t.root)
	path := resolveFrom(root, value)
	allowed := []string{toolrt.ResolvePath(toolrt.JoinPath(root, "plan/batches")), toolrt.ResolvePath(toolrt.JoinPath(root, "plan/awaiting"))}
	inside := false
	for _, base := range append(append([]string{}, allowed...), tempDir()) {
		inside = inside || toolrt.IsRelativeTo(path, base)
	}
	if path == allowed[0] || path == allowed[1] || !inside {
		return "", valueError("Папка пакета должна находиться внутри plan/batches, plan/awaiting или временной папки.")
	}
	for _, name := range []string{"assets", "source", "plan/animatic"} {
		if toolrt.IsRelativeTo(path, toolrt.ResolvePath(toolrt.JoinPath(root, name))) {
			return "", valueError("Папка пакета не может находиться в assets, source или plan/animatic.")
		}
	}
	if exist && !toolrt.IsFile(toolrt.JoinPath(path, "workflow.json")) {
		return "", valueError("В папке нет workflow.json; создайте пакет командой init.")
	}
	return path, nil
}

// load читает workflow.json: схема 1, известный этап и обязательный список keyframe_notes;
// отсутствующие keyframes и approved_frames добавляются пустыми (setdefault).
func load(directory string) (*toolrt.Dict, error) {
	value, err := toolrt.LoadJSONFile(toolrt.JoinPath(directory, "workflow.json"))
	if err != nil {
		return nil, err
	}
	schema, err := get(value, "schema_version", nil)
	if err != nil {
		return nil, err
	}
	data := value.(*toolrt.Dict)
	if _, isString := data.Value("shot").(string); !toolrt.Equal(schema, toolrt.NewInt(1)) || !isString {
		return nil, valueError("Неизвестная схема workflow.json.")
	}
	stage := data.Value("stage")
	if !containsValue(stages, stage) && !containsValue(imageStages, stage) && !is(stage, revision) {
		return nil, valueError("Неизвестный этап: " + toolrt.Str(stage))
	}
	if !data.Has("keyframes") {
		data.Set("keyframes", []any{})
	}
	if !data.Has("approved_frames") {
		data.Set("approved_frames", toolrt.NewDict())
	}
	notes, ok := data.Value("keyframe_notes").([]any)
	for _, note := range notes {
		if _, isDict := note.(*toolrt.Dict); !isDict {
			ok = false
		}
	}
	if !ok {
		return nil, valueError("В workflow.json нет списка keyframe_notes: пакет нужно привести к актуальному формату.")
	}
	return data, nil
}

// keyframes — элементы data["keyframes"].
func keyframes(data *toolrt.Dict) ([]any, error) {
	value, err := item(data, "keyframes")
	if err != nil {
		return nil, err
	}
	return toolrt.Iter(value)
}

// pendingIDs — id опор без истинного approved, в порядке keyframes.
func pendingIDs(data *toolrt.Dict) ([]any, error) {
	items, err := keyframes(data)
	if err != nil {
		return nil, err
	}
	result := []any{}
	for _, keyframe := range items {
		approved, err := get(keyframe, "approved", nil)
		if err != nil {
			return nil, err
		}
		if !toolrt.Truthy(approved) {
			id, err := item(keyframe, "id")
			if err != nil {
				return nil, err
			}
			result = append(result, id)
		}
	}
	return result, nil
}

// save записывает workflow.json: current_keyframe — первая непринятая опора; запись атомарная
// (права 0600, зафиксированы эталоном).
func save(directory string, data *toolrt.Dict) (*toolrt.Dict, error) {
	pending, err := pendingIDs(data)
	if err != nil {
		return nil, err
	}
	var current any
	if len(pending) > 0 {
		current = pending[0]
	}
	data.Set("current_keyframe", current)
	if err := toolrt.WriteJSONAtomic(toolrt.JoinPath(directory, "workflow.json"), data); err != nil {
		return nil, err
	}
	return data, nil
}

// sceneOf — проверенный реестр и план shot; плана нет — ValueError.
func (t *workflowTool) sceneOf(shot any) (*toolrt.Dict, *toolrt.Dict, error) {
	registry, err := sceneregistry.Load(t.root)
	if err != nil {
		return nil, nil, err
	}
	scenes, err := toolrt.Iter(registry.Value("scenes"))
	if err != nil {
		return nil, nil, err
	}
	for _, scene := range scenes {
		id, err := item(scene, "id")
		if err != nil {
			return nil, nil, err
		}
		if toolrt.Equal(id, shot) {
			return registry, scene.(*toolrt.Dict), nil
		}
	}
	return nil, nil, valueError(toolrt.Str(shot) + ": план отсутствует в реестре сцен.")
}

// fingerprint — отпечаток постановки плана с начальным состоянием кастинга проекта.
func (t *workflowTool) fingerprint(registry *toolrt.Dict, shot string) (string, error) {
	initial, err := sceneregistry.InitialStatesFor(t.root)
	if err != nil {
		return "", err
	}
	return sceneregistry.SceneFingerprint(registry, shot, initial)
}

var batchName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,40}$`)

// init — новый пакет на description_review с
// окном и отпечатком постановки плана; повтор ссылается на пакет того же плана.
func (t *workflowTool) init(shot, dirArg, mode string, batch, retryOf *string) (*toolrt.Dict, error) {
	if !contains(modes, mode) {
		return nil, valueError("Режим согласования: shot или frame.")
	}
	if batch != nil && !batchName.MatchString(*batch) {
		return nil, valueError("Имя партии: латиница, цифры, точка, дефис, подчёркивание.")
	}
	registry, scene, err := t.sceneOf(shot)
	if err != nil {
		return nil, err
	}
	directory, err := t.packageDir(dirArg, false)
	if err != nil {
		return nil, err
	}
	var retry any
	if retryOf != nil {
		previous, err := t.packageDir(*retryOf, true)
		if err != nil {
			return nil, err
		}
		if previous == directory {
			return nil, valueError("Повтор должен ссылаться на другой пакет того же плана.")
		}
		old, err := load(previous)
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(old.Value("shot"), shot) {
			return nil, valueError("Повтор должен ссылаться на другой пакет того же плана.")
		}
		root := toolrt.ResolvePath(t.root)
		if relative, err := toolrt.RelativeTo(previous, root); err == nil {
			retry = relative
		} else {
			retry = previous
		}
	}
	if entries, err := os.ReadDir(directory); err == nil && len(entries) > 0 {
		return nil, valueError("Папка пакета уже содержит файлы; выберите новую.")
	}
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, directory)
	}
	frames, err := toolrt.Sub(scene.Value("end_frame_exclusive"), scene.Value("start_frame"))
	if err != nil {
		return nil, err
	}
	fps := registry.Value("fps")
	window, err := toolrt.TrueDiv(frames, fps)
	if err != nil {
		return nil, err
	}
	digest, err := t.fingerprint(registry, shot)
	if err != nil {
		return nil, err
	}
	var batchValue any
	if batch != nil {
		batchValue = *batch
	}
	data := record(
		"schema_version", toolrt.NewInt(1),
		"shot", shot,
		"mode", mode,
		"stage", "description_review",
		"wait_reason", nil,
		"request_dir", nil,
		"description_approved", false,
		"scene_sha256", digest,
		"timing", record("fps", fps, "frames", frames, "window_seconds", window, "request_seconds", nil),
		"keyframes", []any{},
		"approved_frames", toolrt.NewDict(),
		"keyframe_notes", []any{},
		"prompt", record("path", "video-prompt.txt", "approved", false),
		"approved_prompt_sha256", nil,
		"retry_of", retry,
		"frame_source", nil,
		"model", nil,
		"batch", batchValue,
	)
	return save(directory, data)
}

// record — словарь из пар ключ-значение с порядком ключей как в аргументах.
func record(pairs ...any) *toolrt.Dict {
	result := toolrt.NewDict()
	for index := 0; index+1 < len(pairs); index += 2 {
		result.Set(pairs[index].(string), pairs[index+1])
	}
	return result
}

// middle — промежуточная опора: время в секундах и заметка.
type middle struct {
	seconds float64
	note    string
}

// lessText — сравнение строк по кодовым точкам Unicode.
func lessText(a, b string) bool {
	left, right := toolrt.Runes(a), toolrt.Runes(b)
	for index := 0; index < len(left) && index < len(right); index++ {
		if left[index] != right[index] {
			return left[index] < right[index]
		}
	}
	return len(left) < len(right)
}

// readProject — plan/project.json: nil для отсутствующего и false для
// повреждённого файла (оба не словарь для generation_settings).
func (t *workflowTool) readProject() any {
	value, damaged := toolrt.ReadJSON(toolrt.JoinPath(t.root, "plan/project.json"))
	if damaged {
		return false
	}
	return value
}

// planKeyframes — каркас K01 (первый кадр), промежуточные по времени и
// конечная опора на границе запроса; длительность проверяется правилом generation.video проекта.
// single — только K01: видео плана создаётся вне приложения по одной опоре, промежуточных и
// конечной нет. Принятые опоры с той же ролью и временем сохраняются.
func (t *workflowTool) planKeyframes(dirArg string, requestSeconds toolrt.Int, middles []middle, single bool) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	if requestSeconds.Sign() <= 0 {
		return nil, valueError("Длительность запроса задаётся целым числом секунд.")
	}
	settings, err := sceneregistry.GenerationSettings(t.readProject(), "video")
	if err != nil {
		return nil, err
	}
	rule := settings.Value("duration_rule")
	timing, err := item(data, "timing")
	if err != nil {
		return nil, err
	}
	window, err := item(timing, "window_seconds")
	if err != nil {
		return nil, err
	}
	switch rule {
	case "exact_window":
		number, err := toolrt.Float(window)
		if err != nil {
			return nil, err
		}
		if number != math.Trunc(number) || math.IsInf(number, 0) {
			return nil, valueError("exact_window требует целого монтажного окна в секундах: инструмент принимает целую длительность запроса.")
		}
		if !toolrt.Equal(requestSeconds, window) {
			return nil, valueError("Длительность запроса должна равняться монтажному окну по правилу exact_window.")
		}
	case "min_supported_not_less_than_window":
		less, err := toolrt.Less(requestSeconds, window)
		if err != nil {
			return nil, err
		}
		if less {
			return nil, valueError("Длительность запроса должна быть не меньше монтажного окна по правилу проекта.")
		}
	default:
		notGreater, err := toolrt.LessEqual(requestSeconds, window)
		if err != nil {
			return nil, err
		}
		if notGreater {
			return nil, valueError("Длительность запроса должна быть строго больше монтажного окна по правилу проекта.")
		}
	}
	request, err := requestSeconds.Float()
	if err != nil {
		return nil, err
	}
	type point struct {
		seconds    float64
		role, note string
	}
	points := []point{{0, "first", "первый кадр"}}
	sorted := append([]middle(nil), middles...)
	sort.SliceStable(sorted, func(a, b int) bool {
		if sorted[a].seconds != sorted[b].seconds {
			return sorted[a].seconds < sorted[b].seconds
		}
		return lessText(sorted[a].note, sorted[b].note)
	})
	for _, item := range sorted {
		if !(0 < item.seconds && item.seconds < request) {
			return nil, valueError("Промежуточная опора должна лежать внутри длительности запроса.")
		}
		points = append(points, point{item.seconds, "middle", item.note})
	}
	if single {
		if len(middles) > 0 {
			return nil, valueError("У плана с одной опорой нет промежуточных опор.")
		}
	} else {
		points = append(points, point{request, "last", "конечный кадр"})
	}
	items, err := keyframes(data)
	if err != nil {
		return nil, err
	}
	previous := map[string]any{}
	for _, keyframe := range items {
		id, err := item(keyframe, "id")
		if err != nil {
			return nil, err
		}
		key, err := toolrt.HashKey(id)
		if err != nil {
			return nil, err
		}
		previous[key] = keyframe
	}
	planned := []any{}
	approved := toolrt.NewDict()
	for number, point := range points {
		id := "K" + twoDigits(number+1)
		key, _ := toolrt.HashKey(id)
		old := previous[key]
		keep := false
		if toolrt.Truthy(old) {
			role, err := get(old, "role", nil)
			if err != nil {
				return nil, err
			}
			seconds, err := get(old, "time_seconds", nil)
			if err != nil {
				return nil, err
			}
			flag, err := get(old, "approved", nil)
			if err != nil {
				return nil, err
			}
			keep = toolrt.Equal(role, point.role) && toolrt.Equal(seconds, point.seconds) && toolrt.Truthy(flag)
		}
		var path, digest any
		if keep {
			if path, err = item(old, "path"); err != nil {
				return nil, err
			}
			if digest, err = item(old, "sha256"); err != nil {
				return nil, err
			}
			approved.Set(id, digest)
		}
		planned = append(planned, record("id", id, "role", point.role, "time_seconds", point.seconds, "note", point.note, "path", path, "sha256", digest, "approved", keep))
	}
	data.Set("keyframes", planned)
	data.Set("approved_frames", approved)
	if err := setItem(timing, "request_seconds", requestSeconds); err != nil {
		return nil, err
	}
	return save(directory, data)
}

// twoDigits — число не короче двух цифр (с ведущим нулём).
func twoDigits(number int) string {
	text := toolrt.NewInt(int64(number)).String()
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// keyframeOf — первая опора плана с этим id; нет — ValueError «Опора не входит в план».
func keyframeOf(data *toolrt.Dict, id any) (*toolrt.Dict, error) {
	found, err := findKeyframe(data, id)
	if err != nil {
		return nil, err
	}
	if found == nil {
		return nil, valueError("Опора не входит в план: " + toolrt.Str(id))
	}
	return found, nil
}

// findKeyframe — первая опора с этим id (обязательный ключ id у каждой просмотренной); нет — nil.
func findKeyframe(data *toolrt.Dict, id any) (*toolrt.Dict, error) {
	items, err := keyframes(data)
	if err != nil {
		return nil, err
	}
	for _, keyframe := range items {
		value, err := item(keyframe, "id")
		if err != nil {
			return nil, err
		}
		if toolrt.Equal(value, id) {
			dict, ok := keyframe.(*toolrt.Dict)
			if !ok {
				return nil, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(keyframe))
			}
			return dict, nil
		}
	}
	return nil, nil
}

// approvedFrames — approved_frames как словарь (иначе TypeError присваивания).
func approvedFrames(data *toolrt.Dict) (*toolrt.Dict, error) {
	value, err := item(data, "approved_frames")
	if err != nil {
		return nil, err
	}
	dict, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, toolrt.Raise(toolrt.TypeError, "нельзя изменить элемент: %s", toolrt.TypeName(value))
	}
	return dict, nil
}

// copyFile — байты источника в новый или существующий файл (права нового — 0666 с umask).
func copyFile(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	if err := os.WriteFile(target, data, 0o666); err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	return nil
}

// mkdir — создание одного каталога без родителей; существующий каталог — не ошибка.
func mkdir(path string) error {
	if err := os.Mkdir(path, 0o777); err != nil && !toolrt.IsDir(path) {
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}

// approve — approve (принятие) и propose (кандидат): файл снаружи пакета копируется в
// frames/Kxx.ext, внутри — остаётся на месте; записывается SHA-256. Принятие добавляет опору в
// approved_frames, кандидат — убирает. Этап description_review переходит в keyframes_review.
func (t *workflowTool) approve(dirArg, id, source string, candidate bool) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	keyframe, err := keyframeOf(data, id)
	if err != nil {
		return nil, err
	}
	source = toolrt.ResolvePath(source)
	if !toolrt.IsFile(source) || !contains(imageSuffixes, strings.ToLower(toolrt.PathSuffix(source))) {
		if candidate {
			return nil, valueError("Кандидат опоры должен быть существующим изображением.")
		}
		return nil, valueError("Опора должна быть существующим изображением.")
	}
	relative, err := toolrt.RelativeTo(source, directory)
	if err != nil {
		// Принятые байты остаются в пакете: пакет самодостаточен и переносится целиком.
		frames := toolrt.JoinPath(directory, "frames")
		target := toolrt.JoinPath(frames, id+strings.ToLower(toolrt.PathSuffix(source)))
		if err := mkdir(frames); err != nil {
			return nil, err
		}
		if err := copyFile(source, target); err != nil {
			return nil, err
		}
		relative, _ = toolrt.RelativeTo(target, directory)
	}
	digest, err := sha(toolrt.JoinPath(directory, relative))
	if err != nil {
		return nil, err
	}
	keyframe.Set("path", relative)
	keyframe.Set("sha256", digest)
	keyframe.Set("approved", !candidate)
	frames, err := approvedFrames(data)
	if err != nil {
		return nil, err
	}
	if candidate {
		frames.Delete(id)
	} else {
		frames.Set(id, digest)
	}
	if is(data.Value("stage"), "description_review") {
		data.Set("stage", "keyframes_review")
	}
	return save(directory, data)
}

// approvePrompt — после всех опор принимает файл промпта из
// пакета (по умолчанию prompt.path), записывает SHA и число символов. Промпт длиннее предела
// провайдера generation.video (promptLimit) не принимается: его возвращают на доработку.
func (t *workflowTool) approvePrompt(dirArg string, file *string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	return t.approvePromptData(directory, data, file)
}

func (t *workflowTool) approvePromptData(directory string, data *toolrt.Dict, file *string) (*toolrt.Dict, error) {
	pending, err := pendingIDs(data)
	if err != nil {
		return nil, err
	}
	items, _ := keyframes(data)
	if len(items) == 0 || len(pending) > 0 {
		names := make([]string, len(pending))
		for index, id := range pending {
			text, ok := id.(string)
			if !ok {
				return nil, toolrt.Raise(toolrt.TypeError, "элемент %d: ожидается строка, получено: %s", index, toolrt.TypeName(id))
			}
			names[index] = text
		}
		joined := strings.Join(names, ", ")
		if joined == "" {
			joined = "план опор пуст"
		}
		return nil, valueError("Сначала примите все опоры: " + joined)
	}
	var name any
	if file != nil && *file != "" {
		name = *file
	} else {
		prompt, err := get(data, "prompt", toolrt.NewDict())
		if err != nil {
			return nil, err
		}
		if name, err = get(prompt, "path", "video-prompt.txt"); err != nil {
			return nil, err
		}
	}
	joined, err := pathPart(directory, name)
	if err != nil {
		return nil, err
	}
	path := toolrt.ResolvePath(joined)
	if !toolrt.IsRelativeTo(path, directory) || !toolrt.IsFile(path) {
		return nil, valueError("Файл промпта должен лежать в пакете.")
	}
	text, err := toolrt.ReadText(path)
	if err != nil {
		return nil, err
	}
	if toolrt.Strip(text) == "" {
		return nil, valueError("Промпт пуст.")
	}
	digest, err := sha(path)
	if err != nil {
		return nil, err
	}
	relative, _ := toolrt.RelativeTo(path, directory)
	chars := toolrt.Len(text)
	if limit := t.promptLimit(data); limit > 0 && chars > limit {
		return nil, valueError(textPromptOverLimit(chars, limit))
	}
	data.Set("prompt", record("path", relative, "approved", true, "chars", toolrt.NewInt(int64(chars))))
	data.Set("approved_prompt_sha256", digest)
	if stage := data.Value("stage"); is(stage, "description_review") || is(stage, "keyframes_review") {
		data.Set("stage", "prompt_review")
	}
	return save(directory, data)
}

// promptLimit — предел длины видеопромпта провайдера generation.video для пакета data; 0 — предела
// нет: провайдер неизвестен или его не объявил, либо план делается ручной генерацией вне
// приложения (у формы сервиса свои правила, приложение их не знает).
func (t *workflowTool) promptLimit(data *toolrt.Dict) int {
	// Для попытки выбран способ «Вручную вне приложения»: у формы сервиса свои правила.
	if is(data.Value("generation_method"), "manual") {
		return 0
	}
	settings, err := sceneregistry.GenerationSettings(t.readProject(), "video")
	if err != nil {
		return 0
	}
	provider := settings.Value("provider")
	if mediaproviders.ManualVideo(provider, t.lipsync(data.Value("shot"))) {
		return 0
	}
	return mediaadapters.PromptLimit(provider)
}

// lipsync — отметка «Липсинк» плана shot в plan/scenes.json; повреждённый реестр или план без
// записи — false.
func (t *workflowTool) lipsync(shot any) bool {
	registry, damaged := toolrt.ReadJSON(toolrt.JoinPath(t.root, "plan/scenes.json"))
	if damaged {
		return false
	}
	scenes, err := toolrt.DictGet(registry, "scenes", nil)
	if err != nil {
		return false
	}
	list, err := toolrt.Iter(scenes)
	if err != nil {
		return false
	}
	for _, item := range list {
		if scene, ok := item.(*toolrt.Dict); ok && toolrt.Equal(scene.Value("id"), shot) {
			return scene.Value("lipsync") == true
		}
	}
	return false
}

// addNote — непустое замечание к опоре с номером подряд с 1 в пакете; пустое — нет.
func addNote(data *toolrt.Dict, frame any, note, scope string) (*toolrt.Dict, error) {
	if !contains(noteScopes, scope) {
		return nil, valueError("Область замечания: " + strings.Join(noteScopes, ", "))
	}
	text := toolrt.Strip(note)
	if text == "" {
		return nil, nil
	}
	notes := data.Value("keyframe_notes").([]any)
	var highest any = toolrt.NewInt(0)
	for index, entry := range notes {
		id, _ := get(entry, "id", toolrt.NewInt(0))
		if index == 0 {
			highest = id
			continue
		}
		less, err := toolrt.Less(highest, id)
		if err != nil {
			return nil, err
		}
		if less {
			highest = id
		}
	}
	next, err := toolrt.Add(highest, toolrt.NewInt(1))
	if err != nil {
		return nil, err
	}
	entry := record("id", next, "frame", frame, "note", text, "scope", scope, "active", true, "at", Now())
	data.Set("keyframe_notes", append(notes, entry))
	return entry, nil
}

// withdraw — кандидат снимается, файл в пакете остаётся.
func withdraw(data *toolrt.Dict, keyframe *toolrt.Dict) error {
	keyframe.Set("path", nil)
	keyframe.Set("sha256", nil)
	keyframe.Set("approved", false)
	frames, err := approvedFrames(data)
	if err != nil {
		return err
	}
	frames.Delete(toolrt.Str(keyframe.Value("id")))
	return nil
}

// ask — вопрос приложению в pending_decision и очистка
// прежнего ответа; frame — вопрос об одной неутверждённой опоре с кандидатом.
func (t *workflowTool) ask(dirArg, stage string, question *string, options []string, frame *string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	return t.askData(directory, data, stage, question, options, frame)
}

func (t *workflowTool) askData(directory string, data *toolrt.Dict, stage string, question *string, options []string, frame *string) (*toolrt.Dict, error) {
	if !contains(decisionStages, stage) {
		return nil, valueError("Вопрос задаётся на этапах: " + strings.Join(decisionStages, ", "))
	}
	defaults := defaultQuestions[stage]
	text := defaults.question
	if frame != nil {
		if stage != "keyframes_review" {
			return nil, valueError("Вопрос об отдельной опоре задаётся только на этапе keyframes_review.")
		}
		keyframe, err := keyframeOf(data, *frame)
		if err != nil {
			return nil, err
		}
		if !toolrt.Truthy(keyframe.Value("path")) {
			return nil, valueError(*frame + ": у опоры нет кандидата для согласования.")
		}
		if toolrt.Truthy(keyframe.Value("approved")) {
			return nil, valueError(*frame + ": опора уже утверждена.")
		}
		text = "Утвердить опору " + *frame + "?"
	}
	if len(options) == 0 {
		options = defaults.options
	}
	for _, option := range options {
		if !contains(verdicts, option) {
			return nil, valueError("Варианты ответа: " + strings.Join(verdicts, ", "))
		}
	}
	if question != nil && *question != "" {
		text = *question
	}
	values := make([]any, len(options))
	for index, option := range options {
		values[index] = option
	}
	pending := record("stage", stage, "question", text, "options", values, "asked_at", Now())
	if frame != nil {
		pending.Set("frame", *frame)
	}
	data.Set("pending_decision", pending)
	data.Set("decision", nil)
	return save(directory, data)
}

// decide — ответ приложения. На keyframes_review approve
// принимает кандидатов (или одну опору вопроса), revise снимает их и сохраняет замечание; на
// prompt_review approve принимает промпт. Остальные ответы только записываются: отправку,
// очередь, приёмку и повтор выполняет приложение.
func (t *workflowTool) decide(dirArg, verdict, note, scope string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	if !contains(verdicts, verdict) {
		return nil, valueError("Неизвестный ответ: " + verdict)
	}
	if !contains(noteScopes, scope) {
		return nil, valueError("Область замечания: " + strings.Join(noteScopes, ", "))
	}
	pendingValue := data.Value("pending_decision")
	if !toolrt.Truthy(pendingValue) {
		pendingValue = toolrt.NewDict()
	}
	stageValue, err := get(pendingValue, "stage", nil)
	if err != nil {
		return nil, err
	}
	if !toolrt.Truthy(stageValue) {
		if stageValue, err = item(data, "stage"); err != nil {
			return nil, err
		}
	}
	frame, _ := get(pendingValue, "frame", nil)
	options, _ := get(pendingValue, "options", nil)
	if toolrt.Truthy(options) {
		found, err := toolrt.Contains(options, verdict)
		if err != nil {
			return nil, err
		}
		if !found {
			list, err := toolrt.Iter(options)
			if err != nil {
				return nil, err
			}
			names := make([]string, len(list))
			for index, option := range list {
				text, ok := option.(string)
				if !ok {
					return nil, toolrt.Raise(toolrt.TypeError, "элемент %d: ожидается строка, получено: %s", index, toolrt.TypeName(option))
				}
				names[index] = text
			}
			question, _ := get(pendingValue, "question", nil)
			return nil, valueError("Для вопроса «" + toolrt.Str(question) + "» допустимы ответы: " + strings.Join(names, ", ") + ".")
		}
	}
	if is(stageValue, "description_review") && (verdict == "approve" || verdict == "revise") {
		data.Set("description_approved", verdict == "approve")
	}
	if verdict == "revise" && is(stageValue, "keyframes_review") {
		// Отклонённый кандидат перестаёт считаться готовой опорой; файлы и платные оригиналы остаются.
		if frame != nil {
			keyframe, err := keyframeOf(data, frame)
			if err != nil {
				return nil, err
			}
			if toolrt.Truthy(keyframe.Value("approved")) {
				return nil, valueError(toolrt.Str(frame) + ": опора уже утверждена; верните её командой reopen.")
			}
			if err := withdraw(data, keyframe); err != nil {
				return nil, err
			}
		} else {
			items, err := keyframes(data)
			if err != nil {
				return nil, err
			}
			for _, entry := range items {
				keyframe := entry.(*toolrt.Dict)
				if !toolrt.Truthy(keyframe.Value("approved")) {
					keyframe.Set("path", nil)
					keyframe.Set("sha256", nil)
				}
			}
		}
		if _, err := addNote(data, frame, note, scope); err != nil {
			return nil, err
		}
	}
	switch {
	case verdict == "approve" && is(stageValue, "keyframes_review") && frame != nil:
		// Вопрос об одной опоре утверждает только её, остальные кандидаты ждут своих вопросов.
		keyframe, err := keyframeOf(data, frame)
		if err != nil {
			return nil, err
		}
		path := keyframe.Value("path")
		if toolrt.Truthy(keyframe.Value("approved")) || !toolrt.Truthy(path) {
			return nil, valueError(toolrt.Str(frame) + ": нет неутверждённого кандидата для принятия.")
		}
		file, err := pathPart(directory, path)
		if err != nil {
			return nil, err
		}
		if ok, err := sameDigest(file, keyframe.Value("sha256")); err != nil || !ok {
			if err != nil {
				return nil, err
			}
			return nil, valueError(toolrt.Str(frame) + ": файл кандидата отсутствует или изменён.")
		}
		keyframe.Set("approved", true)
		frames, err := approvedFrames(data)
		if err != nil {
			return nil, err
		}
		frames.Set(toolrt.Str(frame), keyframe.Value("sha256"))
		if _, err := save(directory, data); err != nil {
			return nil, err
		}
	case verdict == "approve" && is(stageValue, "keyframes_review"):
		items, err := keyframes(data)
		if err != nil {
			return nil, err
		}
		candidates := []*toolrt.Dict{}
		all := true
		for _, entry := range items {
			keyframe := entry.(*toolrt.Dict)
			approved := toolrt.Truthy(keyframe.Value("approved"))
			all = all && approved
			if toolrt.Truthy(keyframe.Value("path")) && !approved {
				candidates = append(candidates, keyframe)
			}
		}
		if len(candidates) == 0 && !all {
			return nil, valueError("Нет кандидатов опор для принятия.")
		}
		frames, err := approvedFrames(data)
		if err != nil {
			return nil, err
		}
		for _, keyframe := range candidates {
			file, err := pathPart(directory, keyframe.Value("path"))
			if err != nil {
				return nil, err
			}
			if ok, err := sameDigest(file, keyframe.Value("sha256")); err != nil || !ok {
				if err != nil {
					return nil, err
				}
				return nil, valueError(toolrt.Str(keyframe.Value("id")) + ": файл кандидата отсутствует или изменён.")
			}
			keyframe.Set("approved", true)
			frames.Set(toolrt.Str(keyframe.Value("id")), keyframe.Value("sha256"))
		}
		if _, err := save(directory, data); err != nil {
			return nil, err
		}
	case verdict == "approve" && is(stageValue, "prompt_review"):
		if _, err := save(directory, data); err != nil {
			return nil, err
		}
		// approvePrompt заново читает пакет с диска, поэтому изменения сначала сохраняются.
		data, err = t.approvePrompt(dirArg, nil)
		if err != nil {
			return nil, err
		}
	}
	data.Set("decision", record("stage", stageValue, "verdict", verdict, "note", note, "at", Now()))
	data.Set("pending_decision", nil)
	return save(directory, data)
}

// sameDigest — path — обычный файл и его SHA-256 равен expected.
func sameDigest(path string, expected any) (bool, error) {
	if !toolrt.IsFile(path) {
		return false, nil
	}
	digest, err := sha(path)
	if err != nil {
		return false, err
	}
	return toolrt.Equal(digest, expected), nil
}

// reopen — утверждённая опора возвращается на доработку с
// обязательным замечанием; промпт согласуется заново. Пока видеопромпт не утверждён, нет
// video-запроса и этап из reopenStages.
func (t *workflowTool) reopen(dirArg, frame, note, scope string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	keyframe, err := keyframeOf(data, frame)
	if err != nil {
		return nil, err
	}
	if !toolrt.Truthy(keyframe.Value("approved")) {
		return nil, valueError(frame + ": опора не утверждена; доработка задаётся ответом revise на её вопрос.")
	}
	if toolrt.Strip(note) == "" {
		return nil, valueError("Для возврата опоры на доработку нужно замечание.")
	}
	if !contains(noteScopes, scope) {
		return nil, valueError("Область замечания: " + strings.Join(noteScopes, ", "))
	}
	prompt := data.Value("prompt")
	if !toolrt.Truthy(prompt) {
		prompt = toolrt.NewDict()
	}
	approved, err := get(prompt, "approved", nil)
	if err != nil {
		return nil, err
	}
	if toolrt.Truthy(approved) || toolrt.Truthy(data.Value("request_dir")) {
		return nil, valueError("Видеопромпт уже утверждён или запрос подготовлен: опору нельзя вернуть в этом пакете; создайте исправленную попытку (init --retry-of).")
	}
	stage := toolrt.Str(data.Value("stage"))
	if !contains(reopenStages, stage) {
		return nil, valueError("На этапе " + stage + " опору вернуть нельзя: сначала завершите текущую отправку изображения и выберите её результат.")
	}
	if err := withdraw(data, keyframe); err != nil {
		return nil, err
	}
	entry, err := addNote(data, frame, note, scope)
	if err != nil {
		return nil, err
	}
	// Промпт строился по прежним опорам и согласуется заново.
	merged := record("path", "video-prompt.txt")
	if dict, ok := data.Value("prompt").(*toolrt.Dict); ok && dict.Len() > 0 {
		merged = dict.Clone()
	}
	merged.Set("approved", false)
	data.Set("prompt", merged)
	data.Set("approved_prompt_sha256", nil)
	data.Set("stage", "keyframes_review")
	data.Set("wait_reason", nil)
	data.Set("pending_decision", nil)
	data.Set("decision", record("stage", "keyframes_review", "verdict", "revise", "note", entry.Value("note"), "at", entry.Value("at")))
	return save(directory, data)
}

// reopenPromptStages — утверждённый видеопромпт можно вернуть, пока запрос видео не отправлен:
// запрос ещё не готовили или он подготовлен и ждёт ответа «Отправить» (в том числе пакет ручной
// генерации без загруженного видео). Пакет в очереди (ready) возвращают после выбора его судьбы.
var reopenPromptStages = []string{"prompt_review", "request_choice"}

// reopenPrompt — утверждённый видеопромпт возвращается на доработку с обязательным замечанием.
// Описание и утверждённые опоры остаются. Неотправленный подготовленный запрос остаётся в папке
// попытки историей, request_dir снимается: новый запрос готовится по новому промпту. Замечание
// записывается ответом revise на этапе prompt_review — агент получает его тем же путём, что и
// доработку предложенного промпта.
func (t *workflowTool) reopenPrompt(dirArg, note string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	prompt, ok := data.Value("prompt").(*toolrt.Dict)
	if !ok || !toolrt.Truthy(prompt.Value("approved")) {
		return nil, valueError("Видеопромпт не утверждён: доработка задаётся ответом revise на его вопрос.")
	}
	if toolrt.Strip(note) == "" {
		return nil, valueError("Для возврата видеопромпта на доработку нужно замечание.")
	}
	stage := toolrt.Str(data.Value("stage"))
	if !contains(reopenPromptStages, stage) {
		return nil, valueError("На этапе " + stage + " видеопромпт вернуть нельзя: запрос уже отправлен или пакет в очереди; исправленный промпт делается в новой попытке.")
	}
	merged := prompt.Clone()
	merged.Set("approved", false)
	data.Set("prompt", merged)
	data.Set("approved_prompt_sha256", nil)
	data.Set("request_dir", nil)
	data.Set("stage", "prompt_review")
	data.Set("wait_reason", nil)
	data.Set("pending_decision", nil)
	data.Set("decision", record("stage", "prompt_review", "verdict", "revise", "note", toolrt.Strip(note), "at", Now()))
	return save(directory, data)
}

// StartOwnVideo — попытка своего видео плана: только что созданный init пакет (description_review
// без принятого описания и опор) получает отметку own_video, папку собранного пакета ручной
// генерации requestDir и этап request_choice, с которого загрузка видео ведёт попытку к результату
// тем же путём, что ручную генерацию. Описания, опор и промпта у такой попытки нет и не будет:
// шаги до результата пропускаются по выбору пользователя, а не обходом проверок.
func StartOwnVideo(directory, requestDir string) error {
	data, err := load(directory)
	if err != nil {
		return err
	}
	frames, _ := data.Value("keyframes").([]any)
	if toolrt.Str(data.Value("stage")) != "description_review" || toolrt.Truthy(data.Value("description_approved")) || len(frames) > 0 {
		return valueError("Своё видео ставится только в новую попытку без описания и опор.")
	}
	data.Set("own_video", true)
	data.Set("request_dir", requestDir)
	data.Set("stage", "request_choice")
	data.Set("wait_reason", nil)
	_, err = save(directory, data)
	return err
}

// AddFrameNote записывает необязательное указание пользователя к неутверждённой опоре до её
// создания. Это обычная запись keyframe_notes: агент получает её тем же путём, что и замечание
// доработки, а у платного провайдера текст входит в промпт, SHA и подтверждение цены. directory —
// уже проверенная папка пакета; утверждённая опора и пустой текст отклоняются.
func AddFrameNote(directory, frame, note, scope string) error {
	data, err := load(directory)
	if err != nil {
		return err
	}
	keyframe, err := keyframeOf(data, frame)
	if err != nil {
		return err
	}
	if toolrt.Truthy(keyframe.Value("approved")) {
		return valueError(frame + ": опора уже утверждена; замечание задаётся возвратом на доработку.")
	}
	entry, err := addNote(data, frame, note, scope)
	if err != nil {
		return err
	}
	if entry == nil {
		return valueError("Напишите указание к опоре.")
	}
	_, err = save(directory, data)
	return err
}

// setNote — включение или выключение замечания к опорам.
func (t *workflowTool) setNote(dirArg string, id toolrt.Int, active bool) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	for _, entry := range data.Value("keyframe_notes").([]any) {
		note := entry.(*toolrt.Dict)
		if toolrt.Equal(note.Value("id"), id) {
			note.Set("active", active)
			return save(directory, data)
		}
	}
	return nil, valueError("Замечания " + id.String() + " нет в пакете.")
}

// allowedTransition — вперёд только на следующий этап (и request_choice →
// submitted, downloaded → accepted), назад — на любой; needs_revision — с любого, кроме accepted;
// image-ветка — по своему словарю переходов.
func allowedTransition(current, target string) bool {
	if target == revision {
		return current != "accepted"
	}
	if current == revision {
		return contains(stages[:4], target) || target == "ready" || target == "image_request_choice"
	}
	if contains(imageStages, target) || contains(imageStages, current) {
		switch current + ">" + target {
		case "description_review>image_request_choice", "keyframes_review>image_request_choice",
			"image_request_choice>image_submitted", "image_submitted>image_downloaded",
			"image_request_choice>keyframes_review", "image_downloaded>keyframes_review":
			return true
		}
		return false
	}
	here, there := index(stages, current), index(stages, target)
	return there < here || there == here+1 || (current == "request_choice" && target == "submitted") || (current == "downloaded" && target == "accepted")
}

func index(items []string, value string) int {
	for position, item := range items {
		if item == value {
			return position
		}
	}
	return -1
}

// setStage — переход этапа с проверками
// image-ветки (запрос, send, состояние attempt), причины ожидания и подготовленного запроса.
func (t *workflowTool) setStage(dirArg, stage string, waitReason, requestDir *string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	if !contains(stages, stage) && !contains(imageStages, stage) && stage != revision {
		return nil, valueError("Неизвестный этап: " + stage)
	}
	if contains(imageStages, stage) {
		if requestDir != nil {
			return nil, valueError("Для изображения используйте set-image-request; video request_dir сохраняется.")
		}
		_, _, attempt, err := imageAttempt(directory, data, nil)
		if err != nil {
			return nil, err
		}
		status, err := get(attempt, "status", nil)
		if err != nil {
			return nil, err
		}
		generation, _ := get(attempt, "generation_id", nil)
		if stage == "image_request_choice" && (!is(status, "prepared") || toolrt.Truthy(generation)) {
			return nil, valueError("Отправленный запрос нельзя вернуть к новому submit; используйте resume.")
		}
		if stage == "image_submitted" {
			decision := data.Value("decision")
			if !toolrt.Truthy(decision) {
				decision = toolrt.NewDict()
			}
			decisionStage, err := get(decision, "stage", nil)
			if err != nil {
				return nil, err
			}
			decisionVerdict, _ := get(decision, "verdict", nil)
			if !is(decisionStage, "image_request_choice") || !is(decisionVerdict, "send") || toolrt.Truthy(data.Value("pending_decision")) {
				return nil, valueError("Сначала подтвердите отдельный запрос изображения ответом send.")
			}
			sent := []string{"submitting", "submission_unknown", "submitted", "running", "downloading", "download_pending", "outputs_pending", "watermark_free_pending", "downloaded", "failed"}
			if _, err := toolrt.HashKey(status); err != nil {
				return nil, err
			}
			if !containsValue(sent, status) || (!toolrt.Truthy(generation) && !is(status, "submitting") && !is(status, "submission_unknown")) {
				return nil, valueError("Отправка изображения ещё не зарегистрирована в attempt.json.")
			}
		}
		// Результат без ID допустим, только если пользователь сам загрузил оригинал после неизвестного исхода.
		if stage == "image_downloaded" {
			manual, _ := get(attempt, "manual_result", nil)
			if !is(status, "downloaded") || !(toolrt.Truthy(generation) || toolrt.Truthy(manual)) {
				return nil, valueError("Результат изображения ещё не downloaded.")
			}
		}
	}
	current := toolrt.Str(data.Value("stage"))
	if stage == current && waitReason == nil && requestDir == nil {
		return data, nil
	}
	if stage != current && !allowedTransition(current, stage) {
		return nil, valueError("Переход " + current + " → " + stage + " не предусмотрен: вперёд только на следующий этап, назад — на любой.")
	}
	if stage == "ready" || stage == revision {
		if waitReason == nil && data.Value("wait_reason") == nil {
			return nil, valueError("Для этапа очереди укажите причину ожидания: " + strings.Join(shotstatus.WaitReasons, ", "))
		}
		if waitReason != nil && !contains(shotstatus.WaitReasons, *waitReason) {
			return nil, valueError("Неизвестная причина ожидания: " + *waitReason)
		}
		// Без новой причины остаётся прежняя wait_reason.
		if waitReason != nil {
			data.Set("wait_reason", *waitReason)
		}
	} else {
		data.Set("wait_reason", nil)
	}
	if requestDir != nil {
		if !toolrt.IsFile(toolrt.JoinPath(directory, *requestDir, "request.json")) {
			return nil, valueError("В указанной папке запроса нет request.json.")
		}
		data.Set("request_dir", *requestDir)
	}
	if (stage == "request_choice" || stage == "ready" || stage == "submitted") && !toolrt.Truthy(data.Value("request_dir")) {
		return nil, valueError("Для этого этапа нужен подготовленный запрос: укажите --request-dir.")
	}
	data.Set("stage", stage)
	return save(directory, data)
}
