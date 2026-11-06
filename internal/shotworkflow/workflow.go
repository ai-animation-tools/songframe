package shotworkflow

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe-go/internal/assetpackage"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/sceneregistry"
	"songframe-go/internal/shotstatus"
)

// workflowTool — команды инструмента над одним проектом. root — разрешённый корень проекта
// (ROOT оригинала); каждая команда заново читает workflow.json и записывает его атомарно.
type workflowTool struct {
	root string
}

// PromptLimiter — необязательная возможность адаптера провайдера: PROMPT_WARNING_CHARS
// оригинала, целый предел длины видеопромпта. approve-prompt предупреждает о более длинном
// тексте; адаптер без этой возможности (или с пределом ≤ 0) предупреждения не даёт. Интерфейс
// узкий и локальный: таблица internal/mediaadapters знает только наличие адаптера.
type PromptLimiter interface {
	PromptWarningChars() int
}

// get — value.get(key, fallback) Python: у не-словаря — AttributeError.
func get(value any, key string, fallback any) (any, error) {
	return pycompat.DictGet(value, key, fallback)
}

// item — value[key] с KeyError/TypeError Python.
func item(value any, key string) (any, error) { return pycompat.GetItem(value, key) }

// setItem — value[key] = new: присваивание возможно только словарю.
func setItem(value any, key string, new any) error {
	dict, ok := value.(*pycompat.Dict)
	if !ok {
		if _, isList := value.([]any); isList {
			return pycompat.Raise(pycompat.TypeError, "list indices must be integers or slices, not str")
		}
		return pycompat.Raise(pycompat.TypeError, "'%s' object does not support item assignment", pycompat.TypeName(value))
	}
	dict.Set(key, new)
	return nil
}

// pathPart — directory / value: часть пути pathlib должна быть строкой.
func pathPart(directory string, value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(value))
	}
	return pycompat.JoinPath(directory, text), nil
}

// sha — tools.common.sha: SHA-256 файла (OSError при ошибке открытия).
func sha(path string) (string, error) { return assetpackage.FileSHA256(path) }

// tempDir — Path(tempfile.gettempdir()).resolve(): временная папка ОС, где тоже разрешены пакеты.
func tempDir() string { return pycompat.ResolvePath(os.TempDir()) }

// resolveArg — Path(value): абсолютный путь как есть, относительный — от root; затем resolve().
func resolveFrom(root, value string) string {
	if filepath.IsAbs(value) {
		return pycompat.ResolvePath(value)
	}
	return pycompat.ResolvePath(pycompat.JoinPath(root, value))
}

// packageDir — package_dir(value, root, exist): папка пакета внутри plan/batches, plan/awaiting
// или временной папки ОС; сами корни и защищённые папки (assets, source, plan/animatic) запрещены.
func (t *workflowTool) packageDir(value string, exist bool) (string, error) {
	root := pycompat.ResolvePath(t.root)
	path := resolveFrom(root, value)
	allowed := []string{pycompat.ResolvePath(pycompat.JoinPath(root, "plan/batches")), pycompat.ResolvePath(pycompat.JoinPath(root, "plan/awaiting"))}
	inside := false
	for _, base := range append(append([]string{}, allowed...), tempDir()) {
		inside = inside || pycompat.IsRelativeTo(path, base)
	}
	if path == allowed[0] || path == allowed[1] || !inside {
		return "", valueError("Папка пакета должна находиться внутри plan/batches, plan/awaiting или временной папки.")
	}
	for _, name := range []string{"assets", "source", "plan/animatic"} {
		if pycompat.IsRelativeTo(path, pycompat.ResolvePath(pycompat.JoinPath(root, name))) {
			return "", valueError("Папка пакета не может находиться в assets, source или plan/animatic.")
		}
	}
	if exist && !pycompat.IsFile(pycompat.JoinPath(path, "workflow.json")) {
		return "", valueError("В папке нет workflow.json; создайте пакет командой init.")
	}
	return path, nil
}

// load — load_workflow(directory): схема 1, известный этап и обязательный список keyframe_notes;
// отсутствующие keyframes и approved_frames добавляются пустыми (setdefault).
func load(directory string) (*pycompat.Dict, error) {
	value, err := pycompat.LoadJSONFile(pycompat.JoinPath(directory, "workflow.json"))
	if err != nil {
		return nil, err
	}
	schema, err := get(value, "schema_version", nil)
	if err != nil {
		return nil, err
	}
	data := value.(*pycompat.Dict)
	if _, isString := data.Value("shot").(string); !pycompat.Equal(schema, pycompat.NewInt(1)) || !isString {
		return nil, valueError("Неизвестная схема workflow.json.")
	}
	stage := data.Value("stage")
	if !containsValue(stages, stage) && !containsValue(imageStages, stage) && !is(stage, revision) {
		return nil, valueError("Неизвестный этап: " + pycompat.Str(stage))
	}
	if !data.Has("keyframes") {
		data.Set("keyframes", []any{})
	}
	if !data.Has("approved_frames") {
		data.Set("approved_frames", pycompat.NewDict())
	}
	notes, ok := data.Value("keyframe_notes").([]any)
	for _, note := range notes {
		if _, isDict := note.(*pycompat.Dict); !isDict {
			ok = false
		}
	}
	if !ok {
		return nil, valueError("В workflow.json нет списка keyframe_notes: пакет нужно привести к актуальному формату.")
	}
	return data, nil
}

// keyframes — элементы data["keyframes"].
func keyframes(data *pycompat.Dict) ([]any, error) {
	value, err := item(data, "keyframes")
	if err != nil {
		return nil, err
	}
	return pycompat.Iter(value)
}

// pendingIDs — [k["id"] for k in keyframes if not k.get("approved")].
func pendingIDs(data *pycompat.Dict) ([]any, error) {
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
		if !pycompat.Truthy(approved) {
			id, err := item(keyframe, "id")
			if err != nil {
				return nil, err
			}
			result = append(result, id)
		}
	}
	return result, nil
}

// save — save_workflow: current_keyframe — первая непринятая опора; запись атомарная (0600,
// как у NamedTemporaryFile оригинала).
func save(directory string, data *pycompat.Dict) (*pycompat.Dict, error) {
	pending, err := pendingIDs(data)
	if err != nil {
		return nil, err
	}
	var current any
	if len(pending) > 0 {
		current = pending[0]
	}
	data.Set("current_keyframe", current)
	if err := pycompat.WriteJSONAtomic(pycompat.JoinPath(directory, "workflow.json"), data); err != nil {
		return nil, err
	}
	return data, nil
}

// sceneOf — scene_of(root, shot): проверенный реестр и план; плана нет — ValueError.
func (t *workflowTool) sceneOf(shot any) (*pycompat.Dict, *pycompat.Dict, error) {
	registry, err := sceneregistry.Load(t.root)
	if err != nil {
		return nil, nil, err
	}
	scenes, err := pycompat.Iter(registry.Value("scenes"))
	if err != nil {
		return nil, nil, err
	}
	for _, scene := range scenes {
		id, err := item(scene, "id")
		if err != nil {
			return nil, nil, err
		}
		if pycompat.Equal(id, shot) {
			return registry, scene.(*pycompat.Dict), nil
		}
	}
	return nil, nil, valueError(pycompat.Str(shot) + ": план отсутствует в реестре сцен.")
}

// fingerprint — scene_fingerprint(registry, shot) с начальным состоянием кастинга проекта.
func (t *workflowTool) fingerprint(registry *pycompat.Dict, shot string) (string, error) {
	initial, err := sceneregistry.InitialStatesFor(t.root)
	if err != nil {
		return "", err
	}
	return sceneregistry.SceneFingerprint(registry, shot, initial)
}

var batchName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,40}$`)

// init — init(shot, directory, mode, batch, retry_of): новый пакет на description_review с
// окном и отпечатком постановки плана; повтор ссылается на пакет того же плана.
func (t *workflowTool) init(shot, dirArg, mode string, batch, retryOf *string) (*pycompat.Dict, error) {
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
		if !pycompat.Equal(old.Value("shot"), shot) {
			return nil, valueError("Повтор должен ссылаться на другой пакет того же плана.")
		}
		root := pycompat.ResolvePath(t.root)
		if relative, err := pycompat.RelativeTo(previous, root); err == nil {
			retry = relative
		} else {
			retry = previous
		}
	}
	if entries, err := os.ReadDir(directory); err == nil && len(entries) > 0 {
		return nil, valueError("Папка пакета уже содержит файлы; выберите новую.")
	}
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, directory)
	}
	frames, err := pycompat.Sub(scene.Value("end_frame_exclusive"), scene.Value("start_frame"))
	if err != nil {
		return nil, err
	}
	fps := registry.Value("fps")
	window, err := pycompat.TrueDiv(frames, fps)
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
		"schema_version", pycompat.NewInt(1),
		"shot", shot,
		"mode", mode,
		"stage", "description_review",
		"wait_reason", nil,
		"request_dir", nil,
		"description_approved", false,
		"scene_sha256", digest,
		"timing", record("fps", fps, "frames", frames, "window_seconds", window, "request_seconds", nil),
		"keyframes", []any{},
		"approved_frames", pycompat.NewDict(),
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

// record — литерал dict Python с порядком ключей.
func record(pairs ...any) *pycompat.Dict {
	result := pycompat.NewDict()
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

// lessText — сравнение строк Python (по кодовым точкам).
func lessText(a, b string) bool {
	left, right := pycompat.Runes(a), pycompat.Runes(b)
	for index := 0; index < len(left) && index < len(right); index++ {
		if left[index] != right[index] {
			return left[index] < right[index]
		}
	}
	return len(left) < len(right)
}

// readProject — read_json(root / "plan/project.json"): None для отсутствующего и False для
// повреждённого файла (оба не словарь для generation_settings).
func (t *workflowTool) readProject() any {
	value, damaged := pycompat.ReadJSON(pycompat.JoinPath(t.root, "plan/project.json"))
	if damaged {
		return false
	}
	return value
}

// planKeyframes — plan_keyframes: каркас K01 (первый кадр), промежуточные по времени и
// конечная опора на границе запроса; длительность проверяется правилом generation.video проекта.
// Принятые опоры с той же ролью и временем сохраняются.
func (t *workflowTool) planKeyframes(dirArg string, requestSeconds pycompat.Int, middles []middle) (*pycompat.Dict, error) {
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
		number, err := pycompat.Float(window)
		if err != nil {
			return nil, err
		}
		if number != math.Trunc(number) || math.IsInf(number, 0) {
			return nil, valueError("exact_window требует целого монтажного окна в секундах: инструмент принимает целую длительность запроса.")
		}
		if !pycompat.Equal(requestSeconds, window) {
			return nil, valueError("Длительность запроса должна равняться монтажному окну по правилу exact_window.")
		}
	case "min_supported_not_less_than_window":
		less, err := pycompat.Less(requestSeconds, window)
		if err != nil {
			return nil, err
		}
		if less {
			return nil, valueError("Длительность запроса должна быть не меньше монтажного окна по правилу проекта.")
		}
	default:
		notGreater, err := pycompat.LessEqual(requestSeconds, window)
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
	points = append(points, point{request, "last", "конечный кадр"})
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
		key, err := pycompat.HashKey(id)
		if err != nil {
			return nil, err
		}
		previous[key] = keyframe
	}
	planned := []any{}
	approved := pycompat.NewDict()
	for number, point := range points {
		id := "K" + twoDigits(number+1)
		key, _ := pycompat.HashKey(id)
		old := previous[key]
		keep := false
		if pycompat.Truthy(old) {
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
			keep = pycompat.Equal(role, point.role) && pycompat.Equal(seconds, point.seconds) && pycompat.Truthy(flag)
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

// twoDigits — f"{number:02}".
func twoDigits(number int) string {
	text := pycompat.NewInt(int64(number)).String()
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// keyframeOf — первая опора плана с этим id; нет — ValueError «Опора не входит в план».
func keyframeOf(data *pycompat.Dict, id any) (*pycompat.Dict, error) {
	found, err := findKeyframe(data, id)
	if err != nil {
		return nil, err
	}
	if found == nil {
		return nil, valueError("Опора не входит в план: " + pycompat.Str(id))
	}
	return found, nil
}

// findKeyframe — next((k for k in keyframes if k["id"] == id), None).
func findKeyframe(data *pycompat.Dict, id any) (*pycompat.Dict, error) {
	items, err := keyframes(data)
	if err != nil {
		return nil, err
	}
	for _, keyframe := range items {
		value, err := item(keyframe, "id")
		if err != nil {
			return nil, err
		}
		if pycompat.Equal(value, id) {
			dict, ok := keyframe.(*pycompat.Dict)
			if !ok {
				return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'update'", pycompat.TypeName(keyframe))
			}
			return dict, nil
		}
	}
	return nil, nil
}

// approvedFrames — data["approved_frames"] как словарь (иначе TypeError присваивания).
func approvedFrames(data *pycompat.Dict) (*pycompat.Dict, error) {
	value, err := item(data, "approved_frames")
	if err != nil {
		return nil, err
	}
	dict, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, pycompat.Raise(pycompat.TypeError, "'%s' object does not support item assignment", pycompat.TypeName(value))
	}
	return dict, nil
}

// copyFile — shutil.copyfile: байты источника в новый или существующий файл (права нового — 0666 с umask).
func copyFile(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	if err := os.WriteFile(target, data, 0o666); err != nil {
		return pycompat.OSErrorFrom(err, target)
	}
	return nil
}

// mkdir — Path.mkdir(exist_ok=True) без parents.
func mkdir(path string) error {
	if err := os.Mkdir(path, 0o777); err != nil && !pycompat.IsDir(path) {
		return pycompat.OSErrorFrom(err, path)
	}
	return nil
}

// approve — approve (принятие) и propose (кандидат): файл снаружи пакета копируется в
// frames/Kxx.ext, внутри — остаётся на месте; записывается SHA-256. Принятие добавляет опору в
// approved_frames, кандидат — убирает. Этап description_review переходит в keyframes_review.
func (t *workflowTool) approve(dirArg, id, source string, candidate bool) (*pycompat.Dict, error) {
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
	source = pycompat.ResolvePath(source)
	if !pycompat.IsFile(source) || !contains(imageSuffixes, strings.ToLower(pycompat.PathSuffix(source))) {
		if candidate {
			return nil, valueError("Кандидат опоры должен быть существующим изображением.")
		}
		return nil, valueError("Опора должна быть существующим изображением.")
	}
	relative, err := pycompat.RelativeTo(source, directory)
	if err != nil {
		// Принятые байты остаются в пакете: пакет самодостаточен и переносится целиком.
		frames := pycompat.JoinPath(directory, "frames")
		target := pycompat.JoinPath(frames, id+strings.ToLower(pycompat.PathSuffix(source)))
		if err := mkdir(frames); err != nil {
			return nil, err
		}
		if err := copyFile(source, target); err != nil {
			return nil, err
		}
		relative, _ = pycompat.RelativeTo(target, directory)
	}
	digest, err := sha(pycompat.JoinPath(directory, relative))
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

// approvePrompt — approve_prompt(directory, file): после всех опор принимает файл промпта из
// пакета (по умолчанию prompt.path), записывает SHA и число символов; предупреждения о длине —
// по пределу адаптера провайдера generation.video.
func (t *workflowTool) approvePrompt(dirArg string, file *string) (*pycompat.Dict, []string, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, nil, err
	}
	return t.approvePromptData(directory, data, file)
}

func (t *workflowTool) approvePromptData(directory string, data *pycompat.Dict, file *string) (*pycompat.Dict, []string, error) {
	pending, err := pendingIDs(data)
	if err != nil {
		return nil, nil, err
	}
	items, _ := keyframes(data)
	if len(items) == 0 || len(pending) > 0 {
		names := make([]string, len(pending))
		for index, id := range pending {
			text, ok := id.(string)
			if !ok {
				return nil, nil, pycompat.Raise(pycompat.TypeError, "sequence item %d: expected str instance, %s found", index, pycompat.TypeName(id))
			}
			names[index] = text
		}
		joined := strings.Join(names, ", ")
		if joined == "" {
			joined = "план опор пуст"
		}
		return nil, nil, valueError("Сначала примите все опоры: " + joined)
	}
	var name any
	if file != nil && *file != "" {
		name = *file
	} else {
		prompt, err := get(data, "prompt", pycompat.NewDict())
		if err != nil {
			return nil, nil, err
		}
		if name, err = get(prompt, "path", "video-prompt.txt"); err != nil {
			return nil, nil, err
		}
	}
	joined, err := pathPart(directory, name)
	if err != nil {
		return nil, nil, err
	}
	path := pycompat.ResolvePath(joined)
	if !pycompat.IsRelativeTo(path, directory) || !pycompat.IsFile(path) {
		return nil, nil, valueError("Файл промпта должен лежать в пакете.")
	}
	text, err := pycompat.ReadText(path)
	if err != nil {
		return nil, nil, err
	}
	if pycompat.Strip(text) == "" {
		return nil, nil, valueError("Промпт пуст.")
	}
	digest, err := sha(path)
	if err != nil {
		return nil, nil, err
	}
	relative, _ := pycompat.RelativeTo(path, directory)
	chars := pycompat.Len(text)
	data.Set("prompt", record("path", relative, "approved", true, "chars", pycompat.NewInt(int64(chars))))
	data.Set("approved_prompt_sha256", digest)
	if stage := data.Value("stage"); is(stage, "description_review") || is(stage, "keyframes_review") {
		data.Set("stage", "prompt_review")
	}
	warnings := []string{}
	if limit := t.promptWarningChars(); limit > 0 && chars > limit {
		warnings = append(warnings, "Промпт длиннее "+pycompat.NewInt(int64(limit)).String()+" символов ("+pycompat.NewInt(int64(chars)).String()+").")
	}
	saved, err := save(directory, data)
	return saved, warnings, err
}

// promptWarningChars — prompt_warning_chars: предел длины видеопромпта адаптера провайдера
// generation.video; нет блока, адаптера или предела — 0 (без предупреждения).
func (t *workflowTool) promptWarningChars() int {
	settings, err := sceneregistry.GenerationSettings(t.readProject(), "video")
	if err != nil {
		return 0
	}
	provider := settings.Value("provider")
	if !mediaadapters.Known(provider) {
		return 0
	}
	adapter, _ := mediaadapters.Get(provider)
	if limiter, ok := adapter.(PromptLimiter); ok {
		return limiter.PromptWarningChars()
	}
	return 0
}

// addNote — add_note: непустое замечание к опоре с номером подряд с 1 в пакете; пустое — нет.
func addNote(data *pycompat.Dict, frame any, note, scope string) (*pycompat.Dict, error) {
	if !contains(noteScopes, scope) {
		return nil, valueError("Область замечания: " + strings.Join(noteScopes, ", "))
	}
	text := pycompat.Strip(note)
	if text == "" {
		return nil, nil
	}
	notes := data.Value("keyframe_notes").([]any)
	var highest any = pycompat.NewInt(0)
	for index, entry := range notes {
		id, _ := get(entry, "id", pycompat.NewInt(0))
		if index == 0 {
			highest = id
			continue
		}
		less, err := pycompat.Less(highest, id)
		if err != nil {
			return nil, err
		}
		if less {
			highest = id
		}
	}
	next, err := pycompat.Add(highest, pycompat.NewInt(1))
	if err != nil {
		return nil, err
	}
	entry := record("id", next, "frame", frame, "note", text, "scope", scope, "active", true, "at", Now())
	data.Set("keyframe_notes", append(notes, entry))
	return entry, nil
}

// withdraw — withdraw_candidate: кандидат снимается, файл в пакете остаётся.
func withdraw(data *pycompat.Dict, keyframe *pycompat.Dict) error {
	keyframe.Set("path", nil)
	keyframe.Set("sha256", nil)
	keyframe.Set("approved", false)
	frames, err := approvedFrames(data)
	if err != nil {
		return err
	}
	frames.Delete(pycompat.Str(keyframe.Value("id")))
	return nil
}

// ask — ask(stage, question, options, frame): вопрос приложению в pending_decision и очистка
// прежнего ответа; frame — вопрос об одной неутверждённой опоре с кандидатом.
func (t *workflowTool) ask(dirArg, stage string, question *string, options []string, frame *string) (*pycompat.Dict, error) {
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

func (t *workflowTool) askData(directory string, data *pycompat.Dict, stage string, question *string, options []string, frame *string) (*pycompat.Dict, error) {
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
		if !pycompat.Truthy(keyframe.Value("path")) {
			return nil, valueError(*frame + ": у опоры нет кандидата для согласования.")
		}
		if pycompat.Truthy(keyframe.Value("approved")) {
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

// decide — decide(verdict, note, note_scope): ответ приложения. На keyframes_review approve
// принимает кандидатов (или одну опору вопроса), revise снимает их и сохраняет замечание; на
// prompt_review approve принимает промпт. Остальные ответы только записываются: отправку,
// очередь, приёмку и повтор выполняет приложение.
func (t *workflowTool) decide(dirArg, verdict, note, scope string) (*pycompat.Dict, error) {
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
	if !pycompat.Truthy(pendingValue) {
		pendingValue = pycompat.NewDict()
	}
	stageValue, err := get(pendingValue, "stage", nil)
	if err != nil {
		return nil, err
	}
	if !pycompat.Truthy(stageValue) {
		if stageValue, err = item(data, "stage"); err != nil {
			return nil, err
		}
	}
	frame, _ := get(pendingValue, "frame", nil)
	options, _ := get(pendingValue, "options", nil)
	if pycompat.Truthy(options) {
		found, err := pycompat.Contains(options, verdict)
		if err != nil {
			return nil, err
		}
		if !found {
			list, err := pycompat.Iter(options)
			if err != nil {
				return nil, err
			}
			names := make([]string, len(list))
			for index, option := range list {
				text, ok := option.(string)
				if !ok {
					return nil, pycompat.Raise(pycompat.TypeError, "sequence item %d: expected str instance, %s found", index, pycompat.TypeName(option))
				}
				names[index] = text
			}
			question, _ := get(pendingValue, "question", nil)
			return nil, valueError("Для вопроса «" + pycompat.Str(question) + "» допустимы ответы: " + strings.Join(names, ", ") + ".")
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
			if pycompat.Truthy(keyframe.Value("approved")) {
				return nil, valueError(pycompat.Str(frame) + ": опора уже утверждена; верните её командой reopen.")
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
				keyframe := entry.(*pycompat.Dict)
				if !pycompat.Truthy(keyframe.Value("approved")) {
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
		if pycompat.Truthy(keyframe.Value("approved")) || !pycompat.Truthy(path) {
			return nil, valueError(pycompat.Str(frame) + ": нет неутверждённого кандидата для принятия.")
		}
		file, err := pathPart(directory, path)
		if err != nil {
			return nil, err
		}
		if ok, err := sameDigest(file, keyframe.Value("sha256")); err != nil || !ok {
			if err != nil {
				return nil, err
			}
			return nil, valueError(pycompat.Str(frame) + ": файл кандидата отсутствует или изменён.")
		}
		keyframe.Set("approved", true)
		frames, err := approvedFrames(data)
		if err != nil {
			return nil, err
		}
		frames.Set(pycompat.Str(frame), keyframe.Value("sha256"))
		if _, err := save(directory, data); err != nil {
			return nil, err
		}
	case verdict == "approve" && is(stageValue, "keyframes_review"):
		items, err := keyframes(data)
		if err != nil {
			return nil, err
		}
		candidates := []*pycompat.Dict{}
		all := true
		for _, entry := range items {
			keyframe := entry.(*pycompat.Dict)
			approved := pycompat.Truthy(keyframe.Value("approved"))
			all = all && approved
			if pycompat.Truthy(keyframe.Value("path")) && !approved {
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
				return nil, valueError(pycompat.Str(keyframe.Value("id")) + ": файл кандидата отсутствует или изменён.")
			}
			keyframe.Set("approved", true)
			frames.Set(pycompat.Str(keyframe.Value("id")), keyframe.Value("sha256"))
		}
		if _, err := save(directory, data); err != nil {
			return nil, err
		}
	case verdict == "approve" && is(stageValue, "prompt_review"):
		if _, err := save(directory, data); err != nil {
			return nil, err
		}
		// approve_prompt оригинала заново читает пакет с диска.
		data, _, err = t.approvePrompt(dirArg, nil)
		if err != nil {
			return nil, err
		}
	}
	data.Set("decision", record("stage", stageValue, "verdict", verdict, "note", note, "at", Now()))
	data.Set("pending_decision", nil)
	return save(directory, data)
}

// sameDigest — path.is_file() and sha(path) == expected.
func sameDigest(path string, expected any) (bool, error) {
	if !pycompat.IsFile(path) {
		return false, nil
	}
	digest, err := sha(path)
	if err != nil {
		return false, err
	}
	return pycompat.Equal(digest, expected), nil
}

// reopen — reopen(frame, note, scope): утверждённая опора возвращается на доработку с
// обязательным замечанием; промпт согласуется заново. Пока видеопромпт не утверждён, нет
// video-запроса и этап из REOPEN_STAGES.
func (t *workflowTool) reopen(dirArg, frame, note, scope string) (*pycompat.Dict, error) {
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
	if !pycompat.Truthy(keyframe.Value("approved")) {
		return nil, valueError(frame + ": опора не утверждена; доработка задаётся ответом revise на её вопрос.")
	}
	if pycompat.Strip(note) == "" {
		return nil, valueError("Для возврата опоры на доработку нужно замечание.")
	}
	if !contains(noteScopes, scope) {
		return nil, valueError("Область замечания: " + strings.Join(noteScopes, ", "))
	}
	prompt := data.Value("prompt")
	if !pycompat.Truthy(prompt) {
		prompt = pycompat.NewDict()
	}
	approved, err := get(prompt, "approved", nil)
	if err != nil {
		return nil, err
	}
	if pycompat.Truthy(approved) || pycompat.Truthy(data.Value("request_dir")) {
		return nil, valueError("Видеопромпт уже утверждён или запрос подготовлен: опору нельзя вернуть в этом пакете; создайте исправленную попытку (init --retry-of).")
	}
	stage := pycompat.Str(data.Value("stage"))
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
	if dict, ok := data.Value("prompt").(*pycompat.Dict); ok && dict.Len() > 0 {
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
	if pycompat.Truthy(keyframe.Value("approved")) {
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

// setNote — set_note(id, active): включение или выключение замечания к опорам.
func (t *workflowTool) setNote(dirArg string, id pycompat.Int, active bool) (*pycompat.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	for _, entry := range data.Value("keyframe_notes").([]any) {
		note := entry.(*pycompat.Dict)
		if pycompat.Equal(note.Value("id"), id) {
			note.Set("active", active)
			return save(directory, data)
		}
	}
	return nil, valueError("Замечания " + id.String() + " нет в пакете.")
}

// allowedTransition — allowed_transition: вперёд только на следующий этап (и request_choice →
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

// setStage — set_stage(stage, wait_reason, request_dir): переход этапа с проверками
// image-ветки (запрос, send, состояние attempt), причины ожидания и подготовленного запроса.
func (t *workflowTool) setStage(dirArg, stage string, waitReason, requestDir *string) (*pycompat.Dict, error) {
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
		if stage == "image_request_choice" && (!is(status, "prepared") || pycompat.Truthy(generation)) {
			return nil, valueError("Отправленный запрос нельзя вернуть к новому submit; используйте resume.")
		}
		if stage == "image_submitted" {
			decision := data.Value("decision")
			if !pycompat.Truthy(decision) {
				decision = pycompat.NewDict()
			}
			decisionStage, err := get(decision, "stage", nil)
			if err != nil {
				return nil, err
			}
			decisionVerdict, _ := get(decision, "verdict", nil)
			if !is(decisionStage, "image_request_choice") || !is(decisionVerdict, "send") || pycompat.Truthy(data.Value("pending_decision")) {
				return nil, valueError("Сначала подтвердите отдельный запрос изображения ответом send.")
			}
			sent := []string{"submitting", "submission_unknown", "submitted", "running", "downloading", "download_pending", "outputs_pending", "watermark_free_pending", "downloaded", "failed"}
			if _, err := pycompat.HashKey(status); err != nil {
				return nil, err
			}
			if !containsValue(sent, status) || (!pycompat.Truthy(generation) && !is(status, "submitting") && !is(status, "submission_unknown")) {
				return nil, valueError("Отправка изображения ещё не зарегистрирована в attempt.json.")
			}
		}
		// Результат без ID допустим, только если пользователь сам загрузил оригинал после неизвестного исхода.
		if stage == "image_downloaded" {
			manual, _ := get(attempt, "manual_result", nil)
			if !is(status, "downloaded") || !(pycompat.Truthy(generation) || pycompat.Truthy(manual)) {
				return nil, valueError("Результат изображения ещё не downloaded.")
			}
		}
	}
	current := pycompat.Str(data.Value("stage"))
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
		// wait_reason or data["wait_reason"]: без новой причины остаётся прежняя.
		if waitReason != nil {
			data.Set("wait_reason", *waitReason)
		}
	} else {
		data.Set("wait_reason", nil)
	}
	if requestDir != nil {
		if !pycompat.IsFile(pycompat.JoinPath(directory, *requestDir, "request.json")) {
			return nil, valueError("В указанной папке запроса нет request.json.")
		}
		data.Set("request_dir", *requestDir)
	}
	if (stage == "request_choice" || stage == "ready" || stage == "submitted") && !pycompat.Truthy(data.Value("request_dir")) {
		return nil, valueError("Для этого этапа нужен подготовленный запрос: укажите --request-dir.")
	}
	data.Set("stage", stage)
	return save(directory, data)
}
