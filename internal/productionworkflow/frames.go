package productionworkflow

import (
	"context"
	"errors"
	"slices"
	"strings"

	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
)

// framesPlan — проверенный запуск следующей опоры: контекст плана, описание опоры из плана
// пакета, замечания к ней и провайдер изображений проекта.
type framesPlan struct {
	context *Context
	prompt  any
	notes   []string
	info    mediaproviders.Info
	hashes  *dynvalue.Object
}

// ensureFramesAvailable — общие проверки GenerateFrames и ImportFrames: план не
// производный, вид плана разрешает создание опор (пакет с принятым описанием или возвратом опор
// на доработку, есть неутверждённая опора, нет занятости, вопроса и оплаты) и нет непринятого
// предложения этого плана. Вид плана при этом обновляет запись завершённого задания.
func (w *Workflow) ensureFramesAvailable(project, shot, packageDir string) (*Context, error) {
	c, err := ReadContext(project, shot, packageDir)
	if err != nil {
		return nil, err
	}
	if c.DerivedFrom != "" {
		return nil, errors.New(derivedshot.Reason(c.DerivedFrom))
	}
	view, err := w.view(c.Project, shot, packageDir)
	if err != nil {
		return nil, err
	}
	// Готовое предложение называем прямо: CanGenerateFrames учитывает его сам, и общий
	// отказ скрыл бы настоящую причину.
	if !view.Busy && w.store.Read(c.Project, shot).active() {
		return nil, errors.New(textResolveProposalFirstError)
	}
	if !view.CanGenerateFrames {
		return nil, errors.New(TextDescriptionAndFramePlanRequired)
	}
	return c, nil
}

// framesForImport — контекст импорта: обычные условия опор либо замена кандидата той опоры, о
// которой открыт вопрос. Замена не требует замечания: Apply задаст вопрос о новом файле.
func (w *Workflow) framesForImport(project, shot, packageDir string, images []FrameCandidate) (*Context, error) {
	view, err := w.view(project, shot, packageDir)
	if err != nil {
		return nil, err
	}
	if view.ReplaceFrame != nil && len(images) == 1 && images[0].ID == *view.ReplaceFrame {
		return ReadContext(view.Project, shot, packageDir)
	}
	return w.ensureFramesAvailable(project, shot, packageDir)
}

// planFrames — синхронная часть GenerateFrames до запуска генерации: проверки, снимок
// входов, следующая опора по плану и провайдер изображений проекта. Снимок обходит выбранный
// пакет контекста (реальный путь), а не строку packageDir от renderer: иначе при пути проекта
// через ссылку один пакет попал бы в снимок дважды под разными ключами.
func (w *Workflow) planFrames(project, shot, packageDir string) (*framesPlan, error) {
	c, err := w.ensureFramesAvailable(project, shot, packageDir)
	if err != nil {
		return nil, err
	}
	hashes, err := Snapshot(c.Project, c.PackageDir, c.PackageDir, c.AllowedPaths)
	if err != nil {
		return nil, err
	}
	// Опоры создаются по одной: задание готовит следующую по плану, а решение по ней открывает следующую.
	target := c.NextFrame()
	var prompt any
	for _, item := range c.FramePrompts.Items {
		if dynvalue.Get(item, "id") == target {
			prompt = item
			break
		}
	}
	if prompt == nil {
		if undecided := c.UndecidedFrame(); undecided != nil {
			return nil, errors.New(textAcceptFrameFirst(undecided))
		}
		return nil, errors.New(textAllFramesCreated)
	}
	// Опору без промпта (своё описание) создать нечем: её делает пользователь своим файлом.
	if text, _ := dynvalue.Get(prompt, "prompt").(string); dynvalue.Trim(text) == "" {
		return nil, errors.New(textFramePromptMissing(target))
	}
	generation, err := projectGeneration(c.Project)
	if err != nil {
		return nil, err
	}
	provider := dynvalue.Get(dynvalue.Get(generation, "image"), "provider")
	if !mediaproviders.Supports(provider, mediaproviders.Image) {
		return nil, errors.New(textImageProviderRequired(providerTitles(mediaproviders.Image)))
	}
	info, _ := mediaproviders.Lookup(provider.(string))
	return &framesPlan{context: c, prompt: prompt, notes: c.FrameNotes(dynvalue.Get(prompt, "id")), info: info, hashes: hashes}, nil
}

// framePrompt — ProductionFramePrompt из плана опор пакета для запроса провайдеру.
func framePrompt(value any) mediaapi.FramePrompt {
	frame := mediaapi.FramePrompt{ReferencePaths: []string{}}
	frame.ID, _ = dynvalue.Get(value, "id").(string)
	frame.Role, _ = dynvalue.Get(value, "role").(string)
	frame.TimeSeconds, _ = dynvalue.Get(value, "timeSeconds").(float64)
	frame.Prompt, _ = dynvalue.Get(value, "prompt").(string)
	if paths, ok := dynvalue.AsArray(dynvalue.Get(value, "referencePaths")); ok {
		for _, path := range paths {
			text, _ := path.(string)
			frame.ReferencePaths = append(frame.ReferencePaths, text)
		}
	}
	return frame
}

// GenerateFrames создаёт следующую по плану неутверждённую опору пакета.
// Провайдер-агент создаёт её заданием программы-агента (утверждённые опоры пакета — референсы
// согласованности, действующие замечания — исправления), запись предложения frames ждёт его
// завершения. Платный провайдер готовит неизменяемый запрос одной опоры и вопрос согласования в
// пакете; замечания входят в текст промпта, а значит в SHA и подтверждение цены. Пока готовится
// платный запрос, план занят. Доступ к провайдеру проверяет сервис до вызова.
func (w *Workflow) GenerateFrames(ctx context.Context, project, shot, packageDir string) (View, error) {
	w.mu.Lock()
	plan, err := w.planFrames(project, shot, packageDir)
	if err != nil {
		w.mu.Unlock()
		return View{}, err
	}
	c := plan.context
	frame := framePrompt(plan.prompt)
	if w.options.Media == nil {
		w.mu.Unlock()
		return View{}, errors.New(textImageAdapterMissing(plan.info.Title))
	}
	// Провайдер без исполнителя-агента готовит платный запрос на одну опору.
	if plan.info.Executor == "" {
		if len(plan.notes) > 0 {
			frame.Prompt += framesCorrectionsLabel + strings.Join(plan.notes, " ")
		}
		planKey := key(c.Project, shot)
		w.busy[planKey] = true
		w.mu.Unlock()
		err := w.prepareImageRequest(ctx, mediaapi.ImagesInput{Project: c.Project, Shot: shot, PackageDir: c.PackageDir, Frames: []mediaapi.FramePrompt{frame}})
		w.mu.Lock()
		defer w.mu.Unlock()
		delete(w.busy, planKey)
		if err != nil {
			return View{}, err
		}
		return w.view(c.Project, shot, packageDir)
	}
	defer w.mu.Unlock()
	// Утверждённые опоры этого пакета — референсы согласованности: внешность, одежда, свет и
	// расстановка следующего кадра.
	approved := []mediaapi.ApprovedFrame{}
	for _, item := range keyframes(c.Workflow) {
		if !dynvalue.Truthy(dynvalue.Get(item, "approved")) || !dynvalue.Truthy(dynvalue.Get(item, "path")) {
			continue
		}
		path, err := packageFile(c, dynvalue.Get(item, "path"))
		if err != nil {
			return View{}, err
		}
		id, _ := dynvalue.Get(item, "id").(string)
		role, _ := dynvalue.Get(item, "role").(string)
		approved = append(approved, mediaapi.ApprovedFrame{ID: id, Role: role, Path: path})
	}
	notes := slices.Clone(plan.notes)
	job, err := w.generateImages(c.Project, mediaapi.ImagesInput{
		Project: c.Project, Shot: shot, PackageDir: c.PackageDir, Frames: []mediaapi.FramePrompt{frame}, Notes: &notes, ApprovedFrames: &approved,
	})
	if err != nil {
		return View{}, err
	}
	rules := c.RulesFor("frames")
	rules.FramePrompts = &dynvalue.Array{Items: []any{plan.prompt}}
	stored := &Stored{Tree: dynvalue.NewObject()}
	stored.Tree.Set("proposal", proposalTree(randomUUID(), job.ID, "frames", keyframesBefore(c)))
	stored.Tree.Set("packageDir", c.PackageDir)
	stored.Tree.Set("target", c.PackageDir)
	stored.Tree.Set("hashes", plan.hashes)
	stored.Tree.Set("rules", rules.Tree())
	stored.Tree.Set("imageJob", true)
	if err := w.store.Write(c.Project, shot, stored); err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, packageDir)
}

// keyframesBefore — before предложения опор: сериализованный JSON поля keyframes пакета, «[]» без него.
func keyframesBefore(c *Context) string {
	value := c.workflowValue("keyframes")
	if dynvalue.IsNullish(value) {
		return "[]"
	}
	return dynvalue.Stringify(value)
}

// CheckImportImages — проверка входа импорта опор: каждый
// выбранный файл — настоящее изображение (обычный файл PNG, JPEG или WebP по заголовку, который
// декодирует validate). nil — список не передан.
func CheckImportImages(images []FrameCandidate, validate func(string) bool) error {
	if images == nil || slices.ContainsFunc(images, func(image FrameCandidate) bool {
		return !mediafile.IsImage(image.Path) || !validate(image.Path)
	}) {
		return errors.New(TextActualImagesRequired)
	}
	return nil
}

// ImportFrames вместе с проверкой входа: свои изображения для
// любых неутверждённых опор пакета (утверждённую сначала возвращают на доработку) становятся
// готовым предложением опор без задания агента. Кандидаты — в порядке плана, без повторов, по
// абсолютным путям; запоминаются SHA-256 их байтов, изменение файла делает предложение устаревшим.
// Файлы пакета не меняются: кандидатов регистрирует Apply.
func (w *Workflow) ImportFrames(project, shot, packageDir string, images []FrameCandidate) (View, error) {
	if err := CheckImportImages(images, w.options.ValidateImage); err != nil {
		return View{}, err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	c, err := w.framesForImport(project, shot, packageDir, images)
	if err != nil {
		return View{}, err
	}
	open := []any{}
	for _, prompt := range c.FramePrompts.Items {
		id := dynvalue.Get(prompt, "id")
		if !slices.ContainsFunc(keyframes(c.Workflow), func(frame any) bool {
			return dynvalue.Get(frame, "id") == id && dynvalue.Truthy(dynvalue.Get(frame, "approved"))
		}) {
			open = append(open, prompt)
		}
	}
	checked, err := CheckFrameCandidates(candidatesTree(images), &dynvalue.Array{Items: open})
	if err != nil {
		return View{}, err
	}
	hashes, err := Snapshot(c.Project, c.PackageDir, c.PackageDir, c.AllowedPaths)
	if err != nil {
		return View{}, err
	}
	imageHashes := dynvalue.NewObject()
	for _, image := range checked {
		hash, err := requiredFileDigest(image.Path)
		if err != nil {
			return View{}, err
		}
		imageHashes.Set(image.Path, hash)
	}
	after := dynvalue.NewObject()
	after.Set("schemaVersion", float64(1))
	after.Set("stage", "frames")
	after.Set("images", candidatesTree(checked))
	proposal := proposalTree(randomUUID(), "", "frames", keyframesBefore(c))
	proposal.Set("status", "ready")
	proposal.Set("after", after)
	stored := &Stored{Tree: dynvalue.NewObject()}
	stored.Tree.Set("proposal", proposal)
	stored.Tree.Set("packageDir", c.PackageDir)
	stored.Tree.Set("target", c.PackageDir)
	stored.Tree.Set("hashes", hashes)
	stored.Tree.Set("rules", c.RulesFor("frames").Tree())
	stored.Tree.Set("imageHashes", imageHashes)
	if err := w.store.Write(c.Project, shot, stored); err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, packageDir)
}
