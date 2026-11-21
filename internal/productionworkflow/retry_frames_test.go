package productionworkflow

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/mediatest"
)

// paidAttempt — попытка M01-attempt-01 после отправки видео: принятое описание, две
// утверждённые опоры, кадр другого плана, срез речи, утверждённый промпт и запрос с исходом status.
func paidAttempt(t *testing.T, run *goldenRun, status string) string {
	t.Helper()
	dir := filepath.Join(run.project, "plan", "batches", "M01-attempt-01")
	runTool(t, run.project, "shot_workflow", "init", "M01", "--dir", dir, "--mode", "shot")
	runTool(t, run.project, "shot_workflow", "plan-keyframes", "--dir", dir, "--request-seconds", "9")
	write := func(rel string, data []byte) string {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o664); err != nil {
			t.Fatal(err)
		}
		return path
	}
	write("description.md", []byte("Лодка плывёт.\n"))
	write("keyframe-prompts.json", []byte(`[{"id":"K01","role":"first","timeSeconds":0,"prompt":"У берега","referencePaths":[]},{"id":"K02","role":"last","timeSeconds":9,"prompt":"У пристани","referencePaths":[]}]`+"\n"))
	write("video-prompt.txt", []byte("Лодка плывёт к пристани.\n"))
	write("continuity/M00-last.png", mediatest.BuiltinPNG)
	write("audio/speech.wav", []byte("RIFF"))
	runTool(t, run.project, "shot_workflow", "approve", "--dir", dir, "K01", write("frames/K01.png", mediatest.BuiltinPNG))
	runTool(t, run.project, "shot_workflow", "approve", "--dir", dir, "K02", write("frames/K02.png", append(append([]byte{}, mediatest.BuiltinPNG...), 0)))
	write("request-01/attempt.json", []byte(`{"status":"`+status+`"}`))
	write("request-01/original.mp4", []byte("video"))
	workflow, err := packageDocument(dir, textWorkflowNotCreated)
	if err != nil {
		t.Fatal(err)
	}
	workflow.Set("description_approved", true)
	prompt := proposedPrompt(false)
	prompt.Set("approved", true)
	workflow.Set("prompt", prompt)
	workflow.Set("request_dir", "request-01")
	// Запрос отправлен и оригинал скачан: этап пишется сразу, без пошаговой подготовки запроса.
	workflow.Set("stage", "downloaded")
	if err := writeProjectJSON(filepath.Join(dir, "workflow.json"), workflow); err != nil {
		t.Fatal(err)
	}
	return dir
}

// treeBytes — файлы папки: путь → байты.
func treeBytes(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		relative, _ := filepath.Rel(root, path)
		files[filepath.ToSlash(relative)] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// Новая попытка с теми же опорами переносит принятое описание, опоры теми же байтами, кадр другого
// плана и срез речи; видеопромпт переносится неутверждённым, запросы и оригиналы — нет. Прежняя
// попытка не меняется, а в новой опору можно вернуть на доработку.
func TestRetryWithFrames(t *testing.T) {
	run := ownRun(t)
	source := paidAttempt(t, run, "downloaded")
	before := treeBytes(t, source)
	view, err := run.workflow.RetryWithFrames(context.Background(), run.project, "M01", source)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(run.project, "plan", "batches", "M01-attempt-02")
	if view.PackageDir == nil || *view.PackageDir != target || view.Stage == nil || *view.Stage != "prompt_review" {
		t.Fatalf("вид новой попытки: %v %v", view.PackageDir, view.Stage)
	}
	if after := treeBytes(t, source); len(after) != len(before) {
		t.Fatal("прежняя попытка изменилась")
	} else {
		for path, data := range before {
			if !bytes.Equal(after[path], data) {
				t.Fatalf("прежняя попытка: изменён %s", path)
			}
		}
	}
	copied := treeBytes(t, target)
	for _, path := range []string{"description.md", "keyframe-prompts.json", "video-prompt.txt", "continuity/M00-last.png", "audio/speech.wav", "frames/K01.png", "frames/K02.png"} {
		if !bytes.Equal(copied[path], before[path]) {
			t.Fatalf("%s не перенесён теми же байтами", path)
		}
	}
	for _, path := range []string{"request-01/attempt.json", "request-01/original.mp4"} {
		if _, ok := copied[path]; ok {
			t.Fatalf("%s не должен переноситься", path)
		}
	}
	c, err := ReadContext(run.project, "M01", target)
	if err != nil {
		t.Fatal(err)
	}
	if frames, err := c.FramesApproved(); err != nil || !frames {
		t.Fatalf("опоры новой попытки не утверждены: %v", err)
	}
	if prompt, err := c.PromptApproved(); err != nil || prompt {
		t.Fatalf("промпт новой попытки утверждён: %v", err)
	}
	if c.Paid || c.Workflow.Value("description_approved") != true || c.Workflow.Value("retry_of") != "plan/batches/M01-attempt-01" || c.Workflow.Value("request_dir") != nil {
		t.Fatalf("workflow новой попытки: %s", dynvalue.Stringify(c.Workflow))
	}
	runTool(t, run.project, "shot_workflow", "reopen", "--dir", target, "K02", "--note", "Другой свет")
}

// Новая попытка не создаётся, пока опору можно вернуть на месте, пока исход отправки неизвестен и
// когда опоры изменились после утверждения.
func TestRetryWithFramesRefusals(t *testing.T) {
	run := ownRun(t)
	source := paidAttempt(t, run, "submission_unknown")
	if _, err := run.workflow.RetryWithFrames(context.Background(), run.project, "M01", source); err == nil || err.Error() != textRetryFramesInFlight {
		t.Fatalf("неизвестный исход: %v", err)
	}
	if err := os.WriteFile(filepath.Join(source, "request-01", "attempt.json"), []byte(`{"status":"downloaded"}`), 0o664); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "frames", "K01.png"), []byte("другое"), 0o664); err != nil {
		t.Fatal(err)
	}
	if _, err := run.workflow.RetryWithFrames(context.Background(), run.project, "M01", source); err == nil || err.Error() != textRetryFramesNotApproved {
		t.Fatalf("изменённая опора: %v", err)
	}
	runTool(t, run.project, "shot_workflow", "set-stage", "--dir", source, "keyframes_review")
	if _, err := run.workflow.RetryWithFrames(context.Background(), run.project, "M01", source); err == nil || err.Error() != textRetryFramesInPlace {
		t.Fatalf("опору можно вернуть на месте: %v", err)
	}
	if _, err := os.Stat(filepath.Join(run.project, "plan", "batches", "M01-attempt-02")); !os.IsNotExist(err) {
		t.Fatal("отказ создал попытку")
	}
}

// Новая попытка только с первой опорой переносит описание, K01 теми же байтами и её строку плана
// опор, кадр другого плана и срез речи; K02 и видеопромпт двух опор не переносятся, выбор опор —
// одна, поэтому опоры новой попытки утверждены, а промпт пишется заново. Доступна и до отправки,
// на этапе промпта; прежняя попытка не меняется.
func TestRetryFirstFrame(t *testing.T) {
	run := ownRun(t)
	source := paidAttempt(t, run, "downloaded")
	runTool(t, run.project, "shot_workflow", "set-stage", "--dir", source, "prompt_review")
	before := treeBytes(t, source)
	view, err := run.workflow.RetryFirstFrame(context.Background(), run.project, "M01", source)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(run.project, "plan", "batches", "M01-attempt-02")
	if view.PackageDir == nil || *view.PackageDir != target || view.Stage == nil || *view.Stage != "keyframes_review" {
		t.Fatalf("вид новой попытки: %v %v", view.PackageDir, view.Stage)
	}
	after := treeBytes(t, source)
	for path, data := range before {
		if !bytes.Equal(after[path], data) {
			t.Fatalf("прежняя попытка: изменён %s", path)
		}
	}
	copied := treeBytes(t, target)
	for _, path := range []string{"description.md", "continuity/M00-last.png", "audio/speech.wav", "frames/K01.png"} {
		if !bytes.Equal(copied[path], before[path]) {
			t.Fatalf("%s не перенесён теми же байтами", path)
		}
	}
	for _, path := range []string{"frames/K02.png", "video-prompt.txt", "request-01/attempt.json", "request-01/original.mp4"} {
		if _, ok := copied[path]; ok {
			t.Fatalf("%s не должен переноситься", path)
		}
	}
	plan, err := readJSON(filepath.Join(target, "keyframe-prompts.json"))
	if err != nil {
		t.Fatal(err)
	}
	if rows, _ := dynvalue.AsArray(plan); len(rows) != 1 || dynvalue.Get(rows[0], "id") != "K01" || dynvalue.Get(rows[0], "prompt") != "У берега" {
		t.Fatalf("план опор новой попытки: %s", dynvalue.Stringify(plan))
	}
	c, err := ReadContext(run.project, "M01", target)
	if err != nil {
		t.Fatal(err)
	}
	if frames, err := c.FramesApproved(); err != nil || !frames {
		t.Fatalf("опора новой попытки не утверждена: %v", err)
	}
	if prompt, err := c.PromptApproved(); err != nil || prompt {
		t.Fatalf("промпт новой попытки утверждён: %v", err)
	}
	if items := keyframes(c.Workflow); len(items) != 1 || dynvalue.Get(items[0], "id") != "K01" {
		t.Fatalf("опоры новой попытки: %s", dynvalue.Stringify(c.Workflow.Value("keyframes")))
	}
	if c.Workflow.Value("keyframe_count") != float64(1) || c.Workflow.Value("retry_of") != "plan/batches/M01-attempt-01" || c.Workflow.Value("request_dir") != nil {
		t.Fatalf("workflow новой попытки: %s", dynvalue.Stringify(c.Workflow))
	}
	// Из попытки с одной опорой снимать «только с первой» нечего.
	if _, err := run.workflow.RetryFirstFrame(context.Background(), run.project, "M01", target); err == nil || err.Error() != textRetryFirstFrameUnavailable {
		t.Fatalf("попытка с одной опорой: %v", err)
	}
}

// Только с первой опорой можно и тогда, когда последняя опора не утверждена (не удалась): она в
// новую попытку не идёт, и утверждать её ради отказа от неё не нужно.
func TestRetryFirstFrameUnapprovedLast(t *testing.T) {
	run := ownRun(t)
	source := paidAttempt(t, run, "downloaded")
	workflow, err := packageDocument(source, textWorkflowNotCreated)
	if err != nil {
		t.Fatal(err)
	}
	frames := keyframes(workflow)
	last, _ := frames[1].(*dynvalue.Object)
	last.Set("approved", false)
	last.Set("sha256", nil)
	workflow.Delete("request_dir")
	workflow.Set("stage", "keyframes_review")
	if err := writeProjectJSON(filepath.Join(source, "workflow.json"), workflow); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "frames", "K02.png"), []byte("неудачная"), 0o664); err != nil {
		t.Fatal(err)
	}
	view, err := run.workflow.RetryFirstFrame(context.Background(), run.project, "M01", source)
	if err != nil {
		t.Fatal(err)
	}
	c, err := ReadContext(run.project, "M01", *view.PackageDir)
	if err != nil {
		t.Fatal(err)
	}
	if items := keyframes(c.Workflow); len(items) != 1 || dynvalue.Get(items[0], "id") != "K01" || c.Workflow.Value("keyframe_count") != float64(1) {
		t.Fatalf("новая попытка: %s", dynvalue.Stringify(c.Workflow))
	}
	if approved, err := c.FramesApproved(); err != nil || !approved {
		t.Fatalf("опора новой попытки не утверждена: %v", err)
	}
}

// Только с первой опорой нельзя, пока исход отправки неизвестен, когда первая опора изменилась
// после утверждения и когда утверждена только последняя.
func TestRetryFirstFrameRefusals(t *testing.T) {
	run := ownRun(t)
	source := paidAttempt(t, run, "submission_unknown")
	if _, err := run.workflow.RetryFirstFrame(context.Background(), run.project, "M01", source); err == nil || err.Error() != textRetryFramesInFlight {
		t.Fatalf("неизвестный исход: %v", err)
	}
	if err := os.WriteFile(filepath.Join(source, "request-01", "attempt.json"), []byte(`{"status":"downloaded"}`), 0o664); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(filepath.Join(source, "frames", "K01.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "frames", "K01.png"), []byte("другое"), 0o664); err != nil {
		t.Fatal(err)
	}
	if _, err := run.workflow.RetryFirstFrame(context.Background(), run.project, "M01", source); err == nil || err.Error() != textRetryFramesNotApproved {
		t.Fatalf("изменённая первая опора: %v", err)
	}
	if err := os.WriteFile(filepath.Join(source, "frames", "K01.png"), original, 0o664); err != nil {
		t.Fatal(err)
	}
	workflow, err := packageDocument(source, textWorkflowNotCreated)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := keyframes(workflow)[0].(*dynvalue.Object)
	first.Set("approved", false)
	if err := writeProjectJSON(filepath.Join(source, "workflow.json"), workflow); err != nil {
		t.Fatal(err)
	}
	if _, err := run.workflow.RetryFirstFrame(context.Background(), run.project, "M01", source); err == nil || err.Error() != textRetryFramesNotApproved {
		t.Fatalf("первая опора не утверждена: %v", err)
	}
	if _, err := os.Stat(filepath.Join(run.project, "plan", "batches", "M01-attempt-02")); !os.IsNotExist(err) {
		t.Fatal("отказ создал попытку")
	}
}
