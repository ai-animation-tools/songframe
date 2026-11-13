package productionworkflow

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/filedigest"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaproviders"
	"songframe/internal/production"
	"songframe/internal/projectfile"
	"songframe/internal/speech"
)

// shotID — один явный ID плана Mxx или Mxx.N.
var shotID = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)

// durationRules — допустимые duration_rule настроек генерации видео (тот же список у интерфейса в
// frontend/src/shared/types.ts).
var durationRules = []string{"min_supported_strictly_greater_than_window", "min_supported_not_less_than_window", "exact_window"}

// Speech — подготовленный точный WAV речевого плана в пакете: путь от проекта и интервал трека.
type Speech struct {
	Path          string     `json:"path"`
	SourceSeconds [2]float64 `json:"sourceSeconds"`
}

// tree — speech контекста агента; порядок ключей зафиксирован эталонами контекста.
func (s *Speech) tree() any {
	if s == nil {
		return nil
	}
	value := dynvalue.NewObject()
	value.Set("path", s.Path)
	value.Set("sourceSeconds", &dynvalue.Array{Items: []any{s.SourceSeconds[0], s.SourceSeconds[1]}})
	return value
}

// length — длина среза в секундах.
func (s *Speech) length() float64 { return s.SourceSeconds[1] - s.SourceSeconds[0] }

// Context — всё, что проход знает о плане и выбранном пакете на момент
// вызова. Документы проекта хранятся деревьями dynvalue как есть: они уходят агенту в контекст и
// в снимок без схемы. Значение не кэшируется между вызовами Workflow и не делится между потоками.
type Context struct {
	// Project — реальный путь проекта; Shot — ID плана.
	Project string
	Shot    string
	// PackageDir — абсолютный путь выбранного пакета; "" — новая подготовка (null).
	PackageDir string
	// Workflow — workflow.json пакета; nil — пакета нет.
	Workflow *dynvalue.Object
	// Scene — план реестра с visual_direction и sequence_direction.
	Scene *dynvalue.Object
	// Cast — сущности кастинга плана: мир и упомянутые в его references.
	Cast *dynvalue.Array
	// References — референсы плана из реестра по ID.
	References *dynvalue.Object
	// Settings — generation.video проекта ({} — блока нет).
	Settings *dynvalue.Object
	// Window — длина кадрового окна плана в секундах.
	Window float64
	// DurationRule — settings.duration_rule как есть (Undefined — нет поля).
	DurationRule any
	// FramePrompts — keyframe-prompts.json пакета (пустой массив, если файла нет или он не массив).
	FramePrompts *dynvalue.Array
	// Speech — подготовленный WAV речевого плана; nil — нет.
	Speech *Speech
	// AllowedPaths — пути от проекта, которые агент может назвать входами (сортированы).
	AllowedPaths []string
	// Paid — попытка пакета уже оплачена (видео или неизвестная оплата).
	Paid bool
	// Problems — что мешает подготовке: настройки видео, липсинк провайдера.
	Problems []string
	// Manual — видео плана создаёт пользователь вне приложения по пакету ручной генерации:
	// речевой план у провайдера без липсинка (SingleFrame) или попытка, для которой выбран способ
	// «Вручную вне приложения» (workflow generation_method manual). Агентского этапа request,
	// предела промпта провайдера и отправки нет.
	Manual bool
	// SingleFrame — речевой план у провайдера без липсинка: видео всегда создаётся вручную по
	// одной опоре K01, срезу речи и видеопромпту; число опор не выбирается.
	SingleFrame bool
	// DerivedFrom — план-источник производного плана; "" — план обычный.
	DerivedFrom string
	// SceneChanged — постановка плана изменилась после подготовки пакета.
	SceneChanged bool

	framesApproved, promptApproved *bool
}

// ReadContext читает контекст плана shot проекта path. requested — пакет как его передал
// renderer (абсолютный или от проекта); "" — без пакета. Ошибки чтения документов и недопустимые
// пути пакета возвращаются в фиксированном порядке проверок: от него зависит текст первой ошибки.
func ReadContext(path, shot, requested string) (*Context, error) {
	if !shotID.MatchString(shot) {
		return nil, errors.New(textShotIDRequired)
	}
	project, err := dynvalue.Realpath(path)
	if err != nil {
		return nil, err
	}
	scenes, err := readJSON(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		return nil, err
	}
	registry, ok := scenes.(*dynvalue.Object)
	list, listOK := dynvalue.AsArray(dynvalue.Get(scenes, "scenes"))
	if !ok || !listOK {
		return nil, errors.New(textSceneRegistryInvalid)
	}
	var scene *dynvalue.Object
	for _, item := range list {
		if object, isObject := item.(*dynvalue.Object); isObject && object.Value("id") == shot {
			scene = object
			break
		}
	}
	if scene == nil {
		return nil, errors.New(textShotMissing(shot))
	}
	fps := dynvalue.ToNumber(registry.Value("fps"))
	window := (dynvalue.ToNumber(scene.Value("end_frame_exclusive")) - dynvalue.ToNumber(scene.Value("start_frame"))) / fps
	if math.IsNaN(window) || math.IsInf(window, 0) || window <= 0 {
		return nil, errors.New(textShotWindowInvalid)
	}
	settings, err := videoSettings(project)
	if err != nil {
		return nil, err
	}
	durationRule := settings.Value("duration_rule")
	problems := []string{}
	_, providerString := settings.Value("provider").(string)
	_, resolutionString := settings.Value("resolution").(string)
	_, aspectString := settings.Value("aspect_ratio").(string)
	_, watermarkBool := settings.Value("watermark").(bool)
	if !slices.Contains(durationRules, dynvalue.ToString(durationRule)) || !providerString || !resolutionString || !aspectString || !watermarkBool ||
		!mediaproviders.Supports(settings.Value("provider"), mediaproviders.Video) {
		problems = append(problems, textVideoSettingsRequired())
	}
	// Речевой план у провайдера с липсинком ограничен допустимой длиной звука; у провайдера без
	// липсинка видео создаётся вручную вне приложения, и ограничений сервиса приложение не знает.
	provider, known := videoProvider(settings)
	manual := mediaproviders.ManualVideo(settings.Value("provider"), scene.Value("lipsync") == true)
	if scene.Value("lipsync") == true && known && !manual && window > provider.LipSync.Max {
		problems = append(problems, textSpeechWindowTooLong(dynvalue.ToFixed(window, 2), provider.Title, provider.LipSync.Max))
	}
	context := &Context{
		Project: project, Shot: shot, Settings: settings, Window: window, DurationRule: durationRule, Problems: problems, Manual: manual, SingleFrame: manual && scene.Value("lipsync") == true,
		FramePrompts: &dynvalue.Array{Items: []any{}}, References: dynvalue.NewObject(),
	}
	if requested != "" {
		if context.PackageDir, err = PackagePath(project, requested); err != nil {
			return nil, err
		}
		value, err := readJSON(filepath.Join(context.PackageDir, "workflow.json"))
		if err != nil {
			return nil, err
		}
		workflow, isObject := value.(*dynvalue.Object)
		if !isObject || workflow.Value("shot") != shot {
			return nil, errors.New(textPackageMissingOrWrongShot)
		}
		if _, stage := workflow.Value("stage").(string); !stage {
			return nil, errors.New(textPackageMissingOrWrongShot)
		}
		context.Workflow = workflow
		// Способ «Вручную вне приложения», выбранный для попытки, действует до её конца.
		if workflow.Value("generation_method") == "manual" {
			context.Manual = true
		}
	}
	// Тот же отпечаток, что пишет shot_workflow init: пакет, подготовленный по прежней постановке,
	// дальше не продолжается молча.
	if context.Workflow != nil && context.Workflow.Value("stage") != "accepted" {
		if current := production.CurrentShotFingerprint(project, shot); current != "" {
			context.SceneChanged = context.Workflow.Value("scene_sha256") != current
		}
	}
	castFile := cast.Read(project)
	allowed := map[string]bool{}
	addSource := func(path any) error {
		text, ok := path.(string)
		if !ok || text == "" || dynvalue.IsAbs(text) {
			return nil
		}
		local := text
		if !strings.HasPrefix(text, "source/") {
			local = "source/" + text
		}
		full, err := ProductionPath(project, local)
		if err != nil {
			return err
		}
		if dynvalue.Exists(full) {
			if info, err := os.Lstat(full); err == nil && info.Mode().IsRegular() {
				allowed[rel(project, full)] = true
			}
		}
		return nil
	}
	sceneReferences, referencesOK := dynvalue.AsArray(scene.Value("references"))
	if catalog, ok := registry.Value("references").(*dynvalue.Object); referencesOK && ok {
		for _, id := range sceneReferences {
			key, isString := id.(string)
			if !isString {
				continue
			}
			if reference, isObject := catalog.Value(key).(*dynvalue.Object); isObject {
				context.References.Set(key, reference)
				if err := addSource(reference.Value("path")); err != nil {
					return nil, err
				}
			}
		}
	}
	context.Cast = &dynvalue.Array{Items: []any{}}
	if entities, ok := dynvalue.AsArray(dynvalue.Get(castFile.Value, "entities")); ok && dynvalue.IsRecord(castFile.Value) {
		for _, entity := range entities {
			object, isObject := entity.(*dynvalue.Object)
			if isObject && (object.Value("kind") == "world" || (referencesOK && slices.Contains(sceneReferences, object.Value("id")))) {
				context.Cast.Items = append(context.Cast.Items, entity)
			}
		}
	}
	for _, entity := range context.Cast.Items {
		if images, ok := dynvalue.AsArray(dynvalue.Get(entity, "images")); ok {
			for _, image := range images {
				if err := addSource(image); err != nil {
					return nil, err
				}
			}
		}
	}
	manifest, err := readJSON(filepath.Join(project, "source", "manifest.json"))
	if err != nil {
		return nil, err
	}
	if dynvalue.IsRecord(manifest) {
		for _, key := range []string{"track", "lyrics", "idea"} {
			if entry := dynvalue.Get(manifest, key); dynvalue.IsRecord(entry) {
				if err := addSource(dynvalue.Get(entry, "path")); err != nil {
					return nil, err
				}
			}
		}
	}
	if context.PackageDir != "" {
		// Точный WAV речевого плана, подготовленный в пакете, — единственный разрешённый аудиовход.
		if prepared := speech.ReadPackage(context.PackageDir); prepared != nil {
			allowed[rel(project, prepared.Path)] = true
			context.Speech = &Speech{Path: rel(project, prepared.Path), SourceSeconds: [2]float64{prepared.Start, prepared.End}}
		}
		for _, frame := range keyframes(context.Workflow) {
			if !dynvalue.Truthy(dynvalue.Get(frame, "approved")) || !dynvalue.Truthy(dynvalue.Get(frame, "path")) {
				continue
			}
			full, err := packageFile(context, dynvalue.Get(frame, "path"))
			if err != nil {
				return nil, err
			}
			if dynvalue.Exists(full) {
				allowed[rel(project, full)] = true
			}
		}
		raw, err := readJSON(filepath.Join(context.PackageDir, "keyframe-prompts.json"))
		if err != nil {
			return nil, err
		}
		if prompts, ok := raw.(*dynvalue.Array); ok {
			context.FramePrompts = prompts
		}
	}
	context.AllowedPaths = make([]string, 0, len(allowed))
	for path := range allowed {
		context.AllowedPaths = append(context.AllowedPaths, path)
	}
	slices.SortFunc(context.AllowedPaths, compareUTF16)
	scene = dynvalue.Spread(scene)
	scene.Set("visual_direction", registry.Value("visual_direction"))
	var sequence any = nil
	if sequences, ok := dynvalue.AsArray(registry.Value("sequences")); ok {
		sequence = dynvalue.Undefined
		for _, item := range sequences {
			if dynvalue.IsRecord(item) && dynvalue.Get(item, "id") == scene.Value("sequence") {
				sequence = item
				break
			}
		}
	}
	scene.Set("sequence_direction", sequence)
	context.Scene = scene
	if context.PackageDir != "" {
		context.Paid = PackageVideoPaid(context.PackageDir)
	}
	context.DerivedFrom = derivedshot.Source(scene)
	return context, nil
}

// videoSettings — блок generation.video настроек проекта; пустой объект, если его нет или он не объект.
func videoSettings(project string) (*dynvalue.Object, error) {
	generation, err := projectGeneration(project)
	if err != nil {
		return nil, err
	}
	if video, ok := dynvalue.Get(generation, "video").(*dynvalue.Object); ok {
		return video, nil
	}
	return dynvalue.NewObject(), nil
}

// projectGeneration — блок generation настроек проекта (Undefined — нет блока).
func projectGeneration(project string) (any, error) {
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return nil, err
	}
	value, err := dynvalue.Parse(settings.Generation)
	if err != nil || value == nil {
		return dynvalue.Undefined, err
	}
	return value, nil
}

// videoProvider — запись реестра для settings.provider, если провайдер поддерживает видео; иначе false.
func videoProvider(settings *dynvalue.Object) (mediaproviders.Info, bool) {
	id := settings.Value("provider")
	if !mediaproviders.Supports(id, mediaproviders.Video) {
		return mediaproviders.Info{}, false
	}
	return mediaproviders.Lookup(id.(string))
}

// PromptLimit — предел длины видеопромпта провайдера видео проекта; 0 — предела нет или план
// делается ручной генерацией (у формы сервиса свои правила). Тот же предел проверяет утверждение
// промпта в shot_workflow.
func (c *Context) PromptLimit() int {
	if c.Manual {
		return 0
	}
	return mediaadapters.PromptLimit(c.Settings.Value("provider"))
}

// keyframes — workflow.keyframes как массив (не массив — пусто).
func keyframes(workflow *dynvalue.Object) []any {
	if workflow == nil {
		return nil
	}
	items, _ := dynvalue.AsArray(workflow.Value("keyframes"))
	return items
}

// packageFile — ProductionPath пути из workflow.json пакета, отсчитанного от папки пакета.
func packageFile(context *Context, path any) (string, error) {
	text, err := dynvalue.PathArg("path", path)
	if err != nil {
		return "", err
	}
	return ProductionPath(context.Project, filepath.Join(context.PackageDir, text))
}

// matchesDigest — файл есть и его SHA-256 из кэша filedigest строго равен expected.
func matchesDigest(path string, expected any) bool {
	hash, ok := filedigest.File(path)
	return dynvalue.Exists(path) && ok && expected == hash
}

// FramesApproved сообщает, что в пакете не меньше двух опор (в ручном режиме или по выбору одной
// опоры, keyframe_count 1, — ровно одна), все
// утверждены, файлы на месте и совпадают с утверждёнными SHA-256. Результат вычисляется один раз
// на Context.
func (c *Context) FramesApproved() (bool, error) {
	if c.framesApproved != nil {
		return *c.framesApproved, nil
	}
	frames := keyframes(c.Workflow)
	result := len(frames) >= 2 || (len(frames) == 1 && (c.SingleFrame || c.workflowValue("keyframe_count") == float64(1)))
	for _, frame := range frames {
		if !result {
			break
		}
		if !dynvalue.Truthy(dynvalue.Get(frame, "approved")) || !dynvalue.Truthy(dynvalue.Get(frame, "path")) || !dynvalue.Truthy(dynvalue.Get(frame, "sha256")) {
			result = false
			break
		}
		full, err := packageFile(c, dynvalue.Get(frame, "path"))
		if err != nil {
			return false, err
		}
		result = matchesDigest(full, dynvalue.Get(frame, "sha256"))
	}
	c.framesApproved = &result
	return result, nil
}

// PromptApproved сообщает, что видеопромпт пакета утверждён и файл не изменился
// после утверждения.
func (c *Context) PromptApproved() (bool, error) {
	if c.promptApproved != nil {
		return *c.promptApproved, nil
	}
	result := false
	prompt := c.workflowValue("prompt")
	if c.Workflow != nil && dynvalue.Truthy(dynvalue.Get(prompt, "approved")) && dynvalue.Truthy(dynvalue.Get(prompt, "path")) &&
		dynvalue.Truthy(c.Workflow.Value("approved_prompt_sha256")) && c.PackageDir != "" {
		full, err := packageFile(c, dynvalue.Get(prompt, "path"))
		if err != nil {
			return false, err
		}
		result = matchesDigest(full, c.Workflow.Value("approved_prompt_sha256"))
	}
	c.promptApproved = &result
	return result, nil
}

// StageFor возвращает этап, который продолжает пакет (description, prompt, request);
// "" — продолжать нечего (null). Без пакета — описание; вопрос пакета блокирует продолжение;
// доработка возвращает к доступному шагу: повтор сохранённого запроса не содержит утверждений
// предыдущих этапов, а замечания к опорам сначала меняют их постановку.
func (c *Context) StageFor() (string, error) {
	workflow := c.Workflow
	if workflow == nil {
		return "description", nil
	}
	if dynvalue.Truthy(workflow.Value("pending_decision")) {
		return "", nil
	}
	decision := workflow.Value("decision")
	if dynvalue.Get(decision, "verdict") == "revise" {
		switch dynvalue.Get(decision, "stage") {
		case "description_review", "keyframes_review", "image_request_choice":
			return "description", nil
		case "prompt_review":
			frames, err := c.FramesApproved()
			if err != nil || !frames {
				return "description", err
			}
			return "prompt", nil
		case "request_choice":
			frames, err := c.FramesApproved()
			if err != nil || !frames {
				return "description", err
			}
			prompt, err := c.PromptApproved()
			if err != nil || !prompt || c.Manual {
				return "prompt", err
			}
			return "request", nil
		default:
			return "", nil
		}
	}
	prompt, err := c.PromptApproved()
	if err != nil {
		return "", err
	}
	// Пакет ручной генерации собирает приложение без агента (Workflow.BuildManual).
	if prompt && !dynvalue.Truthy(workflow.Value("request_dir")) && !c.Manual {
		return "request", nil
	}
	frames, err := c.FramesApproved()
	if err != nil {
		return "", err
	}
	if frames && !prompt {
		return "prompt", nil
	}
	return "", nil
}

// UndecidedFrame возвращает ID кандидата опоры, который ждёт решения (есть файл,
// нет утверждения); nil — такого нет. Пока он есть, следующая опора не создаётся.
func (c *Context) UndecidedFrame() any {
	for _, frame := range keyframes(c.Workflow) {
		if dynvalue.Truthy(dynvalue.Get(frame, "path")) && !dynvalue.Truthy(dynvalue.Get(frame, "approved")) {
			return orNull(dynvalue.Get(frame, "id"))
		}
	}
	return nil
}

// NextFrame возвращает ID следующей опоры плана без утверждённого кадра; опоры
// создаются по одной в порядке плана. nil — создавать нечего или ждёт решения кандидат.
func (c *Context) NextFrame() any {
	if c.UndecidedFrame() != nil {
		return nil
	}
	for _, prompt := range c.FramePrompts.Items {
		id := dynvalue.Get(prompt, "id")
		approved := false
		for _, frame := range keyframes(c.Workflow) {
			if dynvalue.Get(frame, "id") == id && dynvalue.Truthy(dynvalue.Get(frame, "approved")) {
				approved = true
				break
			}
		}
		if !approved {
			return orNull(id)
		}
	}
	return nil
}

// FrameNotes возвращает действующие замечания к создаваемой опоре frame — её
// собственные и сквозные (scope following), кроме снятых пользователем.
func (c *Context) FrameNotes(frame any) []string {
	notes := []string{}
	if c.Workflow == nil {
		return notes
	}
	items, _ := dynvalue.AsArray(c.Workflow.Value("keyframe_notes"))
	for _, note := range items {
		text, _ := dynvalue.Get(note, "note").(string)
		scope := dynvalue.Get(note, "scope")
		if dynvalue.Truthy(dynvalue.Get(note, "active")) && dynvalue.Trim(text) != "" && (scope == "following" || dynvalue.Get(note, "frame") == frame) {
			notes = append(notes, dynvalue.Trim(text))
		}
	}
	return notes
}

// ApprovedFrameIDs — ID утверждённых опор пакета в порядке workflow.json.
func (c *Context) ApprovedFrameIDs() []any {
	ids := []any{}
	for _, frame := range keyframes(c.Workflow) {
		if dynvalue.Truthy(dynvalue.Get(frame, "approved")) {
			ids = append(ids, dynvalue.Get(frame, "id"))
		}
	}
	return ids
}

// workflowValue — поле key документа workflow.json пакета; Undefined без пакета.
func (c *Context) workflowValue(key string) any {
	if c.Workflow == nil {
		return dynvalue.Undefined
	}
	return c.Workflow.Value(key)
}

// orNull — значение, а вместо null или Undefined — null.
func orNull(value any) any {
	if dynvalue.IsNullish(value) {
		return nil
	}
	return value
}

// RulesFor возвращает правила проверки ответа агента для этапа stage.
func (c *Context) RulesFor(stage string) Rules {
	rules := Rules{
		Project: c.Project, Stage: stage, WindowSeconds: c.Window, DurationRule: c.DurationRule,
		RequestSeconds: orNull(dynvalue.Get(c.workflowValue("timing"), "request_seconds")), AllowedPaths: c.AllowedPaths,
		FramePrompts: c.FramePrompts,
	}
	rules.Manual = c.SingleFrame
	if c.Scene.Value("lipsync") == true {
		if provider, ok := videoProvider(c.Settings); ok && provider.LipSync != nil {
			limits := *provider.LipSync
			rules.LipSync = &limits
		}
	}
	return rules
}

// generationMethod — View.GenerationMethod: "manual", если для попытки выбран способ «Вручную вне
// приложения»; иначе пусто (видео делает провайдер проекта, речевой план без липсинка — SingleFrame).
func generationMethod(c *Context) string {
	if c.workflowValue("generation_method") == "manual" {
		return "manual"
	}
	return ""
}
