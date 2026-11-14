package productionworkflow

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/mediaapi"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
	"songframe/internal/providers/agentexec"
	"songframe/internal/providers/codex"
)

// tinyPNG — PNG 1×1 RGB, декодируемый целиком.
var tinyPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
	0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
	0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
}

// keyframesFixture — проект с одним референсом и KeyframeImages, у которого каталог состояния
// задан через символическую ссылку.
func keyframesFixture(t *testing.T) (*KeyframeImages, *imageAgents, mediaapi.ImagesInput) {
	t.Helper()
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(work, "project")
	if err := os.MkdirAll(filepath.Join(project, "source"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "source", "boat.png"), tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(work, "state")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(work, "state-link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	manager := &imageAgents{fakeAgents: &fakeAgents{}}
	images := &KeyframeImages{LocalDir: link, Agents: manager}
	input := mediaapi.ImagesInput{
		Project: project, Shot: "M01",
		Frames: []mediaapi.FramePrompt{{ID: "K01", Role: "first", Prompt: "Лодка", ReferencePaths: []string{"source/boat.png"}}},
	}
	return images, manager, input
}

// finishJob завершает последнее задание ответом answer и, если file не пуст, пишет кандидата.
func finishJob(t *testing.T, manager *imageAgents, file, answer string) agents.Job {
	t.Helper()
	if file != "" {
		if err := os.WriteFile(filepath.Join(manager.images[len(manager.images)-1].workDir, file), tinyPNG, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	job := manager.last(t)
	code := 0
	job.Status, job.ExitCode, job.Result = "completed", &code, answer
	return *job
}

func TestKeyframeImagesSymlinkedStateDir(t *testing.T) {
	images, manager, input := keyframesFixture(t)
	job, err := images.Start(input, agentexec.ImagesRequest{Provider: "test-agent", RequestSha: "sha", Agent: agents.Settings{Provider: "codex"}})
	if err != nil {
		t.Fatal(err)
	}
	if dir := manager.images[0].workDir; filepath.Dir(filepath.Dir(dir)) == images.LocalDir {
		t.Fatalf("рабочая папка не разыменована: %s", dir)
	}
	job = finishJob(t, manager, "K01.png", `{"schemaVersion":1,"stage":"frames","images":[{"id":"K01","path":"K01.png"}]}`)
	candidates, err := images.Collect(job)
	if err != nil {
		t.Fatalf("кандидат в каталоге состояния через ссылку отклонён: %v", err)
	}
	if len(candidates) != 1 || candidates[0].ID != "K01" || filepath.Base(candidates[0].Path) != "K01.png" {
		t.Fatalf("кандидаты %+v", candidates)
	}
}

func TestKeyframeImagesCollectRefusals(t *testing.T) {
	for _, test := range []struct{ name, file, answer, want string }{
		// Ответ не JSON и отсутствующий файл кандидата дают понятные отказы.
		{"не JSON", "", "Не могу нарисовать", "Тестовый агент изображений не вернул список файлов опор."},
		{"нет файла", "", `{"schemaVersion":1,"stage":"frames","images":[{"id":"K01","path":"K01.png"}]}`, "Опора K01: нужен настоящий файл изображения в папке кандидатов."},
	} {
		t.Run(test.name, func(t *testing.T) {
			images, manager, input := keyframesFixture(t)
			if _, err := images.Start(input, agentexec.ImagesRequest{Provider: "test-agent", RequestSha: "sha", Agent: agents.Settings{Provider: "codex"}}); err != nil {
				t.Fatal(err)
			}
			job := finishJob(t, manager, test.file, test.answer)
			if _, err := images.Collect(job); err == nil || err.Error() != test.want {
				t.Fatalf("ошибка %v, ожидалась %q", err, test.want)
			}
		})
	}
}

// failingImageAgents — менеджер, который не запускает задание опор.
type failingImageAgents struct{}

func (failingImageAgents) StartImages(agents.StartInput, string, agents.Settings) (agents.Job, error) {
	return agents.Job{}, errors.New("программа не запустилась")
}

// jobFolderNames — имена рабочих папок заданий опор каталога состояния local.
func jobFolderNames(t *testing.T, local string) []string {
	t.Helper()
	names, err := readDirNames(filepath.Join(local, ImageJobsFolder))
	if err != nil {
		t.Fatal(err)
	}
	return names
}

// Ошибка Start — неверный референс или отказ менеджера агентов — не оставляет рабочую папку:
// без job.json задание всё равно не собрать.
func TestKeyframeImagesStartFailureRemovesFolder(t *testing.T) {
	images, _, input := keyframesFixture(t)
	missing := input
	missing.Frames = []mediaapi.FramePrompt{{ID: "K01", Role: "first", Prompt: "Лодка", ReferencePaths: []string{"source/boat.png", "source/нет.png"}}}
	if _, err := images.Start(missing, agentexec.ImagesRequest{Provider: "test-agent", RequestSha: "sha", Agent: agents.Settings{Provider: "codex"}}); err == nil {
		t.Fatal("референс вне проекта принят")
	}
	if names := jobFolderNames(t, images.LocalDir); len(names) != 0 {
		t.Fatalf("после ошибки референса остались папки %v", names)
	}
	failing := &KeyframeImages{LocalDir: images.LocalDir, Agents: failingImageAgents{}}
	if _, err := failing.Start(input, agentexec.ImagesRequest{Provider: "test-agent", RequestSha: "sha", Agent: agents.Settings{Provider: "codex"}}); err == nil {
		t.Fatal("ошибка запуска не возвращена")
	}
	if names := jobFolderNames(t, images.LocalDir); len(names) != 0 {
		t.Fatalf("после ошибки запуска остались папки %v", names)
	}
}

// Уборка при первом обращении удаляет папки, которые уже не соберут, и сохраняет папку задания,
// которое ждёт запись предложения running, и папки не своего вида. Уборка однократна.
func TestKeyframeImagesSweepKeepsPendingJobs(t *testing.T) {
	work := t.TempDir()
	local, project := filepath.Join(work, "state"), filepath.Join(work, "project")
	base := filepath.Join(local, ImageJobsFolder)
	folder := func(name string, record map[string]any) string {
		t.Helper()
		directory := filepath.Join(base, name)
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		// Закреплённая копия только для чтения не мешает удалению.
		if err := os.WriteFile(filepath.Join(directory, "reference-01.png"), tinyPNG, 0o444); err != nil {
			t.Fatal(err)
		}
		if record != nil {
			data, _ := json.Marshal(record)
			if err := os.WriteFile(filepath.Join(directory, "job.json"), data, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return name
	}
	proposal := func(shot, jobID, status string, imageJob bool) {
		t.Helper()
		data, _ := json.Marshal(map[string]any{"imageJob": imageJob, "proposal": map[string]any{"id": "p-" + shot, "jobId": jobID, "status": status}})
		path := Store{}.Path(project, shot)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	job := func(id, owner string) map[string]any {
		return map[string]any{"schemaVersion": 1, "jobId": id, "project": owner}
	}
	proposal("M01", "job-pending", "running", true)
	proposal("M02", "job-ready", "ready", true)
	proposal("M03", "job-text", "running", false)
	pending := folder("11111111-1111-4111-8111-111111111111", job("job-pending", project))
	// Удаляются: запись уже ready, запись не опор, записи нет, нет job.json, проект пропал.
	folder("22222222-2222-4222-8222-222222222222", job("job-ready", project))
	folder("33333333-3333-4333-8333-333333333333", job("job-text", project))
	folder("44444444-4444-4444-8444-444444444444", job("job-unknown", project))
	folder("55555555-5555-4555-8555-555555555555", nil)
	folder("66666666-6666-4666-8666-666666666666", job("job-pending", filepath.Join(work, "нет-проекта")))
	foreign := folder("не-задание", nil)

	images := &KeyframeImages{LocalDir: local}
	if _, err := images.RequestSha(agents.Job{ID: "job-pending", Project: project}); err == nil {
		t.Fatal("RequestSha записи без requestSha")
	}
	names := jobFolderNames(t, local)
	if len(names) != 2 || names[0] != pending || names[1] != foreign {
		t.Fatalf("после уборки %v, ожидались %s и %s", names, pending, foreign)
	}
	// Второе обращение того же значения папки не трогает: уборка только при первом.
	later := folder("77777777-7777-4777-8777-777777777777", nil)
	if _, err := images.Collect(agents.Job{ID: "job-pending"}); err == nil {
		t.Fatal("незавершённое задание собрано")
	}
	if names := jobFolderNames(t, local); len(names) != 3 || names[1] != later {
		t.Fatalf("повторная уборка: %v", names)
	}
}

// framesScenario — первые count шагов сценария name эталона production-frames, выполненные без
// сверки, и прогон с зависимостями как в приложении.
func framesScenario(t *testing.T, name string, count int) *framesRun {
	t.Helper()
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image, mediaproviders.Video},
		Paid: true, DefaultImageResolution: "2k", DefaultImageAspectRatio: "16:9", DefaultImageOutputs: 1, LipSync: &mediaproviders.LipSync{Min: 5, Max: 30}}))
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	t.Cleanup(providers.RegisterAgent(providers.AgentAdapter{ID: "test-agent", Images: func(deps agentexec.Deps) agentexec.Executor { return codex.NewImages(deps) }}))
	var file struct {
		Blobs     map[string]string `json:"blobs"`
		Scenarios []struct {
			Name  string       `json:"name"`
			Steps []framesStep `json:"steps"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "production-frames", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range file.Scenarios {
		if scenario.Name != name {
			continue
		}
		if len(scenario.Steps) < count {
			t.Fatalf("сценарий %s эталона изменился", name)
		}
		run := newFramesRun(t, filepath.Join(root, "checks-base", "project"), file.Blobs)
		for _, step := range scenario.Steps[:count] {
			if _, err := run.execute(t, step); err != nil && step.Error == nil {
				t.Fatal(err)
			}
		}
		return run
	}
	t.Fatalf("нет сценария %s", name)
	return nil
}

// proposalStatus — статус записи предложения плана M01.
func proposalStatus(t *testing.T, run *framesRun) string {
	t.Helper()
	value, ok := dynvalue.ReadJSONFile(Store{}.Path(run.project, "M01"))
	if !ok {
		t.Fatal("нет записи предложения")
	}
	return dynvalue.ToString(dynvalue.GetPath(value, "proposal", "status"))
}

// Рабочая папка задания опор удаляется, как только запись предложения получила итоговый статус:
// кандидаты скопированы в проект (ready) или собирать нечего (invalid, failed).
func TestKeyframeJobFolderReleasedAfterRefresh(t *testing.T) {
	for _, test := range []struct {
		name, scenario string
		steps          int
		status         string
	}{
		// Шаги 0–10 agent-generate: подготовка, запуск, кандидат K01 и успешное завершение.
		{"принято", "agent-generate", 11, "ready"},
		// Шаги 0–6 agent-collect-errors: ответ не JSON.
		{"ответ не JSON", "agent-collect-errors", 7, "invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			run := framesScenario(t, test.scenario, test.steps)
			if names := jobFolderNames(t, run.local); len(names) != 1 {
				t.Fatalf("до показа плана папки %v", names)
			}
			if _, err := run.workflow.View(run.project, "M01", filepath.Join(run.project, "plan", "batches", "M01-attempt-01")); err != nil {
				t.Fatal(err)
			}
			if status := proposalStatus(t, run); status != test.status {
				t.Fatalf("статус %s, ожидался %s", status, test.status)
			}
			if names := jobFolderNames(t, run.local); len(names) != 0 {
				t.Fatalf("рабочая папка осталась: %v", names)
			}
			if test.status == "ready" && !dynvalue.Exists(filepath.Join(Store{}.CopiesDir(run.project, "M01"), "K01.png")) {
				t.Fatal("кандидат не скопирован в проект")
			}
		})
	}
	t.Run("ошибка задания", func(t *testing.T) {
		run := framesScenario(t, "agent-generate", 10)
		job := run.agents.last(t)
		code := 1
		job.Status, job.ExitCode, job.Message = "failed", &code, "сбой"
		if _, err := run.workflow.View(run.project, "M01", filepath.Join(run.project, "plan", "batches", "M01-attempt-01")); err != nil {
			t.Fatal(err)
		}
		if status := proposalStatus(t, run); status != "failed" {
			t.Fatalf("статус %s", status)
		}
		if names := jobFolderNames(t, run.local); len(names) != 0 {
			t.Fatalf("рабочая папка осталась: %v", names)
		}
	})
}

// Задание, завершившееся до перезапуска, собирается после него: уборка нового значения
// KeyframeImages сохраняет папку, которую ждёт запись running, и удаляет брошенную.
func TestKeyframeJobCollectedAfterRestart(t *testing.T) {
	run := framesScenario(t, "agent-generate", 11)
	orphan := filepath.Join(run.local, ImageJobsFolder, "99999999-9999-4999-8999-999999999999")
	if err := os.MkdirAll(orphan, 0o755); err != nil {
		t.Fatal(err)
	}
	run.workflow = run.create()
	if _, err := run.workflow.View(run.project, "M01", filepath.Join(run.project, "plan", "batches", "M01-attempt-01")); err != nil {
		t.Fatal(err)
	}
	if status := proposalStatus(t, run); status != "ready" {
		t.Fatalf("после перезапуска статус %s", status)
	}
	if names := jobFolderNames(t, run.local); len(names) != 0 {
		t.Fatalf("после сбора остались папки %v", names)
	}
}
