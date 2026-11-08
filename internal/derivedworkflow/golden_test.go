package derivedworkflow

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"songframe/internal/assetpackage"
	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/jobs"
	"songframe/internal/montage"
)

// goldenStep — шаг эталона: вход (write/append/remove/rmtree/copy), управление окружением или
// действие Workflow с исходом result/error, изменением дерева и запущенными заданиями.
type goldenStep struct {
	Op        string            `json:"op"`
	Path      string            `json:"path"`
	Text      string            `json:"text"`
	From      string            `json:"from"`
	To        string            `json:"to"`
	Index     int               `json:"index"`
	Status    string            `json:"status"`
	Available bool              `json:"available"`
	Shot      string            `json:"shot"`
	Project   *string           `json:"project"`
	Recipe    json.RawMessage   `json:"recipe"`
	ID        string            `json:"id"`
	Token     string            `json:"token"`
	Replace   bool              `json:"replace"`
	Result    json.RawMessage   `json:"result"`
	Error     *string           `json:"error"`
	Changed   map[string]string `json:"changed"`
	Removed   []string          `json:"removed"`
	Started   json.RawMessage   `json:"started"`
	Tree      map[string]string `json:"tree"`
}

// goldenFile — сценарии эталона testdata/golden/derived-workflow/cases.json.
type goldenFile struct {
	Scenarios []struct {
		Name  string       `json:"name"`
		Base  string       `json:"base"`
		Steps []goldenStep `json:"steps"`
	} `json:"scenarios"`
}

// fakeJobs — подставной менеджер: задания сразу running, статус меняет шаг эталона job.
type fakeJobs struct {
	stored  []*jobs.Info
	started []map[string]any
}

func (f *fakeJobs) Start(spec jobs.Spec) (jobs.Info, error) {
	steps := []map[string]any{}
	info := jobs.Info{ID: fmt.Sprintf("job-%d", len(f.stored)), Kind: spec.Kind, Title: spec.Title, Status: jobs.StatusRunning, Project: &spec.Project}
	for _, step := range spec.Steps {
		steps = append(steps, map[string]any{"tool": step.Tool, "args": step.Args, "label": step.Label})
		info.Steps = append(info.Steps, jobs.StepInfo{Tool: step.Tool, Label: step.Label, Status: jobs.StepRunning})
	}
	f.started = append(f.started, map[string]any{"kind": spec.Kind, "title": spec.Title, "project": spec.Project, "steps": steps})
	f.stored = append(f.stored, &info)
	return info, nil
}

func (f *fakeJobs) List() []jobs.Info {
	result := []jobs.Info{}
	for _, job := range f.stored {
		result = append(result, *job)
	}
	return result
}

func (f *fakeJobs) Get(id string) (jobs.Info, bool) {
	for _, job := range f.stored {
		if job.ID == id {
			return *job, true
		}
	}
	return jobs.Info{}, false
}

var uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// normalizer — нормализация, как в эталоне: путь проекта → <project>, UUID → <uuidN> по первому
// появлению. back возвращает настоящие значения для входа шагов.
type normalizer struct {
	project func() string
	ids     map[string]string
	reverse []string
}

func (n *normalizer) text(value string) string {
	return uuidPattern.ReplaceAllStringFunc(strings.ReplaceAll(value, n.project(), "<project>"), func(id string) string {
		if strings.HasPrefix(id, "c0000000-") {
			return id
		}
		if _, ok := n.ids[id]; !ok {
			n.reverse = append(n.reverse, id)
			n.ids[id] = fmt.Sprintf("<uuid%d>", len(n.reverse))
		}
		return n.ids[id]
	})
}

func (n *normalizer) back(value string) string {
	for index := len(n.reverse) - 1; index >= 0; index-- {
		value = strings.ReplaceAll(value, fmt.Sprintf("<uuid%d>", index+1), n.reverse[index])
	}
	return strings.ReplaceAll(value, "<project>", n.project())
}

// tree — снимок дерева проекта в формате эталона.
func tree(t *testing.T, folder string) map[string]string {
	t.Helper()
	result := map[string]string{}
	textName := regexp.MustCompile(`\.(json|txt|mp4|mp3|md)$`)
	err := filepath.Walk(folder, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		name, _ := filepath.Rel(folder, path)
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if textName.MatchString(info.Name()) && len(data) < 20000 {
			result[filepath.ToSlash(name)] = dynvalue.DecodeUTF8(data)
			return nil
		}
		digest, err := assetpackage.FileSHA256(path)
		if err != nil {
			return err
		}
		result[filepath.ToSlash(name)] = "sha256:" + digest
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// copyProject — копия образца в папку сценария.
func copyProject(t *testing.T, from, to string) {
	t.Helper()
	err := filepath.Walk(from, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		name, _ := filepath.Rel(from, path)
		target := filepath.Join(to, name)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// applyInput выполняет входную операцию шага над проектом.
func applyInput(t *testing.T, project string, step goldenStep, back func(string) string) {
	t.Helper()
	name := step.Path
	if step.Op == "copy" {
		name = step.To
	}
	target := filepath.Join(project, filepath.FromSlash(back(name)))
	var err error
	switch step.Op {
	case "write":
		if err = os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
			err = os.WriteFile(target, []byte(back(step.Text)), 0o644)
		}
	case "append":
		var file *os.File
		if file, err = os.OpenFile(target, os.O_APPEND|os.O_WRONLY, 0); err == nil {
			_, err = file.WriteString(back(step.Text))
			file.Close()
		}
	case "remove":
		err = os.Remove(target)
	case "rmtree":
		err = os.RemoveAll(target)
	case "copy":
		var data []byte
		if data, err = os.ReadFile(filepath.Join(project, filepath.FromSlash(back(step.From)))); err == nil {
			if err = os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
				err = os.WriteFile(target, data, 0o644)
			}
		}
	}
	if err != nil {
		t.Fatalf("%+v: %v", step, err)
	}
}

// decoded — значение JSON-текста для сравнения по смыслу.
func decoded(t *testing.T, text []byte) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(text, &value); err != nil {
		t.Fatalf("%s: %v", text, err)
	}
	return value
}

// sameJSON сравнивает JSON-значения; при расхождении показывает оба.
func sameJSON(t *testing.T, label string, want, got []byte) {
	t.Helper()
	if !reflect.DeepEqual(decoded(t, want), decoded(t, got)) {
		t.Errorf("%s:\n got  %s\n want %s", label, got, want)
	}
}

// diffTrees — изменённые и удалённые файлы между двумя снимками дерева.
func diffTrees(before, after map[string]string) (map[string]string, []string) {
	changed := map[string]string{}
	for path, text := range after {
		if value, ok := before[path]; !ok || value != text {
			changed[path] = text
		}
	}
	removed := []string{}
	for path := range before {
		if _, ok := after[path]; !ok {
			removed = append(removed, path)
		}
	}
	sort.Strings(removed)
	return changed, removed
}

// TestDerivedWorkflowGolden проходит все сценарии эталона на копии образца с подставным
// менеджером заданий: результат или текст ошибки, изменённые файлы побайтно, запущенные задания и
// дерево после восстановления. Текст отказа о недоступных инструментах, записанный в эталоне
// (goldenToolsUnavailable), тест заменяет текстом приложения textToolsUnavailable.
func TestDerivedWorkflowGolden(t *testing.T) {
	var file goldenFile
	if err := json.Unmarshal(golden.ReadFile(t, "derived-workflow", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	const goldenToolsUnavailable = "Для сборки нужны доступные Python и FFmpeg. Проверьте страницу «Среда»."
	for _, item := range file.Scenarios {
		t.Run(item.Name, func(t *testing.T) {
			parent, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			project := filepath.Join(parent, "project")
			if item.Base == "sample" {
				copyProject(t, filepath.Join(root, "checks-base", "project"), project)
			} else if err := os.Mkdir(project, 0o755); err != nil {
				t.Fatal(err)
			}
			fake := &fakeJobs{}
			flow := New(fake)
			count := 0
			previous, ready := montage.RandomUUID, mediaReady
			available := true
			montage.RandomUUID = func() string {
				count++
				return fmt.Sprintf("d0000000-0000-4000-8000-%012d", count)
			}
			mediaReady = func() bool { return available }
			t.Cleanup(func() { montage.RandomUUID, mediaReady = previous, ready })
			names := &normalizer{project: func() string { return project }, ids: map[string]string{}}
			for index, step := range item.Steps {
				switch step.Op {
				case "write", "append", "remove", "rmtree", "copy":
					applyInput(t, project, step, names.back)
					continue
				case "job":
					fake.stored[step.Index].Status = jobs.Status(step.Status)
					continue
				case "clearJobs":
					fake.stored = nil
					continue
				case "tools":
					available = step.Available
					continue
				case "moveProject":
					moved := filepath.Join(parent, "moved")
					if err := os.Rename(project, moved); err != nil {
						t.Fatal(err)
					}
					project = moved
					continue
				}
				before := tree(t, project)
				already := len(fake.started)
				path := project
				if step.Project != nil {
					path = names.back(*step.Project)
				}
				id, token := names.back(step.ID), names.back(step.Token)
				var result any
				var failure error
				switch step.Op {
				case "view":
					result, failure = flow.View(path, step.Shot)
				case "save":
					result, failure = flow.Save(path, step.Shot, parseRecipe(t, step.Recipe))
				case "build":
					result, failure = flow.Build(path, step.Shot, parseRecipe(t, step.Recipe))
				case "accept":
					result, failure = flow.Accept(path, step.Shot, id, token, step.Replace)
				case "recover":
					failure = RecoverApplications(project)
				default:
					t.Fatalf("неизвестное действие %s", step.Op)
				}
				label := fmt.Sprintf("шаг %d %s", index, step.Op)
				if failure != nil {
					want := goldenToolsUnavailable
					if step.Error != nil {
						want = strings.ReplaceAll(*step.Error, goldenToolsUnavailable, textToolsUnavailable)
					}
					if got := sameParse(names.text(failure.Error())); got != sameParse(want) {
						t.Fatalf("%s: ошибка %q, ожидалась %q", label, got, want)
					}
				} else if step.Error != nil {
					t.Fatalf("%s: нет ошибки %q, результат %+v", label, *step.Error, result)
				} else if result != nil {
					data, err := json.Marshal(result)
					if err != nil {
						t.Fatal(err)
					}
					sameJSON(t, label, []byte(strings.ReplaceAll(string(step.Result), goldenToolsUnavailable, textToolsUnavailable)), []byte(names.text(string(data))))
				}
				after := tree(t, project)
				changed, removed := diffTrees(before, after)
				paths := make([]string, 0, len(changed))
				for name := range changed {
					paths = append(paths, name)
				}
				sort.Strings(paths)
				got := map[string]string{}
				for _, name := range paths {
					got[names.text(name)] = names.text(changed[name])
				}
				for name, text := range step.Changed {
					if got[name] != text {
						t.Errorf("%s: файл %s:\n got  %q\n want %q", label, name, got[name], text)
					}
				}
				for name := range got {
					if _, ok := step.Changed[name]; !ok {
						t.Errorf("%s: лишнее изменение %s", label, name)
					}
				}
				if strings.Join(removed, "\n") != strings.Join(step.Removed, "\n") {
					t.Errorf("%s: удалено %v, ожидалось %v", label, removed, step.Removed)
				}
				if len(fake.started) > already {
					data, err := json.Marshal(fake.started[already:])
					if err != nil {
						t.Fatal(err)
					}
					sameJSON(t, label+" задания", step.Started, []byte(names.text(string(data))))
				} else if len(step.Started) > 0 {
					t.Errorf("%s: задание не запущено", label)
				}
				if step.Op == "recover" {
					for name, text := range step.Tree {
						if value, ok := after[names.back(name)]; !ok || names.text(value) != text {
							t.Errorf("%s: дерево %s: %q, ожидалось %q", label, name, value, text)
						}
					}
					if len(after) != len(step.Tree) {
						t.Errorf("%s: файлов %d, ожидалось %d", label, len(after), len(step.Tree))
					}
				}
			}
		})
	}
}

// parseReason — причина разбора JSON в тексте ошибки чтения журнала: эталон её не фиксирует
// (правило эталона agents-settings), поэтому сравниваются начало и окончание текста SongFrame.
var parseReason = regexp.MustCompile(`journal\.json: неверный JSON: [^.]*\. Файл сохранён`)

// sameParse убирает из текста ошибки причину разбора JSON.
func sameParse(text string) string {
	return parseReason.ReplaceAllString(text, "journal.json: <разбор>. Файл сохранён")
}

// parseRecipe — рецепт шага значением renderer.
func parseRecipe(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	value, err := montage.ParseDraft(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
