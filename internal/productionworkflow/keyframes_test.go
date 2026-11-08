package productionworkflow

import (
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/agents"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/providers/agentexec"
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
