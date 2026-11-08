package productionworkflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"songframe-go/internal/agents"
	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/mediatest"
	"songframe-go/internal/providers"
	"songframe-go/internal/providers/kling"
	"songframe-go/internal/tools"
)

// Эталон testdata/golden/production-workflow/cases.json: шаги
// сценариев над копией checks-base/project с поддельным менеджером агентов, настоящим
// continuity_brief и подставным каталогом моделей тестового провайдера. Go-тест повторяет те же
// шаги и сверяет результат, ошибки, локальные записи, запуски агента и вызовы инструментов.

// goldenFile — cases.json: тексты по SHA-256 и сценарии.
type goldenFile struct {
	Blobs     map[string]string `json:"blobs"`
	Scenarios []struct {
		Name  string       `json:"name"`
		Steps []goldenStep `json:"steps"`
	} `json:"scenarios"`
}

// goldenStep — вход шага (op и параметры) и ожидаемый исход.
type goldenStep struct {
	Op          string                     `json:"op"`
	Path        string                     `json:"path"`
	JSON        json.RawMessage            `json:"json"`
	Text        *string                    `json:"text"`
	Copy        string                     `json:"copy"`
	Config      map[string]json.RawMessage `json:"config"`
	Shot        string                     `json:"shot"`
	PackageDir  string                     `json:"packageDir"`
	Input       *StartInput                `json:"input"`
	Result      json.RawMessage            `json:"result"`
	Status      string                     `json:"status"`
	ExitCode    json.RawMessage            `json:"exitCode"`
	Set         map[string]json.RawMessage `json:"set"`
	ID          string                     `json:"id"`
	FreshAgents bool                       `json:"freshAgents"`
	Name        string                     `json:"name"`
	Target      string                     `json:"target"`
	Error       *string                    `json:"error"`
	Local       json.RawMessage            `json:"local"`
	Starts      []struct {
		Project string `json:"project"`
		Task    string `json:"task"`
		Prompt  string `json:"prompt"`
		Context string `json:"context"`
	} `json:"starts"`
	Tools []toolCall `json:"tools"`
}

// toolCall — вызов инструмента комплекса.
type toolCall struct {
	Name string   `json:"name"`
	Args []string `json:"args"`
}

// fakeAgents — подставной менеджер агентов эталона: задания не запускают CLI, итог задаёт шаг.
type fakeAgents struct {
	mu     sync.Mutex
	jobs   []*agents.Job
	starts []agents.StartInput
}

func (f *fakeAgents) Start(input agents.StartInput) (agents.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, input)
	job := &agents.Job{
		SchemaVersion: 1, ID: "job-" + jscompat.NumberToString(float64(len(f.jobs)+1)), Sequence: 1, Project: input.Project, Provider: "codex",
		Task: input.Task, Permissions: "read-only", Status: "running",
	}
	f.jobs = append(f.jobs, job)
	return *job, nil
}

func (f *fakeAgents) Get(id string) (agents.Job, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, job := range f.jobs {
		if job.ID == id {
			return *job, true
		}
	}
	return agents.Job{}, false
}

func (f *fakeAgents) List(project string) []agents.Job {
	f.mu.Lock()
	defer f.mu.Unlock()
	list := []agents.Job{}
	for _, job := range f.jobs {
		if job.Project == project {
			list = append(list, *job)
		}
	}
	return list
}

// last — последнее задание.
func (f *fakeAgents) last(t *testing.T) *agents.Job {
	if len(f.jobs) == 0 {
		t.Fatal("заданий нет")
	}
	return f.jobs[len(f.jobs)-1]
}

// testRules — тестовый провайдер с правилами запроса адаптера kling без FrameDefined, на которых
// записан эталон.
type testRules struct{ *mediatest.Service }

func (testRules) RequestRules() mediaapi.RequestRules {
	rules := kling.RequestRules()
	rules.FrameDefined = nil
	return rules
}

// captureConfig — настройки сценария эталона (поле config случая).
type captureConfig struct {
	ScenarioApproved   bool                       `json:"scenarioApproved"`
	PackageBusy        bool                       `json:"packageBusy"`
	FailCapabilities   bool                       `json:"failCapabilities"`
	CapabilityProblems []providers.CatalogProblem `json:"-"`
	AudioSlot          bool                       `json:"audioSlot"`
	MutateOnBrief      *struct {
		Path string `json:"path"`
		Text string `json:"text"`
	} `json:"mutateOnBrief"`
}

var (
	v8Message   = regexp.MustCompile(`(?s)^(Unexpected .*JSON.*|Expected .* in JSON at position \d+.*|.* is not valid JSON)$`)
	uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)
	videoCmds   = []string{"text_to_video", "image_to_video", "omni_ref_video", "motion_control"}
)

// v8Deviation — осознанное отличие от эталона: ответ, который не разбирается как JSON,
// отклоняется текстом textProposalNotJSON, а эталон хранит сообщение SyntaxError разборщика.
// Заменяет такие строки в дереве эталона.
func v8Deviation(value any) any {
	switch typed := value.(type) {
	case string:
		if v8Message.MatchString(typed) {
			return textProposalNotJSON
		}
	case *jscompat.Array:
		for index, item := range typed.Items {
			typed.Items[index] = v8Deviation(item)
		}
	case *jscompat.Object:
		for _, key := range typed.Keys() {
			typed.Set(key, v8Deviation(typed.Value(key)))
		}
	}
	return value
}

// originalFields убирает поля вида, которых нет в эталоне и которые служат только интерфейсу
// (NextStage, ReplaceFrame): остальной вид сверяется с эталоном как есть.
func originalFields(value any) any {
	if view, ok := value.(View); ok {
		view.NextStage, view.ReplaceFrame = nil, nil
		return view
	}
	return value
}

// canonical — JSON в форме JSON.stringify после замены сообщений SyntaxError.
func canonical(t *testing.T, data []byte) string {
	t.Helper()
	value, err := jscompat.Parse(data)
	if err != nil {
		t.Fatalf("%v: %s", err, data)
	}
	return jscompat.Stringify(v8Deviation(value))
}

// canonicalText — запись каталога состояния эталона: файл `JSON.stringify(v, null, 2) + '\n'`
// или компактный JSON записи writeLocal.
func canonicalText(t *testing.T, text string) string {
	t.Helper()
	value, err := jscompat.Parse([]byte(text))
	if err != nil {
		return text
	}
	if !strings.Contains(text, "\n") {
		return jscompat.Stringify(v8Deviation(value))
	}
	return jscompat.StringifyIndent(v8Deviation(value), "  ") + "\n"
}

func TestGoldenProductionWorkflow(t *testing.T) {
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image, mediaproviders.Video},
		Paid: true, DefaultImageResolution: "2k", LipSync: &mediaproviders.LipSync{Min: 5, Max: 30}}))
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	t.Cleanup(mediaadapters.Register(mediatest.ID, testRules{Service: &mediatest.Service{Dir: t.TempDir()}}))
	var file goldenFile
	if err := json.Unmarshal(golden.ReadFile(t, "production-workflow", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(root, "checks-base", "project")
	for _, scenario := range file.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			run := newRun(t, base, file.Blobs)
			for index, step := range scenario.Steps {
				run.step(t, index, step)
			}
		})
	}
}

// goldenRun — состояние одного сценария: проект, каталог состояния, поддельные зависимости.
type goldenRun struct {
	project, local string
	blobs          map[string]string
	config         captureConfig
	agents         *fakeAgents
	workflow       *Workflow
	mu             sync.Mutex
	calls          []toolCall
	expectedLocal  map[string]string
}

func newRun(t *testing.T, base string, blobs map[string]string) *goldenRun {
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := &goldenRun{project: filepath.Join(work, "project"), local: filepath.Join(work, "local"), blobs: blobs, agents: &fakeAgents{},
		config: captureConfig{ScenarioApproved: true}, expectedLocal: map[string]string{}}
	if err := os.CopyFS(run.project, os.DirFS(base)); err != nil {
		t.Fatal(err)
	}
	run.workflow = run.create()
	return run
}

// create — новый экземпляр прохода (перезапуск приложения).
func (r *goldenRun) create() *Workflow {
	return New(Options{
		LocalDir: r.local, Agents: r.agents, Run: r.runTool, Catalog: &providers.Catalogs{Run: r.runTool},
		IsScenarioApproved: func(string) bool { return r.config.ScenarioApproved },
		IsPackageBusy:      func(string, string) bool { return r.config.PackageBusy },
	})
}

// runTool — настоящий continuity_brief и подставной media_request capabilities.
func (r *goldenRun) runTool(ctx context.Context, project, name string, args []string) (tools.Result, error) {
	r.mu.Lock()
	r.calls = append(r.calls, toolCall{Name: name, Args: slices.Clone(args)})
	r.mu.Unlock()
	if name == "media_request" && len(args) > 0 && args[0] == "capabilities" {
		if r.config.FailCapabilities {
			code := 1
			return tools.Result{Code: &code, Stderr: "Каталог временно недоступен."}, nil
		}
		reports := &jscompat.Array{}
		for _, command := range videoCmds {
			if slices.ContainsFunc(r.config.CapabilityProblems, func(problem providers.CatalogProblem) bool { return problem.Command == command }) {
				continue
			}
			slots := `{"first_image":{"required":true},"tail_image":{}` + map[bool]string{true: `,"audio_1":{}`}[r.config.AudioSlot] + `}`
			report, _ := jscompat.Parse([]byte(`{"command":"` + command + `","models":{"test-video":{"arguments":{"duration":{"allowed":["9"]},"resolution":{"allowed":["1080p"]}},"slots":` + slots + `}}}`))
			reports.Items = append(reports.Items, report)
		}
		problems := &jscompat.Array{}
		for _, problem := range r.config.CapabilityProblems {
			item := jscompat.NewObject()
			item.Set("command", problem.Command)
			item.Set("message", problem.Message)
			problems.Items = append(problems.Items, item)
		}
		output := jscompat.NewObject()
		output.Set("reports", reports)
		output.Set("problems", problems)
		code := 0
		return tools.Result{Code: &code, Stdout: jscompat.Stringify(output)}, nil
	}
	result, err := tools.RunContext(ctx, project, name, args)
	if err == nil && r.config.MutateOnBrief != nil && slices.Contains(args, "after") {
		if err := os.WriteFile(filepath.Join(r.project, r.config.MutateOnBrief.Path), []byte(r.config.MutateOnBrief.Text), 0o644); err != nil {
			return result, err
		}
		r.config.MutateOnBrief = nil
	}
	return result, err
}

// normalize — маркеры путей и UUID, как в эталоне.
func (r *goldenRun) normalize(text string) string {
	text = strings.ReplaceAll(text, r.local, "<local>")
	text = strings.ReplaceAll(text, r.project, "<project>")
	return uuidPattern.ReplaceAllString(text, "<id>")
}

// packagePath — путь пакета шага (от проекта) или "".
func (r *goldenRun) packagePath(path string) string {
	if path == "" {
		return ""
	}
	return filepath.Join(r.project, path)
}

// recordPath — запись предложения плана.
func (r *goldenRun) recordPath(shot string) string {
	return filepath.Join(r.local, StoreFolder, FileName(r.project, shot))
}

// step исполняет шаг и сверяет его исход с эталоном.
func (r *goldenRun) step(t *testing.T, index int, step goldenStep) {
	t.Helper()
	label := func() string { return jscompat.NumberToString(float64(index)) + " " + step.Op }
	startsBefore, callsBefore := len(r.agents.starts), len(r.calls)
	manager := r.agents
	result, err := r.execute(t, step)
	if manager != r.agents {
		startsBefore = 0
	}
	if step.Error != nil {
		if err == nil {
			t.Fatalf("%s: ожидалась ошибка %q", label(), *step.Error)
		}
		if got := r.normalize(err.Error()); canonical(t, []byte(jscompat.Quote(got))) != canonical(t, []byte(jscompat.Quote(*step.Error))) {
			t.Fatalf("%s: ошибка\n got %s\nwant %s", label(), got, *step.Error)
		}
	} else if err != nil {
		t.Fatalf("%s: %v", label(), err)
	}
	if step.Op != "finish" && step.Error == nil && len(step.Result) > 0 {
		r.compareResult(t, label(), step.Result, result)
	}
	r.compareLocal(t, label(), step.Local)
	starts := r.agents.starts[startsBefore:]
	if len(starts) != len(step.Starts) {
		t.Fatalf("%s: запусков агента %d, ожидалось %d", label(), len(starts), len(step.Starts))
	}
	for position, start := range starts {
		want := step.Starts[position]
		if r.normalize(start.Project) != want.Project || start.Task != want.Task {
			t.Fatalf("%s: запуск %s %s, ожидался %s %s", label(), start.Project, start.Task, want.Project, want.Task)
		}
		if got := r.normalize(start.Prompt); got != r.blobs[want.Prompt] {
			t.Fatalf("%s: промпт отличается\n%s", label(), firstDifference(got, r.blobs[want.Prompt]))
		}
		if got := r.normalize(start.Context); got != r.blobs[want.Context] {
			t.Fatalf("%s: контекст отличается\n%s", label(), firstDifference(got, r.blobs[want.Context]))
		}
	}
	calls := r.calls[callsBefore:]
	gotCalls, _ := json.Marshal(calls)
	wantCalls, _ := json.Marshal(step.Tools)
	if len(calls) == 0 && len(step.Tools) == 0 {
		return
	}
	if r.normalize(string(gotCalls)) != string(wantCalls) {
		t.Fatalf("%s: вызовы инструментов\n got %s\nwant %s", label(), r.normalize(string(gotCalls)), wantCalls)
	}
}

// firstDifference — окрестность первого расхождения двух текстов.
func firstDifference(got, want string) string {
	position := 0
	for position < len(got) && position < len(want) && got[position] == want[position] {
		position++
	}
	from := max(position-200, 0)
	return "got:  …" + got[from:min(position+200, len(got))] + "\nwant: …" + want[from:min(position+200, len(want))]
}

// compareResult сверяет результат шага (вид, сводку) в форме JSON.stringify.
func (r *goldenRun) compareResult(t *testing.T, label string, want json.RawMessage, got any) {
	t.Helper()
	data, err := json.Marshal(originalFields(got))
	if err != nil {
		t.Fatal(err)
	}
	gotText := canonical(t, []byte(r.normalize(jscompat.Stringify(mustParse(t, data)))))
	if summaries, ok := got.(map[string]Summary); ok {
		// Порядок ключей сводки в эталоне — порядок файлов каталога состояния; план ищется по ID.
		expected := mustParse(t, want).(*jscompat.Object)
		if len(expected.Keys()) != len(summaries) {
			t.Fatalf("%s: сводка %s, ожидалась %s", label, gotText, want)
		}
		for _, shot := range expected.Keys() {
			summary, found := summaries[shot]
			if !found || r.normalize(string(summary.Value)) != jscompat.Stringify(expected.Value(shot)) {
				t.Fatalf("%s: сводка %s: %s, ожидалась %s", label, shot, summary.Value, jscompat.Stringify(expected.Value(shot)))
			}
		}
		return
	}
	if wantText := canonical(t, want); gotText != wantText {
		t.Fatalf("%s: результат отличается\n%s", label, firstDifference(gotText, wantText))
	}
}

func mustParse(t *testing.T, data []byte) any {
	t.Helper()
	value, err := jscompat.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

// compareLocal сверяет записи каталога состояния (имя `<план>.json` вместо SHA).
func (r *goldenRun) compareLocal(t *testing.T, label string, want json.RawMessage) {
	t.Helper()
	if string(want) != `"unchanged"` {
		expected := map[string]string{}
		if err := json.Unmarshal(want, &expected); err != nil {
			t.Fatalf("%s: local %s", label, want)
		}
		r.expectedLocal = map[string]string{}
		for name, sha := range expected {
			r.expectedLocal[name] = canonicalText(t, r.blobs[sha])
		}
	}
	names := map[string]string{}
	for _, shot := range []string{"M01", "M02", "M03", "M04", "M05", "M06"} {
		names[FileName(r.project, shot)] = shot + ".json"
	}
	got := map[string]string{}
	entries, _ := os.ReadDir(filepath.Join(r.local, StoreFolder))
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(r.local, StoreFolder, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		name := entry.Name()
		if mapped, ok := names[name]; ok {
			name = mapped
		}
		got[name] = r.normalize(string(data))
	}
	if len(got) != len(r.expectedLocal) {
		t.Fatalf("%s: записи каталога состояния %v, ожидались %v", label, keysOf(got), keysOf(r.expectedLocal))
	}
	for name, text := range r.expectedLocal {
		if got[name] != text {
			t.Fatalf("%s: запись %s отличается\n%s", label, name, firstDifference(got[name], text))
		}
	}
}

func keysOf(values map[string]string) []string {
	keys := []string{}
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// execute выполняет шаг сценария эталона.
func (r *goldenRun) execute(t *testing.T, step goldenStep) (any, error) {
	t.Helper()
	switch step.Op {
	case "write":
		path := filepath.Join(r.project, step.Path)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		var data []byte
		switch {
		case step.Copy != "":
			var err error
			if data, err = os.ReadFile(filepath.Join(r.project, step.Copy)); err != nil {
				t.Fatal(err)
			}
		case len(step.JSON) > 0:
			data = []byte(jscompat.StringifyIndent(mustParse(t, step.JSON), "  ") + "\n")
		default:
			data = []byte(*step.Text)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	case "remove":
		if err := os.RemoveAll(filepath.Join(r.project, step.Path)); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	case "set":
		for name, raw := range step.Config {
			switch name {
			case "capabilityProblems":
				r.config.CapabilityProblems = nil
				var problems []struct{ Command, Message string }
				if err := json.Unmarshal(raw, &problems); err != nil {
					t.Fatal(err)
				}
				for _, problem := range problems {
					r.config.CapabilityProblems = append(r.config.CapabilityProblems, providers.CatalogProblem{Command: problem.Command, Message: problem.Message})
				}
			default:
				if err := json.Unmarshal([]byte(`{"`+name+`":`+string(raw)+`}`), &r.config); err != nil {
					t.Fatal(err)
				}
			}
		}
		return nil, nil
	case "view":
		return r.workflow.View(r.project, step.Shot, r.packagePath(step.PackageDir))
	case "start", "startNoAgent":
		input := *step.Input
		input.Project = r.project
		input.PackageDir = r.packagePath(input.PackageDir)
		if step.Op == "startNoAgent" {
			// Маршрут productionWorkflow:start: сначала ai.requireAccess(project, 'agent').
			checker := &agents.AccessChecker{Settings: agents.NewSettingsStore(t.TempDir())}
			project := r.project
			if err := checker.RequireAccess(context.Background(), &project, agents.KindAgent); err != nil {
				return nil, err
			}
		}
		return r.workflow.Start(context.Background(), input)
	case "finish":
		job := r.agents.last(t)
		result := mustParse(t, step.Result)
		if text, ok := result.(string); ok {
			job.Result = text
		} else {
			job.Result = jscompat.Stringify(result)
		}
		job.Status = "completed"
		if step.Status != "" {
			job.Status = step.Status
		}
		code := 0
		if len(step.ExitCode) > 0 {
			code = int(jscompat.ToNumber(mustParse(t, step.ExitCode)))
		}
		job.ExitCode = &code
		return nil, nil
	case "job":
		job := r.agents.last(t)
		for name, raw := range step.Set {
			value := mustParse(t, raw)
			switch name {
			case "status":
				job.Status = value.(string)
			case "exitCode":
				code := int(value.(float64))
				job.ExitCode = &code
			case "message":
				job.Message = value.(string)
			case "result":
				job.Result = value.(string)
			default:
				t.Fatalf("поле задания %s", name)
			}
		}
		return nil, nil
	case "discard":
		id := step.ID
		if id == "current" {
			id = ""
			if value, ok := jscompat.ReadJSONFile(r.recordPath(step.Shot)); ok {
				id, _ = jscompat.GetPath(value, "proposal", "id").(string)
			}
		}
		return r.workflow.Discard(r.project, step.Shot, r.packagePath(step.PackageDir), id)
	case "pending":
		return r.workflow.PendingProposals(r.project), nil
	case "restart":
		if step.FreshAgents {
			r.agents = &fakeAgents{}
		}
		r.workflow = r.create()
		return nil, nil
	case "writeLocal":
		folder := filepath.Join(r.local, StoreFolder)
		if err := os.MkdirAll(folder, 0o755); err != nil {
			t.Fatal(err)
		}
		text := strings.ReplaceAll(jscompat.Stringify(mustParse(t, step.JSON)), "<project>", r.project)
		if err := os.WriteFile(filepath.Join(folder, step.Name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	case "patchLocal":
		path := r.recordPath(step.Shot)
		value, ok := jscompat.ReadJSONFile(path)
		if !ok {
			t.Fatal("нет записи для patchLocal")
		}
		if step.Status != "" {
			value.(*jscompat.Object).Value("proposal").(*jscompat.Object).Set("status", step.Status)
		}
		if step.Target != "" {
			value.(*jscompat.Object).Set("target", filepath.Join(r.project, step.Target))
		}
		if err := os.WriteFile(path, []byte(jscompat.StringifyIndent(value, "  ")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	}
	t.Fatalf("неизвестная операция %s", step.Op)
	return nil, nil
}
