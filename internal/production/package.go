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

	"songframe/internal/acceptance"
	"songframe/internal/dynvalue"
	"songframe/internal/filedigest"
	"songframe/internal/sourceinputs"
	"songframe/internal/speech"
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

// RequestInput — вход зафиксированного запроса: slot и role как в request.json, ImagePath —
// абсолютный путь файла в папке попытки.
type RequestInput struct {
	Slot      json.RawMessage `json:"slot,omitempty"`
	Role      json.RawMessage `json:"role,omitempty"`
	Path      string          `json:"path"`
	ImagePath string          `json:"imagePath"`
}

// Request — активная попытка пакета: неизменяемый request.json и состояние attempt.json.
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
	// PromptText — зафиксированный текст запроса; в подтверждении показывается он, а не черновик.
	PromptText      *string         `json:"promptText"`
	Parameters      json.RawMessage `json:"parameters"`
	Inputs          []RequestInput  `json:"inputs"`
	AttemptStatus   *string         `json:"attemptStatus"`
	GenerationID    *string         `json:"generationId"`
	ManualResult    bool            `json:"manualResult"`
	CreditsConsumed *float64        `json:"creditsConsumed"`
	// Mode — "manual" у пакета ручной генерации (видео создаётся вне приложения); поле опускается у
	// обычного запроса. ManualGeneration — attempt.json manual_generation загруженного видео как есть.
	Mode             string          `json:"mode,omitempty"`
	ManualGeneration json.RawMessage `json:"manualGeneration,omitempty"`
	// OwnVideo — своё видео плана (request.json own_video): попытка без описания, опор и промпта,
	// видео пользователь сделал сам; поле опускается у остальных запросов.
	OwnVideo bool `json:"ownVideo,omitempty"`
	// Downloads — абсолютные пути существующих скачанных оригиналов.
	Downloads []string `json:"downloads"`
}

// PackageView — вид рабочего пакета плана. Документы workflow.json без
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
	workflow *dynvalue.Object
}

// Pending — ожидающий вопрос пакета (pending_decision) для проверок сервиса.
type Pending struct {
	Stage    string
	Question string
	Options  []string
	// Frame — опора, о которой вопрос; "" — вопрос не об опоре.
	Frame string
}

// Pending — вопрос пакета или nil, если pending_decision ложен по правилам истинности dynvalue:
// пустая строка, 0 и null вопроса не означают.
func (p *PackageView) Pending() *Pending {
	value := dynvalue.Get(p.workflow, "pending_decision")
	if !dynvalue.Truthy(value) {
		return nil
	}
	pending := &Pending{}
	pending.Stage, _ = dynvalue.Get(value, "stage").(string)
	pending.Question, _ = dynvalue.Get(value, "question").(string)
	if options, ok := dynvalue.AsArray(dynvalue.Get(value, "options")); ok {
		for _, option := range options {
			if text, ok := option.(string); ok {
				pending.Options = append(pending.Options, text)
			}
		}
	}
	if frame := dynvalue.Get(value, "frame"); dynvalue.Truthy(frame) {
		pending.Frame = dynvalue.ToString(frame)
	}
	return pending
}

// DecisionVerdict — decision.verdict ответа пакета или "".
func (p *PackageView) DecisionVerdict() string {
	verdict, _ := dynvalue.GetPath(p.workflow, "decision", "verdict").(string)
	return verdict
}

// RequestSeconds — timing.request_seconds пакета (длительность запроса) или nil.
func (p *PackageView) RequestSeconds() *float64 {
	if value, ok := dynvalue.GetPath(p.workflow, "timing", "request_seconds").(float64); ok {
		return &value
	}
	return nil
}

// Workflow — разобранный workflow.json пакета (только чтение).
func (p *PackageView) Workflow() *dynvalue.Object { return p.workflow }

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

// readJSON — разобранный JSON файла; nil при отсутствии файла и любой ошибке.
func readJSON(path string) any {
	value, ok := dynvalue.ReadJSONFile(path)
	if !ok {
		return nil
	}
	return value
}

// readText — текст существующего файла в UTF-8; ошибка чтения отклоняет вызов.
func readText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", dynvalue.FsError("open", path, err)
	}
	return dynvalue.DecodeUTF8(data), nil
}

// joinArg — путь value из документа пакета относительно base; нестроковое значение — ошибка
// ERR_INVALID_ARG_TYPE dynvalue.PathArg, которая отклоняет весь вызов.
func joinArg(base string, value any) (string, error) {
	path, err := dynvalue.PathArg("path", value)
	if err != nil {
		return "", err
	}
	return filepath.Join(base, filepath.FromSlash(path)), nil
}

// within — нормализованный путь материала лежит строго внутри папки пакета или запроса
// (сама папка не считается).
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

// rawOrNull — значение как JSON; null и отсутствующее свойство дают null.
func rawOrNull(value any) json.RawMessage {
	if dynvalue.IsNullish(value) {
		return json.RawMessage("null")
	}
	return dynvalue.Raw(value)
}

// rawOptional — значение как JSON; отсутствующее свойство (dynvalue.Undefined) опускается.
func rawOptional(value any) json.RawMessage {
	if value == dynvalue.Undefined {
		return nil
	}
	return dynvalue.Raw(value)
}

// fingerprintFunc — отпечаток текущей постановки плана или "" (см. CurrentShotFingerprint).
type fingerprintFunc func(shot string) string

// CurrentShotFingerprint — отпечаток текущей постановки плана shot
// по сохранённому реестру и кастингу проекта; "" — реестр не разбирается или плана нет.
func CurrentShotFingerprint(project, shot string) string {
	scenes, ok := dynvalue.ReadJSONFile(filepath.Join(project, "plan", "scenes.json"))
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
	var fingerprints *dynvalue.Object
	computed := false
	return func(shot string) string {
		if !computed {
			computed = true
			if scenes, ok := dynvalue.ReadJSONFile(filepath.Join(project, "plan", "scenes.json")); ok {
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

// ReadPackage — вид пакета или nil, если workflow.json не читается или поле shot не строка.
// Условия проблем пакета зафиксированы эталонами. Ошибка (stage не строка, keyframes не массив,
// нестроковые пути) отклоняет весь вызов, а не превращается в проблему пакета. Ничего не пишет.
func ReadPackage(project, dir string) (*PackageView, error) {
	return readPackage(project, dir, func(shot string) string { return CurrentShotFingerprint(project, shot) })
}

func readPackage(project, dir string, fingerprint fingerprintFunc) (*PackageView, error) {
	parsed := readJSON(filepath.Join(dir, "workflow.json"))
	shot, ok := dynvalue.Get(parsed, "shot").(string)
	if !dynvalue.Truthy(parsed) || !ok {
		return nil, nil
	}
	workflow, _ := dynvalue.AsObject(parsed)
	problems := []string{}
	list, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(parsed, "keyframes"), &dynvalue.Array{}))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "workflow.keyframes: ожидается список"}
	}
	keyframes := make([]Keyframe, 0, len(list))
	for _, frame := range list {
		if _, err := dynvalue.Prop(frame, "id"); err != nil {
			return nil, err
		}
		item := Keyframe{Note: rawOptional(dynvalue.Get(frame, "note")), Approved: dynvalue.Truthy(dynvalue.Get(frame, "approved"))}
		item.ID = dynvalue.ToString(dynvalue.Coalesce(dynvalue.Get(frame, "id"), ""))
		item.Role = dynvalue.ToString(dynvalue.Coalesce(dynvalue.Get(frame, "role"), ""))
		item.TimeSeconds, _ = dynvalue.Get(frame, "time_seconds").(float64)
		if path := dynvalue.Get(frame, "path"); dynvalue.Truthy(path) {
			file, err := joinArg(dir, path)
			if err != nil {
				return nil, err
			}
			if dynvalue.Exists(file) {
				item.ImagePath = &file
			}
		}
		keyframes = append(keyframes, item)
	}
	promptPath, err := joinArg(dir, dynvalue.Coalesce(dynvalue.GetPath(parsed, "prompt", "path"), "video-prompt.txt"))
	if err != nil {
		return nil, err
	}
	var prompt *Prompt
	if dynvalue.Exists(promptPath) {
		text, err := readText(promptPath)
		if err != nil {
			return nil, err
		}
		prompt = &Prompt{Path: promptPath, Approved: dynvalue.Truthy(dynvalue.GetPath(parsed, "prompt", "approved")), Text: text}
	}
	stage, ok := dynvalue.Get(parsed, "stage").(string)
	if !ok {
		return nil, &dynvalue.TypeError{Message: "workflow.stage: ожидается строка"}
	}
	imageRequest := strings.HasPrefix(stage, "image_")
	active := dynvalue.Get(parsed, "request_dir")
	if imageRequest {
		active = dynvalue.Get(parsed, "image_request_dir")
	}
	var request *Request
	if dynvalue.Truthy(active) {
		request, err = readRequest(dir, parsed, active, imageRequest, &problems)
		if err != nil {
			return nil, err
		}
	}
	var description *string
	if path := filepath.Join(dir, "description.md"); dynvalue.Exists(path) {
		text, err := readText(path)
		if err != nil {
			return nil, err
		}
		description = &text
	}
	preview := []string{}
	if folder := filepath.Join(dir, "preview"); dynvalue.Exists(folder) {
		entries, err := dynvalue.ReadDir(folder)
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
	if stage == "description_review" && dynvalue.Get(workflow, "description_approved") == true {
		stageLabel = textDescriptionAccepted
	}
	// Утверждённый промпт (свой утверждается при сохранении) остаётся на этапе prompt_review до запроса.
	if stage == "prompt_review" && dynvalue.Get(dynvalue.Get(workflow, "prompt"), "approved") == true {
		stageLabel = textPromptApproved
	}
	if stage == "submitted" && request != nil && request.AttemptStatus != nil && *request.AttemptStatus != "" {
		label, ok := attemptLabels[*request.AttemptStatus]
		if !ok {
			label = *request.AttemptStatus
		}
		stageLabel = stageLabels["submitted"] + ": " + label
	}
	view := &PackageView{
		Dir: dir, Relative: dynvalue.Relative(project, dir), Shot: shot, Stage: stage, StageLabel: stageLabel,
		WaitReason: rawOrNull(dynvalue.Get(parsed, "wait_reason")), Mode: rawOrNull(dynvalue.Get(parsed, "mode")),
		RetryOf: rawOrNull(dynvalue.Get(parsed, "retry_of")), Batch: rawOrNull(dynvalue.Get(parsed, "batch")),
		Timing: rawOrNull(dynvalue.Get(parsed, "timing")), Keyframes: keyframes, Description: description,
		Prompt: prompt, Request: request, Speech: speech.ReadPackage(dir),
		PendingDecision: rawOrNull(dynvalue.Get(parsed, "pending_decision")),
		Decision:        rawOrNull(dynvalue.Get(parsed, "decision")),
		KeyframeNotes:   dynvalue.Raw(dynvalue.Coalesce(dynvalue.Get(parsed, "keyframe_notes"), &dynvalue.Array{})),
		Preview:         preview, workflow: workflow,
	}
	// Сбой расчёта токенов результата и решения — проблема пакета с текстом ошибки, а не отказ вызова.
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
		if current := fingerprint(shot); current != "" && !dynvalue.StrictEqual(dynvalue.Get(parsed, "scene_sha256"), current) {
			view.SceneChanged = true
			problems = append(problems, SceneChanged)
		}
	}
	view.Problems = problems
	return view, nil
}

// readRequest — активная попытка пакета, если в workflow.json указан active_request.
func readRequest(dir string, workflow, active any, imageRequest bool, problems *[]string) (*Request, error) {
	requestDir, err := joinArg(dir, active)
	if err != nil {
		return nil, err
	}
	frozen := readJSON(filepath.Join(requestDir, "request.json"))
	attempt := readJSON(filepath.Join(requestDir, "attempt.json"))
	if !dynvalue.Truthy(frozen) {
		*problems = append(*problems, textRequestFileMissing)
		return nil, nil
	}
	providerValue := dynvalue.Get(frozen, "provider")
	if provider, ok := providerValue.(string); !ok || dynvalue.Trim(provider) == "" {
		*problems = append(*problems, textRequestProviderMissing)
	}
	kind := dynvalue.Get(frozen, "kind")
	if imageRequest && !dynvalue.StrictEqual(kind, "image") {
		*problems = append(*problems, textImageKindRequired)
	}
	if !imageRequest && dynvalue.StrictEqual(kind, "image") {
		*problems = append(*problems, textVideoReferencesImage)
	}
	if imageRequest {
		entries, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(workflow, "image_requests"), &dynvalue.Array{}))
		if !ok {
			return nil, &dynvalue.TypeError{Message: "workflow.image_requests: ожидается список"}
		}
		matched := false
		for _, entry := range entries {
			if _, err := dynvalue.Prop(entry, "request_dir"); err != nil {
				return nil, err
			}
			if dynvalue.StrictEqual(dynvalue.Get(entry, "request_dir"), active) &&
				dynvalue.StrictEqual(dynvalue.Get(entry, "frame_id"), dynvalue.Get(workflow, "image_frame_id")) &&
				dynvalue.StrictEqual(dynvalue.Get(entry, "request_sha256"), dynvalue.Get(attempt, "request_sha256")) {
				matched = true
				break
			}
		}
		if !matched {
			*problems = append(*problems, textImageHistoryMismatch)
		}
	}
	promptValue := dynvalue.Get(frozen, "prompt")
	if _, isString := promptValue.(string); !isString {
		promptValue = dynvalue.Coalesce(dynvalue.Get(promptValue, "path"), "prompt.txt")
	}
	frozenPrompt, err := joinArg(requestDir, promptValue)
	if err != nil {
		return nil, err
	}
	downloads := []string{}
	list, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(attempt, "downloads"), &dynvalue.Array{}))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "attempt.downloads: ожидается список"}
	}
	for _, item := range list {
		path, err := dynvalue.Prop(item, "path")
		if err != nil {
			return nil, err
		}
		if dynvalue.Truthy(path) {
			file, err := joinArg(requestDir, path)
			if err != nil {
				return nil, err
			}
			downloads = append(downloads, file)
		}
	}
	if dynvalue.Exists(requestDir) {
		entries, err := dynvalue.ReadDir(requestDir)
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
		if !seen[file] && dynvalue.Exists(file) {
			existing = append(existing, file)
		}
		seen[file] = true
	}
	request := &Request{
		Dir: requestDir, Kind: "video", Command: rawOptional(dynvalue.Get(frozen, "command")),
		SHA256: optionalString(dynvalue.Get(attempt, "request_sha256")), Model: rawOptional(dynvalue.Get(frozen, "model")),
		Parameters:    dynvalue.Raw(dynvalue.Coalesce(dynvalue.Get(frozen, "parameters"), dynvalue.NewObject())),
		AttemptStatus: optionalString(dynvalue.Get(attempt, "status")), GenerationID: optionalString(dynvalue.Get(attempt, "generation_id")),
		ManualResult: dynvalue.StrictEqual(dynvalue.Get(attempt, "manual_result"), true), Downloads: existing, Inputs: []RequestInput{},
	}
	if text, ok := kind.(string); ok {
		request.Kind = text
	}
	if mode, ok := dynvalue.Get(frozen, "mode").(string); ok {
		request.Mode = mode
	}
	request.OwnVideo = dynvalue.StrictEqual(dynvalue.Get(frozen, "own_video"), true)
	if generation := dynvalue.Get(attempt, "manual_generation"); dynvalue.IsRecord(generation) {
		request.ManualGeneration = dynvalue.Raw(generation)
	}
	if provider, ok := providerValue.(string); ok {
		trimmed := dynvalue.Trim(provider)
		request.Provider = &trimmed
	}
	if frame := dynvalue.Get(workflow, "image_frame_id"); imageRequest && dynvalue.Truthy(frame) {
		request.FrameID = dynvalue.ToString(frame)
	}
	if selection := dynvalue.Get(frozen, "model_selection"); dynvalue.Truthy(selection) {
		request.ModelSelection = dynvalue.Raw(selection)
	}
	if dynvalue.Exists(frozenPrompt) {
		text, err := readText(frozenPrompt)
		if err != nil {
			return nil, err
		}
		request.PromptText = &text
	}
	inputs, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(frozen, "inputs"), &dynvalue.Array{}))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "frozen.inputs: ожидается список"}
	}
	for _, input := range inputs {
		value, err := dynvalue.Prop(input, "path")
		if err != nil {
			return nil, err
		}
		file, err := joinArg(requestDir, value)
		if err != nil {
			return nil, err
		}
		request.Inputs = append(request.Inputs, RequestInput{
			Slot: rawOptional(dynvalue.Get(input, "slot")), Role: rawOptional(dynvalue.Get(input, "role")),
			Path: value.(string), ImagePath: file,
		})
	}
	if credits, ok := dynvalue.Get(attempt, "credits_consumed").(float64); ok {
		request.CreditsConsumed = &credits
	}
	return request, nil
}

// tokenDigest — SHA-256 файла с кэшем по identity (internal/filedigest).
func tokenDigest(path string) (string, error) {
	digest, ok := filedigest.File(path)
	if !ok {
		// Файл есть, но не читается (например, это папка): проблема пакета, а не отказ вызова.
		if _, err := os.ReadFile(path); err != nil {
			return "", dynvalue.FsError("read", path, err)
		}
		return "", errors.New("не удалось прочитать " + path)
	}
	return digest, nil
}

// regularFile — путь существует и сам является обычным файлом (ссылка не разыменовывается).
func regularFile(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// missingFile — маркер отсутствующего файла в SHA материалов; входит в формат токена.
const missingFile = "<нет файла>"

// packageToken — ответ связан с показанными байтами вопроса, кандидатов и зафиксированного запроса:
// SHA-256 путей и содержимого материалов пакета, документов проекта (без декоративной обложки
// описи) и, на этапах просмотра результата, токена результата.
func packageToken(project, directory string, workflow any, stage, resultToken string) (string, error) {
	seen := map[string]bool{}
	paths := []string{}
	add := func(value any) error {
		text, err := dynvalue.PathArg("path", value)
		if err != nil {
			return err
		}
		if !seen[text] {
			seen[text] = true
			paths = append(paths, text)
		}
		return nil
	}
	for _, value := range []any{"workflow.json", "description.md", dynvalue.Coalesce(dynvalue.GetPath(workflow, "prompt", "path"), "video-prompt.txt")} {
		if err := add(value); err != nil {
			return "", err
		}
	}
	frames, _ := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(workflow, "keyframes"), &dynvalue.Array{}))
	for _, frame := range frames {
		if path := dynvalue.Get(frame, "path"); dynvalue.Truthy(path) {
			if err := add(path); err != nil {
				return "", err
			}
		}
	}
	requests := []any{dynvalue.Get(workflow, "request_dir"), dynvalue.Get(workflow, "image_request_dir")}
	entries, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(workflow, "image_requests"), &dynvalue.Array{}))
	if !ok {
		return "", &dynvalue.TypeError{Message: "workflow.image_requests: ожидается список"}
	}
	for _, entry := range entries {
		value, err := dynvalue.Prop(entry, "request_dir")
		if err != nil {
			return "", err
		}
		requests = append(requests, value)
	}
	visited := []any{}
	for _, requestDir := range requests {
		duplicate := false
		for _, previous := range visited {
			if dynvalue.StrictEqual(previous, requestDir) {
				duplicate = true
			}
		}
		visited = append(visited, requestDir)
		if duplicate || !dynvalue.Truthy(requestDir) {
			continue
		}
		base, err := dynvalue.PathArg("path", requestDir)
		if err != nil {
			return "", err
		}
		if err := add(joinRelative(base, "request.json")); err != nil {
			return "", err
		}
		request := readJSON(filepath.Join(directory, base, "request.json"))
		if !dynvalue.Truthy(request) {
			continue
		}
		prompt := dynvalue.Get(request, "prompt")
		if _, isString := prompt.(string); !isString {
			prompt = dynvalue.Coalesce(dynvalue.Get(prompt, "path"), "prompt.txt")
		}
		path, err := dynvalue.PathArg("path", prompt)
		if err != nil {
			return "", err
		}
		if err := add(joinRelative(base, path)); err != nil {
			return "", err
		}
		inputs, err := dynvalue.Iterate(dynvalue.Coalesce(dynvalue.Get(request, "inputs"), &dynvalue.Array{}))
		if err != nil {
			return "", err
		}
		for _, input := range inputs {
			value, err := dynvalue.Prop(input, "path")
			if err != nil {
				return "", err
			}
			path, err := dynvalue.PathArg("path", value)
			if err != nil {
				return "", err
			}
			if err := add(joinRelative(base, path)); err != nil {
				return "", err
			}
		}
	}
	sort.SliceStable(paths, func(i, j int) bool { return dynvalue.LessUTF16(paths[i], paths[j]) })
	hash := sha256.New()
	for _, path := range paths {
		file := dynvalue.Resolve(directory, path)
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
			// Декоративная обложка не меняет показанное согласование или зафиксированный платный запрос.
			value, ok, err := sourceinputs.Digest(project)
			if err != nil {
				return "", err
			}
			if ok {
				digest = value
			}
		} else if dynvalue.Exists(file) {
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

// joinRelative — соединение base и name для относительных путей токена: нормализация без
// превращения в абсолютный путь и с разделителем «/» на любой ОС: от него зависит токен.
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
	sort.SliceStable(paths, func(i, j int) bool { return dynvalue.LessUTF16(paths[i], paths[j]) })
	hash := sha256.New()
	for _, path := range paths {
		file := dynvalue.Resolve(path)
		if !within(requestDir, file) {
			return "", errors.New(textResultFileRequired)
		}
		info, err := os.Lstat(file)
		if err != nil {
			return "", dynvalue.FsError("lstat", file, err)
		}
		if !info.Mode().IsRegular() {
			return "", errors.New(textResultFileRequired)
		}
		digest, err := tokenDigest(file)
		if err != nil {
			return "", err
		}
		hash.Write([]byte(filepath.ToSlash(dynvalue.Relative(requestDir, file)) + "\x00" + digest + "\x00"))
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
