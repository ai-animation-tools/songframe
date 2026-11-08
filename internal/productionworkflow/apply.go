package productionworkflow

import (
	"context"
	"errors"
	"path/filepath"
	"regexp"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
	"songframe/internal/production"
	"songframe/internal/projectfs"
	"songframe/internal/providers"
)

// Применение готового предложения к пакету. Проверки
// идут под мьютексом Workflow и заканчиваются отметкой busy плана; сами записи (инструменты
// shot_workflow, файлы пакета, подготовка запроса провайдером) выполняются без мьютекса под
// журналом замены пакета (journal.go), а запись applied — снова под ним.

// VideoMedia — платный адаптер видео провайдера проекта (providers.Layer.PaidMedia для вида
// video); false — провайдер не платный или не поддерживает видео.
type VideoMedia func(provider string) (*providers.PaidMedia, bool)

// applyPlan — проверенное применение: запись предложения, заново разобранный ответ и контекст
// плана на момент проверки.
type applyPlan struct {
	stored  *Stored
	after   *dynvalue.Object
	context *Context
	shot    string
}

// Apply применяет готовое актуальное предложение id плана shot к его целевому
// пакету (новому attempt-NN для описания, иначе выбранному пакету packageDir). Ответ агента
// разбирается и сверяется с объявлениями моделей заново, входы — со снимком подготовки. Ошибка
// записи откатывает пакет к резерву, а предложение остаётся готовым; успех отмечает его applied и
// возвращает вид целевого пакета.
func (w *Workflow) Apply(ctx context.Context, project, shot, packageDir, id string) (View, error) {
	w.mu.Lock()
	plan, err := w.checkApply(project, shot, packageDir, id)
	if err != nil {
		w.mu.Unlock()
		return View{}, err
	}
	planKey := key(plan.context.Project, shot)
	w.busy[planKey] = true
	w.mu.Unlock()
	err = applyPackage(w.options.LocalDir, plan.context.Project, plan.stored.Target(), func() error { return w.applyStage(ctx, plan) })
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.busy, planKey)
	if err != nil {
		return View{}, err
	}
	proposal := plan.stored.Proposal()
	proposal.Set("status", "applied")
	proposal.Set("after", plan.after)
	if err := w.store.Write(plan.context.Project, shot, plan.stored); err != nil {
		return View{}, err
	}
	return w.view(plan.context.Project, shot, plan.stored.Target())
}

// replacesAskedFrame сообщает, что предложение заменяет кандидата той опоры, о которой открыт
// вопрос: тогда вопрос не мешает применению, применение задаст его заново о новом файле.
func replacesAskedFrame(c *Context, after any) bool {
	frame := dynvalue.Get(c.workflowValue("pending_decision"), "frame")
	images, _ := dynvalue.AsArray(dynvalue.Get(after, "images"))
	return dynvalue.Get(after, "stage") == "frames" && dynvalue.Truthy(frame) && len(images) == 1 && dynvalue.Get(images[0], "id") == frame
}

// checkApply — синхронная часть Apply до занятия плана: предложение готово, относится
// к выбранному пакету и не устарело, вопрос пакета решён, сценарий утверждён (для нового пакета),
// задание агента успешно, ответ проходит проверку, изображения и входы не изменились.
func (w *Workflow) checkApply(project, shot, packageDir, id string) (*applyPlan, error) {
	view, err := w.view(project, shot, packageDir)
	if err != nil {
		return nil, err
	}
	stored := w.store.Read(view.Project, shot)
	viewPackage := ""
	if view.PackageDir != nil {
		viewPackage = *view.PackageDir
	}
	proposal, _ := dynvalue.Parse(view.Proposal)
	if view.Busy || stored == nil || stored.ID() != id || stored.PackageDir() != viewPackage || stored.Status() != "ready" ||
		dynvalue.Get(proposal, "stale") == true || !dynvalue.Truthy(stored.Proposal().Value("after")) {
		return nil, errors.New(TextApplyUnavailable)
	}
	c, err := ReadContext(view.Project, shot, viewPackage)
	if err != nil {
		return nil, err
	}
	samePackage := stored.Target() == c.PackageDir
	if samePackage && dynvalue.Truthy(c.workflowValue("pending_decision")) && !replacesAskedFrame(c, stored.Proposal().Value("after")) {
		return nil, errors.New(textResolveQuestionFirst)
	}
	if !samePackage && !w.options.IsScenarioApproved(view.Project) {
		return nil, errors.New(textScenarioApprovalStale)
	}
	var job *agents.Job
	if jobID := stored.JobID(); jobID != "" {
		found, ok := w.options.Agents.Get(jobID)
		if !ok || found.Status != "completed" || found.ExitCode == nil || *found.ExitCode != 0 {
			return nil, errors.New(textAgentResultMissing)
		}
		job = &found
	}
	raw := dynvalue.Stringify(stored.Proposal().Value("after"))
	if job != nil {
		raw = job.Result
		if stored.ImageJob() {
			images, err := w.collectImages(*job)
			if err != nil {
				return nil, err
			}
			document := dynvalue.NewObject()
			document.Set("schemaVersion", float64(1))
			document.Set("stage", "frames")
			document.Set("images", candidatesTree(images))
			raw = dynvalue.Stringify(document)
		}
	}
	rules := stored.Rules()
	after, err := ParseProposal(raw, rules)
	if err != nil {
		return nil, err
	}
	if err := CheckCapabilities(after, rules, stored.Capabilities(), c.Settings); err != nil {
		return nil, err
	}
	if imagesChanged(stored) {
		return nil, errors.New(textProposalImagesChanged)
	}
	same, err := SameSnapshot(view.Project, stored)
	if err != nil {
		return nil, err
	}
	if !same {
		return nil, errors.New(textProposalStale)
	}
	return &applyPlan{stored: stored, after: after, context: c, shot: shot}, nil
}

// run — запуск инструмента комплекса: ненулевой код — ошибка с его stderr/stdout.
func (w *Workflow) run(ctx context.Context, project, tool string, args ...string) error {
	result, err := w.options.Run(ctx, project, tool, args)
	if err != nil {
		return err
	}
	if result.Code == nil || *result.Code != 0 {
		text := result.Stderr
		if text == "" {
			text = result.Stdout
		}
		if text = dynvalue.Trim(text); text == "" {
			text = textToolExitCode(tool, result.Code)
		}
		return errors.New(text)
	}
	return nil
}

// applyStage — колбэк журнала: записи этапа предложения в целевой пакет.
func (w *Workflow) applyStage(ctx context.Context, plan *applyPlan) error {
	project, target := plan.context.Project, plan.stored.Target()
	ask := func(stage string, extra ...string) error {
		return w.run(ctx, project, "shot_workflow", append([]string{"ask", "--dir", target, "--stage", stage}, extra...)...)
	}
	switch plan.after.Value("stage") {
	case "description":
		if err := w.applyDescription(ctx, plan); err != nil {
			return err
		}
		return ask("description_review")
	case "frames":
		images, _ := dynvalue.AsArray(plan.after.Value("images"))
		for _, image := range images {
			if err := w.run(ctx, project, "shot_workflow", "propose", "--dir", target, dynvalue.ToString(dynvalue.Get(image, "id")),
				dynvalue.ToString(dynvalue.Get(image, "path"))); err != nil {
				return err
			}
		}
		// Вопрос задаётся о первом в плане неутверждённом кандидате; остальные получат свой после
		// решения по нему.
		proposed, err := readJSON(filepath.Join(target, "workflow.json"))
		if err != nil {
			return err
		}
		var frames []any
		if dynvalue.IsRecord(proposed) {
			frames, _ = dynvalue.AsArray(dynvalue.Get(proposed, "keyframes"))
		}
		for _, frame := range frames {
			if dynvalue.Truthy(dynvalue.Get(frame, "path")) && !dynvalue.Truthy(dynvalue.Get(frame, "approved")) {
				return ask("keyframes_review", "--frame", dynvalue.ToString(dynvalue.Get(frame, "id")))
			}
		}
		return nil
	case "prompt":
		approved, err := plan.context.FramesApproved()
		if err != nil {
			return err
		}
		if !approved {
			return errors.New(textAcceptedFramesChanged)
		}
		if err := writeProjectFile(filepath.Join(target, "video-prompt.txt"), []byte(dynvalue.ToString(plan.after.Value("prompt")))); err != nil {
			return err
		}
		workflow, err := packageDocument(target, textWorkflowMissing)
		if err != nil {
			return err
		}
		workflow.Set("prompt", promptRecord())
		workflow.Set("approved_prompt_sha256", nil)
		workflow.Set("request_dir", nil)
		if err := writeProjectJSON(filepath.Join(target, "workflow.json"), workflow); err != nil {
			return err
		}
		if err := w.run(ctx, project, "shot_workflow", "set-stage", "--dir", target, "prompt_review"); err != nil {
			return err
		}
		return ask("prompt_review")
	}
	requestName, err := w.applyRequest(ctx, plan)
	if err != nil {
		return err
	}
	if err := w.run(ctx, project, "shot_workflow", "set-stage", "--dir", target, "request_choice", "--request-dir", requestName); err != nil {
		return err
	}
	return ask("request_choice")
}

// applyDescription — этап описания: новый пакет (init, при доработке оплаченного — с retry_of),
// description.md, план опор (plan-keyframes и keyframe-prompts.json) и сброс утверждений. Опора с
// теми же ролью, временем, текстом и референсами (порядок ключей не важен) сохраняет принятый
// кадр; изменённая требует нового. Исправленное описание требует нового согласования промпта и
// запроса; прежние request-NN сохраняются.
func (w *Workflow) applyDescription(ctx context.Context, plan *applyPlan) error {
	c, after, target := plan.context, plan.after, plan.stored.Target()
	if target != c.PackageDir {
		args := []string{"init", plan.shot, "--dir", target, "--mode", "shot"}
		if c.PackageDir != "" {
			args = append(args, "--retry-of", c.PackageDir)
		}
		if err := w.run(ctx, c.Project, "shot_workflow", args...); err != nil {
			return err
		}
	}
	if err := writeProjectFile(filepath.Join(target, "description.md"), []byte(dynvalue.ToString(after.Value("description"))+"\n")); err != nil {
		return err
	}
	keyframes, _ := dynvalue.AsArray(after.Value("keyframes"))
	args := []string{"plan-keyframes", "--dir", target, "--request-seconds", dynvalue.ToString(after.Value("requestSeconds"))}
	for _, frame := range keyframes {
		if dynvalue.Get(frame, "role") == "middle" {
			// Подпись опоры входит в данные аргумента --middle штатного инструмента.
			args = append(args, "--middle", dynvalue.ToString(dynvalue.Get(frame, "timeSeconds"))+":опора "+dynvalue.ToString(dynvalue.Get(frame, "id")))
		}
	}
	if err := w.run(ctx, c.Project, "shot_workflow", args...); err != nil {
		return err
	}
	if err := writeProjectJSON(filepath.Join(target, "keyframe-prompts.json"), after.Value("keyframes")); err != nil {
		return err
	}
	workflow, err := packageDocument(target, textWorkflowNotCreated)
	if err != nil {
		return err
	}
	frames, _ := dynvalue.AsArray(workflow.Value("keyframes"))
	approved, ok := workflow.Value("approved_frames").(*dynvalue.Object)
	if !ok || !dynvalue.IsRecord(approved) {
		approved = dynvalue.NewObject()
	}
	for _, item := range frames {
		frame, isObject := item.(*dynvalue.Object)
		if !isObject {
			return errors.New(textWorkflowFrameInvalid)
		}
		id := frame.Value("id")
		if !dynvalue.DeepStrictEqual(findByID(c.FramePrompts.Items, id), findByID(keyframes, id)) {
			frame.Set("approved", false)
			frame.Set("path", nil)
			frame.Set("sha256", nil)
			approved.Delete(dynvalue.ToString(id))
		}
	}
	workflow.Set("approved_frames", approved)
	workflow.Set("description_approved", false)
	// Новое описание построено по текущей постановке: пакет снова соответствует сценарию.
	if current := production.CurrentShotFingerprint(c.Project, plan.shot); current != "" {
		workflow.Set("scene_sha256", current)
	}
	workflow.Set("prompt", promptRecord())
	workflow.Set("request_dir", nil)
	workflow.Set("approved_prompt_sha256", nil)
	if err := writeProjectJSON(filepath.Join(target, "workflow.json"), workflow); err != nil {
		return err
	}
	return w.run(ctx, c.Project, "shot_workflow", "set-stage", "--dir", target, "description_review")
}

// audioSlot — именованный слот звукового входа модели (audio_N).
var audioSlot = regexp.MustCompile(`(?i)^audio`)

// applyRequest — этап запроса: проверка утверждений и речевого входа, затем подготовка нового
// request-NN платным адаптером видео проекта (неизменяемый request.json без отправки). Возвращает
// имя папки запроса. Запрос готовит только адаптер провайдера (Options.VideoMedia); отдельная
// спецификация запроса в каталоге состояния не пишется, чтобы там не копились файлы.
func (w *Workflow) applyRequest(ctx context.Context, plan *applyPlan) (string, error) {
	c, target := plan.context, plan.stored.Target()
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
	request := plan.after.Value("request").(*dynvalue.Object)
	inputs, _ := dynvalue.AsArray(request.Value("inputs"))
	lipSync := dynvalue.Truthy(c.Scene.Value("lipsync"))
	if lipSync {
		// Звуковой вход — именно подготовленный WAV пакета: отдельным флагом audio или именованным
		// слотом audio_N.
		speechInput := false
		for _, input := range inputs {
			flag, slot := dynvalue.Get(input, "flag"), dynvalue.Get(input, "slot")
			slotText, _ := slot.(string)
			if (flag == "audio" || (flag == "input" && audioSlot.MatchString(slotText))) && c.Speech != nil && dynvalue.Get(input, "path") == c.Speech.Path {
				speechInput = true
				break
			}
		}
		if !speechInput {
			return "", errors.New(textSpeechInputRequired)
		}
		// Видео короче среза оборвало бы речь: длительность запроса покрывает весь WAV.
		length := 0.0
		if c.Speech != nil {
			length = c.Speech.length()
		}
		if duration := dynvalue.ToNumber(dynvalue.Get(request.Value("parameters"), "duration")); duration < length-1e-6 {
			return "", errors.New(textRequestShorterThanSpeech(dynvalue.ToFixed(length, 2)))
		}
	}
	number := 1
	for dynvalue.Exists(filepath.Join(target, "request-"+twoDigits(number))) {
		number++
	}
	requestName := "request-" + twoDigits(number)
	promptPath, _ := dynvalue.Get(c.workflowValue("prompt"), "path").(string)
	text, err := readText(filepath.Join(target, promptPath))
	if err != nil {
		return "", err
	}
	if err := w.prepareVideo(ctx, plan, filepath.Join(target, requestName), text, request, inputs); err != nil {
		return "", err
	}
	return requestName, nil
}

// prepareVideo — подготовка видеозапроса: доступ к провайдеру видео,
// его платный адаптер, свежие объявления моделей и локальная подготовка запроса по черновику
// агента с ограничениями проекта (предпочтительная модель, разрешение, соотношение сторон,
// options) и правилом длительности окна плана.
func (w *Workflow) prepareVideo(ctx context.Context, plan *applyPlan, requestDir, prompt string, draft *dynvalue.Object, inputs []any) error {
	c := plan.context
	if w.options.RequireVideoAccess != nil {
		if err := w.options.RequireVideoAccess(ctx, c.Project); err != nil {
			return err
		}
	}
	settings, err := videoSettings(c.Project)
	if err != nil {
		return err
	}
	provider, _ := settings.Value("provider").(string)
	var media *providers.PaidMedia
	if mediaproviders.Supports(provider, mediaproviders.Video) && w.options.VideoMedia != nil {
		media, _ = w.options.VideoMedia(provider)
	}
	if media == nil {
		return errors.New(textChooseVideoProvider())
	}
	items := make([]providers.PaidInputItem, 0, len(inputs))
	for _, input := range inputs {
		flag, _ := dynvalue.Get(input, "flag").(string)
		slot, _ := dynvalue.Get(input, "slot").(string)
		path, _ := dynvalue.Get(input, "path").(string)
		role, _ := dynvalue.Get(input, "role").(string)
		items = append(items, providers.PaidInputItem{Flag: flag, Slot: slot, Path: path, Role: role})
	}
	// Модель из настроек без краевых пробелов; пустая строка или нет поля — «предпочтения нет».
	preferred := ""
	if model, isString := settings.Value("model").(string); isString {
		preferred = dynvalue.Trim(model)
	}
	constraint := &providers.DurationConstraint{WindowSeconds: c.Window, Rule: dynvalue.ToString(c.DurationRule)}
	if limits := plan.stored.Rules().LipSync; limits != nil {
		minimum := limits.Min
		constraint.MinSeconds = &minimum
	}
	required := dynvalue.NewObject()
	required.Set("resolution", settings.Value("resolution"))
	required.Set("aspect_ratio", settings.Value("aspect_ratio"))
	options, _ := settings.Value("options").(*dynvalue.Object)
	parameters, _ := draft.Value("parameters").(*dynvalue.Object)
	command, _ := draft.Value("command").(string)
	model, _ := draft.Value("model").(string)
	caps := media.Capabilities(ctx, c.Project)
	_, err = media.Prepare(ctx, providers.PaidInput{
		Project: c.Project, WorkDir: requestDir, Shot: plan.shot, Kind: mediaproviders.Video, Command: command, Model: model,
		PreferredModel: &preferred, DurationConstraint: constraint, RequiredParameters: required, ProjectOptions: options,
		Prompt: prompt, Parameters: parameters, Inputs: items, Outputs: int(dynvalue.ToNumber(draft.Value("outputs"))),
	}, caps)
	return err
}

// findByID — первый элемент массива документа, чей id строго равен id; Undefined — не найдено.
func findByID(items []any, id any) any {
	for _, item := range items {
		if dynvalue.StrictEqual(dynvalue.Get(item, "id"), id) {
			return item
		}
	}
	return dynvalue.Undefined
}

// promptRecord — { path: 'video-prompt.txt', approved: false }: промпт требует согласования.
func promptRecord() *dynvalue.Object {
	prompt := dynvalue.NewObject()
	prompt.Set("path", "video-prompt.txt")
	prompt.Set("approved", false)
	return prompt
}

// packageDocument — workflow.json пакета объектом; отсутствующий или не объект — ошибка missing.
func packageDocument(target, missing string) (*dynvalue.Object, error) {
	value, err := readJSON(filepath.Join(target, "workflow.json"))
	if err != nil {
		return nil, err
	}
	workflow, ok := value.(*dynvalue.Object)
	if !ok {
		return nil, errors.New(missing)
	}
	return workflow, nil
}

// writeProjectFile — запись файла пакета атомарной заменой с правами 0666 с учётом umask, как у
// обычного создания файла. Родительские папки создаются.
func writeProjectFile(path string, data []byte) error {
	return projectfs.WriteFile(path, data, 0o666)
}

// writeProjectJSON — запись JSON файла проекта атомарной заменой: отступ в два пробела и
// завершающий перевод строки, порядок ключей документа сохраняется (dynvalue).
func writeProjectJSON(path string, value any) error {
	return writeProjectFile(path, []byte(dynvalue.StringifyIndent(value, "  ")+"\n"))
}
