package scenarioworkflow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
)

// Эталоны testdata/golden/reference-advice описывают рекомендации по референсам с поддельным
// менеджером агентов: вид до запуска, вход задания (промпт и контекст, вложений нет), итог
// задания и запись plan/batches/proposals/reference-advice.json.

// adviceStep — шаг case.json эталона рекомендаций.
type adviceStep struct {
	Op      string          `json:"op"`
	Result  *string         `json:"result,omitempty"`
	Message *string         `json:"message,omitempty"`
	View    json.RawMessage `json:"view,omitempty"`
	Error   *string         `json:"error,omitempty"`
	Context string          `json:"context,omitempty"`
	Text    *string         `json:"text,omitempty"`
}

func TestGoldenAdvice(t *testing.T) {
	prompt := string(golden.ReadFile(t, "reference-advice", "prompt.txt"))
	for _, item := range golden.Load(t, "reference-advice") {
		t.Run(item.Name, func(t *testing.T) {
			var spec struct {
				Steps []adviceStep `json:"steps"`
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
				var view AdviceView
				var err error
				ran := true
				switch step.Op {
				case "view":
					view, err = workflow.AdviceView(path)
				case "start":
					count := len(agents.inputs)
					view, err = workflow.StartAdvice(path)
					if (step.Context != "") != (len(agents.inputs) > count) {
						t.Fatalf("%s: запуск агента %v, в эталоне %v", label, len(agents.inputs) > count, step.Context != "")
					}
					if step.Context != "" {
						input := agents.inputs[len(agents.inputs)-1]
						if input.Task != AdviceTask || input.Prompt != prompt || len(input.Images) != 0 || input.Place == nil || input.Place.Page != "cast" {
							t.Fatalf("%s: задание %s, промпт, вложения или место отличаются от эталона", label, input.Task)
						}
						if want := string(item.Read(t, step.Context)); input.Context != want {
							golden.AssertJSON(t, []byte(want), []byte(input.Context))
							t.Fatalf("%s: контекст отличается порядком или форматом", label)
						}
					}
				case "finish":
					agents.update(func(job *AgentJob) {
						job.Status, job.ExitCode, job.Result = "completed", new(int), *step.Result
					})
					ran = false
				case "fail":
					agents.update(func(job *AgentJob) {
						code := 1
						job.Status, job.ExitCode, job.Message = "failed", &code, *step.Message
					})
					ran = false
				case "markdown":
					text, err := workflow.AdviceMarkdown(path)
					if step.Error != nil {
						if err == nil || err.Error() != *step.Error {
							t.Fatalf("%s: ошибка %v, в эталоне %q", label, err, *step.Error)
						}
					} else if err != nil || text != *step.Text {
						t.Fatalf("%s: %v\n%s", label, err, text)
					}
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
			got, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(AdvicePath)))
			if os.IsNotExist(err) {
				got = []byte("null\n")
			} else if err != nil {
				t.Fatal(err)
			}
			if string(want) != names.text(string(got)) {
				golden.AssertJSON(t, want, []byte(names.text(string(got))))
				t.Fatalf("запись рекомендаций отличается порядком или форматом")
			}
		})
	}
}
