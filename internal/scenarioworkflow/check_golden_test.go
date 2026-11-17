package scenarioworkflow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
)

// Эталоны testdata/golden/scenario-check описывают проверку сценария агентом с поддельным
// менеджером агентов: вид до запуска, вход задания (промпт, контекст и имена вложений), итог
// задания и запись plan/scenario-check.json. Копии изображений сравниваются по составу: их байты
// зависят от кодировщика JPEG.

// checkStep — шаг case.json эталона проверки.
type checkStep struct {
	Op      string          `json:"op"`
	Result  *string         `json:"result"`
	Message *string         `json:"message"`
	Path    string          `json:"path"`
	Text    *string         `json:"text"`
	View    json.RawMessage `json:"view"`
	Error   *string         `json:"error"`
	Agent   *struct {
		Task    string   `json:"task"`
		Context string   `json:"context"`
		Images  []string `json:"images"`
	} `json:"agent"`
}

func TestGoldenCheck(t *testing.T) {
	prompt := string(golden.ReadFile(t, "scenario-check", "prompt.txt"))
	for _, item := range golden.Load(t, "scenario-check") {
		t.Run(item.Name, func(t *testing.T) {
			var spec struct {
				Steps []checkStep `json:"steps"`
			}
			if err := json.Unmarshal(item.Read(t, "case.json"), &spec); err != nil {
				t.Fatal(err)
			}
			path := item.BuildProject(t)
			project, err := filepath.EvalSymlinks(path)
			if err != nil {
				t.Fatal(err)
			}
			localDir := filepath.Join(t.TempDir(), "state")
			agents := &fakeAgents{}
			workflow := New(Options{LocalDir: localDir, Agents: agents})
			names := &normalizer{project: project, state: localDir}
			for index, step := range spec.Steps {
				label := item.Name + "#" + itoa(index) + " " + step.Op
				var view CheckView
				var err error
				ran := true
				switch step.Op {
				case "view":
					view, err = workflow.CheckView(path)
				case "start":
					count := len(agents.inputs)
					view, err = workflow.StartCheck(path)
					if (step.Agent != nil) != (len(agents.inputs) > count) {
						t.Fatalf("%s: запуск агента %v, в эталоне %v", label, len(agents.inputs) > count, step.Agent != nil)
					}
					if step.Agent != nil {
						input := agents.inputs[len(agents.inputs)-1]
						if input.Task != step.Agent.Task || input.Prompt != prompt {
							t.Fatalf("%s: задание %s или промпт отличаются от эталона", label, input.Task)
						}
						if want := string(item.Read(t, step.Agent.Context)); input.Context != want {
							golden.AssertJSON(t, []byte(want), []byte(input.Context))
							t.Fatalf("%s: контекст отличается порядком или форматом", label)
						}
						images := []string{}
						for _, image := range input.Images {
							if !strings.HasPrefix(image, localDir) {
								t.Fatalf("%s: вложение вне каталога состояния: %s", label, image)
							}
							images = append(images, filepath.Base(image))
						}
						if strings.Join(images, ",") != strings.Join(step.Agent.Images, ",") {
							t.Fatalf("%s: вложения %v, в эталоне %v", label, images, step.Agent.Images)
						}
					}
				case "finish":
					agents.update(func(job *AgentJob) {
						job.Status, job.ExitCode, job.Result = "completed", new(int), *step.Result
					})
					ran = false
				case "cancel":
					agents.update(func(job *AgentJob) { job.Status, job.ExitCode = "cancelled", nil })
					ran = false
				case "fail":
					agents.update(func(job *AgentJob) {
						code := 1
						job.Status, job.ExitCode, job.Message = "failed", &code, *step.Message
					})
					ran = false
				case "drop":
					agents.mu.Lock()
					agents.jobs = nil
					agents.mu.Unlock()
					ran = false
				case "write":
					if err := os.WriteFile(filepath.Join(project, filepath.FromSlash(step.Path)), []byte(*step.Text), 0o644); err != nil {
						t.Fatal(err)
					}
					ran = false
				case "editCast":
					editCast(t, project)
					ran = false
				default:
					t.Fatalf("%s: неизвестный шаг", label)
				}
				if !ran {
					continue
				}
				if step.Error != nil {
					if err == nil || names.text(err.Error()) != *step.Error {
						t.Fatalf("%s: ошибка %v, в эталоне %q", label, err, *step.Error)
					}
					continue
				}
				if err != nil {
					t.Fatalf("%s: %v", label, err)
				}
				got, err := json.Marshal(view)
				if err != nil {
					t.Fatal(err)
				}
				if diffs, err := golden.Diff(step.View, []byte(names.text(string(got)))); err != nil || len(diffs) > 0 {
					t.Fatalf("%s: вид отличается от эталона: %v %s\n%s", label, err, strings.Join(diffs, "\n"), got)
				}
			}
			want := item.Read(t, "record.json")
			got, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(CheckPath)))
			if os.IsNotExist(err) {
				got = []byte("null\n")
			} else if err != nil {
				t.Fatal(err)
			}
			if string(want) != names.text(string(got)) {
				golden.AssertJSON(t, want, []byte(names.text(string(got))))
				t.Fatalf("запись проверки отличается порядком или форматом")
			}
		})
	}
}
