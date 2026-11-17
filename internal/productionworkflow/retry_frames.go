package productionworkflow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
)

// Новая попытка с теми же опорами. После запроса видео опору и промпт попытки на месте уже не
// вернуть: прежние входы платной отправки должны остаться такими, какими их отправили. Чтобы
// исправить одну опору или только промпт, приложение создаёт следующую попытку плана с retry_of и
// переносит в неё утверждённое: описание, план опор с промптами, файлы утверждённых опор теми же
// байтами, кадры других планов (continuity/) и срез речи (audio/). Видеопромпт переносится
// неутверждённым: его утверждают заново или переделывают. Запросы, оригиналы и решения прежней
// попытки не переносятся, а сама она не меняется.

// inPlaceStages — этапы, на которых опору возвращают на доработку в самой попытке
// (shot_workflow reopen; FRAME_REOPEN_STAGES в planPath.ts страницы «Производство»), и этап описания: на них новая
// попытка не нужна.
var inPlaceStages = []string{"description_review", "keyframes_review", "prompt_review", "image_request_choice", "needs_revision"}

// inFlightStatuses — отправка ещё не завершена (production.blockingStatuses, REQUEST_IN_FLIGHT
// страницы «Производство»): новая попытка подождёт исхода, как удаление и повторная оплата.
var inFlightStatuses = []string{"submitting", "submission_unknown", "submitted", "running", "watermark_free_pending",
	"outputs_pending", "download_pending", "downloading", "polling"}

// RetryWithFrames — productionWorkflow.retryWithFrames: новая попытка плана shot с описанием,
// опорами и срезом речи пакета packageDir. Доступна, когда описание принято, все опоры утверждены
// и совпадают с файлами, а вернуть опору на месте уже нельзя; не для попытки своего видео и не во
// время задания плана или неизвестного исхода отправки. Возвращает вид новой попытки.
func (w *Workflow) RetryWithFrames(ctx context.Context, project, shot, packageDir string) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	canonical, err := dynvalue.Realpath(project)
	if err != nil {
		return View{}, err
	}
	if packageDir == "" {
		return View{}, errors.New(textRetryFramesUnavailable)
	}
	c, err := ReadContext(canonical, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	if w.busy[key(canonical, shot)] || slices.ContainsFunc(w.options.Agents.List(canonical), func(job agents.Job) bool { return job.Status == "running" }) ||
		(w.options.IsPackageBusy != nil && w.options.IsPackageBusy(canonical, c.PackageDir)) {
		return View{}, errors.New(textRetryFramesBusy)
	}
	if err := retryFramesAllowed(c); err != nil {
		return View{}, err
	}
	planKey := key(canonical, shot)
	w.busy[planKey] = true
	defer delete(w.busy, planKey)
	target := nextPackage(canonical, shot)
	if err := w.copyAttempt(ctx, c, target); err != nil {
		// Новая папка создана этим вызовом и ни на что ещё не ссылается: недописанную убираем.
		_ = os.RemoveAll(target)
		return View{}, err
	}
	return w.view(canonical, shot, target)
}

// retryFramesAllowed — причина, по которой из попытки c нельзя начать новую с теми же опорами;
// nil — можно.
func retryFramesAllowed(c *Context) error {
	if c.Workflow == nil || c.workflowValue("own_video") == true || c.DerivedFrom != "" {
		return errors.New(textRetryFramesUnavailable)
	}
	if slices.Contains(inPlaceStages, dynvalue.ToString(c.Workflow.Value("stage"))) {
		return errors.New(textRetryFramesInPlace)
	}
	if request := c.Workflow.Value("request_dir"); dynvalue.Truthy(request) {
		status := dynvalue.Get(readJSONOrNil(filepath.Join(c.PackageDir, dynvalue.ToString(request), "attempt.json")), "status")
		if slices.Contains(inFlightStatuses, dynvalue.ToString(status)) {
			return errors.New(textRetryFramesInFlight)
		}
	}
	approved, err := c.FramesApproved()
	if err != nil {
		return err
	}
	if !dynvalue.Truthy(c.Workflow.Value("description_approved")) || !approved {
		return errors.New(textRetryFramesNotApproved)
	}
	return nil
}

// copyAttempt создаёт попытку target с retry_of на c.PackageDir и переносит в неё описание, план
// опор, утверждённые опоры, кадры других планов, срез речи и неутверждённый видеопромпт. Отпечаток
// постановки и тайминг — прежние: описание построено по ним, и изменившийся с тех пор сценарий
// попытка покажет так же, как прежняя.
func (w *Workflow) copyAttempt(ctx context.Context, c *Context, target string) error {
	mode := dynvalue.ToString(c.Workflow.Value("mode"))
	if mode == "" {
		mode = "shot"
	}
	if err := w.run(ctx, c.Project, "shot_workflow", "init", c.Shot, "--dir", target, "--mode", mode, "--retry-of", c.PackageDir); err != nil {
		return err
	}
	prompt := dynvalue.ToString(dynvalue.Get(c.workflowValue("prompt"), "path"))
	if prompt == "" {
		prompt = "video-prompt.txt"
	}
	for _, name := range []string{"description.md", "keyframe-prompts.json", prompt, "continuity", "audio"} {
		if err := copyPackageEntry(c.PackageDir, target, name); err != nil {
			return err
		}
	}
	workflow, err := packageDocument(target, textWorkflowNotCreated)
	if err != nil {
		return err
	}
	if err := carryApprovedFrames(c.PackageDir, target, c.Workflow, workflow); err != nil {
		return err
	}
	workflow.Set("description_approved", true)
	for _, field := range []string{"scene_sha256", "timing", "keyframe_count"} {
		if value := c.Workflow.Value(field); value != dynvalue.Undefined {
			workflow.Set(field, dynvalue.DeepClone(value))
		}
	}
	workflow.Set("prompt", promptRecord())
	workflow.Set("approved_prompt_sha256", nil)
	// Опоры уже утверждены: попытка начинается с промпта, если он перенесён, иначе с опор. Этап
	// пишется сразу — set-stage переводит только на соседний этап вперёд.
	stage := "keyframes_review"
	if dynvalue.Exists(filepath.Join(target, prompt)) {
		stage = "prompt_review"
	}
	workflow.Set("stage", stage)
	return writeProjectJSON(filepath.Join(target, "workflow.json"), workflow)
}

// carryApprovedFrames переносит утверждённые опоры workflow.json прежней попытки previous
// (папка from) в документ новой попытки next (папка to): файлы копируются по тем же путям внутри
// пакета, запись опоры и approved_frames — как в прежней попытке. Отметка провайдера снимается:
// опора не создавалась заново, и расход новой попытке не принадлежит. Неутверждённые опоры не
// переносятся. Документ next записывает вызывающий.
func carryApprovedFrames(from, to string, previous, next *dynvalue.Object) error {
	frames := []any{}
	approved := dynvalue.NewObject()
	for _, item := range keyframes(previous) {
		frame, ok := dynvalue.DeepClone(item).(*dynvalue.Object)
		if !ok || !dynvalue.Truthy(frame.Value("approved")) || !dynvalue.Truthy(frame.Value("path")) || !dynvalue.Truthy(frame.Value("sha256")) {
			continue
		}
		relative := filepath.FromSlash(dynvalue.ToString(frame.Value("path")))
		if filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return errors.New(textRetryFramesNotApproved)
		}
		if !matchesDigest(filepath.Join(from, relative), frame.Value("sha256")) {
			return errors.New(textRetryFramesNotApproved)
		}
		if err := copyPackageEntry(from, to, relative); err != nil {
			return err
		}
		frame.Delete("provider")
		frames = append(frames, frame)
		approved.Set(dynvalue.ToString(frame.Value("id")), frame.Value("sha256"))
	}
	next.Set("keyframes", &dynvalue.Array{Items: frames})
	next.Set("approved_frames", approved)
	return nil
}

// copyPackageEntry копирует файл или папку name из пакета from в пакет to по тому же пути с правами
// источника (copyMutable без защищённых image-попыток: их в переносимом нет); отсутствующий
// источник пропускается.
func copyPackageEntry(from, to, name string) error {
	source := filepath.Join(from, name)
	if !dynvalue.Exists(source) {
		return nil
	}
	target := filepath.Join(to, name)
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return err
	}
	return copyMutable(source, target, nil)
}

// readJSONOrNil — разобранный JSON файла или nil при отсутствии и ошибке.
func readJSONOrNil(path string) any {
	value, err := readJSON(path)
	if err != nil {
		return nil
	}
	return value
}
