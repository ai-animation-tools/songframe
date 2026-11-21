package productionworkflow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
)

// withTranslation — утверждённый к отправке перевод в попытке dir: video-prompt.ru.txt, ключи
// original и translation записи prompt, path и SHA-256 — по переводу.
func withTranslation(t *testing.T, dir, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, promptTranslationFile), []byte(text), 0o664); err != nil {
		t.Fatal(err)
	}
	workflow, err := packageDocument(dir, textWorkflowNotCreated)
	if err != nil {
		t.Fatal(err)
	}
	record := proposedPrompt(true)
	record.Set("path", promptTranslationFile)
	record.Set("approved", true)
	workflow.Set("prompt", record)
	digest := sha256.Sum256([]byte(text))
	workflow.Set("approved_prompt_sha256", hex.EncodeToString(digest[:]))
	if err := writeProjectJSON(filepath.Join(dir, "workflow.json"), workflow); err != nil {
		t.Fatal(err)
	}
}

// Утверждённый к отправке перевод становится текстом запроса: запрос читает выбранный prompt.path.
func TestPrepareRequestTranslation(t *testing.T) {
	run := ownRun(t)
	workflow := requestWorkflow(t, run)
	dir := promptReady(t, run, 2)
	translation := "Лодка подходит к пристани, перевод.\n"
	withTranslation(t, dir, translation)
	if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	request := requestFile(t, dir, "request-01")
	path := dynvalue.ToString(dynvalue.Get(request.Value("prompt"), "path"))
	data, err := os.ReadFile(filepath.Join(dir, "request-01", path))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != translation {
		t.Fatalf("текст запроса: %q", data)
	}
}

// Новая попытка с теми же опорами переносит оба варианта видеопромпта и их ключи; к отправке снова
// выбран оригинал, утверждения нет.
func TestRetryWithFramesTranslation(t *testing.T) {
	run := ownRun(t)
	source := paidAttempt(t, run, "downloaded")
	withTranslation(t, source, "Лодка плывёт, перевод.\n")
	if _, err := run.workflow.RetryWithFrames(context.Background(), run.project, "M01", source); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(run.project, "plan", "batches", "M01-attempt-02")
	before, copied := treeBytes(t, source), treeBytes(t, target)
	for _, path := range []string{promptOriginalFile, promptTranslationFile} {
		if copied[path] == nil || !bytes.Equal(copied[path], before[path]) {
			t.Fatalf("%s не перенесён теми же байтами", path)
		}
	}
	c, err := ReadContext(run.project, "M01", target)
	if err != nil {
		t.Fatal(err)
	}
	if got := dynvalue.Stringify(c.workflowValue("prompt")); got != `{"path":"video-prompt.txt","approved":false,"original":"video-prompt.txt","translation":"video-prompt.ru.txt"}` {
		t.Fatalf("запись промпта: %s", got)
	}
	if stage := c.Workflow.Value("stage"); stage != "prompt_review" {
		t.Fatalf("этап: %v", stage)
	}
}

// Свой промпт заменяет утверждённый и до отправки, когда запрос уже подготовлен и открыт вопрос
// об отправке: подготовленная папка запроса остаётся неотправленной, вопрос переходит к новому
// промпту, а следующий запрос собирается по нему.
func TestSaveOwnPromptPreparedRequest(t *testing.T) {
	run := ownRun(t)
	workflow := requestWorkflow(t, run)
	dir := promptReady(t, run, 2)
	withTranslation(t, dir, "Лодка подходит к пристани, перевод.\n")
	if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	own := "The boat glides to the pier."
	if _, err := workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", PackageDir: dir, Stage: "prompt", Prompt: own}); err != nil {
		t.Fatalf("свой промпт при подготовленном запросе: %v", err)
	}
	c, err := ReadContext(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.workflowValue("request_dir") != nil || c.workflowValue("stage") != "prompt_review" ||
		dynvalue.Get(c.workflowValue("pending_decision"), "stage") != "prompt_review" {
		t.Fatalf("попытка после своего промпта: %s", dynvalue.Stringify(c.Workflow))
	}
	if _, err := os.Stat(filepath.Join(dir, promptTranslationFile)); !os.IsNotExist(err) {
		t.Fatalf("перевод прежнего промпта остался: %v", err)
	}
	runTool(t, run.project, "shot_workflow", "decide", "--dir", dir, "--verdict", "approve")
	if _, err := workflow.PrepareRequest(context.Background(), run.project, "M01", dir, nil); err != nil {
		t.Fatal(err)
	}
	request := requestFile(t, dir, "request-02")
	data, err := os.ReadFile(filepath.Join(dir, "request-02", dynvalue.ToString(dynvalue.Get(request.Value("prompt"), "path"))))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != own {
		t.Fatalf("текст нового запроса: %q", data)
	}
}
