package agents

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Жизненный цикл менеджера на поддельных CLI: то, что эталоны не фиксируют (отмена,
// тайм-аут, остановка, перезапуск, занятость, конкурентная доставка событий).

// testProject — проект с plan/project.json.
func testProject(t *testing.T, manifest string) string {
	t.Helper()
	project := filepath.Join(t.TempDir(), "project")
	writeTestFile(t, filepath.Join(project, "plan", "project.json"), []byte(manifest))
	return project
}

// testManager — менеджер с выбранным агентом и поддельными CLI.
func testManager(t *testing.T, agent *Settings, scenarios map[string]fakeScenario, options Options) (*Manager, string, string) {
	t.Helper()
	dir := fakeDir(t, scenarios)
	local := t.TempDir()
	if agent != nil {
		data, _ := json.Marshal(map[string]any{"agent": agent})
		writeTestFile(t, filepath.Join(local, SettingsFile), data)
	}
	options.Check = fakeOptions(t, dir)
	manager := NewManager(NewSettingsStore(local), options)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = manager.ShutdownAndWait(ctx)
	})
	return manager, dir, local
}

// events собирает события и ждёт итогового.
type eventLog struct {
	mu     sync.Mutex
	events []Event
	done   chan Event
}

func watch(m *Manager) *eventLog {
	log := &eventLog{done: make(chan Event, 16)}
	m.OnEvent(func(event Event) {
		log.mu.Lock()
		log.events = append(log.events, event)
		log.mu.Unlock()
		if event.Type == EventCompleted || event.Type == EventFailed {
			log.done <- event
		}
	})
	return log
}

func (l *eventLog) wait(t *testing.T) Event {
	t.Helper()
	select {
	case event := <-l.done:
		return event
	case <-time.After(20 * time.Second):
		t.Fatal("нет итогового события")
	}
	return Event{}
}

// waitFor ждёт условия (появления файла, фазы задания).
func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("не дождались: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func codeOf(err error) string {
	var agentErr *Error
	if errors.As(err, &agentErr) {
		return agentErr.Code
	}
	return ""
}

// hangingCodex — Codex, который после старта ждёт отмены; потомок пишет pid в child.pid.
func hangingCodex(child bool) map[string]fakeScenario {
	rule := fakeRule{Prefix: []string{"-a"}, Record: "run.json", Hang: true}
	if child {
		rule.Child = "child.pid"
	}
	return map[string]fakeScenario{"codex": {Rules: append(append([]fakeRule{}, codexReady...), rule)}}
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestManagerCancelKillsTree(t *testing.T) {
	manager, dir, _ := testManager(t, &Settings{Provider: Codex}, hangingCodex(true), Options{})
	log := watch(manager)
	project := testProject(t, "{}")
	job, err := manager.Start(StartInput{Project: project, Task: "T", Prompt: "P"})
	if err != nil {
		t.Fatal(err)
	}
	pidFile := filepath.Join(dir, "child.pid")
	waitFor(t, "потомок CLI", func() bool { data, err := os.ReadFile(pidFile); return err == nil && len(data) > 0 })
	data, _ := os.ReadFile(pidFile)
	pid, _ := strconv.Atoi(string(data))
	cancelled, err := manager.Cancel(job.ID)
	if err != nil || cancelled.Status != StatusCancelled || cancelled.Diagnostic != CodeCancelled || cancelled.Message != textCancelled || cancelled.Phase != "Остановлено" {
		t.Fatalf("отмена: %+v %v", cancelled, err)
	}
	if event := log.wait(t); event.Type != EventFailed || event.Job.Status != StatusCancelled {
		t.Fatalf("событие отмены %+v", event)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := manager.ShutdownAndWait(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "завершение потомка", func() bool { return !alive(pid) })
	// Повторная отмена завершённого задания возвращает снимок без изменений.
	again, err := manager.Cancel(job.ID)
	if err != nil || again.Sequence != cancelled.Sequence {
		t.Fatalf("повторная отмена %+v %v", again, err)
	}
	if _, err := manager.Cancel("missing"); codeOf(err) != CodeInvalidInput || !strings.Contains(err.Error(), textJobNotFound) {
		t.Fatalf("отмена неизвестного: %v", err)
	}
}

func TestManagerTimeoutAndOutputLimit(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		manager, _, _ := testManager(t, &Settings{Provider: Codex}, hangingCodex(false), Options{Timeout: 300 * time.Millisecond})
		log := watch(manager)
		if _, err := manager.Start(StartInput{Project: testProject(t, "{}"), Task: "T", Prompt: "P"}); err != nil {
			t.Fatal(err)
		}
		if event := log.wait(t); event.Job.Diagnostic != CodeTimeout || event.Job.Message != textJobTimeout || event.Job.ExitCode != nil {
			t.Fatalf("тайм-аут %+v", event.Job)
		}
	})
	t.Run("output", func(t *testing.T) {
		rules := append(append([]fakeRule{}, codexReady...), fakeRule{Prefix: []string{"-a"}, Bytes: 1 << 20, Hang: true})
		manager, _, _ := testManager(t, &Settings{Provider: Codex}, map[string]fakeScenario{"codex": {Rules: rules}}, Options{OutputBytes: 4096})
		log := watch(manager)
		if _, err := manager.Start(StartInput{Project: testProject(t, "{}"), Task: "T", Prompt: "P"}); err != nil {
			t.Fatal(err)
		}
		if event := log.wait(t); event.Job.Diagnostic != CodeOutputLimit || event.Job.Message != textJobOutputLimit {
			t.Fatalf("предел вывода %+v", event.Job)
		}
	})
	t.Run("result", func(t *testing.T) {
		delta := `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"` + strings.Repeat("я", 70000) + `"}}}`
		rules := append(append([]fakeRule{}, claudeReady...), fakeRule{Prefix: []string{"-p"}, Lines: []string{delta, delta}})
		manager, _, _ := testManager(t, &Settings{Provider: Claude}, map[string]fakeScenario{"claude": {Rules: rules}}, Options{})
		log := watch(manager)
		if _, err := manager.Start(StartInput{Project: testProject(t, "{}"), Task: "T", Prompt: "P"}); err != nil {
			t.Fatal(err)
		}
		event := log.wait(t)
		if event.Job.Diagnostic != CodeOutputLimit || event.Job.Message != textResultTooLarge || len(event.Job.Result) > TextLimit {
			t.Fatalf("большой результат %s %d", event.Job.Diagnostic, len(event.Job.Result))
		}
	})
}

func TestManagerShutdownAndRestart(t *testing.T) {
	manager, _, local := testManager(t, &Settings{Provider: Codex}, hangingCodex(false), Options{})
	log := watch(manager)
	project := testProject(t, "{}")
	job, err := manager.Start(StartInput{Project: project, Task: "T", Prompt: "P"})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "запуск CLI", func() bool { snapshot, _ := manager.Get(job.ID); return snapshot.Phase == phaseWorking })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := manager.ShutdownAndWait(ctx); err != nil {
		t.Fatal(err)
	}
	if event := log.wait(t); event.Job.Status != StatusInterrupted || event.Job.Message != textShutdownInterrupted {
		t.Fatalf("остановка %+v", event.Job)
	}
	if _, err := manager.Start(StartInput{Project: project, Task: "T", Prompt: "P"}); codeOf(err) != CodeInterrupted {
		t.Fatalf("запуск после остановки: %v", err)
	}

	// Запись running после аварийного выхода становится interrupted при следующем запуске.
	running := Job{SchemaVersion: 1, ID: "00000000-0000-4000-8000-000000000001", Sequence: 3, Project: project, Provider: Codex, Task: "T",
		Permissions: PermissionsReadOnly, InputHashes: InputHashes{Prompt: strings.Repeat("a", 64), Context: strings.Repeat("b", 64)},
		Status: StatusRunning, Phase: phaseWorking, StartedAt: "2020-01-01T10:00:00.000Z"}
	if err := NewHistory(local).Write(running); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(local, "jobs", "agent-broken.json"), []byte("{"))
	writeTestFile(t, filepath.Join(local, "jobs", "agent-00000000-0000-4000-8000-000000000002.json"), []byte(`{"schemaVersion":1,"id":"other"}`))
	writeTestFile(t, filepath.Join(local, "jobs", "script-1.json"), []byte(`{}`))
	restarted := NewManager(NewSettingsStore(local), Options{})
	restored, ok := restarted.Get(running.ID)
	if !ok || restored.Status != StatusInterrupted || restored.Phase != phaseRestartInterrupted || restored.Sequence != 4 ||
		restored.Diagnostic != CodeInterrupted || restored.Message != textRestartInterrupted || restored.FinishedAt == nil {
		t.Fatalf("восстановление %+v", restored)
	}
	saved := NewHistory(local).Read()
	if len(saved) != 2 {
		t.Fatalf("история %d записей", len(saved))
	}
	if list := restarted.List(""); len(list) != 2 || list[0].ID != job.ID {
		t.Fatalf("порядок List: %+v", list)
	}
	if list := restarted.List(project); len(list) != 2 {
		t.Fatalf("фильтр проекта: %d", len(list))
	}
	if list := restarted.List("/elsewhere"); len(list) != 0 {
		t.Fatalf("чужой проект: %d", len(list))
	}
}

func TestManagerBusyRetryAndPaths(t *testing.T) {
	manager, _, local := testManager(t, &Settings{Provider: Codex}, hangingCodex(false), Options{})
	log := watch(manager)
	project := testProject(t, "{}")
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(project, link); err != nil {
		t.Fatal(err)
	}
	job, err := manager.Start(StartInput{Project: project, Task: "T", Prompt: "P"})
	if err != nil {
		t.Fatal(err)
	}
	// Занятость определяется по realpath: ссылка на тот же проект не создаёт второй запрос.
	if _, err := manager.Start(StartInput{Project: link, Task: "T", Prompt: "P"}); codeOf(err) != CodeProjectBusy {
		t.Fatalf("занятый проект: %v", err)
	}
	if _, err := manager.Start(StartInput{Project: project, Task: "T", Prompt: "P", RetryOf: job.ID}); codeOf(err) != CodeProjectBusy {
		t.Fatalf("повтор во время выполнения: %v", err)
	}
	if _, err := manager.Cancel(job.ID); err != nil {
		t.Fatal(err)
	}
	log.wait(t)
	other := testProject(t, "{}")
	if _, err := manager.Start(StartInput{Project: other, Task: "T", Prompt: "P", RetryOf: job.ID}); !strings.Contains(fmtErr(err), textRetryUnavailable) {
		t.Fatalf("повтор в другом проекте: %v", err)
	}
	retry, err := manager.Start(StartInput{Project: link, Task: "T", Prompt: "P", RetryOf: job.ID})
	if err != nil || retry.RetryOf != job.ID || retry.Project != link {
		t.Fatalf("повтор по ссылке: %+v %v", retry, err)
	}
	if _, err := manager.Cancel(retry.ID); err != nil {
		t.Fatal(err)
	}
	log.wait(t)

	// Кандидаты изображений пишутся только внутри <state>/image-jobs.
	if err := os.MkdirAll(filepath.Join(local, "image-jobs"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if _, err := manager.StartImages(StartInput{Project: project, Task: "T", Prompt: "P"}, outside, Settings{Provider: Codex}); !strings.Contains(fmtErr(err), textInvalidCandidateDir) {
		t.Fatalf("папка вне image-jobs: %v", err)
	}
	workDir := filepath.Join(local, "image-jobs", "job")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(t.TempDir(), "a.png")
	writeTestFile(t, image, append(append([]byte{}, pngMagic...), 1))
	if _, err := manager.StartImages(StartInput{Project: project, Task: "T", Prompt: "P", Images: []string{image}}, workDir, Settings{Provider: Codex}); !strings.Contains(fmtErr(err), textImageAttachmentsReadOnly) {
		t.Fatalf("вложения в режиме записи: %v", err)
	}
	job, err = manager.StartImages(StartInput{Project: project, Task: "T", Prompt: "P"}, workDir, Settings{Provider: Codex})
	if err != nil || job.Permissions != PermissionsWorkspaceWrite {
		t.Fatalf("кандидаты: %+v %v", job, err)
	}
	if _, err := manager.Cancel(job.ID); err != nil {
		t.Fatal(err)
	}
	log.wait(t)
}

func fmtErr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestManagerImageLimits(t *testing.T) {
	dir := t.TempDir()
	big := filepath.Join(dir, "big.png")
	writeTestFile(t, big, append(append([]byte{}, pngMagic...), make([]byte, imageBytes)...))
	small := filepath.Join(dir, "small.jpg")
	writeTestFile(t, small, append(append([]byte{}, jpegMagic...), make([]byte, 4*1024*1024)...))
	empty := filepath.Join(dir, "empty.png")
	writeTestFile(t, empty, nil)
	cases := []struct {
		paths []string
		want  string
	}{
		{[]string{big}, textImageAttachmentsTooLarge},
		{[]string{small, small, small, small, small, small}, textImageAttachmentsTooLarge},
		{[]string{empty}, textImageAttachmentsInvalid},
		{[]string{dir + "/x.PNG"}, textImageAttachmentsInvalid},
		{[]string{" "}, textImageAttachmentsInvalid},
	}
	for _, item := range cases {
		if _, err := readImages(item.paths); !strings.Contains(fmtErr(err), item.want) {
			t.Fatalf("%v: %v", item.paths, err)
		}
	}
	images, err := readImages([]string{small, small})
	if err != nil || len(images) != 2 || images[0].MediaType != "image/jpeg" {
		t.Fatalf("допустимые вложения: %v", err)
	}
}

func TestManagerEventsDelivery(t *testing.T) {
	rules := append(append([]fakeRule{}, claudeReady...), fakeRule{Prefix: []string{"-p"}, LineDelayMs: 5, Lines: []string{
		`{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"a"}}}`,
		`{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"b"}}}`,
		`{"type":"stream_event","event":{"delta":{"type":"text_delta","text":""}}}`,
		`{"type":"result","subtype":"success","result":"ab"}`,
	}})
	manager, _, _ := testManager(t, &Settings{Provider: Claude}, map[string]fakeScenario{"claude": {Rules: rules}}, Options{})
	// Паникующий и отписанный подписчики не мешают остальным; подписчик может читать менеджер.
	manager.OnEvent(func(Event) { panic("подписчик") })
	removed := 0
	unsubscribe := manager.OnEvent(func(Event) { removed++ })
	unsubscribe()
	log := watch(manager)
	manager.OnEvent(func(event Event) { manager.Get(event.JobID) })
	if _, err := manager.Start(StartInput{Project: testProject(t, "{}"), Task: "T", Prompt: "P"}); err != nil {
		t.Fatal(err)
	}
	final := log.wait(t)
	log.mu.Lock()
	defer log.mu.Unlock()
	if removed != 0 || final.Job.Result != "ab" || final.Job.Status != StatusCompleted {
		t.Fatalf("итог %+v, отписанный получил %d", final.Job, removed)
	}
	for index, event := range log.events {
		if event.Sequence != index+1 {
			t.Fatalf("порядок событий: %d на месте %d", event.Sequence, index+1)
		}
	}
	if empty := log.events[3]; empty.Type != EventTextDelta || empty.Text == nil || *empty.Text != "" {
		t.Fatalf("пустая дельта %+v", empty)
	}
}

func TestHistoryRead(t *testing.T) {
	local := t.TempDir()
	history := NewHistory(local)
	if jobs := history.Read(); len(jobs) != 0 {
		t.Fatal("нет каталога — пустая история")
	}
	valid := Job{SchemaVersion: 1, ID: "00000000-0000-4000-8000-00000000000a", Project: "/p", Provider: Claude, Task: "T",
		Permissions: PermissionsReadOnly, InputHashes: InputHashes{Prompt: strings.Repeat("a", 64), Context: strings.Repeat("b", 64)},
		Status: StatusCompleted, Phase: "Завершено", StartedAt: "x"}
	if err := history.Write(valid); err != nil {
		t.Fatal(err)
	}
	broken := []string{
		`{"schemaVersion":2}`,
		strings.Replace(mustJSON(t, valid), `"claude"`, `"gemini"`, 1),
		strings.Replace(mustJSON(t, valid), `"sequence":0`, `"sequence":-1`, 1),
		strings.Replace(mustJSON(t, valid), `"exitCode":null`, `"exitCode":1.5`, 1),
		strings.Replace(mustJSON(t, valid), `"read-only"`, `"all"`, 1),
		strings.Replace(mustJSON(t, valid), strings.Repeat("a", 64), "short", 1),
	}
	for index, text := range broken {
		id := "00000000-0000-4000-8000-00000000000" + strconv.Itoa(index)
		writeTestFile(t, filepath.Join(local, "jobs", "agent-"+id+".json"), []byte(strings.ReplaceAll(text, valid.ID, id)))
	}
	writeTestFile(t, filepath.Join(local, "jobs", "agent-00000000-0000-4000-8000-00000000000f.json"), make([]byte, historyLimit+1))
	jobs := history.Read()
	if len(jobs) != 1 || jobs[0].ID != valid.ID {
		t.Fatalf("прочитано %+v", jobs)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestCheckTimeoutAndLaunch(t *testing.T) {
	dir := fakeDir(t, map[string]fakeScenario{"codex": {Rules: []fakeRule{{Args: []string{"--version"}, Hang: true}}}})
	options := fakeOptions(t, dir)
	options.Timeout = 300 * time.Millisecond
	result, err := CheckAgent(context.Background(), Settings{Provider: Codex}, options)
	if err != nil || result.Availability != Unavailable || result.Message != textCheckTimeout {
		t.Fatalf("тайм-аут проверки %+v %v", result, err)
	}
	if _, err := CheckAgent(context.Background(), Settings{Provider: "x"}, options); err == nil {
		t.Fatal("неизвестный агент")
	}
	// Файл без права исполнения не считается найденной программой.
	plain := t.TempDir()
	writeTestFile(t, filepath.Join(plain, "claude"), []byte("#!/bin/sh\n"))
	result, _ = CheckAgent(context.Background(), Settings{Provider: Claude}, fakeOptions(t, plain))
	if result.Availability != NotFound {
		t.Fatalf("файл без x: %+v", result)
	}
}
