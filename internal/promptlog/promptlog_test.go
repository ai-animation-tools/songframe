package promptlog

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/agents"
)

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(value)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestAgentRecord — задание агента: одна запись с полным промптом без секретов, контекстом,
// вложением внутри проекта (путь от проекта) и вне его (только имя), затем итог с ответом.
// Незавершённая запись другого запуска показывается прерванной.
func TestAgentRecord(t *testing.T) {
	project := t.TempDir()
	inside := filepath.Join(project, "plan", "frame.png")
	outside := filepath.Join(t.TempDir(), "copy.png")
	for _, file := range []string{inside, outside} {
		writeJSON(t, file, "png")
	}
	job := agents.Job{ID: "00000000-0000-4000-8000-00000000000a", Project: project, Provider: "claude", Task: "Сцена M02",
		Permissions: agents.PermissionsReadOnly, StartedAt: "2026-11-12T10:00:00.000Z"}
	journal := AgentJournal{}
	journal.Begin(job, "Промпт с ключом sk-abcdefghijklmnop", "Контекст", []string{inside, outside}, &agents.Place{Page: "production", Shot: "M02"})
	list, err := List(project)
	if err != nil || len(list) != 1 || list[0].Status != StatusRunning || list[0].Place.Shot != "M02" {
		t.Fatalf("после запуска %+v %v", list, err)
	}
	job.Status, job.Result, job.Diagnostic, job.Message = agents.StatusFailed, "частичный ответ", agents.CodeCLIError, "сбой"
	journal.End(job)
	record, err := Get(project, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != StatusFailed || record.Response != "частичный ответ" || record.Error != "[CLI_ERROR] сбой" || record.FinishedAt == nil ||
		strings.Contains(record.Prompt, "sk-abcdefghijklmnop") || !strings.Contains(record.Prompt, "[скрыто]") || record.Context != "Контекст" {
		t.Fatalf("итог %+v", record)
	}
	if len(record.Attachments) != 2 || record.Attachments[0].Path != "plan/frame.png" || record.Attachments[1].Path != "copy.png" || len(record.Attachments[0].SHA256) != 64 {
		t.Fatalf("вложения %+v", record.Attachments)
	}
	if list, _ := List(project); len(list) != 1 {
		t.Fatalf("записей %d", len(list))
	}

	// Запись running, оставшаяся от прошлого запуска, — прервана; длинный текст обрезан.
	stale := Record{SchemaVersion: 1, ID: "stale", Kind: KindAgent, Title: "Старое", StartedAt: "2026-11-12T09:00:00.000Z", Status: StatusRunning,
		Prompt: strings.Repeat("я", TextLimit)}
	if err := write(project, stale); err != nil {
		t.Fatal(err)
	}
	shown, _ := Get(project, "stale")
	if shown.Status != StatusInterrupted || !shown.Truncated || len(shown.Prompt) > TextLimit+64 {
		t.Fatalf("прерванная запись: %s, обрезана %v, %d байт", shown.Status, shown.Truncated, len(shown.Prompt))
	}
	if list, _ := List(project); len(list) != 2 || list[0].ID != job.ID {
		t.Fatalf("порядок %+v", list)
	}
}

// paidRequest — замороженный запрос видео плана M03 с промптом и опорой.
func paidRequest(t *testing.T, project string) string {
	t.Helper()
	dir := filepath.Join(project, "plan", "batches", "M03-attempt-01", "request")
	writeJSON(t, filepath.Join(dir, "request.json"), map[string]any{
		"shot": "M03", "kind": "video", "provider": "test", "model": "test-video", "parameters": map[string]any{"duration": 5},
		"prompt": map[string]any{"path": "prompt.txt"}, "inputs": []any{map[string]any{"path": "frame.png"}},
	})
	if err := os.WriteFile(filepath.Join(dir, "prompt.txt"), []byte("Камера приближается."), 0o644); err != nil {
		t.Fatal(err)
	}
	writeJSON(t, filepath.Join(dir, "frame.png"), "png")
	writeJSON(t, filepath.Join(dir, "attempt.json"), map[string]any{"status": "prepared", "request_sha256": "abc"})
	return dir
}

// TestPaidSubmit — платная отправка: успех с номером генерации и списанием, отказ сервиса и
// отмена — по одной записи с промптом, параметрами и ответом.
func TestPaidSubmit(t *testing.T) {
	project := t.TempDir()
	dir := paidRequest(t, project)
	place := &Place{Page: "production", Shot: "M03"}
	err := PaidSubmit(context.Background(), project, dir, place, func() error {
		writeJSON(t, filepath.Join(dir, "attempt.json"), map[string]any{"status": "submitted", "request_sha256": "abc", "generation_id": "gen-1", "credits_consumed": 13})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rejected := errors.New("Сервис отклонил запрос до оплаты")
	if err := PaidSubmit(context.Background(), project, dir, place, func() error { return rejected }); !errors.Is(err, rejected) {
		t.Fatalf("отказ: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_ = PaidSubmit(ctx, project, dir, place, func() error { return ctx.Err() })
	list, err := List(project)
	if err != nil || len(list) != 3 {
		t.Fatalf("записи %+v %v", list, err)
	}
	statuses := map[string]int{}
	for _, item := range list {
		statuses[item.Status]++
		if !item.Paid || item.Kind != KindVideo || item.Title != "M03 · Запрос видео" || item.Executor != "test" {
			t.Fatalf("строка %+v", item)
		}
	}
	if statuses[StatusCompleted] != 1 || statuses[StatusFailed] != 1 || statuses[StatusCancelled] != 1 {
		t.Fatalf("итоги %v", statuses)
	}
	for _, item := range list {
		if item.Status != StatusCompleted {
			continue
		}
		record, _ := Get(project, item.ID)
		if record.Prompt != "Камера приближается." || record.Context != `{"duration":5}` || record.Paid.GenerationID == nil || *record.Paid.GenerationID != "gen-1" ||
			record.Paid.Amount == nil || *record.Paid.Amount != 13 || compact(record.Paid.Parameters) != `{"duration":5}` ||
			len(record.Attachments) != 1 || record.Attachments[0].Path != "plan/batches/M03-attempt-01/request/frame.png" || !strings.Contains(record.Response, `"generation_id": "gen-1"`) {
			t.Fatalf("успешная отправка %+v", record)
		}
	}
}

// TestRecordID — номер записи не выходит за папку журнала.
func TestRecordID(t *testing.T) {
	if _, err := Read(t.TempDir(), "../x"); err == nil {
		t.Fatal("ждали ошибку")
	}
}

// compact — JSON без пробелов: файл записи форматирован с отступами.
func compact(raw json.RawMessage) string {
	var buffer strings.Builder
	var value any
	_ = json.Unmarshal(raw, &value)
	data, _ := json.Marshal(value)
	buffer.Write(data)
	return buffer.String()
}
