package agents

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingJournal — журнал отправок теста: запоминает вызовы Begin и End.
type recordingJournal struct {
	mu     sync.Mutex
	begins []string
	ends   []Job
}

func (j *recordingJournal) Begin(job Job, prompt, context string, images []string, place *Place) {
	j.mu.Lock()
	defer j.mu.Unlock()
	shot := ""
	if place != nil {
		shot = place.Page + "/" + place.Shot
	}
	j.begins = append(j.begins, job.ID+"|"+prompt+"|"+context+"|"+shot)
}

func (j *recordingJournal) End(job Job) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.ends = append(j.ends, job)
}

// TestManagerJournal — каждое задание попадает в журнал отправок ровно один раз при запуске (с
// полным промптом, контекстом и местом) и один раз при завершении: успех с ответом, отмена и
// прерывание прошлого запуска при перезапуске.
func TestManagerJournal(t *testing.T) {
	journal := &recordingJournal{}
	rules := append(append([]fakeRule{}, claudeReady...), fakeRule{Prefix: []string{"-p"}, Lines: []string{`{"type":"result","subtype":"success","result":"ответ"}`}})
	manager, _, _ := testManager(t, &Settings{Provider: Claude}, map[string]fakeScenario{"claude": {Rules: rules}}, Options{Journal: journal})
	log := watch(manager)
	job, err := manager.Start(StartInput{Project: testProject(t, "{}"), Task: "T", Prompt: "Промпт", Context: "Контекст", Place: &Place{Page: "production", Shot: "M02"}})
	if err != nil {
		t.Fatal(err)
	}
	log.wait(t)
	journal.mu.Lock()
	if len(journal.begins) != 1 || !strings.HasPrefix(journal.begins[0], job.ID+"|") || !strings.Contains(journal.begins[0], "Задача:\nПромпт") ||
		!strings.HasSuffix(journal.begins[0], "|Контекст|production/M02") {
		t.Fatalf("Begin %q", journal.begins)
	}
	if len(journal.ends) != 1 || journal.ends[0].ID != job.ID || journal.ends[0].Status != StatusCompleted || journal.ends[0].Result != "ответ" {
		t.Fatalf("End %+v", journal.ends)
	}
	journal.mu.Unlock()

	cancelling, _, local := testManager(t, &Settings{Provider: Codex}, hangingCodex(false), Options{Journal: journal})
	project := testProject(t, "{}")
	hanging, err := cancelling.Start(StartInput{Project: project, Task: "T", Prompt: "P"})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "запуск CLI", func() bool { snapshot, _ := cancelling.Get(hanging.ID); return snapshot.Phase == phaseWorking })
	if _, err := cancelling.Cancel(hanging.ID); err != nil {
		t.Fatal(err)
	}
	// Повторная отмена и остановка менеджера не дают второго итога.
	_, _ = cancelling.Cancel(hanging.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = cancelling.ShutdownAndWait(ctx)
	journal.mu.Lock()
	if len(journal.begins) != 2 || len(journal.ends) != 2 || journal.ends[1].Status != StatusCancelled {
		t.Fatalf("отмена: %d/%d %+v", len(journal.begins), len(journal.ends), journal.ends)
	}
	journal.mu.Unlock()

	running := Job{SchemaVersion: 1, ID: "00000000-0000-4000-8000-000000000009", Sequence: 1, Project: project, Provider: Codex, Task: "T",
		Permissions: PermissionsReadOnly, InputHashes: InputHashes{Prompt: strings.Repeat("a", 64), Context: strings.Repeat("b", 64)},
		Status: StatusRunning, Phase: phaseWorking, StartedAt: "2020-01-01T10:00:00.000Z"}
	if err := NewHistory(local).Write(running); err != nil {
		t.Fatal(err)
	}
	NewManager(NewSettingsStore(local), Options{Journal: journal})
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if len(journal.ends) != 3 || journal.ends[2].ID != running.ID || journal.ends[2].Status != StatusInterrupted {
		t.Fatalf("перезапуск: %+v", journal.ends)
	}
}
