package scenarioworkflow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
)

// Эталоны testdata/golden/scenario-workflow описывают шаги сценарного прохода с поддельным
// менеджером агентов и настоящей публикацией. Тест проходит эти шаги и сверяет виды и тексты
// отказов, вход задания агента (промпт и контекст дословно), изменения файлов проекта и
// локальную запись сценария. Байты PNG карточек зависят от растеризатора, поэтому у них
// сравнивается только состав, а SHA в манифесте карточек — с фактическими файлами.

// fakeAgents — поддельный менеджер агентов для шагов эталона: задания в памяти, ID job-N.
type fakeAgents struct {
	mu     sync.Mutex
	jobs   []AgentJob
	inputs []AgentStartInput
	// refuse — ошибка следующего Start (отказ менеджера до запуска).
	refuse error
}

func digestHex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func (f *fakeAgents) Start(input AgentStartInput) (AgentJob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refuse != nil {
		return AgentJob{}, f.refuse
	}
	f.inputs = append(f.inputs, input)
	job := AgentJob{
		SchemaVersion: 1, ID: "job-" + itoa(len(f.jobs)), Sequence: len(f.jobs) + 1, Project: input.Project, Provider: "codex",
		Task: input.Task, Permissions: "read-only", InputHashes: AgentInputHashes{Prompt: digestHex(input.Prompt), Context: digestHex(input.Context)},
		Status: "running", Phase: "работает", StartedAt: fixedNow,
	}
	f.jobs = append(f.jobs, job)
	return job, nil
}

func (f *fakeAgents) Get(id string) (AgentJob, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, job := range f.jobs {
		if job.ID == id {
			return job, true
		}
	}
	return AgentJob{}, false
}

func (f *fakeAgents) List(project string) []AgentJob {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := []AgentJob{}
	for _, job := range f.jobs {
		if job.Project == project {
			result = append(result, job)
		}
	}
	return result
}

// update меняет последнее задание (завершение, отмена, сбой).
func (f *fakeAgents) update(change func(*AgentJob)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(&f.jobs[len(f.jobs)-1])
}

const fixedNow = "2026-11-04T12:00:00.000Z"

func itoa(value int) string { return dynvalue.NumberToString(float64(value)) }

// goldenStep — шаг case.json.
type goldenStep struct {
	Op          string          `json:"op"`
	Pass        string          `json:"pass"`
	Note        *string         `json:"note"`
	SelectedIDs []string        `json:"selectedIds"`
	ID          *string         `json:"id"`
	Text        *string         `json:"text"`
	Result      *string         `json:"result"`
	Message     *string         `json:"message"`
	Path        string          `json:"path"`
	View        json.RawMessage `json:"view"`
	Error       *string         `json:"error"`
	Agent       *struct {
		Project string `json:"project"`
		Task    string `json:"task"`
		Prompt  string `json:"prompt"`
		Context string `json:"context"`
	} `json:"agent"`
}

// normalizer — замена путей и случайных ID предложений маркерами эталона.
type normalizer struct {
	project, state string
	ids            []string
}

func (n *normalizer) text(value string) string {
	value = strings.ReplaceAll(value, n.project, "<project>")
	value = strings.ReplaceAll(value, n.state, "<state>")
	for index, id := range n.ids {
		value = strings.ReplaceAll(value, id, "<proposal-"+itoa(index+1)+">")
	}
	return value
}

func (n *normalizer) remember(view View) {
	if view.Proposal != nil && !containsString(n.ids, view.Proposal.ID) {
		n.ids = append(n.ids, view.Proposal.ID)
	}
}

func containsString(items []string, item string) bool {
	for _, value := range items {
		if value == item {
			return true
		}
	}
	return false
}

// tree — normalize для дерева dynvalue (строки значений, ключи как есть).
func (n *normalizer) tree(value any) any {
	switch typed := value.(type) {
	case string:
		return n.text(typed)
	case *dynvalue.Array:
		for index, item := range typed.Items {
			typed.Items[index] = n.tree(item)
		}
	case *dynvalue.Object:
		for _, key := range typed.Keys() {
			typed.Set(key, n.tree(typed.Value(key)))
		}
	}
	return value
}

func (n *normalizer) json(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	tree, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(dynvalue.Stringify(n.tree(tree)))
}

// parseMessage — текст ошибки разбора JSON, который эталон хранит на месте отказа
// («неверный JSON: …»).
var parseMessage = regexp.MustCompile(`^неверный JSON: .*$`)

// replaceParseMessages — ответ агента, который не разбирается как JSON, отклоняется текстом
// proposalInvalidDocument (см. proposalDocuments), а эталон хранит на этом месте сообщение
// разбора (parseMessage). Функция заменяет такие сообщения эталона и сохраняет его форму (отступы state.json).
func replaceParseMessages(t *testing.T, data []byte) []byte {
	t.Helper()
	value, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	changed := false
	var walk func(any) any
	walk = func(item any) any {
		switch typed := item.(type) {
		case string:
			if parseMessage.MatchString(typed) {
				changed = true
				return textProposalInvalidDocument
			}
		case *dynvalue.Array:
			for index, entry := range typed.Items {
				typed.Items[index] = walk(entry)
			}
		case *dynvalue.Object:
			for _, key := range typed.Keys() {
				typed.Set(key, walk(typed.Value(key)))
			}
		}
		return item
	}
	walk(value)
	if !changed {
		return data
	}
	return []byte(dynvalue.StringifyIndent(value, "  ") + "\n")
}

// treeFiles — файлы проекта без .git: путь → байты.
func treeFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && entry.Name() == ".git" {
			return filepath.SkipDir
		}
		if entry.Type().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			relative, _ := filepath.Rel(root, path)
			result[filepath.ToSlash(relative)] = data
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// maskCards — манифест карточек без SHA PNG: байты PNG зависят от растеризатора и с эталоном не сравниваются.
func maskCards(t *testing.T, data []byte) []byte {
	t.Helper()
	value, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if cards, ok := dynvalue.AsObject(dynvalue.Get(value, "cards")); ok {
		for _, key := range cards.Keys() {
			if card, ok := dynvalue.AsObject(cards.Value(key)); ok && card.Has("sha256") {
				card.Set("sha256", "<png>")
			}
		}
	}
	return []byte(dynvalue.StringifyIndent(value, "  "))
}

func TestGoldenWorkflow(t *testing.T) {
	prompts := map[string]string{}
	for _, pass := range passes {
		prompts[pass] = string(golden.ReadFile(t, "scenario-workflow", "prompt-"+pass+".txt"))
	}
	for _, item := range golden.Load(t, "scenario-workflow") {
		t.Run(item.Name, func(t *testing.T) {
			var spec struct {
				Steps []goldenStep `json:"steps"`
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
			before := treeFiles(t, project)
			current := func() string {
				_, proposal := pendingProposal(readState(localDir, project))
				return dynvalue.ToString(proposal.Value("id"))
			}
			for index, step := range spec.Steps {
				label := item.Name + "#" + itoa(index) + " " + step.Op
				var view View
				var err error
				ran := true
				switch step.Op {
				case "view":
					view, err = workflow.View(path)
				case "start":
					count := len(agents.inputs)
					view, err = workflow.Start(StartInput{Project: path, Pass: step.Pass, Note: step.Note, SelectedIDs: step.SelectedIDs})
					if (step.Agent != nil) != (len(agents.inputs) > count) {
						t.Fatalf("%s: запуск агента %v, в эталоне %v", label, len(agents.inputs) > count, step.Agent != nil)
					}
					if step.Agent != nil {
						input := agents.inputs[len(agents.inputs)-1]
						if names.text(input.Project) != step.Agent.Project || input.Task != step.Agent.Task {
							t.Fatalf("%s: задание %s %s, в эталоне %s %s", label, input.Project, input.Task, step.Agent.Project, step.Agent.Task)
						}
						if input.Prompt != prompts[step.Pass] {
							t.Fatalf("%s: промпт отличается от %s", label, step.Agent.Prompt)
						}
						if want := string(item.Read(t, step.Agent.Context)); names.text(input.Context) != want {
							golden.AssertJSON(t, []byte(want), []byte(names.text(input.Context)))
							t.Fatalf("%s: контекст отличается порядком или форматом", label)
						}
						if len(input.Images) > 0 || input.RetryOf != "" {
							t.Fatalf("%s: лишние images или retryOf", label)
						}
					}
				case "finish":
					agents.update(func(job *AgentJob) {
						job.Status, job.ExitCode, job.Result = "completed", new(int), *step.Result
						finished := fixedNow
						job.FinishedAt = &finished
					})
					ran = false
				case "cancel":
					agents.update(func(job *AgentJob) {
						job.Status, job.ExitCode, job.Message = "cancelled", nil, "Задание остановлено."
					})
					ran = false
				case "fail":
					agents.update(func(job *AgentJob) {
						code := 1
						job.Status, job.ExitCode = "failed", &code
						if step.Message != nil {
							job.Message = *step.Message
						}
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
				case "apply", "discard":
					id := current()
					if step.ID != nil {
						id = *step.ID
					}
					if step.Op == "apply" {
						view, err = workflow.Apply(path, id)
					} else {
						view, err = workflow.Discard(path, id)
					}
				case "approveCurrent":
					view, err = workflow.ApproveCurrent(path)
				case "approveScenes":
					view, err = workflow.ApproveScenes(path)
				default:
					t.Fatalf("%s: неизвестная операция", label)
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
				names.remember(view)
				if diffs, err := golden.Diff(replaceParseMessages(t, step.View), names.json(t, view)); err != nil || len(diffs) > 0 {
					t.Fatalf("%s: вид отличается от эталона: %v %s", label, err, strings.Join(diffs, "\n"))
				}
			}
			compareFiles(t, item, project, before)
			compareState(t, item, localDir, project, names)
			if entries, _ := os.ReadDir(filepath.Join(localDir, "scenario-apply")); len(entries) > 0 {
				for _, entry := range entries {
					if files, _ := os.ReadDir(filepath.Join(localDir, "scenario-apply", entry.Name())); len(files) > 0 {
						t.Fatalf("остался журнал применения %s", entry.Name())
					}
				}
			}
		})
	}
}

// editCast — правка роли второй сущности по шагу эталона; JSON записывается с отступом 2.
func editCast(t *testing.T, project string) {
	t.Helper()
	path := filepath.Join(project, "plan", "cast.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	value, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	entity, _ := dynvalue.AsObject(arrayItems(dynvalue.Get(value, "entities"))[1])
	entity.Set("role", dynvalue.ToString(entity.Value("role"))+" Ведёт лодку.")
	if err := os.WriteFile(path, []byte(dynvalue.StringifyIndent(value, "  ")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// compareFiles — изменения проекта против files.json и after/ случая.
func compareFiles(t *testing.T, item golden.Case, project string, before map[string][]byte) {
	t.Helper()
	var want map[string]struct {
		Before *string `json:"before"`
		After  *string `json:"after"`
	}
	if err := json.Unmarshal(item.Read(t, "files.json"), &want); err != nil {
		t.Fatal(err)
	}
	after := treeFiles(t, project)
	paths := map[string]bool{}
	for path := range before {
		paths[path] = true
	}
	for path := range after {
		paths[path] = true
	}
	sorted := make([]string, 0, len(paths))
	for path := range paths {
		sorted = append(sorted, path)
	}
	sort.Strings(sorted)
	for _, path := range sorted {
		left, hadLeft := before[path]
		right, hasRight := after[path]
		changed := hadLeft != hasRight || !bytes.Equal(left, right)
		expected, listed := want[path]
		if strings.HasSuffix(path, ".png") {
			// Состав PNG совпадает; перерисовка существующей карточки — допустимое отличие растеризатора.
			if listed && (expected.After != nil) != hasRight {
				t.Fatalf("%s: наличие PNG после %v, в эталоне %v", path, hasRight, expected.After != nil)
			}
			if !listed && changed && (!hadLeft || !hasRight) {
				t.Fatalf("%s: PNG появилась или исчезла, в эталоне без изменений", path)
			}
			continue
		}
		if !listed {
			if changed {
				t.Fatalf("%s изменён, в эталоне без изменений", path)
			}
			continue
		}
		if expected.After == nil {
			if hasRight {
				t.Fatalf("%s: файл остался, в эталоне удалён", path)
			}
			continue
		}
		wantBytes := item.Read(t, "after/"+path)
		if path == "plan/animatic/cards/manifest.json" {
			checkCardHashes(t, project, right)
			if !bytes.Equal(maskCards(t, wantBytes), maskCards(t, right)) {
				t.Fatalf("%s отличается от эталона без учёта SHA PNG:\n%s", path, right)
			}
			continue
		}
		if path == "source/manifest.json" {
			// updated_at описи — время записи (в эталоне зафиксировано): сравнивается остальное.
			wantBytes, right = maskUpdated(t, wantBytes), maskUpdated(t, right)
		}
		if !bytes.Equal(wantBytes, right) {
			t.Fatalf("%s отличается от эталона:\n--- ожидалось\n%s\n--- получено\n%s", path, wantBytes, right)
		}
	}
}

// maskUpdated — опись с updated_at, заменённым маркером, после проверки формата времени.
func maskUpdated(t *testing.T, data []byte) []byte {
	t.Helper()
	value, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	record, _ := dynvalue.AsObject(value)
	if text, ok := record.Value("updated_at").(string); !ok || !isoTime.MatchString(text) {
		t.Fatalf("updated_at описи не время ISO: %v", record.Value("updated_at"))
	}
	record.Set("updated_at", "<time>")
	return []byte(dynvalue.StringifyIndent(value, "  ") + "\n")
}

var isoTime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

// checkCardHashes — SHA карточек в манифесте совпадают с записанными PNG.
func checkCardHashes(t *testing.T, project string, manifest []byte) {
	t.Helper()
	value, err := dynvalue.Parse(manifest)
	if err != nil {
		t.Fatal(err)
	}
	cards, _ := dynvalue.AsObject(dynvalue.Get(value, "cards"))
	for _, key := range cards.Keys() {
		card := cards.Value(key)
		data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(dynvalue.ToString(dynvalue.Get(card, "path")))))
		if err != nil {
			t.Fatal(err)
		}
		if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != dynvalue.Get(card, "sha256") {
			t.Fatalf("карточка %s: SHA манифеста не совпадает с PNG", key)
		}
	}
}

// compareState — локальная запись сценария побайтно после замены путей и ID.
func compareState(t *testing.T, item golden.Case, localDir, project string, names *normalizer) {
	t.Helper()
	want := replaceParseMessages(t, item.Read(t, "state.json"))
	data, err := os.ReadFile(statePath(localDir, project))
	if os.IsNotExist(err) {
		if strings.TrimSpace(string(want)) != "null" {
			t.Fatal("нет локальной записи, в эталоне есть")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	value, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	got := dynvalue.StringifyIndent(names.tree(value), "  ") + "\n"
	if got != string(want) {
		golden.AssertJSON(t, want, []byte(got))
		t.Fatalf("локальная запись отличается порядком ключей или форматом:\n%s", got)
	}
}
