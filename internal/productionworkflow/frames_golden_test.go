package productionworkflow

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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
	"songframe-go/internal/mediafile"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/mediatest"
	"songframe-go/internal/providers"
	"songframe-go/internal/providers/agentexec"
	"songframe-go/internal/providers/codex"
	"songframe-go/internal/tools"
)

// Эталон production-frames/cases.json снят скриптом capture-production-frames.ts (вне репозитория,
// ../test-projects/golden/capture/45g3/) с временной копии оригинала с двумя исправлениями
// keyframe-images.ts (README эталонов). Зависимости — как в ipc.ts: исполнитель провайдера-агента
// test-agent (адаптер codex) поверх KeyframeImages, платный test через общий PaidMedia, настоящие
// media_request и shot_workflow (здесь — их Go-порты) и тестовый сервис mediatest. Менеджер
// агентов подставной: задание опор не запускает программу, файлы кандидатов и итог задают шаги.
// Сверяются результат или ошибка, записи каталога состояния, дерево plan/batches, рабочие папки
// image-jobs, запуски заданий опор, вызовы инструментов и вызовы тестового сервиса.

// framesStep — шаг сценария эталона: вход (op и параметры) и исход оригинала.
type framesStep struct {
	Op         string                     `json:"op"`
	Path       string                     `json:"path"`
	JSON       json.RawMessage            `json:"json"`
	Text       *string                    `json:"text"`
	Copy       string                     `json:"copy"`
	Base64     *string                    `json:"base64"`
	Symlink    string                     `json:"symlink"`
	Config     json.RawMessage            `json:"config"`
	Shot       string                     `json:"shot"`
	PackageDir string                     `json:"packageDir"`
	Images     json.RawMessage            `json:"images"`
	Files      []framesStep               `json:"files"`
	Remove     bool                       `json:"remove"`
	Set        map[string]json.RawMessage `json:"set"`
	Result     json.RawMessage            `json:"result"`
	Status     string                     `json:"status"`
	ExitCode   json.RawMessage            `json:"exitCode"`
	Message    string                     `json:"message"`
	ID         string                     `json:"id"`
	Error      *string                    `json:"error"`
	Local      json.RawMessage            `json:"local"`
	Packages   json.RawMessage            `json:"packages"`
	Jobs       json.RawMessage            `json:"jobs"`
	Starts     json.RawMessage            `json:"starts"`
	Tools      json.RawMessage            `json:"tools"`
	Service    json.RawMessage            `json:"service"`
}

// imageStart — вызов StartImages подставного менеджера.
type imageStart struct {
	input   agents.StartInput
	workDir string
	config  agents.Settings
}

// imageAgents — fakeAgents съёмки с запуском заданий опор: задание получает программу config.
type imageAgents struct {
	*fakeAgents
	images []imageStart
}

func (a *imageAgents) StartImages(input agents.StartInput, workDir string, config agents.Settings) (agents.Job, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.images = append(a.images, imageStart{input: input, workDir: workDir, config: config})
	job := &agents.Job{
		SchemaVersion: 1, ID: "job-" + jscompat.NumberToString(float64(len(a.jobs)+1)), Sequence: 1, Project: input.Project, Provider: config.Provider,
		Task: input.Task, Permissions: "read-only", Status: "running",
	}
	a.jobs = append(a.jobs, job)
	return *job, nil
}

var (
	prepareTemp = regexp.MustCompile(`songframe-media-prepare-[A-Za-z0-9]+`)
	isoTime     = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})`)
	requestHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
	textName    = regexp.MustCompile(`\.(json|md|txt|jsonl)$`)
)

func TestGoldenProductionFrames(t *testing.T) {
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
	base := filepath.Join(root, "checks-base", "project")
	for _, scenario := range file.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			run := newFramesRun(t, base, file.Blobs)
			for index, step := range scenario.Steps {
				run.step(t, index, step)
			}
		})
	}
}

// framesRun — состояние одного сценария: проект, каталоги состояния и сервиса, подставные зависимости.
type framesRun struct {
	project, local, service, temp string
	blobs                         map[string]string
	scenarioApproved, packageBusy bool
	agents                        *imageAgents
	workflow                      *Workflow
	mu                            sync.Mutex
	calls                         []toolCall
	requests                      []string
	serviceSeen                   int
	// expected — последнее записанное оригиналом состояние local/packages/jobs ("unchanged" — прежнее).
	expected map[string]json.RawMessage
}

func newFramesRun(t *testing.T, base string, blobs map[string]string) *framesRun {
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := &framesRun{
		project: filepath.Join(work, "project"), local: filepath.Join(work, "local"), service: filepath.Join(work, "service"), temp: filepath.Join(work, "tmp"),
		blobs: blobs, scenarioApproved: true, agents: &imageAgents{fakeAgents: &fakeAgents{}},
		expected: map[string]json.RawMessage{"local": json.RawMessage("{}"), "packages": json.RawMessage("{}"), "jobs": json.RawMessage("{}")},
	}
	for _, path := range []string{r.service, r.temp} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(r.service, "service.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(r.project, os.DirFS(base)); err != nil {
		t.Fatal(err)
	}
	// media_request принимает спецификацию подготовки только во временной папке ОС.
	t.Setenv("TMPDIR", r.temp)
	t.Setenv("SONGFRAME_PRICING_FILE", "")
	t.Cleanup(mediaadapters.Register(mediatest.ID, testRules{Service: &mediatest.Service{Dir: r.service}}))
	savedLocal, savedState := tools.LocalDir, mediaadapters.StateDir
	tools.LocalDir = func() (string, error) { return r.local, nil }
	mediaadapters.StateDir = func() (string, error) { return r.local, nil }
	t.Cleanup(func() { tools.LocalDir, mediaadapters.StateDir = savedLocal, savedState })
	r.workflow = r.create()
	return r
}

// create — проход с зависимостями, как в ipc.ts; новый вызов — перезапуск приложения.
func (r *framesRun) create() *Workflow {
	images := &KeyframeImages{LocalDir: r.local, Agents: r.agents, ValidateImage: mediafile.Decodes}
	catalogs := &providers.Catalogs{Run: r.runTool}
	layer := providers.NewLayer(providers.Options{
		Catalogs: catalogs, Paid: providers.PaidOptions{Run: r.runTool, ValidateImage: mediafile.Decodes}, Agents: agentexec.Deps{Images: images},
	})
	return New(Options{
		LocalDir: r.local, Agents: r.agents, Run: r.runTool, Catalog: catalogs, Media: layer, ValidateImage: mediafile.Decodes,
		IsScenarioApproved: func(string) bool { return r.scenarioApproved },
		IsPackageBusy:      func(string, string) bool { return r.packageBusy },
	})
}

// runTool — Go-порты инструментов с записью вызовов.
func (r *framesRun) runTool(ctx context.Context, project, name string, args []string) (tools.Result, error) {
	r.mu.Lock()
	r.calls = append(r.calls, toolCall{Name: name, Args: slices.Clone(args)})
	r.mu.Unlock()
	return tools.RunContext(ctx, project, name, args)
}

// normalize — маркеры путей, временной папки подготовки, времени, SHA запросов опор и UUID, как в скрипте.
func (r *framesRun) normalize(text string) string {
	for _, pair := range [][2]string{{r.local, "<local>"}, {r.project, "<project>"}, {r.service, "<service>"}, {r.temp, "<tmp>"}} {
		text = strings.ReplaceAll(text, pair[0], pair[1])
	}
	text = prepareTemp.ReplaceAllString(text, "songframe-media-prepare-<n>")
	text = isoTime.ReplaceAllString(text, "<time>")
	for _, request := range r.requests {
		text = strings.ReplaceAll(text, request, "<request>")
	}
	return uuidPattern.ReplaceAllString(text, "<id>")
}

// writeFile — writeData скрипта: symlink, copy (от проекта), base64, json или text.
func writeFile(t *testing.T, project, path string, step framesStep) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink == 0 {
		_ = os.Chmod(path, 0o644)
	}
	_ = os.Remove(path)
	var data []byte
	switch {
	case step.Symlink != "":
		if err := os.Symlink(step.Symlink, path); err != nil {
			t.Fatal(err)
		}
		return
	case step.Copy != "":
		var err error
		if data, err = os.ReadFile(filepath.Join(project, step.Copy)); err != nil {
			t.Fatal(err)
		}
	case step.Base64 != nil:
		var err error
		if data, err = base64.StdEncoding.DecodeString(*step.Base64); err != nil {
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
}

// jobDir — рабочая папка последнего задания опор.
func (r *framesRun) jobDir(t *testing.T) string {
	if len(r.agents.images) == 0 {
		t.Fatal("нет рабочей папки задания")
	}
	return r.agents.images[len(r.agents.images)-1].workDir
}

// execute — execute скрипта съёмки.
func (r *framesRun) execute(t *testing.T, step framesStep) (any, error) {
	t.Helper()
	packageDir := ""
	if step.PackageDir != "" {
		packageDir = filepath.Join(r.project, step.PackageDir)
	}
	switch step.Op {
	case "write":
		writeFile(t, r.project, filepath.Join(r.project, step.Path), step)
	case "remove":
		if err := os.RemoveAll(filepath.Join(r.project, step.Path)); err != nil {
			t.Fatal(err)
		}
	case "set":
		var flags struct {
			PackageBusy      *bool `json:"packageBusy"`
			ScenarioApproved *bool `json:"scenarioApproved"`
		}
		if err := json.Unmarshal(step.Config, &flags); err != nil {
			t.Fatal(err)
		}
		if flags.PackageBusy != nil {
			r.packageBusy = *flags.PackageBusy
		}
		if flags.ScenarioApproved != nil {
			r.scenarioApproved = *flags.ScenarioApproved
		}
	case "service":
		if err := os.WriteFile(filepath.Join(r.service, "service.json"), []byte(jscompat.StringifyIndent(mustParse(t, step.Config), "  ")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	case "view":
		return r.workflow.View(r.project, step.Shot, packageDir)
	case "generate":
		return r.workflow.GenerateFrames(context.Background(), r.project, step.Shot, packageDir)
	case "import":
		var images []FrameCandidate
		if string(step.Images) != "null" {
			if err := json.Unmarshal(step.Images, &images); err != nil {
				t.Fatal(err)
			}
			for index := range images {
				images[index].Path = filepath.Join(r.project, images[index].Path)
			}
		}
		return r.workflow.ImportFrames(r.project, step.Shot, packageDir, images)
	case "agentFiles":
		for _, file := range step.Files {
			writeFile(t, r.project, filepath.Join(r.jobDir(t), file.Path), file)
		}
	case "jobFile":
		switch {
		case step.Remove:
			if err := os.RemoveAll(r.jobDir(t)); err != nil {
				t.Fatal(err)
			}
		case step.Set != nil:
			path := filepath.Join(r.jobDir(t), step.Path)
			value, ok := jscompat.ReadJSONFile(path)
			if !ok {
				t.Fatal("нет job.json")
			}
			for name, raw := range step.Set {
				value.(*jscompat.Object).Set(name, mustParse(t, raw))
			}
			writeFile(t, r.project, path, framesStep{JSON: json.RawMessage(jscompat.Stringify(value))})
		default:
			writeFile(t, r.project, filepath.Join(r.jobDir(t), step.Path), step)
		}
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
		job.Message = step.Message
	case "discard":
		id := step.ID
		if id == "current" {
			id = ""
			if value, ok := jscompat.ReadJSONFile(filepath.Join(r.local, StoreFolder, FileName(r.project, step.Shot))); ok {
				id, _ = jscompat.GetPath(value, "proposal", "id").(string)
			}
		}
		return r.workflow.Discard(r.project, step.Shot, packageDir, id)
	case "pending":
		return r.workflow.PendingProposals(r.project), nil
	case "restart":
		r.workflow = r.create()
	default:
		t.Fatalf("неизвестная операция %s", step.Op)
	}
	return nil, nil
}

// step исполняет шаг и сверяет его исход с эталоном.
func (r *framesRun) step(t *testing.T, index int, step framesStep) {
	t.Helper()
	label := jscompat.NumberToString(float64(index)) + " " + step.Op
	startsBefore, callsBefore := len(r.agents.images), len(r.calls)
	result, err := r.execute(t, step)
	// Сначала рабочие папки: SHA запросов опор из job.json нужны нормализации остального.
	jobs := r.jobFolders(t)
	if step.Error != nil {
		if err == nil {
			t.Fatalf("%s: ожидалась ошибка %q", label, *step.Error)
		}
		if got := r.normalize(err.Error()); got != *step.Error {
			t.Fatalf("%s: ошибка\n got %s\nwant %s", label, got, *step.Error)
		}
	} else if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	if step.Op != "finish" && step.Error == nil && len(step.Result) > 0 {
		r.compareResult(t, label, step.Result, result)
	}
	r.compareState(t, label, "local", step.Local, r.localFiles(t))
	r.compareState(t, label, "packages", step.Packages, r.tree(t, filepath.Join(r.project, "plan", "batches")))
	r.compareState(t, label, "jobs", step.Jobs, jobs)

	starts := []any{}
	for _, start := range r.agents.images[startsBefore:] {
		entry := jscompat.NewObject()
		entry.Set("project", r.normalize(start.input.Project))
		entry.Set("task", start.input.Task)
		entry.Set("prompt", remember(r.normalize(start.input.Prompt)))
		entry.Set("context", remember(r.normalize(start.input.Context)))
		entry.Set("workDir", r.normalize(start.workDir))
		config, _ := json.Marshal(start.config)
		entry.Set("config", mustParse(t, config))
		starts = append(starts, entry)
	}
	r.compareList(t, label, "starts", step.Starts, starts)
	calls := []any{}
	for _, call := range r.calls[callsBefore:] {
		data, _ := json.Marshal(call)
		calls = append(calls, mustParse(t, []byte(r.normalize(string(data)))))
	}
	r.compareList(t, label, "tools", step.Tools, calls)
	service := []any{}
	if data, err := os.ReadFile(filepath.Join(r.service, "calls.jsonl")); err == nil {
		lines := slices.DeleteFunc(strings.Split(string(data), "\n"), func(line string) bool { return line == "" })
		for _, line := range lines[r.serviceSeen:] {
			service = append(service, mustParse(t, []byte(r.normalize(line))))
		}
		r.serviceSeen = len(lines)
	}
	r.compareList(t, label, "service", step.Service, service)
}

// compareResult сверяет результат шага (вид, сводку) в форме JSON.stringify.
func (r *framesRun) compareResult(t *testing.T, label string, want json.RawMessage, got any) {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if summaries, ok := got.(map[string]Summary); ok {
		expected := mustParse(t, want).(*jscompat.Object)
		if len(expected.Keys()) != len(summaries) {
			t.Fatalf("%s: сводка %s, ожидалась %s", label, data, want)
		}
		for _, shot := range expected.Keys() {
			summary, found := summaries[shot]
			if !found || r.normalize(string(summary.Value)) != jscompat.Stringify(expected.Value(shot)) {
				t.Fatalf("%s: сводка %s: %s, ожидалась %s", label, shot, summary.Value, jscompat.Stringify(expected.Value(shot)))
			}
		}
		return
	}
	gotText := jscompat.Stringify(mustParse(t, []byte(r.normalize(jscompat.Stringify(mustParse(t, data))))))
	if wantText := jscompat.Stringify(mustParse(t, want)); gotText != wantText {
		t.Fatalf("%s: результат отличается\n%s", label, firstDifference(gotText, wantText))
	}
}

// compareList сверяет необязательный список шага (starts, tools, service): отсутствие — пустой.
func (r *framesRun) compareList(t *testing.T, label, name string, want json.RawMessage, got []any) {
	t.Helper()
	wantText := "[]"
	if len(want) > 0 {
		wantText = jscompat.Stringify(mustParse(t, want))
	}
	if gotText := jscompat.Stringify(&jscompat.Array{Items: got}); gotText != wantText {
		t.Fatalf("%s: %s отличаются\n%s", label, name, firstDifference(gotText, wantText))
	}
}

// compareState сверяет состояние (local/packages/jobs) с последним записанным в эталоне. Текстовые
// записи хранятся по SHA: при расхождении показывается окрестность первого отличия текста.
func (r *framesRun) compareState(t *testing.T, label, name string, want json.RawMessage, got map[string]any) {
	t.Helper()
	if string(want) != `"unchanged"` {
		r.expected[name] = want
	}
	expected := sortDeep(mustParse(t, r.expected[name]))
	gotValue := sortDeep(mustParse(t, []byte(jscompat.Stringify(mapObject(got)))))
	if jscompat.Stringify(gotValue) == jscompat.Stringify(expected) {
		return
	}
	wantObject := expected.(*jscompat.Object)
	gotObject := gotValue.(*jscompat.Object)
	for _, key := range append(wantObject.Keys(), gotObject.Keys()...) {
		left, right := jscompat.Stringify(gotObject.Value(key)), jscompat.Stringify(wantObject.Value(key))
		if left == right {
			continue
		}
		detail := "got " + left + "\nwant " + right
		if want := r.textOf(wantObject.Value(key)); want != "" {
			detail += "\n" + firstDifference(r.pendingText(gotObject.Value(key)), want)
		}
		t.Fatalf("%s: %s %s отличается\n%s", label, name, key, detail)
	}
	t.Fatalf("%s: %s отличается\n got %s\nwant %s", label, name, jscompat.Stringify(gotValue), jscompat.Stringify(expected))
}

// textOf — текст эталона записи {text: sha} либо SHA записи каталога состояния.
func (r *framesRun) textOf(value any) string {
	if sha, ok := value.(string); ok {
		return r.blobs[sha]
	}
	if sha, ok := jscompat.Get(value, "text").(string); ok {
		return r.blobs[sha]
	}
	return ""
}

// pendingTexts — тексты Go-состояния по SHA для показа расхождения.
var pendingTexts = map[string]string{}

// pendingText — текст Go-состояния записи {text: sha} либо SHA записи каталога состояния.
func (r *framesRun) pendingText(value any) string {
	if sha, ok := value.(string); ok {
		return pendingTexts[sha]
	}
	if sha, ok := jscompat.Get(value, "text").(string); ok {
		return pendingTexts[sha]
	}
	return ""
}

// remember — SHA текста Go-состояния с запоминанием текста для показа расхождения.
func remember(text string) string {
	sum := sha256.Sum256([]byte(text))
	key := hex.EncodeToString(sum[:])
	pendingTexts[key] = text
	return key
}

// mapObject — объект с ключами в порядке сортировки (как readdirSync().sort() скрипта).
func mapObject(values map[string]any) *jscompat.Object {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	object := jscompat.NewObject()
	for _, key := range keys {
		object.Set(key, values[key])
	}
	return object
}

// sortDeep — объекты дерева с отсортированными ключами: порядок обхода папок не сравнивается.
func sortDeep(value any) any {
	object, ok := value.(*jscompat.Object)
	if !ok {
		return value
	}
	values := map[string]any{}
	for _, key := range object.Keys() {
		values[key] = sortDeep(object.Value(key))
	}
	return mapObject(values)
}

// localFiles — записи production-workflow каталога состояния: имя `<план>.json`, SHA нормализованного текста.
func (r *framesRun) localFiles(t *testing.T) map[string]any {
	t.Helper()
	names := map[string]string{}
	for _, shot := range []string{"M01", "M02", "M03", "M04", "M05", "M06"} {
		names[FileName(r.project, shot)] = shot + ".json"
	}
	result := map[string]any{}
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
		result[name] = remember(r.normalize(string(data)))
	}
	return result
}

// tree — дерево папки, как tree скрипта: каталог — `путь/`, текст — SHA нормализованного
// содержимого, иначе SHA-256 и размер; файлы без прав записи помечены readonly, ссылки — symlink.
func (r *framesRun) tree(t *testing.T, directory string) map[string]any {
	t.Helper()
	result := map[string]any{}
	var walk func(full, local string)
	walk = func(full, local string) {
		entries, err := os.ReadDir(full)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			path := filepath.Join(full, entry.Name())
			key := entry.Name()
			if local != "" {
				key = local + "/" + entry.Name()
			}
			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			item := jscompat.NewObject()
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				item.Set("symlink", true)
				result[key] = item
			case info.IsDir():
				result[key+"/"] = true
				walk(path, key)
			default:
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if textName.MatchString(entry.Name()) {
					item.Set("text", remember(r.normalize(string(data))))
				} else {
					sum := sha256.Sum256(data)
					item.Set("sha256", hex.EncodeToString(sum[:]))
					item.Set("bytes", float64(len(data)))
				}
				if info.Mode().Perm()&0o222 == 0 {
					item.Set("readonly", true)
				}
				result[key] = item
			}
		}
	}
	if jscompat.Exists(directory) {
		walk(directory, "")
	}
	return result
}

// jobFolders — рабочие папки заданий опор по jobId записи; попутно запоминает SHA запросов.
func (r *framesRun) jobFolders(t *testing.T) map[string]any {
	t.Helper()
	folder := filepath.Join(r.local, ImageJobsFolder)
	result := map[string]any{}
	entries, _ := os.ReadDir(folder)
	for _, entry := range entries {
		id := entry.Name()
		if value, ok := jscompat.ReadJSONFile(filepath.Join(folder, entry.Name(), "job.json")); ok {
			if jobID, ok := jscompat.Get(value, "jobId").(string); ok {
				id = jobID
			}
			if request, ok := jscompat.Get(value, "requestSha").(string); ok && requestHash.MatchString(request) && !slices.Contains(r.requests, request) {
				r.requests = append(r.requests, request)
			}
		}
		result[r.normalize(id)] = mapObject(r.tree(t, filepath.Join(folder, entry.Name())))
	}
	return result
}
