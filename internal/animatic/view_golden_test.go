package animatic

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/jobs"
)

// viewStep — шаг сценария эталона animatic-view: запись/удаление файла, fixture или вызов
// view / setStatus / build с ожидаемым исходом.
type viewStep struct {
	Op       string          `json:"op"`
	Path     string          `json:"path"`
	Text     string          `json:"text"`
	Status   json.RawMessage `json:"status"`
	Decision string          `json:"decision"`
	PlanOnly bool            `json:"planOnly"`
	Result   json.RawMessage `json:"result"`
	Error    *string         `json:"error"`
	Start    json.RawMessage `json:"start"`
}

type viewScenario struct {
	Name  string     `json:"name"`
	Base  *string    `json:"base"`
	Steps []viewStep `json:"steps"`
}

// viewCases — cases.json домена: общий вход проверок свежести и сценарии.
type viewCases struct {
	Fixture   []viewStep     `json:"fixture"`
	Scenarios []viewScenario `json:"scenarios"`
}

func decodeJSON(t *testing.T, data []byte) any {
	t.Helper()
	var value any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("JSON %s: %v", data, err)
	}
	return value
}

// TestViewGolden воспроизводит сценарии эталона (вид, принятие, сборка) и сверяет вид, тексты
// ошибок, текст production-status.json и аргументы задания.
func TestViewGolden(t *testing.T) {
	var cases viewCases
	if err := json.Unmarshal(golden.ReadFile(t, "animatic-view", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.Scenarios) == 0 {
		t.Fatal("нет сценариев")
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range cases.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			work, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			project := filepath.Join(work, "project")
			if err := os.MkdirAll(project, 0o755); err != nil {
				t.Fatal(err)
			}
			if scenario.Base != nil {
				if err := os.CopyFS(project, os.DirFS(filepath.Join(root, filepath.FromSlash(*scenario.Base)))); err != nil {
					t.Fatal(err)
				}
			}
			write := func(path, text string) {
				full := filepath.Join(project, filepath.FromSlash(path))
				if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			statusPath := filepath.Join(project, "plan", "production-status.json")
			manifestPath := filepath.Join(project, "plan", "animatic", "latest", "manifest.json")
			readStatusText := func() any {
				data, err := os.ReadFile(statusPath)
				if err != nil {
					return nil
				}
				return string(data)
			}
			for _, step := range scenario.Steps {
				label := scenario.Name + "#" + step.Op
				switch step.Op {
				case "fixture":
					for _, item := range cases.Fixture {
						write(item.Path, item.Text)
					}
					continue
				case "write":
					write(step.Path, step.Text)
					continue
				case "remove":
					if err := os.RemoveAll(filepath.Join(project, filepath.FromSlash(step.Path))); err != nil {
						t.Fatal(err)
					}
					continue
				}
				statusBefore := readStatusText()
				var result any
				var callErr error
				var start any
				switch step.Op {
				case "view":
					result, callErr = ViewAnimatic(project)
				case "setStatus":
					result, callErr = SetStatus(project, step.Decision)
				case "build":
					var spec *jobs.Spec
					service := &Service{start: func(s jobs.Spec) (jobs.Info, error) { spec = &s; return jobs.Info{ID: "job"}, nil }}
					_, callErr = service.Build(project, step.PlanOnly)
					if spec != nil {
						steps := []any{}
						for _, item := range spec.Steps {
							steps = append(steps, map[string]any{"tool": item.Tool, "args": item.Args, "label": item.Label})
						}
						start = []any{string(spec.Kind), spec.Title, spec.Project, steps}
					}
				default:
					t.Fatalf("неизвестный шаг %s", step.Op)
				}
				normalize := func(text string) string { return strings.ReplaceAll(text, project, "<project>") }
				if step.Error != nil {
					if callErr == nil || normalize(callErr.Error()) != *step.Error {
						t.Fatalf("%s: ошибка %v, ждали %q", label, callErr, *step.Error)
					}
				} else if callErr != nil {
					t.Fatalf("%s: %v", label, callErr)
				}
				if step.Op == "build" {
					want := decodeJSON(t, step.Start)
					data, _ := json.Marshal(start)
					got := decodeJSON(t, []byte(normalize(string(data))))
					if !reflect.DeepEqual(want, got) {
						t.Fatalf("%s: start %s, ждали %s", label, data, step.Start)
					}
				}
				if step.Error == nil && step.Op != "build" {
					view := result.(View)
					if view.Built != nil {
						info, err := os.Stat(manifestPath)
						if err != nil || view.Built.BuiltAt != info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z") {
							t.Fatalf("%s: builtAt %s не mtime манифеста", label, view.Built.BuiltAt)
						}
						view.Built.BuiltAt = "<mtime>"
					}
					data, err := json.Marshal(view)
					if err != nil {
						t.Fatal(err)
					}
					want := decodeJSON(t, step.Result)
					got := decodeJSON(t, []byte(normalize(string(data))))
					if !reflect.DeepEqual(want, got) {
						t.Fatalf("%s: вид\n%s\nждали\n%s", label, normalize(string(data)), step.Result)
					}
				}
				if step.Op == "setStatus" {
					want := decodeJSON(t, step.Status)
					if got := readStatusText(); !reflect.DeepEqual(want, got) {
						t.Fatalf("%s: production-status %v, ждали %v", label, got, want)
					}
				} else if !reflect.DeepEqual(readStatusText(), statusBefore) {
					t.Fatalf("%s изменил production-status", label)
				}
			}
		})
	}
}
