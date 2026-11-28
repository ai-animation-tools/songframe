package productionworkflow

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"slices"

	"songframe/internal/dynvalue"
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
// пакету (новому attempt-NN для описания, иначе выбранному пакету packageDir). Предложение
// (after записи) разбирается и сверяется с объявлениями моделей заново, входы — со снимком
// подготовки. Ошибка записи откатывает пакет к резерву, а предложение остаётся готовым; успех
// отмечает его applied (копии кандидатов опор при этом удаляются) и возвращает вид целевого пакета.
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

// replacesAskedText сообщает, что свой текст пользователя снимает открытый вопрос попытки
// (SaveOwn, ownReplacesQuestion): применение задаст вопрос заново о новом тексте.
func replacesAskedText(c *Context, proposal *dynvalue.Object) bool {
	stage, _ := proposal.Value("stage").(string)
	return proposal.Value("own") == true && ownReplacesQuestion(c, stage)
}

// ownReplacesQuestion сообщает, что свой текст этапа stage можно сохранить при открытом вопросе
// попытки c: вопрос о тексте того же этапа (промпт агента сверх предела) или, для видеопромпта,
// вопрос об отправке подготовленного, но не отправленного запроса. Утверждённый промпт меняется до
// отправки: применение сбрасывает request_dir, папка неотправленного запроса остаётся в попытке, а
// следующий запрос собирается по новому тексту.
func ownReplacesQuestion(c *Context, stage string) bool {
	pending := c.workflowValue("pending_decision")
	if dynvalue.Get(pending, "stage") == stage+"_review" {
		return true
	}
	if stage != "prompt" || dynvalue.Get(pending, "stage") != "request_choice" {
		return false
	}
	request := dynvalue.ToString(c.workflowValue("request_dir"))
	if request == "" {
		return false
	}
	status := dynvalue.Get(readJSONOrNil(filepath.Join(c.PackageDir, request, "attempt.json")), "status")
	return status == "prepared"
}

// checkApply — синхронная часть Apply до занятия плана: предложение готово, относится
// к выбранному пакету и не устарело, вопрос пакета решён, сценарий утверждён (для нового пакета),
// предложение проходит проверку, изображения и входы не изменились. Источник — after записи, а не
// задание агента: ответ задания разобран и проверен, когда предложение стало готовым, а кандидаты
// опор скопированы в проект. Поэтому применение не зависит от истории заданий и рабочих папок
// машины и работает в перенесённой папке проекта.
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
	if samePackage && dynvalue.Truthy(c.workflowValue("pending_decision")) && !replacesAskedFrame(c, stored.Proposal().Value("after")) &&
		!replacesAskedText(c, stored.Proposal()) {
		return nil, errors.New(textResolveQuestionFirst)
	}
	if !samePackage && !w.options.IsScenarioApproved(view.Project) {
		return nil, errors.New(textScenarioApprovalStale)
	}
	raw := dynvalue.Stringify(stored.Proposal().Value("after"))
	rules := stored.Rules()
	rules.Own = stored.Proposal().Value("own") == true
	after, err := ParseProposal(raw, rules)
	if err != nil {
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
		// Кандидат от провайдера изображений помечается его ID: принятая опора остаётся
		// сгенерированной, и учёт расхода (internal/spend) не выдаёт её за свой файл. propose снимает
		// отметку с любой опоры, поэтому импорт файла её не наследует.
		// Промпт, который исполнитель передал генератору (generator_prompt), сохраняется на опоре:
		// приёмка плана кладёт его в комплект. propose снимает и его.
		provider, _ := plan.stored.Tree.Value("imageProvider").(string)
		prompts, _ := plan.stored.Tree.Value("imagePrompts").(*dynvalue.Object)
		if (provider != "" || prompts != nil) && len(images) > 0 {
			for _, frame := range frames {
				object, isObject := frame.(*dynvalue.Object)
				if !isObject || !slices.ContainsFunc(images, func(image any) bool { return dynvalue.Get(image, "id") == object.Value("id") }) {
					continue
				}
				if provider != "" {
					object.Set("provider", provider)
				}
				if prompts == nil {
					continue
				}
				if prompt, ok := prompts.Value(dynvalue.ToString(object.Value("id"))).(string); ok {
					object.Set("generator_prompt", prompt)
				}
			}
			if err := writeProjectJSON(filepath.Join(target, "workflow.json"), proposed); err != nil {
				return err
			}
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
		// Метки картинок попытки по референсам должны называть её референсы — в обоих текстах.
		if plan.context.ReferencesMethod {
			for _, key := range []string{"prompt", "translation"} {
				if text, ok := plan.after.Value(key).(string); ok {
					if err := checkReferenceMarks(plan.context, text); err != nil {
						return err
					}
				}
			}
		}
		// Оригинал на языке провайдера и русский перевод — два файла попытки; отправляется выбранный
		// при утверждении (prompt.path). Перевод прежнего предложения к новому оригиналу не относится.
		if err := writeProjectFile(filepath.Join(target, promptOriginalFile), []byte(dynvalue.ToString(plan.after.Value("prompt")))); err != nil {
			return err
		}
		translation, translated := plan.after.Value("translation").(string)
		if translated {
			if err := writeProjectFile(filepath.Join(target, promptTranslationFile), []byte(translation)); err != nil {
				return err
			}
		} else if err := removePackageFile(filepath.Join(target, promptTranslationFile)); err != nil {
			return err
		}
		workflow, err := packageDocument(target, textWorkflowMissing)
		if err != nil {
			return err
		}
		workflow.Set("prompt", proposedPrompt(translated))
		workflow.Set("approved_prompt_sha256", nil)
		workflow.Set("request_dir", nil)
		if err := writeProjectJSON(filepath.Join(target, "workflow.json"), workflow); err != nil {
			return err
		}
		// У попытки по референсам утверждение референсов этап не двигает (опор, принятие которых
		// переводит description_review в keyframes_review, нет): переход к prompt_review идёт
		// через следующий этап, set-stage не пропускает этапов.
		if plan.context.ReferencesMethod && plan.context.workflowValue("stage") == "description_review" {
			if err := w.run(ctx, project, "shot_workflow", "set-stage", "--dir", target, "keyframes_review"); err != nil {
				return err
			}
		}
		if err := w.run(ctx, project, "shot_workflow", "set-stage", "--dir", target, "prompt_review"); err != nil {
			return err
		}
		return ask("prompt_review")
	}
	return errors.New(textStageUnavailable)
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
		// Повтор оплаченной попытки: утверждённые опоры прежней переносятся теми же файлами, и
		// plan-keyframes с проверкой ниже сохраняет неизменённые, как в той же попытке.
		if c.PackageDir != "" && c.Workflow != nil {
			fresh, err := packageDocument(target, textWorkflowNotCreated)
			if err != nil {
				return err
			}
			if err := carryApprovedFrames(c.PackageDir, target, c.Workflow, fresh, 0); err != nil {
				return err
			}
			if err := writeProjectJSON(filepath.Join(target, "workflow.json"), fresh); err != nil {
				return err
			}
		}
	}
	if plan.stored.Rules().References {
		return w.applyReferences(ctx, plan, target)
	}
	keyframes, _ := dynvalue.AsArray(after.Value("keyframes"))
	// Кадры других планов, которые опоры назвали референсами, — в пакет до остальных файлов: без
	// FFmpeg или принятого видео описание не применяется.
	if err := w.placeShotFrames(ctx, c.Project, target, keyframes); err != nil {
		return err
	}
	if err := writeProjectFile(filepath.Join(target, "description.md"), []byte(dynvalue.ToString(after.Value("description"))+"\n")); err != nil {
		return err
	}
	rules := plan.stored.Rules()
	requestSeconds := dynvalue.ToString(after.Value("requestSeconds"))
	if rules.Static {
		// Запроса видео у плана из опор нет: длительность попытки — окно плана целыми секундами.
		requestSeconds = dynvalue.ToString(math.Ceil(rules.WindowSeconds))
	}
	args := []string{"plan-keyframes", "--dir", target, "--request-seconds", requestSeconds}
	if rules.Static {
		args = append(args, "--static")
	} else if rules.Manual || len(keyframes) == 1 {
		args = append(args, "--single")
	}
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
	// Сброшенные опоры: копия (copyOf) сбрасывается вместе с источником, даже если сама не изменилась.
	reset := map[any]bool{}
	for _, item := range frames {
		frame, isObject := item.(*dynvalue.Object)
		if !isObject {
			return errors.New(textWorkflowFrameInvalid)
		}
		id := frame.Value("id")
		planned := findByID(keyframes, id)
		if !dynvalue.DeepStrictEqual(findByID(c.FramePrompts.Items, id), planned) || (isFrameCopy(planned) && reset[dynvalue.Get(planned, "copyOf")]) {
			reset[id] = true
			frame.Set("approved", false)
			frame.Set("path", nil)
			frame.Set("sha256", nil)
			frame.Delete("provider")
			frame.Delete("generator_prompt")
			approved.Delete(dynvalue.ToString(id))
		}
	}
	workflow.Set("approved_frames", approved)
	// Выбор пользователя сохраняется в попытке: доработка описания без нового выбора его соблюдает.
	if rules.Keyframes > 0 {
		workflow.Set("keyframe_count", float64(rules.Keyframes))
	} else {
		workflow.Delete("keyframe_count")
	}
	return w.finishDescription(ctx, plan, target, workflow)
}

// applyReferences — описание попытки по референсам: description.md, длительность запроса без
// опор (plan-keyframes --no-frames), пустой план опор и копии предложенных картинок в references/
// с ролями (кадр принятого плана сначала извлекается в continuity/). Способ записывается в
// попытку: дальше он не меняется.
func (w *Workflow) applyReferences(ctx context.Context, plan *applyPlan, target string) error {
	c, after := plan.context, plan.after
	proposed, _ := dynvalue.AsArray(after.Value("references"))
	if err := w.placeShotFrames(ctx, c.Project, target, referenceShotFrames(proposed)); err != nil {
		return err
	}
	if err := writeProjectFile(filepath.Join(target, "description.md"), []byte(dynvalue.ToString(after.Value("description"))+"\n")); err != nil {
		return err
	}
	if err := w.run(ctx, c.Project, "shot_workflow", "plan-keyframes", "--dir", target, "--request-seconds", dynvalue.ToString(after.Value("requestSeconds")), "--no-frames"); err != nil {
		return err
	}
	if err := writeProjectJSON(filepath.Join(target, "keyframe-prompts.json"), &dynvalue.Array{Items: []any{}}); err != nil {
		return err
	}
	workflow, err := packageDocument(target, textWorkflowNotCreated)
	if err != nil {
		return err
	}
	previous := []any{}
	if target == c.PackageDir {
		previous = referenceItems(c.Workflow)
	}
	references, err := referencesTree(c.Project, target, proposed, previous)
	if err != nil {
		return err
	}
	workflow.Set("generation_method", methodReferences)
	workflow.Set("references", references)
	workflow.Delete("keyframe_count")
	return w.finishDescription(ctx, plan, target, workflow)
}

// finishDescription — общий конец применения описания: выбор героев с образами, сброс
// утверждений описания, промпта и запроса, отпечаток постановки и этап description_review.
func (w *Workflow) finishDescription(ctx context.Context, plan *applyPlan, target string, workflow *dynvalue.Object) error {
	c, rules := plan.context, plan.stored.Rules()
	// Выбор героев с образами — тоже в попытке: по нему видеопромпт получает тех же героев.
	if rules.Looks != nil {
		workflow.Set("saved_looks", stringsArray(rules.Looks))
	} else {
		workflow.Delete("saved_looks")
	}
	workflow.Set("description_approved", false)
	// Новое описание построено по текущей постановке: пакет снова соответствует сценарию.
	if current := production.CurrentShotFingerprint(c.Project, plan.shot); current != "" {
		workflow.Set("scene_sha256", current)
	}
	workflow.Set("prompt", unapprovedPrompt(workflow.Value("prompt")))
	workflow.Set("request_dir", nil)
	workflow.Set("approved_prompt_sha256", nil)
	if err := writeProjectJSON(filepath.Join(target, "workflow.json"), workflow); err != nil {
		return err
	}
	return w.run(ctx, c.Project, "shot_workflow", "set-stage", "--dir", target, "description_review")
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

// Файлы видеопромпта попытки: оригинал на языке провайдера (его пишет и «Написать самому») и
// русский перевод из предложения агента. Запись prompt в workflow.json называет их ключами
// original и translation, а path — тот, что выбран для отправки.
const (
	promptOriginalFile    = "video-prompt.txt"
	promptTranslationFile = "video-prompt.ru.txt"
)

// proposedPrompt — запись только что применённого видеопромпта: на согласовании, к отправке
// выбран оригинал; translation — только при записанном переводе.
func proposedPrompt(translated bool) *dynvalue.Object {
	prompt := dynvalue.NewObject()
	prompt.Set("path", promptOriginalFile)
	prompt.Set("approved", false)
	prompt.Set("original", promptOriginalFile)
	if translated {
		prompt.Set("translation", promptTranslationFile)
	}
	return prompt
}

// unapprovedPrompt — запись видеопромпта, снова требующего согласования (новое описание, повтор
// попытки): к отправке выбирается оригинал, ключи вариантов previous сохраняются. Без вариантов —
// { path: 'video-prompt.txt', approved: false }.
func unapprovedPrompt(previous any) *dynvalue.Object {
	prompt := dynvalue.NewObject()
	original, hasOriginal := dynvalue.Get(previous, "original").(string)
	if !hasOriginal || original == "" {
		prompt.Set("path", promptOriginalFile)
		prompt.Set("approved", false)
		return prompt
	}
	prompt.Set("path", original)
	prompt.Set("approved", false)
	prompt.Set("original", original)
	if translation, ok := dynvalue.Get(previous, "translation").(string); ok && translation != "" {
		prompt.Set("translation", translation)
	}
	return prompt
}

// promptVariantFiles — файлы вариантов видеопромпта записи prompt: оригинал и перевод, если они
// названы; без ключа original — только path (запись без вариантов).
func promptVariantFiles(prompt any) []string {
	files := []string{}
	for _, field := range []string{"original", "translation"} {
		if name, ok := dynvalue.Get(prompt, field).(string); ok && name != "" {
			files = append(files, name)
		}
	}
	if len(files) == 0 {
		if path, ok := dynvalue.Get(prompt, "path").(string); ok && path != "" {
			files = append(files, path)
		}
	}
	return files
}

// removePackageFile — удаление файла пакета; отсутствующий файл — не ошибка.
func removePackageFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
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
