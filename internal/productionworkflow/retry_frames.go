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
	return w.retryAttempt(ctx, project, shot, packageDir, false)
}

// RetryFirstFrame — productionWorkflow.retryFirstFrame: новая попытка плана shot, которая снимает
// видео только с первой опорой пакета packageDir. Две почти одинаковые опоры модель видео держит
// неподвижными; пользователь, увидев утверждённые опоры, решает снимать с одной, а конец плана
// видеопромпт описывает словами; так же снимают план, когда остальные опоры не удаются. Переносятся описание, первая утверждённая опора теми же байтами,
// её строка плана опор, кадры других планов и срез речи; выбор опор попытки — одна
// (keyframe_count 1), поэтому в запрос и в ручную генерацию уходит только она. Видеопромпт прежней
// попытки написан для двух опор и не переносится: агент пишет новый. Доступна, когда описание
// принято, опор не меньше двух и утверждена первая (остальные могут быть не утверждены), на любом
// этапе до отправки и после неё, кроме незавершённой отправки; прежняя попытка не меняется.
func (w *Workflow) RetryFirstFrame(ctx context.Context, project, shot, packageDir string) (View, error) {
	return w.retryAttempt(ctx, project, shot, packageDir, true)
}

// retryAttempt — общий путь RetryWithFrames и RetryFirstFrame: firstOnly переносит только первую
// опору без видеопромпта.
func (w *Workflow) retryAttempt(ctx context.Context, project, shot, packageDir string, firstOnly bool) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	canonical, err := dynvalue.Realpath(project)
	if err != nil {
		return View{}, err
	}
	if packageDir == "" {
		return View{}, errors.New(unavailableText(firstOnly))
	}
	c, err := ReadContext(canonical, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	if w.busy[key(canonical, shot)] || slices.ContainsFunc(w.options.Agents.List(canonical), func(job agents.Job) bool { return job.Status == "running" }) ||
		(w.options.IsPackageBusy != nil && w.options.IsPackageBusy(canonical, c.PackageDir)) {
		return View{}, errors.New(textRetryFramesBusy)
	}
	if err := retryFramesAllowed(c, firstOnly); err != nil {
		return View{}, err
	}
	planKey := key(canonical, shot)
	w.busy[planKey] = true
	defer delete(w.busy, planKey)
	target := nextPackage(canonical, shot)
	if err := w.copyAttempt(ctx, c, target, firstOnly); err != nil {
		// Новая папка создана этим вызовом и ни на что ещё не ссылается: недописанную убираем.
		_ = os.RemoveAll(target)
		return View{}, err
	}
	return w.view(canonical, shot, target)
}

// unavailableText — отказ попытке без описания и опор для повтора с теми же опорами или только с
// первой.
func unavailableText(firstOnly bool) string {
	if firstOnly {
		return textRetryFirstFrameUnavailable
	}
	return textRetryFramesUnavailable
}

// retryFramesAllowed — причина, по которой из попытки c нельзя начать новую с теми же опорами
// (firstOnly — только с первой опорой); nil — можно. Только первую опору переносят и до отправки:
// число опор на месте не меняется, а на этапе опор и промпта это та же новая попытка. Для неё
// достаточно утверждённой первой опоры: остальные в новую попытку не идут, и неудачную последнюю
// опору не нужно утверждать, чтобы от неё отказаться.
func retryFramesAllowed(c *Context, firstOnly bool) error {
	if c.Workflow == nil || c.workflowValue("own_video") == true || c.DerivedFrom != "" {
		return errors.New(unavailableText(firstOnly))
	}
	if firstOnly && (c.SingleFrame || len(keyframes(c.Workflow)) < 2) {
		return errors.New(textRetryFirstFrameUnavailable)
	}
	if !firstOnly && slices.Contains(inPlaceStages, dynvalue.ToString(c.Workflow.Value("stage"))) {
		return errors.New(textRetryFramesInPlace)
	}
	if request := c.Workflow.Value("request_dir"); dynvalue.Truthy(request) {
		status := dynvalue.Get(readJSONOrNil(filepath.Join(c.PackageDir, dynvalue.ToString(request), "attempt.json")), "status")
		if slices.Contains(inFlightStatuses, dynvalue.ToString(status)) {
			return errors.New(textRetryFramesInFlight)
		}
	}
	check := c.FramesApproved
	if firstOnly {
		check = c.firstFrameApproved
	}
	approved, err := check()
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
// попытка покажет так же, как прежняя. firstOnly переносит только первую утверждённую опору и её
// строку плана опор, записывает выбор одной опоры и не переносит видеопромпт: попытка начинается
// с промпта для одной опоры.
func (w *Workflow) copyAttempt(ctx context.Context, c *Context, target string, firstOnly bool) error {
	mode := dynvalue.ToString(c.Workflow.Value("mode"))
	if mode == "" {
		mode = "shot"
	}
	if err := w.run(ctx, c.Project, "shot_workflow", "init", c.Shot, "--dir", target, "--mode", mode, "--retry-of", c.PackageDir); err != nil {
		return err
	}
	// Видеопромпт переносится обоими вариантами (оригинал и перевод), запись без вариантов — файлом path.
	previous := c.workflowValue("prompt")
	prompts := promptVariantFiles(previous)
	if len(prompts) == 0 {
		prompts = []string{promptOriginalFile}
	}
	names := []string{"description.md", "keyframe-prompts.json"}
	if !firstOnly {
		names = append(names, prompts...)
	}
	for _, name := range append(names, "continuity", "audio") {
		if err := copyPackageEntry(c.PackageDir, target, name); err != nil {
			return err
		}
	}
	workflow, err := packageDocument(target, textWorkflowNotCreated)
	if err != nil {
		return err
	}
	limit := 0
	if firstOnly {
		limit = 1
	}
	if err := carryApprovedFrames(c.PackageDir, target, c.Workflow, workflow, limit); err != nil {
		return err
	}
	if firstOnly {
		if err := keepFramePrompts(target, workflow); err != nil {
			return err
		}
	}
	workflow.Set("description_approved", true)
	for _, field := range []string{"scene_sha256", "timing", "keyframe_count"} {
		if value := c.Workflow.Value(field); value != dynvalue.Undefined {
			workflow.Set(field, dynvalue.DeepClone(value))
		}
	}
	if firstOnly {
		// Запись prompt — от shot_workflow init: неутверждённый video-prompt.txt, которого ещё нет.
		workflow.Set("keyframe_count", float64(1))
	} else {
		workflow.Set("prompt", unapprovedPrompt(previous))
	}
	workflow.Set("approved_prompt_sha256", nil)
	// Опоры уже утверждены: попытка начинается с промпта, если он перенесён, иначе с опор. Этап
	// пишется сразу — set-stage переводит только на соседний этап вперёд.
	stage := "keyframes_review"
	if !firstOnly && dynvalue.Exists(filepath.Join(target, prompts[0])) {
		stage = "prompt_review"
	}
	workflow.Set("stage", stage)
	return writeProjectJSON(filepath.Join(target, "workflow.json"), workflow)
}

// carryApprovedFrames переносит утверждённые опоры workflow.json прежней попытки previous
// (папка from) в документ новой попытки next (папка to): файлы копируются по тем же путям внутри
// пакета, запись опоры и approved_frames — как в прежней попытке. Отметка провайдера снимается:
// опора не создавалась заново, и расход новой попытке не принадлежит. Неутверждённые опоры не
// переносятся; limit > 0 ограничивает перенос первыми limit утверждёнными по порядку плана.
// Документ next записывает вызывающий.
func carryApprovedFrames(from, to string, previous, next *dynvalue.Object, limit int) error {
	frames := []any{}
	approved := dynvalue.NewObject()
	for _, item := range keyframes(previous) {
		if limit > 0 && len(frames) == limit {
			break
		}
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

// keepFramePrompts оставляет в keyframe-prompts.json попытки target только строки опор документа
// workflow: план опор не должен называть опору, которой в попытке нет. Порядок и поля строк — как
// в прежнем плане; отсутствующий или не массив файл не трогается.
func keepFramePrompts(target string, workflow *dynvalue.Object) error {
	path := filepath.Join(target, "keyframe-prompts.json")
	if !dynvalue.Exists(path) {
		return nil
	}
	raw, err := readJSON(path)
	if err != nil {
		return err
	}
	rows, ok := dynvalue.AsArray(raw)
	if !ok {
		return nil
	}
	ids := map[string]bool{}
	for _, frame := range keyframes(workflow) {
		ids[dynvalue.ToString(dynvalue.Get(frame, "id"))] = true
	}
	kept := []any{}
	for _, row := range rows {
		if ids[dynvalue.ToString(dynvalue.Get(row, "id"))] {
			kept = append(kept, row)
		}
	}
	return writeProjectJSON(path, &dynvalue.Array{Items: kept})
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
