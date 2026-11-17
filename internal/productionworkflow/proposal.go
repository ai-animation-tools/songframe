package productionworkflow

import (
	"bytes"
	"errors"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
)

// Rules — что проверяется в ответе агента. Значения из документов
// проекта (правило длительности, requestSeconds, план опор) хранятся как есть: их сравнение
// идёт строгим равенством dynvalue (тип и значение). Записываются в запись предложения при
// подготовке и читаются из неё при обновлении статуса и Apply.
type Rules struct {
	// Project — реальный путь проекта. В файл записи не пишется: Store подставляет его при чтении
	// по месту записи, поэтому запись не зависит от того, где лежит папка проекта.
	Project string
	// Stage — description, frames, prompt или request.
	Stage         string
	WindowSeconds float64
	// DurationRule — settings.duration_rule (Undefined — поля не было).
	DurationRule any
	// RequestSeconds — workflow.timing.request_seconds пакета; null, если поля нет.
	RequestSeconds any
	AllowedPaths   []string
	// FramePrompts — план опор пакета (массив документа keyframe-prompts.json).
	FramePrompts any
	// LipSync — допустимая длина звукового входа провайдера для речевого плана; nil — null.
	LipSync *mediaproviders.LipSync
	// Manual — речевой план без липсинка у провайдера: видео создаётся вне приложения по одной
	// опоре, этапа request нет.
	Manual bool
	// Keyframes — число опор, выбранное пользователем для этапа description; 0 — «авто»: агент
	// выбирает сам в пределах 2–20.
	Keyframes int
	// Own — свой текст пользователя (предложение с отметкой own): промпт опоры может быть пустым,
	// такую опору пользователь делает своим файлом. В дерево правил не входит: признак берётся из
	// предложения при каждом разборе.
	Own bool
}

// Tree — правила для записи предложения; порядок ключей зафиксирован эталоном (project Store
// убирает при записи файла).
func (r Rules) Tree() *dynvalue.Object {
	tree := dynvalue.NewObject()
	tree.Set("project", r.Project)
	tree.Set("stage", r.Stage)
	tree.Set("windowSeconds", r.WindowSeconds)
	tree.Set("durationRule", r.DurationRule)
	tree.Set("requestSeconds", r.RequestSeconds)
	paths := make([]any, len(r.AllowedPaths))
	for index, path := range r.AllowedPaths {
		paths[index] = path
	}
	tree.Set("allowedPaths", &dynvalue.Array{Items: paths})
	tree.Set("framePrompts", r.FramePrompts)
	if r.LipSync == nil {
		tree.Set("lipSync", nil)
	} else {
		limits := dynvalue.NewObject()
		limits.Set("min", r.LipSync.Min)
		limits.Set("max", r.LipSync.Max)
		tree.Set("lipSync", limits)
	}
	// Ключ пишется только в ручном режиме: записи обычных планов не меняются.
	if r.Manual {
		tree.Set("manualGeneration", true)
	}
	// Выбранное число опор пишется только при явном выборе: записи «авто» не меняются.
	if r.Keyframes > 0 {
		tree.Set("keyframeCount", float64(r.Keyframes))
	}
	return tree
}

// RulesFromTree — правила из записанной записи предложения.
func RulesFromTree(value any) Rules {
	rules := Rules{
		Stage: dynvalue.ToString(dynvalue.Get(value, "stage")), WindowSeconds: dynvalue.ToNumber(dynvalue.Get(value, "windowSeconds")),
		DurationRule: dynvalue.Get(value, "durationRule"), RequestSeconds: dynvalue.Get(value, "requestSeconds"),
		FramePrompts: dynvalue.Get(value, "framePrompts"), AllowedPaths: []string{},
	}
	rules.Project, _ = dynvalue.Get(value, "project").(string)
	rules.Manual = dynvalue.Get(value, "manualGeneration") == true
	if count, ok := dynvalue.Get(value, "keyframeCount").(float64); ok && dynvalue.IsInteger(count) && count > 0 {
		rules.Keyframes = int(count)
	}
	if paths, ok := dynvalue.AsArray(dynvalue.Get(value, "allowedPaths")); ok {
		for _, path := range paths {
			if text, isString := path.(string); isString {
				rules.AllowedPaths = append(rules.AllowedPaths, text)
			}
		}
	}
	if limits := dynvalue.Get(value, "lipSync"); dynvalue.IsRecord(limits) {
		rules.LipSync = &mediaproviders.LipSync{Min: dynvalue.ToNumber(dynvalue.Get(limits, "min")), Max: dynvalue.ToNumber(dynvalue.Get(limits, "max"))}
	}
	return rules
}

// keys проверяет, что в объекте только разрешённые поля.
func keys(value *dynvalue.Object, allowed ...string) error {
	for _, key := range value.Keys() {
		if !slices.Contains(allowed, key) {
			return errors.New(textUnknownFields)
		}
	}
	return nil
}

// CheckDuration проверяет, что длительность запроса — положительное целое число
// секунд по правилу окна (exact_window, min_supported_not_less_than_window или строго больше).
func CheckDuration(seconds any, window float64, rule any) error {
	value, isNumber := seconds.(float64)
	if !dynvalue.IsInteger(seconds) || value <= 0 {
		return errors.New(textDurationPositiveInteger)
	}
	var valid bool
	switch rule {
	case "exact_window":
		valid = isNumber && value == window
	case "min_supported_not_less_than_window":
		valid = value >= window
	default:
		valid = value > window
	}
	if !valid {
		return errors.New(textDurationRuleViolation(value, dynvalue.ToString(rule), window))
	}
	return nil
}

// imagePath — допустимое расширение референса опоры.
var imagePath = regexp.MustCompile(`(?i)\.(png|jpe?g|webp)$`)

// pngSignature — первые восемь байт PNG.
var pngSignature = []byte{137, 80, 78, 71, 13, 10, 26, 10}

// FrameCandidate — ProductionFrameCandidate: кандидат опоры id в файле path (реальный путь).
type FrameCandidate struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

// CheckFrameCandidates проверяет кандидатов части опор плана prompts: каждая опора не больше
// одного раза и в порядке плана; файл — обычный PNG, JPEG или WebP по абсолютному пути.
// Возвращает кандидатов с разыменованными путями (импорт и задание провайдера-агента).
func CheckFrameCandidates(value any, prompts any) ([]FrameCandidate, error) {
	items, ok := dynvalue.AsArray(value)
	if !ok || len(items) == 0 {
		return nil, errors.New(textFrameImageRequired)
	}
	order := []any{}
	if list, isArray := dynvalue.AsArray(prompts); isArray {
		for _, prompt := range list {
			order = append(order, dynvalue.Get(prompt, "id"))
		}
	}
	previous := -1
	result := make([]FrameCandidate, 0, len(items))
	for _, item := range items {
		object, isObject := item.(*dynvalue.Object)
		if !isObject {
			return nil, errors.New(textFrameCandidateInvalid)
		}
		if err := keys(object, "id", "path"); err != nil {
			return nil, err
		}
		id := object.Value("id")
		position := slices.Index(order, id)
		path, isString := object.Value("path").(string)
		if position <= previous || !isText(path) || !isString || !dynvalue.IsAbs(path) {
			return nil, errors.New(textFrameCandidateOrderInvalid)
		}
		previous = position
		real, err := dynvalue.Realpath(path)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(real)
		if err != nil {
			return nil, dynvalue.FsError("lstat", real, err)
		}
		if !info.Mode().IsRegular() {
			return nil, errors.New(textFrameFileRequired(id))
		}
		data, err := os.ReadFile(real)
		if err != nil {
			return nil, dynvalue.FsError("open", real, err)
		}
		png := bytes.HasPrefix(data, pngSignature)
		jpeg := len(data) >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255
		webp := len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP"
		if !png && !jpeg && !webp {
			return nil, errors.New(textFrameFormatRequired(id))
		}
		text, _ := id.(string)
		result = append(result, FrameCandidate{ID: text, Path: real})
	}
	return result, nil
}

// candidatesTree — кандидаты в форме массива { id, path } предложения.
func candidatesTree(candidates []FrameCandidate) *dynvalue.Array {
	items := make([]any, len(candidates))
	for index, candidate := range candidates {
		object := dynvalue.NewObject()
		object.Set("id", candidate.ID)
		object.Set("path", candidate.Path)
		items[index] = object
	}
	return &dynvalue.Array{Items: items}
}

// agentTextLimit — предел показанного ответа агента в кодовых единицах UTF-16.
const agentTextLimit = 4000

// AgentResponseText — что ответил агент, когда предложение не прошло
// проверку, — текст основного поля этапа (description, prompt) либо сам ответ, без NUL и
// распознаваемых секретов, не длиннее agentTextLimit. "" — показывать нечего.
func AgentResponseText(raw, stage string) string {
	value, _ := dynvalue.Parse([]byte(raw))
	chosen := raw
	if field := map[string]string{"description": "description", "prompt": "prompt"}[stage]; field != "" {
		if own, ok := dynvalue.Get(value, field).(string); ok && dynvalue.IsRecord(value) && dynvalue.Trim(own) != "" {
			chosen = own
		}
	}
	clean := agents.Redact(dynvalue.Trim(strings.ReplaceAll(chosen, "\x00", "")))
	if clean == "" {
		return ""
	}
	units := utf16.Encode([]rune(clean))
	if len(units) <= agentTextLimit {
		return clean
	}
	return trimEnd(string(utf16.Decode(units[:agentTextLimit]))) + "…"
}

// trimEnd — срез пробелов только в конце: тот же набор пробелов, что у dynvalue.Trim (в тексте нет
// NUL, поэтому служебный префикс не может быть съеден).
func trimEnd(text string) string {
	return strings.TrimPrefix(dynvalue.Trim("\x00"+text), "\x00")
}

// IsAgentRefusal сообщает, что вместо JSON агент вернул обычный текст с причиной
// (штатный отказ по скиллу). Испорченный JSON, начинающийся с «{» или блока кода, отказом не
// считается.
func IsAgentRefusal(raw string) bool {
	text := dynvalue.Trim(raw)
	if text == "" || strings.HasPrefix(text, "{") || strings.HasPrefix(text, "```") {
		return false
	}
	_, err := dynvalue.Parse([]byte(text))
	return err != nil
}

// ParseProposal разбирает строгую форму ответа агента для этапа
// rules.Stage. Пути и технические поля проверяются до изменения пакета; кандидаты опор
// заменяются разыменованными путями. Возвращает документ предложения (ProductionStageProposal)
// деревом dynvalue в порядке ключей ответа.
func ParseProposal(raw string, rules Rules) (*dynvalue.Object, error) {
	parsed, err := dynvalue.Parse([]byte(raw))
	if err != nil {
		return nil, errors.New(textProposalNotJSON)
	}
	value, ok := parsed.(*dynvalue.Object)
	if !ok || value.Value("schemaVersion") != float64(1) || value.Value("stage") != rules.Stage {
		return nil, errors.New(textProposalVersionOrStage)
	}
	switch rules.Stage {
	case "description":
		return value, parseDescription(value, rules)
	case "frames":
		if err := keys(value, "schemaVersion", "stage", "images"); err != nil {
			return nil, err
		}
		images, err := CheckFrameCandidates(value.Value("images"), rules.FramePrompts)
		if err != nil {
			return nil, err
		}
		value.Set("images", candidatesTree(images))
	case "prompt":
		if err := keys(value, "schemaVersion", "stage", "prompt"); err != nil {
			return nil, err
		}
		if !isText(value.Value("prompt")) {
			return nil, errors.New(textVideoPromptRequired)
		}
	}
	return value, nil
}

// parseDescription — проверка описания и плана опор: K01..KNN подряд, first на 0, last на
// requestSeconds, middle строго между; референсы — изображения из allowedPaths. В ручном режиме
// (rules.Manual) опора ровно одна — K01 first на 0. Выбранное пользователем число опор
// (rules.Keyframes) соблюдается точно; одна опора — только K01 first, без last. У своего описания
// (rules.Own) промпт опоры может быть пустой строкой: опору без промпта создать нельзя, только
// загрузить своим файлом. Опора с copyOf — копия более ранней опоры-не-копии или кадра принятого
// плана из continuityFrames (его путь в allowedPaths): пустой промпт и без референсов.
func parseDescription(value *dynvalue.Object, rules Rules) error {
	if err := keys(value, "schemaVersion", "stage", "description", "requestSeconds", "keyframes"); err != nil {
		return err
	}
	seconds, isNumber := value.Value("requestSeconds").(float64)
	frames, isArray := dynvalue.AsArray(value.Value("keyframes"))
	if !isText(value.Value("description")) || !isNumber || !isArray {
		return errors.New(textDescriptionInvalid)
	}
	if rules.Manual && len(frames) != 1 {
		return errors.New(textManualSingleFrame)
	}
	if !rules.Manual && rules.Keyframes > 0 && len(frames) != rules.Keyframes {
		return errors.New(textKeyframeCountMismatch(rules.Keyframes, len(frames)))
	}
	if !rules.Manual && rules.Keyframes != 1 && (len(frames) < 2 || len(frames) > mediaproviders.DefaultKeyframeLimit) {
		return errors.New(textDescriptionInvalid)
	}
	if err := CheckDuration(seconds, rules.WindowSeconds, rules.DurationRule); err != nil {
		return err
	}
	if rules.LipSync != nil && (seconds < rules.LipSync.Min || seconds > rules.LipSync.Max) {
		return errors.New(textSpeechDurationRange(rules.LipSync.Min, rules.LipSync.Max))
	}
	previous := -1.0
	for index, item := range frames {
		frame, isObject := item.(*dynvalue.Object)
		if !isObject {
			return errors.New(textFrameStructureInvalid)
		}
		if err := keys(frame, "id", "role", "timeSeconds", "prompt", "referencePaths", "copyOf"); err != nil {
			return err
		}
		// Копия повторяет более раннюю опору или кадр принятого плана кадр в кадр: её не создают, а
		// получают файлом источника (internal/production, frame_copies.go), поэтому своего промпта и
		// референсов у неё нет.
		if frame.Has("copyOf") {
			source, _ := frame.Value("copyOf").(string)
			references, _ := dynvalue.AsArray(frame.Value("referencePaths"))
			valid := !rules.Manual && frame.Value("prompt") == "" && len(references) == 0 && (isShotFramePath(source) && slices.Contains(rules.AllowedPaths, source) ||
				slices.ContainsFunc(frames[:index], func(item any) bool {
					earlier, _ := item.(*dynvalue.Object)
					return earlier != nil && earlier.Value("id") == source && !earlier.Has("copyOf")
				}))
			if !valid {
				return errors.New(textFrameCopyInvalid)
			}
		}
		role := "middle"
		if index == 0 {
			role = "first"
		} else if index == len(frames)-1 {
			role = "last"
		}
		time, timeOK := frame.Value("timeSeconds").(float64)
		references, referencesOK := dynvalue.AsArray(frame.Value("referencePaths"))
		valid := frame.Value("id") == "K"+twoDigits(index+1) && frame.Value("role") == role && timeOK && dynvalue.IsFinite(time) &&
			time > previous && (isText(frame.Value("prompt")) || frame.Has("copyOf") || (rules.Own && isOptionalText(frame.Value("prompt")))) && referencesOK
		for _, path := range references {
			text, _ := path.(string)
			if !valid || !isText(path) || !imagePath.MatchString(text) || !slices.Contains(rules.AllowedPaths, text) {
				valid = false
				break
			}
		}
		if !valid {
			return errors.New(textFramePlanInvalid)
		}
		if (role == "first" && time != 0) || (role == "last" && time != seconds) || time > seconds {
			return errors.New(textFrameBoundariesInvalid)
		}
		previous = time
	}
	return nil
}
