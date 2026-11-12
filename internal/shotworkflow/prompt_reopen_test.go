package shotworkflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/toolrt"
)

// writePromptPackage — пакет с утверждёнными опорами и видеопромптом на этапе stage; requestDir —
// подготовленный запрос или "" (null).
func writePromptPackage(t *testing.T, stage, requestDir string) string {
	t.Helper()
	directory := t.TempDir()
	request := "null"
	if requestDir != "" {
		request = `"` + requestDir + `"`
	}
	document := `{"schema_version":1,"shot":"M01","mode":"shot","stage":"` + stage + `","wait_reason":null,` +
		`"request_dir":` + request + `,"description_approved":true,"scene_sha256":"x","timing":{},` +
		`"keyframes":[{"id":"K01","approved":true}],"approved_frames":{"K01":"a"},` +
		`"keyframe_notes":[],"prompt":{"path":"video-prompt.txt","approved":true,"chars":5},"approved_prompt_sha256":"b",` +
		`"retry_of":null,"frame_source":null,"model":null,"batch":null,"current_keyframe":null,` +
		`"pending_decision":{"stage":"` + stage + `","question":"?"},"decision":null}`
	if err := os.WriteFile(filepath.Join(directory, "workflow.json"), []byte(document), 0o644); err != nil {
		t.Fatal(err)
	}
	return directory
}

// Возврат с этапа запроса снимает утверждение промпта и неотправленный запрос, сохраняет опоры и
// записывает замечание ответом revise на prompt_review: следующий проход агента — промпт.
func TestReopenPromptKeepsFramesAndDropsRequest(t *testing.T) {
	directory := writePromptPackage(t, "request_choice", "request-01")
	tool := &workflowTool{root: directory}
	if _, err := tool.reopenPrompt(directory, "  короче, без титров  "); err != nil {
		t.Fatal(err)
	}
	data, err := load(directory)
	if err != nil {
		t.Fatal(err)
	}
	prompt := data.Value("prompt").(*toolrt.Dict)
	if prompt.Value("approved") != false || data.Value("approved_prompt_sha256") != nil || data.Value("request_dir") != nil {
		t.Fatalf("промпт %v, sha %v, запрос %v", prompt, data.Value("approved_prompt_sha256"), data.Value("request_dir"))
	}
	if !is(data.Value("stage"), "prompt_review") || data.Value("pending_decision") != nil {
		t.Fatalf("этап %v, вопрос %v", data.Value("stage"), data.Value("pending_decision"))
	}
	decision := data.Value("decision")
	verdict, _ := get(decision, "verdict", nil)
	stage, _ := get(decision, "stage", nil)
	note, _ := get(decision, "note", nil)
	if verdict != "revise" || stage != "prompt_review" || note != "короче, без титров" {
		t.Fatalf("решение %v", decision)
	}
	frames, _ := keyframes(data)
	approved, _ := get(frames[0], "approved", nil)
	if approved != true || data.Value("description_approved") != true {
		t.Fatalf("опоры или описание сброшены: %v", data)
	}
}

// Без замечания, с неутверждённым промптом и после отправки промпт не возвращается.
func TestReopenPromptRefusals(t *testing.T) {
	tool := &workflowTool{}
	directory := writePromptPackage(t, "request_choice", "request-01")
	tool.root = directory
	if _, err := tool.reopenPrompt(directory, "   "); err == nil || !strings.Contains(err.Error(), "замечание") {
		t.Fatalf("пустое замечание: %v", err)
	}
	sent := writePromptPackage(t, "submitted", "request-01")
	tool.root = sent
	if _, err := tool.reopenPrompt(sent, "текст"); err == nil || !strings.Contains(err.Error(), "новой попытке") {
		t.Fatalf("отправленный запрос: %v", err)
	}
	fresh := writeFrameNotePackage(t)
	tool.root = fresh
	if _, err := tool.reopenPrompt(fresh, "текст"); err == nil || !strings.Contains(err.Error(), "не утверждён") {
		t.Fatalf("неутверждённый промпт: %v", err)
	}
}

// Склонение в отказе по длине совпадает с текстами интерфейса.
func TestPromptOverLimitText(t *testing.T) {
	cases := map[int]string{2501: "2501 символ", 2504: "2504 символа", 2511: "2511 символов"}
	for chars, want := range cases {
		if text := textPromptOverLimit(chars, 2500); !strings.Contains(text, want+" при пределе 2500") {
			t.Fatalf("%d: %s", chars, text)
		}
	}
}
