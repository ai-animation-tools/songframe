package production

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe-go/internal/acceptance"
	"songframe-go/internal/filedigest"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/sourceinputs"
	"songframe-go/internal/speech"
)

// Keyframe — PackageKeyframe: опора пакета из workflow.json. ImagePath — абсолютный путь
// существующего изображения кандидата или принятой опоры. Note — значение workflow.json как есть
// (отсутствует, null или строка).
type Keyframe struct {
	ID          string          `json:"id"`
	Role        string          `json:"role"`
	TimeSeconds float64         `json:"time_seconds"`
	Note        json.RawMessage `json:"note,omitempty"`
	ImagePath   *string         `json:"imagePath"`
	Approved    bool            `json:"approved"`
}

// Prompt — редактируемый видеопромпт пакета (video-prompt.txt) и его утверждение.
type Prompt struct {
	Path     string `json:"path"`
	Approved bool   `json:"approved"`
	Text     string `json:"text"`
}

// RequestInput — вход замороженного запроса: slot и role как в request.json, ImagePath —
// абсолютный путь файла в папке попытки.
type RequestInput struct {
	Slot      json.RawMessage `json:"slot,omitempty"`
	Role      json.RawMessage `json:"role,omitempty"`
	Path      string          `json:"path"`
	ImagePath string          `json:"imagePath"`
}

// Request — активная попытка пакета: замороженный request.json и состояние attempt.json.
// Model, Command, ModelSelection и Parameters — значения request.json как есть.
type Request struct {
	Dir            string          `json:"dir"`
	Kind           string          `json:"kind"`
	Provider       *string         `json:"provider,omitempty"`
	Command        json.RawMessage `json:"command,omitempty"`
	FrameID        string          `json:"frameId,omitempty"`
	SHA256         *string         `json:"sha256"`
	Model          json.RawMessage `json:"model,omitempty"`
	ModelSelection json.RawMessage `json:"modelSelection,omitempty"`
	// PromptText — замороженный текст запроса; в подтверждении показывается он, а не черновик.
	PromptText      *string         `json:"promptText"`
	Parameters      json.RawMessage `json:"parameters"`
	Inputs          []RequestInput  `json:"inputs"`
	AttemptStatus   *string         `json:"attemptStatus"`
	GenerationID    *string         `json:"generationId"`
	ManualResult    bool            `json:"manualResult"`
	CreditsConsumed *float64        `json:"creditsConsumed"`
	// Downloads — абсолютные пути существующих скачанных оригиналов.
	Downloads []string `json:"downloads"`
}

// PackageView — вид рабочего пакета плана (readPackage оригинала). Документы workflow.json без
// схемы (timing, pendingDecision, decision, keyframeNotes) передаются как есть.
type PackageView struct {
	// ResultToken — хеш показанных оригиналов: не меняется от записи ответа пользователя.
	ResultToken string `json:"resultToken,omitempty"`
	// DecisionToken — связь ответа с показанным вопросом и его материалами.
	DecisionToken   string          `json:"decisionToken,omitempty"`
	Dir             string          `json:"dir"`
	Relative        string          `json:"relative"`
	Shot            string          `json:"shot"`
	Stage           string          `json:"stage"`
	StageLabel      string          `json:"stageLabel"`
	WaitReason      json.RawMessage `json:"waitReason"`
	Mode            json.RawMessage `json:"mode"`
	RetryOf         json.RawMessage `json:"retryOf"`
	Batch           json.RawMessage `json:"batch"`
	Timing          json.RawMessage `json:"timing"`
	Keyframes       []Keyframe      `json:"keyframes"`
	Description     *string         `json:"description"`
	Prompt          *Prompt         `json:"prompt"`
	Request         *Request        `json:"request"`
	Speech          *speech.Package `json:"speech"`
	PendingDecision json.RawMessage `json:"pendingDecision"`
	Decision        json.RawMessage `json:"decision"`
	KeyframeNotes   json.RawMessage `json:"keyframeNotes"`
	// SceneChanged — постановка плана изменилась после подготовки пакета: отправка и
	// согласования заблокированы до решения пользователя.
	SceneChanged bool     `json:"sceneChanged"`
	Preview      []string `json:"preview"`
	Problems     []string `json:"problems"`

	// workflow — разобранный workflow.json: внутренние проверки читают из него вопрос и ответ.
	workflow *jscompat.Object
}

// Pending — ожидающий вопрос пакета (pending_decision) для проверок сервиса.
type Pending struct {
	Stage    string
	Question string
	Options  []string
	// Frame — опора, о которой вопрос; "" — вопрос не об опоре.
	Frame string
}

// Pending — вопрос пакета или nil, если pending_decision ложен (как `pkg.pendingDecision`
// в условиях оригинала).
func (p *PackageView) Pending() *Pending {
	value := jscompat.Get(p.workflow, "pending_decision")
	if !jscompat.Truthy(value) {
		return nil
	}
	pending := &Pending{}
	pending.Stage, _ = jscompat.Get(value, "stage").(string)
	pending.Question, _ = jscompat.Get(value, "question").(string)
	if options, ok := jscompat.AsArray(jscompat.Get(value, "options")); ok {
		for _, option := range options {
			if text, ok := option.(string); ok {
				pending.Options = append(pending.Options, text)
			}
		}
	}
	if frame := jscompat.Get(value, "frame"); jscompat.Truthy(frame) {
		pending.Frame = jscompat.ToString(frame)
	}
	return pending
}

// DecisionVerdict — decision.verdict ответа пакета или "".
func (p *PackageView) DecisionVerdict() string {
	verdict, _ := jscompat.GetPath(p.workflow, "decision", "verdict").(string)
	return verdict
}

// RequestSeconds — timing.request_seconds пакета (длительность запроса) или nil.
func (p *PackageView) RequestSeconds() *float64 {
	if value, ok := jscompat.GetPath(p.workflow, "timing", "request_seconds").(float64); ok {
		return &value
	}
	return nil
}

// Workflow — разобранный workflow.json пакета (только чтение).
func (p *PackageView) Workflow() *jscompat.Object { return p.workflow }

// attemptStatus — request.attemptStatus или "".
func (p *PackageView) attemptStatus() string {
	if p.Request == nil || p.Request.AttemptStatus == nil {
		return ""
	}
	return *p.Request.AttemptStatus
}

// originalName — скачанные оригиналы попытки в папке запроса.
var originalName = regexp.MustCompile(`^original(-\d+)?\.(mp4|png|jpg|webp)$`)

// previewName — файлы технической сводки в preview/.
var previewName = regexp.MustCompile(`(?i)\.(png|jpg|webp)$`)

// readJSON — readJson модуля production: null (nil) при отсутствии и любой ошибке.
func readJSON(path string) any {
	value, ok := jscompat.ReadJSONFile(path)
	if !ok {
		return nil
	}
	return value
}

// readText — readFileSync(path, 'utf-8') существующего файла; ошибка чтения — исключение.
func readText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", jscompat.FsError("open", path, err)
	}
	return jscompat.DecodeUTF8(data), nil
}

// joinArg — path.join(base, value): нестроковый аргумент — ERR_INVALID_ARG_TYPE.
func joinArg(base string, value any) (string, error) {
	path, err := jscompat.PathArg("path", value)
	if err != nil {
		return "", err
	}
	return filepath.Join(base, filepath.FromSlash(path)), nil
}

// within — `file.startsWith(resolve(root) + sep)`: путь материала внутри папки пакета или запроса.
func within(root, file string) bool {
	return strings.HasPrefix(filepath.Clean(file), filepath.Clean(root)+string(filepath.Separator))
}

// optionalString — строковое значение или nil.
func optionalString(value any) *string {
	if text, ok := value.(string); ok {
		return &text
	}
	return nil
}

// rawOrNull — `value ?? null` как JSON.
func rawOrNull(value any) json.RawMessage {
	if jscompat.IsNullish(value) {
		return json.RawMessage("null")
	}
	return jscompat.Raw(value)
}

// rawOptional — значение как JSON; отсутствующее свойство (undefined) опускается.
func rawOptional(value any) json.RawMessage {
	if value == jscompat.Undefined {
		return nil
	}
	return jscompat.Raw(value)
}

// fingerprintFunc — currentShotFingerprint: отпечаток текущей постановки плана или "".
type fingerprintFunc func(shot string) string

// CurrentShotFingerprint — currentShotFingerprint(project, shot): отпечаток текущей постановки плана
// по сохранённому реестру и кастингу проекта; "" — реестр не разбирается или плана нет.
func CurrentShotFingerprint(project, shot string) string {
	scenes, ok := jscompat.ReadJSONFile(filepath.Join(project, "plan", "scenes.json"))
	if !ok {
		return ""
	}
	fingerprints, err := acceptance.ProjectFingerprints(project, scenes)
	if err != nil || fingerprints == nil {
		return ""
	}
	value, _ := fingerprints.Value(shot).(string)
	return value
}

// projectFingerprint — отпечатки проекта, вычисляемые один раз за вызов вида производства.
func projectFingerprint(project string) fingerprintFunc {
	var fingerprints *jscompat.Object
	computed := false
	return func(shot string) string {
		if !computed {
			computed = true
			if scenes, ok := jscompat.ReadJSONFile(filepath.Join(project, "plan", "scenes.json")); ok {
				fingerprints, _ = acceptance.ProjectFingerprints(project, scenes)
			}
		}
		if fingerprints == nil {
			return ""
		}
		value, _ := fingerprints.Value(shot).(string)
		return value
	}
}

// ReadPackage — readPackage(project, dir): вид пакета или nil, если workflow.json не читается или
// поле shot не строка. Проблемы пакета — те же условия, что у оригинала. Ошибка — исключение JS
// оригинала вне его try (stage не строка, keyframes не массив, нестроковые пути): оригинал
// отклонял весь вызов. Ничего не пишет.
func ReadPackage(project, dir string) (*PackageView, error) {
	return readPackage(project, dir, func(shot string) string { return CurrentShotFingerprint(project, shot) })
}

func readPackage(project, dir string, fingerprint fingerprintFunc) (*PackageView, error) {
	parsed := readJSON(filepath.Join(dir, "workflow.json"))
	shot, ok := jscompat.Get(parsed, "shot").(string)
	if !jscompat.Truthy(parsed) || !ok {
		return nil, nil
	}
	workflow, _ := jscompat.AsObject(parsed)
	problems := []string{}
	list, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(parsed, "keyframes"), &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "(workflow.keyframes ?? []).map is not a function"}
	}
	keyframes := make([]Keyframe, 0, len(list))
	for _, frame := range list {
		if jscompat.IsNullish(frame) {
			return nil, &jscompat.TypeError{Message: "Cannot read properties of " + jscompat.TypeOf(frame) + " (reading 'id')"}
		}
		item := Keyframe{Note: rawOptional(jscompat.Get(frame, "note")), Approved: jscompat.Truthy(jscompat.Get(frame, "approved"))}
		item.ID = jscompat.ToString(jscompat.Coalesce(jscompat.Get(frame, "id"), ""))
		item.Role = jscompat.ToString(jscompat.Coalesce(jscompat.Get(frame, "role"), ""))
		item.TimeSeconds, _ = jscompat.Get(frame, "time_seconds").(float64)
		if path := jscompat.Get(frame, "path"); jscompat.Truthy(path) {
			file, err := joinArg(dir, path)
			if err != nil {
				return nil, err
			}
			if jscompat.Exists(file) {
				item.ImagePath = &file
			}
		}
		keyframes = append(keyframes, item)
	}
	promptPath, err := joinArg(dir, jscompat.Coalesce(jscompat.GetPath(parsed, "prompt", "path"), "video-prompt.txt"))
	if err != nil {
		return nil, err
	}
	var prompt *Prompt
	if jscompat.Exists(promptPath) {
		text, err := readText(promptPath)
		if err != nil {
			return nil, err
		}
		prompt = &Prompt{Path: promptPath, Approved: jscompat.Truthy(jscompat.GetPath(parsed, "prompt", "approved")), Text: text}
	}
	stage, ok := jscompat.Get(parsed, "stage").(string)
	if !ok {
		return nil, &jscompat.TypeError{Message: "workflow.stage.startsWith is not a function"}
	}
	imageRequest := strings.HasPrefix(stage, "image_")
	active := jscompat.Get(parsed, "request_dir")
	if imageRequest {
		active = jscompat.Get(parsed, "image_request_dir")
	}
	var request *Request
	if jscompat.Truthy(active) {
		request, err = readRequest(dir, parsed, active, imageRequest, &problems)
		if err != nil {
			return nil, err
		}
	}
	var description *string
	if path := filepath.Join(dir, "description.md"); jscompat.Exists(path) {
		text, err := readText(path)
		if err != nil {
			return nil, err
		}
		description = &text
	}
	preview := []string{}
	if folder := filepath.Join(dir, "preview"); jscompat.Exists(folder) {
		entries, err := jscompat.ReadDir(folder)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if previewName.MatchString(entry.Name()) {
				preview = append(preview, filepath.Join(folder, entry.Name()))
			}
		}
	}
	stageLabel, known := stageLabels[stage]
	if !known {
		stageLabel = stage
	}
	// Принятое описание не меняет этап до первой опоры, но вопрос по нему уже закрыт.
	if stage == "description_review" && jscompat.Get(workflow, "description_approved") == true {
		stageLabel = textDescriptionAccepted
	}
	if stage == "submitted" && request != nil && request.AttemptStatus != nil && *request.AttemptStatus != "" {
		label, ok := attemptLabels[*request.AttemptStatus]
		if !ok {
			label = *request.AttemptStatus
		}
		stageLabel = stageLabels["submitted"] + ": " + label
	}
	view := &PackageView{
		Dir: dir, Relative: jscompat.Relative(project, dir), Shot: shot, Stage: stage, StageLabel: stageLabel,
		WaitReason: rawOrNull(jscompat.Get(parsed, "wait_reason")), Mode: rawOrNull(jscompat.Get(parsed, "mode")),
		RetryOf: rawOrNull(jscompat.Get(parsed, "retry_of")), Batch: rawOrNull(jscompat.Get(parsed, "batch")),
		Timing: rawOrNull(jscompat.Get(parsed, "timing")), Keyframes: keyframes, Description: description,
		Prompt: prompt, Request: request, Speech: speech.ReadPackage(dir),
		PendingDecision: rawOrNull(jscompat.Get(parsed, "pending_decision")),
		Decision:        rawOrNull(jscompat.Get(parsed, "decision")),
		KeyframeNotes:   jscompat.Raw(jscompat.Coalesce(jscompat.Get(parsed, "keyframe_notes"), &jscompat.Array{})),
		Preview:         preview, workflow: workflow,
	}
	// try { resultToken; decisionToken } catch → проблема пакета с текстом исключения.
	func() {
		if request != nil && len(request.Downloads) > 0 {
			token, err := packageResultToken(request.Dir, request.Downloads)
			if err != nil {
				problems = append(problems, err.Error())
				return
			}
			view.ResultToken = token
		}
		token, err := packageToken(project, dir, parsed, stage, view.ResultToken)
		if err != nil {
			problems = append(problems, err.Error())
			return
		}
		view.DecisionToken = token
	}()
	// Пакет подготовлен по отпечатку постановки: после её правки отправка и согласования ждут
	// решения пользователя.
	if stage != "accepted" {
		if current := fingerprint(shot); current != "" && !jscompat.StrictEqual(jscompat.Get(parsed, "scene_sha256"), current) {
			view.SceneChanged = true
			problems = append(problems, SceneChanged)
		}
	}
	view.Problems = problems
	return view, nil
}

// readRequest — активная попытка пакета (ветка `if (activeRequest)` оригинала).
func readRequest(dir string, workflow, active any, imageRequest bool, problems *[]string) (*Request, error) {
	requestDir, err := joinArg(dir, active)
	if err != nil {
		return nil, err
	}
	frozen := readJSON(filepath.Join(requestDir, "request.json"))
	attempt := readJSON(filepath.Join(requestDir, "attempt.json"))
	if !jscompat.Truthy(frozen) {
		*problems = append(*problems, textRequestFileMissing)
		return nil, nil
	}
	providerValue := jscompat.Get(frozen, "provider")
	if provider, ok := providerValue.(string); !ok || jscompat.Trim(provider) == "" {
		*problems = append(*problems, textRequestProviderMissing)
	}
	kind := jscompat.Get(frozen, "kind")
	if imageRequest && !jscompat.StrictEqual(kind, "image") {
		*problems = append(*problems, textImageKindRequired)
	}
	if !imageRequest && jscompat.StrictEqual(kind, "image") {
		*problems = append(*problems, textVideoReferencesImage)
	}
	if imageRequest {
		entries, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "image_requests"), &jscompat.Array{}))
		if !ok {
			return nil, &jscompat.TypeError{Message: "(workflow.image_requests ?? []).some is not a function"}
		}
		matched := false
		for _, entry := range entries {
			if jscompat.IsNullish(entry) {
				return nil, &jscompat.TypeError{Message: "Cannot read properties of " + jscompat.TypeOf(entry) + " (reading 'request_dir')"}
			}
			if jscompat.StrictEqual(jscompat.Get(entry, "request_dir"), active) &&
				jscompat.StrictEqual(jscompat.Get(entry, "frame_id"), jscompat.Get(workflow, "image_frame_id")) &&
				jscompat.StrictEqual(jscompat.Get(entry, "request_sha256"), jscompat.Get(attempt, "request_sha256")) {
				matched = true
				break
			}
		}
		if !matched {
			*problems = append(*problems, textImageHistoryMismatch)
		}
	}
	promptValue := jscompat.Get(frozen, "prompt")
	if _, isString := promptValue.(string); !isString {
		promptValue = jscompat.Coalesce(jscompat.Get(promptValue, "path"), "prompt.txt")
	}
	frozenPrompt, err := joinArg(requestDir, promptValue)
	if err != nil {
		return nil, err
	}
	downloads := []string{}
	list, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(attempt, "downloads"), &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "(attempt?.downloads ?? []).map is not a function"}
	}
	for _, item := range list {
		path, err := jscompat.Prop(item, "path")
		if err != nil {
			return nil, err
		}
		if jscompat.Truthy(path) {
			file, err := joinArg(requestDir, path)
			if err != nil {
				return nil, err
			}
			downloads = append(downloads, file)
		}
	}
	if jscompat.Exists(requestDir) {
		entries, err := jscompat.ReadDir(requestDir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if originalName.MatchString(entry.Name()) {
				downloads = append(downloads, filepath.Join(requestDir, entry.Name()))
			}
		}
	}
	existing := []string{}
	seen := map[string]bool{}
	for _, file := range downloads {
		if !seen[file] && jscompat.Exists(file) {
			existing = append(existing, file)
		}
		seen[file] = true
	}
	request := &Request{
		Dir: requestDir, Kind: "video", Command: rawOptional(jscompat.Get(frozen, "command")),
		SHA256: optionalString(jscompat.Get(attempt, "request_sha256")), Model: rawOptional(jscompat.Get(frozen, "model")),
		Parameters:    jscompat.Raw(jscompat.Coalesce(jscompat.Get(frozen, "parameters"), jscompat.NewObject())),
		AttemptStatus: optionalString(jscompat.Get(attempt, "status")), GenerationID: optionalString(jscompat.Get(attempt, "generation_id")),
		ManualResult: jscompat.StrictEqual(jscompat.Get(attempt, "manual_result"), true), Downloads: existing, Inputs: []RequestInput{},
	}
	if text, ok := kind.(string); ok {
		request.Kind = text
	}
	if provider, ok := providerValue.(string); ok {
		trimmed := jscompat.Trim(provider)
		request.Provider = &trimmed
	}
	if frame := jscompat.Get(workflow, "image_frame_id"); imageRequest && jscompat.Truthy(frame) {
		request.FrameID = jscompat.ToString(frame)
	}
	if selection := jscompat.Get(frozen, "model_selection"); jscompat.Truthy(selection) {
		request.ModelSelection = jscompat.Raw(selection)
	}
	if jscompat.Exists(frozenPrompt) {
		text, err := readText(frozenPrompt)
		if err != nil {
			return nil, err
		}
		request.PromptText = &text
	}
	inputs, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(frozen, "inputs"), &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "(frozen.inputs ?? []).map is not a function"}
	}
	for _, input := range inputs {
		value, err := jscompat.Prop(input, "path")
		if err != nil {
			return nil, err
		}
		file, err := joinArg(requestDir, value)
		if err != nil {
			return nil, err
		}
		request.Inputs = append(request.Inputs, RequestInput{
			Slot: rawOptional(jscompat.Get(input, "slot")), Role: rawOptional(jscompat.Get(input, "role")),
			Path: value.(string), ImagePath: file,
		})
	}
	if credits, ok := jscompat.Get(attempt, "credits_consumed").(float64); ok {
		request.CreditsConsumed = &credits
	}
	return request, nil
}

// tokenDigest — SHA-256 файла с кэшем по identity (filedigest повторяет tokenDigest оригинала).
func tokenDigest(path string) (string, error) {
	digest, ok := filedigest.File(path)
	if !ok {
		// Файл есть, но не читается (например, это папка): исключение оригинала внутри try.
		if _, err := os.ReadFile(path); err != nil {
			return "", jscompat.FsError("read", path, err)
		}
		return "", errors.New("не удалось прочитать " + path)
	}
	return digest, nil
}

// regularFile — existsSync(file) && lstatSync(file).isFile().
func regularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// missingFile — маркер отсутствующего файла в SHA материалов (формат токена оригинала).
const missingFile = "<нет файла>"

// packageToken — ответ связан с показанными байтами вопроса, кандидатов и замороженного запроса:
// SHA-256 путей и содержимого материалов пакета, документов проекта (без декоративной обложки
// описи) и, на этапах просмотра результата, токена результата.
func packageToken(project, directory string, workflow any, stage, resultToken string) (string, error) {
	seen := map[string]bool{}
	paths := []string{}
	add := func(value any) error {
		text, err := jscompat.PathArg("path", value)
		if err != nil {
			return err
		}
		if !seen[text] {
			seen[text] = true
			paths = append(paths, text)
		}
		return nil
	}
	for _, value := range []any{"workflow.json", "description.md", jscompat.Coalesce(jscompat.GetPath(workflow, "prompt", "path"), "video-prompt.txt")} {
		if err := add(value); err != nil {
			return "", err
		}
	}
	frames, _ := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "keyframes"), &jscompat.Array{}))
	for _, frame := range frames {
		if path := jscompat.Get(frame, "path"); jscompat.Truthy(path) {
			if err := add(path); err != nil {
				return "", err
			}
		}
	}
	requests := []any{jscompat.Get(workflow, "request_dir"), jscompat.Get(workflow, "image_request_dir")}
	entries, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "image_requests"), &jscompat.Array{}))
	if !ok {
		return "", &jscompat.TypeError{Message: "(workflow.image_requests ?? []).map is not a function"}
	}
	for _, entry := range entries {
		value, err := jscompat.Prop(entry, "request_dir")
		if err != nil {
			return "", err
		}
		requests = append(requests, value)
	}
	visited := []any{}
	for _, requestDir := range requests {
		duplicate := false
		for _, previous := range visited {
			if jscompat.StrictEqual(previous, requestDir) {
				duplicate = true
			}
		}
		visited = append(visited, requestDir)
		if duplicate || !jscompat.Truthy(requestDir) {
			continue
		}
		base, err := jscompat.PathArg("path", requestDir)
		if err != nil {
			return "", err
		}
		if err := add(joinRelative(base, "request.json")); err != nil {
			return "", err
		}
		request := readJSON(filepath.Join(directory, base, "request.json"))
		if !jscompat.Truthy(request) {
			continue
		}
		prompt := jscompat.Get(request, "prompt")
		if _, isString := prompt.(string); !isString {
			prompt = jscompat.Coalesce(jscompat.Get(prompt, "path"), "prompt.txt")
		}
		path, err := jscompat.PathArg("path", prompt)
		if err != nil {
			return "", err
		}
		if err := add(joinRelative(base, path)); err != nil {
			return "", err
		}
		inputs, err := jscompat.Iterate(jscompat.Coalesce(jscompat.Get(request, "inputs"), &jscompat.Array{}))
		if err != nil {
			return "", err
		}
		for _, input := range inputs {
			value, err := jscompat.Prop(input, "path")
			if err != nil {
				return "", err
			}
			path, err := jscompat.PathArg("path", value)
			if err != nil {
				return "", err
			}
			if err := add(joinRelative(base, path)); err != nil {
				return "", err
			}
		}
	}
	sort.SliceStable(paths, func(i, j int) bool { return jscompat.LessUTF16(paths[i], paths[j]) })
	hash := sha256.New()
	for _, path := range paths {
		file := jscompat.Resolve(directory, path)
		if !within(directory, file) {
			return "", errors.New(textPackageMaterialsOutside)
		}
		digest := missingFile
		if regularFile(file) {
			value, err := tokenDigest(file)
			if err != nil {
				return "", err
			}
			digest = value
		}
		hash.Write([]byte(path + "\x00" + digest + "\x00"))
	}
	for _, path := range []string{"plan/scenes.json", "plan/cast.json", "plan/project.json", sourceinputs.ManifestPath} {
		file := filepath.Join(project, filepath.FromSlash(path))
		digest := missingFile
		if path == sourceinputs.ManifestPath {
			// Декоративная обложка не меняет показанное согласование или замороженный платный запрос.
			value, ok, err := sourceinputs.Digest(project)
			if err != nil {
				return "", err
			}
			if ok {
				digest = value
			}
		} else if jscompat.Exists(file) {
			value, err := tokenDigest(file)
			if err != nil {
				return "", err
			}
			digest = value
		}
		hash.Write([]byte(path + "\x00" + digest + "\x00"))
	}
	if stage == "downloaded" || stage == "edit_review" || stage == "image_downloaded" {
		token := resultToken
		if token == "" {
			token = "<нет результата>"
		}
		hash.Write([]byte("result" + token))
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// joinRelative — path.join(base, name) для относительных путей токена: нормализация без
// превращения в абсолютный путь и с разделителем «/», как на Linux у оригинала.
func joinRelative(base, name string) string {
	return filepath.ToSlash(filepath.Join(filepath.FromSlash(base), filepath.FromSlash(name)))
}

// packageResultToken — принятие связано с полученными байтами и метаданными сервиса, но не с
// последующим ответом workflow: SHA-256 request.json, attempt.json и скачанных файлов попытки.
func packageResultToken(requestDir string, downloads []string) (string, error) {
	seen := map[string]bool{}
	paths := []string{}
	for _, path := range append([]string{filepath.Join(requestDir, "request.json"), filepath.Join(requestDir, "attempt.json")}, downloads...) {
		if !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	sort.SliceStable(paths, func(i, j int) bool { return jscompat.LessUTF16(paths[i], paths[j]) })
	hash := sha256.New()
	for _, path := range paths {
		file := jscompat.Resolve(path)
		if !within(requestDir, file) {
			return "", errors.New(textResultFileRequired)
		}
		info, err := os.Lstat(file)
		if err != nil {
			return "", jscompat.FsError("lstat", file, err)
		}
		if !info.Mode().IsRegular() {
			return "", errors.New(textResultFileRequired)
		}
		digest, err := tokenDigest(file)
		if err != nil {
			return "", err
		}
		hash.Write([]byte(filepath.ToSlash(jscompat.Relative(requestDir, file)) + "\x00" + digest + "\x00"))
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
