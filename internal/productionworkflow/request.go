package productionworkflow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"songframe/internal/agents"
	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
)

// Запрос видео собирает приложение, без агента. Всё содержимое запроса следует из утверждённого:
// опоры по порядку плана — в слоты кадров адаптера, срез речи — в его звуковой слот, длительность —
// requestSeconds описания, разрешение и пропорции — настройки проекта, остальные параметры —
// значения единого плана из правил адаптера (mediaapi.VideoRules). Модель выбирает общий селектор
// платного адаптера: предпочтение проекта, затем модели адаптера, затем остальные модели команды;
// у каждой модели свои объявленные параметры. Пользователь может изменить модель и параметры
// (RequestChange): тогда пробуется только выбранная модель, и её отказ показывается как есть.

// RequestChange — изменение запроса пользователем на вопросе request_choice: модель и значения
// параметров из её объявлений (RequestOptions).
type RequestChange struct {
	Model      string         `json:"model"`
	Parameters map[string]any `json:"parameters"`
}

// RequestOptions — productionWorkflow.requestOptions: модели команды видео и параметры, которые
// пользователь выбирает сам, с текущими моделью и параметрами запроса попытки.
type RequestOptions struct {
	Models []RequestModel `json:"models"`
	// Model и Parameters — текущий запрос попытки; Parameters — только выбираемые параметры.
	Model      string         `json:"model"`
	Parameters map[string]any `json:"parameters"`
}

// RequestModel — модель команды видео и её выбираемые параметры. Unavailable — почему модель не
// подходит плану (опоры, длительность, срез речи, настройки проекта) с её значениями по
// умолчанию: такую модель окно показывает выключенной.
type RequestModel struct {
	ID          string             `json:"id"`
	Parameters  []RequestParameter `json:"parameters"`
	Unavailable string             `json:"unavailable,omitempty"`
}

// RequestParameter — параметр с перечнем допустимых значений (JSON-значения: true, 5, "pro").
type RequestParameter struct {
	Name   string `json:"name"`
	Values []any  `json:"values"`
}

// Роли входов запроса — подписи файлов в request.json и на странице.
const (
	roleFirstFrame  = "Первый кадр"
	roleMiddleFrame = "Промежуточный кадр"
	roleLastFrame   = "Последний кадр"
	roleSpeech      = "Срез речи"
)

// PrepareRequest — productionWorkflow.prepareRequest: приложение готовит запрос видео попытки
// packageDir (новая папка request-NN, неизменяемый request.json без отправки) и задаёт вопрос
// request_choice. Без change — следующий шаг после утверждённого видеопромпта; с change — ответ
// «Изменить» на открытом вопросе request_choice: прежний запрос остаётся историей попытки, вопрос
// задаётся о новом. Отправка — только после отдельного согласования.
func (w *Workflow) PrepareRequest(ctx context.Context, project, shot, packageDir string, change *RequestChange) (View, error) {
	w.mu.Lock()
	c, err := w.checkRequest(project, shot, packageDir, change)
	if err != nil {
		w.mu.Unlock()
		return View{}, err
	}
	// Подготовка ходит к провайдеру за доступом, объявлениями моделей и ценой и может идти дольше
	// срока ожидания интерфейса. Как Start и Apply, она идёт без мьютекса: план отмечен busy, поэтому
	// другие действия с ним отказывают «Дождитесь…», а вид плана и список предложений не ждут.
	planKey := key(c.Project, shot)
	w.busy[planKey] = true
	w.mu.Unlock()
	err = w.prepareRequest(ctx, c, change)
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.busy, planKey)
	if err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, c.PackageDir)
}

// checkRequest — под мьютексом: контекст попытки и причины, по которым запрос сейчас не готовится
// (идёт задание, вопрос не закрыт, непринятое предложение).
func (w *Workflow) checkRequest(project, shot, packageDir string, change *RequestChange) (*Context, error) {
	canonical, err := dynvalue.Realpath(project)
	if err != nil {
		return nil, err
	}
	c, err := ReadContext(canonical, shot, packageDir)
	if err != nil {
		return nil, err
	}
	if w.busy[key(canonical, shot)] || slices.ContainsFunc(w.options.Agents.List(canonical), func(job agents.Job) bool { return job.Status == "running" }) ||
		(c.PackageDir != "" && w.options.IsPackageBusy != nil && w.options.IsPackageBusy(canonical, c.PackageDir)) {
		return nil, errors.New(textWaitForJob)
	}
	if err := requestAllowed(c, change); err != nil {
		return nil, err
	}
	if w.store.Read(canonical, shot).active() {
		return nil, errors.New(textResolveProposalFirstError)
	}
	return c, nil
}

// prepareRequest — без мьютекса, план отмечен busy: папка request-NN, этап request_choice и вопрос
// о запросе.
func (w *Workflow) prepareRequest(ctx context.Context, c *Context, change *RequestChange) error {
	requestName, err := w.buildRequest(ctx, c, change)
	if err != nil {
		return err
	}
	if err := w.run(ctx, c.Project, "shot_workflow", "set-stage", "--dir", c.PackageDir, "request_choice", "--request-dir", requestName); err != nil {
		return err
	}
	return w.run(ctx, c.Project, "shot_workflow", "ask", "--dir", c.PackageDir, "--stage", "request_choice")
}

// requestAllowed — причина, по которой запрос попытки сейчас не готовится; nil — можно. Без
// изменения запрос — следующий шаг попытки (StageFor), с изменением — ответ на вопрос
// request_choice.
func requestAllowed(c *Context, change *RequestChange) error {
	switch {
	case c.DerivedFrom != "":
		return errors.New(derivedshot.Reason(c.DerivedFrom))
	case c.StaticShot:
		return errors.New(textStaticNoVideoStage)
	case c.PackageDir == "" || c.Workflow == nil:
		return errors.New(textPackageUnavailable)
	case len(c.Problems) > 0:
		return errors.New(strings.Join(c.Problems, " "))
	case c.Paid:
		return errors.New(textSentAttemptNeedsRetry)
	case c.Manual:
		return errors.New(textManualNoRequest)
	case c.SceneChanged:
		return errors.New(textResolveSceneChangedPackageFirst(textSceneChangedReason))
	}
	pending := c.workflowValue("pending_decision")
	if change != nil {
		if dynvalue.Get(pending, "stage") != "request_choice" {
			return errors.New(textRequestChangeUnavailable)
		}
		if dynvalue.Trim(change.Model) == "" {
			return errors.New(textRequestModelRequired)
		}
		return nil
	}
	if dynvalue.Truthy(pending) {
		return errors.New(textResolveQuestionFirst)
	}
	next, err := c.StageFor()
	if err != nil {
		return err
	}
	if next != "request" {
		return errors.New(textStageUnavailable)
	}
	return nil
}

// buildRequest проверяет утверждения и срез речи, собирает черновик и готовит его платным
// адаптером видео проекта в новой папке request-NN пакета. Недописанная папка удаляется.
// Возвращает имя папки запроса.
func (w *Workflow) buildRequest(ctx context.Context, c *Context, change *RequestChange) (string, error) {
	prompt, err := c.PromptApproved()
	if err != nil {
		return "", err
	}
	frames, err := c.FramesApproved()
	if err != nil {
		return "", err
	}
	if !prompt || !frames {
		return "", errors.New(textFrameOrPromptApprovalStale)
	}
	lipSync := dynvalue.Truthy(c.Scene.Value("lipsync"))
	if lipSync && c.Speech == nil {
		return "", errors.New(textSpeechInputRequired)
	}
	if w.options.RequireVideoAccess != nil {
		if err := w.options.RequireVideoAccess(ctx, c.Project); err != nil {
			return "", err
		}
	}
	media, settings, err := w.videoMedia(c)
	if err != nil {
		return "", err
	}
	rules := media.Paid.Rules.Video
	if rules == nil {
		return "", errors.New(textChooseVideoProvider())
	}
	caps := media.Capabilities(ctx, c.Project)
	draft, err := requestDraft(c, media.Paid, settings, caps, change)
	if err != nil {
		return "", err
	}
	if err := applySavedLooks(ctx, c, media, caps, &draft); err != nil {
		return "", err
	}
	number := 1
	for dynvalue.Exists(filepath.Join(c.PackageDir, "request-"+twoDigits(number))) {
		number++
	}
	requestName := "request-" + twoDigits(number)
	draft.WorkDir = filepath.Join(c.PackageDir, requestName)
	if _, err := media.Prepare(ctx, draft, caps); err != nil {
		// Папку создал этот вызов, и на неё ещё ничто не ссылается.
		_ = os.RemoveAll(draft.WorkDir)
		return "", err
	}
	return requestName, nil
}

// requestDraft — черновик запроса попытки без записи: текст утверждённого промпта, входы, модель и
// параметры по снимку caps. У речевого плана длительность покрывает весь срез.
func requestDraft(c *Context, paid providers.Paid, settings *dynvalue.Object, caps mediaapi.Capabilities, change *RequestChange) (providers.PaidInput, error) {
	input, ordered, candidate, err := requestSelection(c, paid, settings, caps, change)
	if err != nil {
		return providers.PaidInput{}, err
	}
	draft, err := providers.SelectPaidRequest(paid, input, ordered, candidate)
	if err != nil {
		return providers.PaidInput{}, err
	}
	if dynvalue.Truthy(c.Scene.Value("lipsync")) {
		// Видео короче среза оборвало бы речь: длительность запроса покрывает весь WAV.
		if length := c.Speech.length(); dynvalue.ToNumber(draft.Parameters.Value("duration")) < length-1e-6 {
			return providers.PaidInput{}, errors.New(textRequestShorterThanSpeech(dynvalue.ToFixed(length, 2)))
		}
	}
	return draft, nil
}

// videoMedia — платный адаптер видео провайдера проекта и блок generation.video настроек.
func (w *Workflow) videoMedia(c *Context) (*providers.PaidMedia, *dynvalue.Object, error) {
	settings, err := videoSettings(c.Project)
	if err != nil {
		return nil, nil, err
	}
	provider, _ := settings.Value("provider").(string)
	var media *providers.PaidMedia
	if mediaproviders.Supports(provider, mediaproviders.Video) && w.options.VideoMedia != nil {
		media, _ = w.options.VideoMedia(provider)
	}
	if media == nil {
		return nil, nil, errors.New(textChooseVideoProvider())
	}
	return media, settings, nil
}

// requestInputs — входы запроса: утверждённые опоры по порядку плана в слотах кадров адаптера и,
// у речевого плана, точный WAV пакета в звуковом слоте. Пути — от проекта.
func requestInputs(c *Context, rules *mediaapi.VideoRules, lipSync bool) ([]providers.PaidInputItem, error) {
	paths := []string{}
	for _, frame := range keyframes(c.Workflow) {
		if !dynvalue.Truthy(dynvalue.Get(frame, "approved")) {
			continue
		}
		full, err := packageFile(c, dynvalue.Get(frame, "path"))
		if err != nil {
			return nil, err
		}
		paths = append(paths, rel(c.Project, full))
	}
	if len(paths) == 0 {
		return nil, errors.New(textFrameOrPromptApprovalStale)
	}
	slots := rules.FrameSlots(len(paths))
	inputs := make([]providers.PaidInputItem, len(paths))
	for index, path := range paths {
		role := roleMiddleFrame
		switch {
		case index == 0:
			role = roleFirstFrame
		case index == len(paths)-1:
			role = roleLastFrame
		}
		inputs[index] = providers.PaidInputItem{Flag: "input", Slot: slots[index], Path: path, Role: role}
	}
	if lipSync {
		if rules.SpeechSlot == "" {
			return nil, errors.New(textSpeechInputRequired)
		}
		inputs = append(inputs, providers.PaidInputItem{Flag: "input", Slot: rules.SpeechSlot, Path: c.Speech.Path, Role: roleSpeech})
	}
	return inputs, nil
}

// requestSelection — запрос попытки до выбора модели: текст утверждённого промпта, входы, правило
// длительности и настройки проекта, кандидаты в порядке выбора и параметры каждой модели
// (videoParameters). С изменением пользователя кандидат один — его модель с его значениями. Той же
// заготовкой RequestOptions проверяет каждую модель, поэтому окно «Изменить» и сборка не
// расходятся.
func requestSelection(c *Context, paid providers.Paid, settings *dynvalue.Object, caps mediaapi.Capabilities, change *RequestChange) (providers.PaidInput, mediaapi.Capabilities, providers.CandidateParameters, error) {
	promptPath, _ := dynvalue.Get(c.workflowValue("prompt"), "path").(string)
	prompt, err := readText(filepath.Join(c.PackageDir, promptPath))
	if err != nil {
		return providers.PaidInput{}, caps, nil, err
	}
	inputs, err := requestInputs(c, paid.Rules.Video, dynvalue.Truthy(c.Scene.Value("lipsync")))
	if err != nil {
		return providers.PaidInput{}, caps, nil, err
	}
	rules := paid.Rules.Video
	preferred := ""
	if model, isString := settings.Value("model").(string); isString {
		preferred = dynvalue.Trim(model)
	}
	if change != nil {
		preferred = dynvalue.Trim(change.Model)
	}
	// Модели адаптера пробуются раньше остальных моделей каталога: порядок кандидатов селектора —
	// предпочтение, затем модели в порядке переданного снимка.
	ordered := caps
	ordered.Models = []mediaapi.Model{}
	for _, item := range caps.Models {
		if change == nil || item.ID == preferred {
			ordered.Models = append(ordered.Models, item)
		}
	}
	slices.SortStableFunc(ordered.Models, func(a, b mediaapi.Model) int { return modelRank(rules.Models, a.ID) - modelRank(rules.Models, b.ID) })
	constraint := &providers.DurationConstraint{WindowSeconds: c.Window, Rule: dynvalue.ToString(c.DurationRule)}
	if provider, ok := videoProvider(c.Settings); ok && dynvalue.Truthy(c.Scene.Value("lipsync")) && provider.LipSync != nil {
		minimum := provider.LipSync.Min
		constraint.MinSeconds = &minimum
	}
	required := dynvalue.NewObject()
	required.Set("resolution", settings.Value("resolution"))
	required.Set("aspect_ratio", settings.Value("aspect_ratio"))
	options, _ := settings.Value("options").(*dynvalue.Object)
	requestSeconds := dynvalue.Get(c.workflowValue("timing"), "request_seconds")
	input := providers.PaidInput{
		Project: c.Project, Shot: c.Shot, Kind: mediaproviders.Video, Command: rules.Command, PreferredModel: &preferred,
		DurationConstraint: constraint, RequiredParameters: required, ProjectOptions: options, Inputs: inputs, Outputs: 1, Prompt: prompt,
	}
	return input, ordered, func(item mediaapi.Model) *dynvalue.Object {
		parameters := videoParameters(paid.Rules, item, settings, requestSeconds, inputs)
		if change != nil {
			for name, value := range change.Parameters {
				parameters.Set(name, fromJSON(value))
			}
		}
		return parameters
	}, nil
}

// modelRank — место модели в списке адаптера; модели вне списка — после него.
func modelRank(models []string, id string) int {
	if index := slices.Index(models, id); index >= 0 {
		return index
	}
	return len(models)
}

// videoParameters — параметры запроса для модели item: длительность описания, разрешение и
// пропорции проекта, если модель их объявляет (пропорции, которые задаёт начальный кадр, не
// передаются: с настройкой сверяется сам кадр), и значения единого плана адаптера.
func videoParameters(rules mediaapi.RequestRules, item mediaapi.Model, settings *dynvalue.Object, requestSeconds any, inputs []providers.PaidInputItem) *dynvalue.Object {
	arguments := modelArguments(item)
	parameters := dynvalue.NewObject()
	parameters.Set("duration", requestSeconds)
	frame := rules.FrameDefined != nil && slices.ContainsFunc(inputs, func(entry providers.PaidInputItem) bool { return rules.FrameDefined.Slots.MatchString(entry.Slot) })
	for _, setting := range []string{"resolution", "aspect_ratio"} {
		name := providers.ArgumentName(arguments, setting)
		value := settings.Value(setting)
		if name == "" || !dynvalue.Truthy(value) || (frame && slices.Contains(rules.FrameDefined.Parameters, name)) {
			continue
		}
		parameters.Set(name, value)
	}
	for _, preference := range rules.Video.Defaults {
		name := providers.ArgumentName(arguments, preference.Name)
		if name == "" {
			continue
		}
		allowed, limited := dynvalue.AsArray(dynvalue.Get(arguments.Value(name), "allowed"))
		for _, value := range preference.Values {
			if !limited || slices.ContainsFunc(allowed, func(entry any) bool { return dynvalue.ToString(entry) == dynvalue.ToString(value) }) {
				parameters.Set(name, value)
				break
			}
		}
	}
	return parameters
}

// modelArguments — объявления параметров модели; повреждённое объявление — пустой объект.
func modelArguments(item mediaapi.Model) *dynvalue.Object {
	value, err := dynvalue.Parse(item.Arguments)
	if object, ok := value.(*dynvalue.Object); err == nil && ok {
		return object
	}
	return dynvalue.NewObject()
}

// RequestOptions — productionWorkflow.requestOptions: модели команды видео адаптера по свежим
// объявлениям и их выбираемые параметры для диалога «Изменить» вопроса request_choice. Выбираемые —
// параметры с перечнем допустимых значений, кроме тех, что задают описание и проект (длительность,
// разрешение, пропорции), обязательных значений провайдера и числа результатов.
func (w *Workflow) RequestOptions(ctx context.Context, project, shot, packageDir string) (RequestOptions, error) {
	canonical, err := dynvalue.Realpath(project)
	if err != nil {
		return RequestOptions{}, err
	}
	c, err := ReadContext(canonical, shot, packageDir)
	if err != nil {
		return RequestOptions{}, err
	}
	if err := requestAllowed(c, &RequestChange{Model: "-"}); err != nil {
		return RequestOptions{}, err
	}
	media, settings, err := w.videoMedia(c)
	if err != nil {
		return RequestOptions{}, err
	}
	rules := media.Paid.Rules
	if rules.Video == nil {
		return RequestOptions{}, errors.New(textChooseVideoProvider())
	}
	fixed := map[string]bool{}
	names := append([]string{"duration", "prompt", "model", "resolution", "aspect_ratio"}, rules.OutputCount...)
	for _, alias := range rules.Aliases[mediaproviders.Video] {
		names = append(names, alias.Names...)
	}
	for _, name := range append(names, enforcedNames(rules)...) {
		fixed[plainName(name)] = true
	}
	result := RequestOptions{Models: []RequestModel{}, Parameters: map[string]any{}}
	caps := media.Capabilities(ctx, canonical)
	input, _, candidate, err := requestSelection(c, media.Paid, settings, caps, nil)
	if err != nil {
		return RequestOptions{}, err
	}
	for _, item := range caps.Models {
		if item.Command != rules.Video.Command {
			continue
		}
		arguments := modelArguments(item)
		model := RequestModel{ID: item.ID, Parameters: []RequestParameter{}}
		for _, name := range arguments.Keys() {
			allowed, ok := dynvalue.AsArray(dynvalue.Get(arguments.Value(name), "allowed"))
			if !ok || len(allowed) == 0 || fixed[plainName(name)] {
				continue
			}
			values := make([]any, len(allowed))
			for index, entry := range allowed {
				values[index] = typedValue(entry)
			}
			model.Parameters = append(model.Parameters, RequestParameter{Name: name, Values: values})
		}
		// Пригодность — той же проверкой, что у сборки запроса этой моделью, без записи и сети.
		if err := providers.PaidModelProblem(media.Paid, input, caps, item, candidate); err != nil {
			model.Unavailable = modelProblem(err, input.Inputs)
		}
		result.Models = append(result.Models, model)
	}
	request, err := readJSON(filepath.Join(c.PackageDir, dynvalue.ToString(c.workflowValue("request_dir")), "request.json"))
	if err != nil {
		return RequestOptions{}, err
	}
	result.Model, _ = dynvalue.Get(request, "model").(string)
	if parameters, ok := dynvalue.Get(request, "parameters").(*dynvalue.Object); ok {
		for _, name := range parameters.Keys() {
			if !fixed[plainName(name)] {
				result.Parameters[name] = dynvalue.Raw(parameters.Value(name))
			}
		}
	}
	return result, nil
}

// modelProblem — причина отказа модели словами пользователя: вход называется назначением
// («Последний кадр», «Срез речи»), длительность, разрешение и пропорции — значениями плана и
// модели; прочие причины — как есть.
func modelProblem(err error, inputs []providers.PaidInputItem) string {
	var input *providers.InputNotDeclaredError
	if errors.As(err, &input) {
		frames := 0
		role := ""
		for _, entry := range inputs {
			if entry.Role != roleSpeech {
				frames++
			}
			if entry.Slot == input.Name {
				role = entry.Role
			}
		}
		switch role {
		case "":
			return err.Error()
		case roleSpeech:
			return textModelNoSpeech
		default:
			return textModelNoFrame(role, frames)
		}
	}
	var duration *providers.DurationMismatchError
	if errors.As(err, &duration) {
		return textModelDuration(dynvalue.NumberToString(duration.Duration), joinSeconds(duration.Allowed))
	}
	var unsupported *providers.UnsupportedParameterError
	if errors.As(err, &unsupported) {
		value := strings.Trim(unsupported.Value, `"`)
		allowed := strings.Join(unsupported.Allowed, ", ")
		switch plainName(unsupported.Name) {
		case "duration":
			return textModelDuration(value, allowed)
		case "resolution":
			return textModelResolution(value, allowed)
		case "aspectratio":
			return textModelAspectRatio(value, allowed)
		}
	}
	return err.Error()
}

// joinSeconds — длительности модели через запятую: «5, 10».
func joinSeconds(values []float64) string {
	texts := make([]string, len(values))
	for index, value := range values {
		texts[index] = dynvalue.NumberToString(value)
	}
	return strings.Join(texts, ", ")
}

// enforcedNames — параметры, значения которых задаёт провайдер (mediaapi.Enforced).
func enforcedNames(rules mediaapi.RequestRules) []string {
	names := make([]string, len(rules.Enforced))
	for index, rule := range rules.Enforced {
		names[index] = rule.Name
	}
	return names
}

// typedValue — допустимое значение объявления как JSON-значение: "true" → true, "5" → 5, иначе
// строка. Так значение совпадает с тем, что пишется в запрос.
func typedValue(entry any) any {
	text := dynvalue.ToString(entry)
	var value any
	if err := json.Unmarshal([]byte(text), &value); err == nil {
		switch value.(type) {
		case bool, float64:
			return value
		}
	}
	return text
}

// plainName — имя параметра без подчёркиваний и регистра: snake_case и camelCase одного
// параметра совпадают (как providers.ArgumentName).
func plainName(name string) string { return strings.ToLower(strings.ReplaceAll(name, "_", "")) }

// fromJSON — значение изменения из JSON интерфейса в значение dynvalue запроса.
func fromJSON(value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	parsed, err := dynvalue.Parse(data)
	if err != nil {
		return nil
	}
	return parsed
}
