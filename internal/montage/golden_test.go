package montage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"songframe-go/internal/golden"
	"songframe-go/internal/jobs"
	"songframe-go/internal/jscompat"
)

// Эталон testdata/golden/montage/cases.json фиксирует операции монтажа: черновики, экспорт и
// применение, путь и копию пробы, восстановление прерванной публикации.
// Сценарий — последовательность шагов над пустой папкой проекта: входные операции (write, remove,
// mkdir, mtime) и действия с ожидаемым исходом (result/error, записанные файлы, запущенное
// задание, копия пробы, дерево после восстановления).

// goldenScenario — сценарий эталона; шаги сохраняются сырыми, чтобы сравнивать исход целиком.
type goldenScenario struct {
	Name  string            `json:"name"`
	Steps []json.RawMessage `json:"steps"`
}

// fakeJobs — Starter теста: записывает параметры jobs.Start и возвращает job-N, как capture.
type fakeJobs struct{ started []jobs.Spec }

func (f *fakeJobs) Start(spec jobs.Spec) (jobs.Info, error) {
	f.started = append(f.started, spec)
	return jobs.Info{ID: "job-" + strconv.Itoa(len(f.started)), Kind: spec.Kind, Title: spec.Title, Status: jobs.StatusRunning}, nil
}

// jobJSON — сведения о задании подставного менеджера в форме эталона: только id, kind, title и
// status.
func jobJSON(info jobs.Info) map[string]any {
	return map[string]any{"id": info.ID, "kind": string(info.Kind), "title": info.Title, "status": string(info.Status)}
}

// startedJSON — аргументы jobs.start в форме эталона.
func startedJSON(spec jobs.Spec) map[string]any {
	steps := []any{}
	for _, step := range spec.Steps {
		args := []any{}
		for _, arg := range step.Args {
			args = append(args, arg)
		}
		steps = append(steps, map[string]any{"tool": step.Tool, "args": args, "label": step.Label})
	}
	return map[string]any{"kind": string(spec.Kind), "title": spec.Title, "project": spec.Project, "steps": steps}
}

var (
	anyUUID = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	anyTime = regexp.MustCompile(`"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"`)
	marker  = regexp.MustCompile(`<uuid\d+>`)
)

// marks — нормализация исхода, как в эталоне: пути проекта и назначения — маркерами, случайные
// UUID — <uuidN> по первому появлению, время изменения в пределах прогона — <time>.
type marks struct {
	project, out string
	started      time.Time
	ids          map[string]string
	names        map[string]string
}

func (m *marks) mark(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(strings.ReplaceAll(string(data), m.project, "<project>"), m.out, "<out>")
	text = anyUUID.ReplaceAllStringFunc(text, func(id string) string {
		if strings.HasPrefix(id, "00000000-") {
			return id
		}
		if _, ok := m.ids[id]; !ok {
			name := "<uuid" + strconv.Itoa(len(m.ids)+1) + ">"
			m.ids[id], m.names[name] = name, id
		}
		return m.ids[id]
	})
	text = anyTime.ReplaceAllStringFunc(text, func(match string) string {
		moment, err := time.Parse("2006-01-02T15:04:05.000Z", strings.Trim(match, `"`))
		if err == nil && !moment.Before(m.started.Add(-time.Second)) && !moment.After(time.Now().Add(time.Minute)) {
			return `"<time>"`
		}
		return match
	})
	var result any
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func (m *marks) unmark(text string) string {
	text = strings.ReplaceAll(strings.ReplaceAll(text, "<project>", m.project), "<out>", m.out)
	return marker.ReplaceAllStringFunc(text, func(name string) string {
		if id, ok := m.names[name]; ok {
			return id
		}
		return name
	})
}

// treeText — снимок дерева: каталоги «dir», файлы — текстом UTF-8, ключи по возрастанию.
func treeText(t *testing.T, root string) map[string]any {
	t.Helper()
	result := map[string]any{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || path == root {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		if info.IsDir() {
			result[filepath.ToSlash(relative)] = "dir"
			return nil
		}
		data, err := os.ReadFile(path)
		result[filepath.ToSlash(relative)] = jscompat.DecodeUTF8(data)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// jsonParse — сообщение JSON.parse V8 (позиция и строка) в Go другое: такие ошибки сверяются
// по тексту до причины и после неё.
var jsonParse = regexp.MustCompile(`^(Не удалось прочитать .*?: )(?:Expected|Unexpected|Unterminated|Bad).*?(\. Файл сохранён; .*)$`)

// sameError сравнивает текст ошибки с эталоном с поправкой на jsonParse.
func sameError(want, got string) bool {
	if want == got {
		return true
	}
	parts := jsonParse.FindStringSubmatch(want)
	return parts != nil && strings.HasPrefix(got, parts[1]) && strings.HasSuffix(got, parts[2])
}

// TestMontageGolden воспроизводит сценарии эталона и сверяет каждый исход действия.
func TestMontageGolden(t *testing.T) {
	var file struct {
		Scenarios []goldenScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "montage", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range file.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			work, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			m := &marks{project: filepath.Join(work, "project"), out: filepath.Join(work, "out"), started: time.Now(), ids: map[string]string{}, names: map[string]string{}}
			for _, dir := range []string{m.project, m.out} {
				if err := os.Mkdir(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			starter := &fakeJobs{}
			service := New(starter)
			for index, raw := range scenario.Steps {
				var expected map[string]any
				if err := json.Unmarshal(raw, &expected); err != nil {
					t.Fatal(err)
				}
				var step map[string]json.RawMessage
				if err := json.Unmarshal([]byte(m.unmark(string(raw))), &step); err != nil {
					t.Fatal(err)
				}
				var op string
				_ = json.Unmarshal(step["op"], &op)
				text := func(key string) string {
					var value string
					_ = json.Unmarshal(step[key], &value)
					return value
				}
				path := func() string { return filepath.Join(m.project, filepath.FromSlash(text("path"))) }
				draft := func() any {
					value, err := ParseDraft(step["draft"])
					if err != nil {
						t.Fatal(err)
					}
					return value
				}
				outcome := map[string]any{}
				done := func(result any, err error) {
					if err != nil {
						outcome["error"] = err.Error()
						return
					}
					outcome["result"] = result
				}
				before := len(starter.started)
				switch op {
				case "write":
					if err := os.MkdirAll(filepath.Dir(path()), 0o755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path(), []byte(text("text")), 0o644); err != nil {
						t.Fatal(err)
					}
					continue
				case "remove":
					if err := os.RemoveAll(path()); err != nil {
						t.Fatal(err)
					}
					continue
				case "mkdir":
					if err := os.MkdirAll(path(), 0o755); err != nil {
						t.Fatal(err)
					}
					continue
				case "mtime":
					var seconds float64
					_ = json.Unmarshal(step["seconds"], &seconds)
					moment := time.Unix(0, int64(seconds*1e9))
					if err := os.Chtimes(path(), moment, moment); err != nil {
						t.Fatal(err)
					}
					continue
				case "view":
					done(ViewProject(m.project))
				case "load":
					value, err := Load(m.project, text("id"))
					done(jscompat.Raw(value), err)
				case "save":
					var id *string
					if _, ok := step["id"]; ok {
						value := text("id")
						id = &value
					}
					saved, err := Save(m.project, draft(), id)
					done(saved, err)
					name := saved.ID
					if err != nil && id != nil {
						name = *id
					}
					if name != "" {
						rel := "plan/montage/" + name + ".json"
						if info, err := os.Lstat(filepath.Join(m.project, filepath.FromSlash(rel))); err == nil && info.Mode().IsRegular() {
							data, _ := os.ReadFile(filepath.Join(m.project, filepath.FromSlash(rel)))
							outcome["files"] = map[string]any{rel: string(data)}
						}
					}
				case "export":
					result, err := service.Export(m.project, draft())
					if err != nil {
						done(nil, err)
						break
					}
					done(map[string]any{"job": jobJSON(result.Job), "video": result.Video}, nil)
					folder := filepath.ToSlash(filepath.Dir(filepath.FromSlash(result.Video)))
					files := map[string]any{}
					for _, name := range []string{"montage.json", "review-spec.json"} {
						data, err := os.ReadFile(filepath.Join(m.project, filepath.FromSlash(folder), name))
						if err != nil {
							t.Fatal(err)
						}
						files[folder+"/"+name] = string(data)
					}
					outcome["files"] = files
				case "apply":
					info, err := service.Apply(m.project, draft())
					if err != nil {
						done(nil, err)
						break
					}
					done(jobJSON(info), nil)
					spec := starter.started[len(starter.started)-1].Steps[0].Args[1]
					data, err := os.ReadFile(filepath.Join(m.project, filepath.FromSlash(spec)))
					if err != nil {
						t.Fatal(err)
					}
					outcome["files"] = map[string]any{spec: string(data)}
				case "videoPath":
					done(VideoPath(m.project, text("video")))
				case "copyVideo":
					target, err := CopyVideo(m.project, text("video"), text("destination"))
					done(target, err)
					if err == nil {
						data, _ := os.ReadFile(target)
						outcome["copied"] = string(data)
					}
					outcome["out"] = treeText(t, m.out)
				case "recover":
					err := RecoverApplications(m.project)
					done(nil, err)
					outcome["tree"] = treeText(t, m.project)
				default:
					t.Fatalf("неизвестный шаг %q", op)
				}
				if len(starter.started) > before {
					outcome["started"] = startedJSON(starter.started[len(starter.started)-1])
				}
				// Порядок ключей как у { ...item, ...outcome }: UUID нумеруются по первому появлению.
				ordered := []string{"result", "error", "files", "copied", "out", "tree", "started"}
				got := map[string]any{}
				for _, key := range ordered {
					if value, ok := outcome[key]; ok {
						got[key] = m.mark(t, value)
					}
				}
				for _, key := range ordered {
					want, wantOK := expected[key]
					value, gotOK := got[key]
					if key == "error" && wantOK && gotOK && sameError(want.(string), value.(string)) {
						continue
					}
					if wantOK != gotOK || !reflect.DeepEqual(want, value) {
						t.Errorf("шаг %d (%s) %s:\n got  %s\n want %s", index, op, key, short(value), short(want))
					}
				}
			}
		})
	}
}

// short — JSON значения для сообщения, с ограничением длины.
func short(value any) string {
	data, _ := json.Marshal(value)
	text := string(data)
	if len(text) > 1500 {
		text = text[:1500] + "…"
	}
	return text
}
