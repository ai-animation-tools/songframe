package productionworkflow

import (
	"context"
	"errors"
	"path/filepath"
	"regexp"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/production"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/providers"
)

// Применение готового предложения к пакету (apply класса ProductionWorkflow оригинала). Проверки
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
	after   *jscompat.Object
	context *Context
	shot    string
}

// Apply — apply оригинала: применить готовое актуальное предложение id плана shot к его целевому
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
	frame := jscompat.Get(c.workflowValue("pending_decision"), "frame")
	images, _ := jscompat.AsArray(jscompat.Get(after, "images"))
	return jscompat.Get(after, "stage") == "frames" && jscompat.Truthy(frame) && len(images) == 1 && jscompat.Get(images[0], "id") == frame
}

// checkApply — синхронная часть apply оригинала до занятия плана: предложение готово, относится
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
	proposal, _ := jscompat.Parse(view.Proposal)
	if view.Busy || stored == nil || stored.ID() != id || stored.PackageDir() != viewPackage || stored.Status() != "ready" ||
		jscompat.Get(proposal, "stale") == true || !jscompat.Truthy(stored.Proposal().Value("after")) {
		return nil, errors.New(TextApplyUnavailable)
	}
	c, err := ReadContext(view.Project, shot, viewPackage)
	if err != nil {
		return nil, err
	}
	samePackage := stored.Target() == c.PackageDir
	if samePackage && jscompat.Truthy(c.workflowValue("pending_decision")) && !replacesAskedFrame(c, stored.Proposal().Value("after")) {
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
	raw := jscompat.Stringify(stored.Proposal().Value("after"))
	if job != nil {
		raw = job.Result
		if stored.ImageJob() {
			images, err := w.collectImages(*job)
			if err != nil {
				return nil, err
			}
			document := jscompat.NewObject()
			document.Set("schemaVersion", float64(1))
			document.Set("stage", "frames")
			document.Set("images", candidatesTree(images))
			raw = jscompat.Stringify(document)
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
		if text = jscompat.Trim(text); text == "" {
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
		images, _ := jscompat.AsArray(plan.after.Value("images"))
		for _, image := range images {
			if err := w.run(ctx, project, "shot_workflow", "propose", "--dir", target, jscompat.ToString(jscompat.Get(image, "id")),
				jscompat.ToString(jscompat.Get(image, "path"))); err != nil {
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
		if jscompat.IsRecord(proposed) {
			frames, _ = jscompat.AsArray(jscompat.Get(proposed, "keyframes"))
		}
		for _, frame := range frames {
			if jscompat.Truthy(jscompat.Get(frame, "path")) && !jscompat.Truthy(jscompat.Get(frame, "approved")) {
				return ask("keyframes_review", "--frame", jscompat.ToString(jscompat.Get(frame, "id")))
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
		if err := writeProjectFile(filepath.Join(target, "video-prompt.txt"), []byte(jscompat.ToString(plan.after.Value("prompt")))); err != nil {
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
	if err := writeProjectFile(filepath.Join(target, "description.md"), []byte(jscompat.ToString(after.Value("description"))+"\n")); err != nil {
		return err
	}
	keyframes, _ := jscompat.AsArray(after.Value("keyframes"))
	args := []string{"plan-keyframes", "--dir", target, "--request-seconds", jscompat.ToString(after.Value("requestSeconds"))}
	for _, frame := range keyframes {
		if jscompat.Get(frame, "role") == "middle" {
			// Подпись опоры входит в данные аргумента --middle штатного инструмента.
			args = append(args, "--middle", jscompat.ToString(jscompat.Get(frame, "timeSeconds"))+":опора "+jscompat.ToString(jscompat.Get(frame, "id")))
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
	frames, _ := jscompat.AsArray(workflow.Value("keyframes"))
	approved, ok := workflow.Value("approved_frames").(*jscompat.Object)
	if !ok || !jscompat.IsRecord(approved) {
		approved = jscompat.NewObject()
	}
	for _, item := range frames {
		frame, isObject := item.(*jscompat.Object)
		if !isObject {
			return errors.New(textWorkflowFrameInvalid)
		}
		id := frame.Value("id")
		if !jscompat.DeepStrictEqual(findByID(c.FramePrompts.Items, id), findByID(keyframes, id)) {
			frame.Set("approved", false)
			frame.Set("path", nil)
			frame.Set("sha256", nil)
			approved.Delete(jscompat.ToString(id))
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
// request-NN платным адаптером видео проекта (замороженный запрос без отправки). Возвращает имя
// папки запроса.
//
// Отличие от оригинала: спецификация запроса <id>-request.json в каталоге состояния больше не
// пишется. Оригинал записывал её всегда, хотя в приложении она нужна была только тестовой ветке
// без prepareVideoRequest, и не удалял: файлы копились в production-workflow/ при каждом запросе.
// Go-версия готовит запрос только адаптером провайдера (Options.VideoMedia), как приложение
// оригинала.
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
	request := plan.after.Value("request").(*jscompat.Object)
	inputs, _ := jscompat.AsArray(request.Value("inputs"))
	lipSync := jscompat.Truthy(c.Scene.Value("lipsync"))
	if lipSync {
		// Звуковой вход — именно подготовленный WAV пакета: отдельным флагом audio или именованным
		// слотом audio_N.
		speechInput := false
		for _, input := range inputs {
			flag, slot := jscompat.Get(input, "flag"), jscompat.Get(input, "slot")
			slotText, _ := slot.(string)
			if (flag == "audio" || (flag == "input" && audioSlot.MatchString(slotText))) && c.Speech != nil && jscompat.Get(input, "path") == c.Speech.Path {
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
		if duration := jscompat.ToNumber(jscompat.Get(request.Value("parameters"), "duration")); duration < length-1e-6 {
			return "", errors.New(textRequestShorterThanSpeech(jscompat.ToFixed(length, 2)))
		}
	}
	number := 1
	for jscompat.Exists(filepath.Join(target, "request-"+twoDigits(number))) {
		number++
	}
	requestName := "request-" + twoDigits(number)
	promptPath, _ := jscompat.Get(c.workflowValue("prompt"), "path").(string)
	text, err := readText(filepath.Join(target, promptPath))
	if err != nil {
		return "", err
	}
	if err := w.prepareVideo(ctx, plan, filepath.Join(target, requestName), text, request, inputs); err != nil {
		return "", err
	}
	return requestName, nil
}

// prepareVideo — prepareVideoRequest приложения оригинала (ipc.ts): доступ к провайдеру видео,
// его платный адаптер, свежие объявления моделей и локальная подготовка запроса по черновику
// агента с ограничениями проекта (предпочтительная модель, разрешение, соотношение сторон,
// options) и правилом длительности окна плана.
func (w *Workflow) prepareVideo(ctx context.Context, plan *applyPlan, requestDir, prompt string, draft *jscompat.Object, inputs []any) error {
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
		flag, _ := jscompat.Get(input, "flag").(string)
		slot, _ := jscompat.Get(input, "slot").(string)
		path, _ := jscompat.Get(input, "path").(string)
		role, _ := jscompat.Get(input, "role").(string)
		items = append(items, providers.PaidInputItem{Flag: flag, Slot: slot, Path: path, Role: role})
	}
	// settings.model?.trim() || null: пустая строка означает «предпочтения нет».
	preferred := ""
	if model, isString := settings.Value("model").(string); isString {
		preferred = jscompat.Trim(model)
	}
	constraint := &providers.DurationConstraint{WindowSeconds: c.Window, Rule: jscompat.ToString(c.DurationRule)}
	if limits := plan.stored.Rules().LipSync; limits != nil {
		minimum := limits.Min
		constraint.MinSeconds = &minimum
	}
	required := jscompat.NewObject()
	required.Set("resolution", settings.Value("resolution"))
	required.Set("aspect_ratio", settings.Value("aspect_ratio"))
	options, _ := settings.Value("options").(*jscompat.Object)
	parameters, _ := draft.Value("parameters").(*jscompat.Object)
	command, _ := draft.Value("command").(string)
	model, _ := draft.Value("model").(string)
	caps := media.Capabilities(ctx, c.Project)
	_, err = media.Prepare(ctx, providers.PaidInput{
		Project: c.Project, WorkDir: requestDir, Shot: plan.shot, Kind: mediaproviders.Video, Command: command, Model: model,
		PreferredModel: &preferred, DurationConstraint: constraint, RequiredParameters: required, ProjectOptions: options,
		Prompt: prompt, Parameters: parameters, Inputs: items, Outputs: int(jscompat.ToNumber(draft.Value("outputs"))),
	}, caps)
	return err
}

// findByID — find(item => item.id === id) по массиву документа; Undefined — не найдено.
func findByID(items []any, id any) any {
	for _, item := range items {
		if jscompat.StrictEqual(jscompat.Get(item, "id"), id) {
			return item
		}
	}
	return jscompat.Undefined
}

// promptRecord — { path: 'video-prompt.txt', approved: false }: промпт требует согласования.
func promptRecord() *jscompat.Object {
	prompt := jscompat.NewObject()
	prompt.Set("path", "video-prompt.txt")
	prompt.Set("approved", false)
	return prompt
}

// packageDocument — workflow.json пакета объектом; отсутствующий или не объект — ошибка missing.
func packageDocument(target, missing string) (*jscompat.Object, error) {
	value, err := readJSON(filepath.Join(target, "workflow.json"))
	if err != nil {
		return nil, err
	}
	workflow, ok := value.(*jscompat.Object)
	if !ok {
		return nil, errors.New(missing)
	}
	return workflow, nil
}

// writeProjectFile — запись файла пакета атомарной заменой с правами по умолчанию Node
// (0666 с учётом umask), как writeFileSync оригинала. Родительские папки создаются.
func writeProjectFile(path string, data []byte) error {
	return projectfs.WriteFile(path, data, 0o666)
}

// writeProjectJSON — writeProductionJson оригинала для файла проекта:
// `JSON.stringify(value, null, 2) + '\n'` атомарной заменой.
func writeProjectJSON(path string, value any) error {
	return writeProjectFile(path, []byte(jscompat.StringifyIndent(value, "  ")+"\n"))
}
