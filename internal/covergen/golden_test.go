package covergen_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"songframe-go/internal/agents"
	"songframe-go/internal/covergen"
	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediafile"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/mediatest"
	"songframe-go/internal/providers"
	"songframe-go/internal/providers/agentexec"
	"songframe-go/internal/providers/kling"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/referenceimage"
	"songframe-go/internal/tools"
)

// Эталон cover-generation/cases.json снят с CoverGeneration, prepareProjectCover и
// preparePaidCover оригинала (скрипт capture-cover.ts вне репозитория,
// не сохранён). Тест повторяет те же шаги на Go-генераторе: провайдер-агент test-agent исполняет
// подставной runner с очередью поведений, платный провайдер test — Go-перенос тестового сервиса
// (internal/mediatest) через настоящие media_request и cost_check. Сверяются результат или текст
// ошибки шага, сессия после шага, деревья временной папки обложки и проекта, вызовы сервиса и
// запуски агента с той же нормализацией, что у скрипта съёмки.

// outputKeys — ключи шага, которые пишет исполнение; остальные — вход шага.
var outputKeys = map[string]bool{"result": true, "error": true, "session": true, "rootTree": true, "projectTree": true, "calls": true, "runs": true}

type fileSpec struct {
	Path    string  `json:"path"`
	Base64  *string `json:"base64"`
	Text    *string `json:"text"`
	Symlink string  `json:"symlink"`
	Remove  bool    `json:"remove"`
}

type behavior struct {
	Write         string `json:"write"`
	Base64        string `json:"base64"`
	Path          string `json:"path"`
	Error         string `json:"error"`
	Block         bool   `json:"block"`
	LateWrite     string `json:"lateWrite"`
	ValidateError string `json:"validateError"`
}

type stepInput struct {
	Op               string          `json:"op"`
	Generation       json.RawMessage `json:"generation"`
	Files            []fileSpec      `json:"files"`
	Behaviors        []behavior      `json:"behaviors"`
	Config           json.RawMessage `json:"config"`
	Pricing          json.RawMessage `json:"pricing"`
	Project          *string         `json:"project"`
	Prompt           json.RawMessage `json:"prompt"`
	Images           json.RawMessage `json:"images"`
	Token            string          `json:"token"`
	Sha              string          `json:"sha"`
	Confirmed        *bool           `json:"confirmed"`
	AllowUnknownCost *bool           `json:"allowUnknownCost"`
	Crop             json.RawMessage `json:"crop"`
	Entity           string          `json:"entity"`
	Path             string          `json:"path"`
	Base64           string          `json:"base64"`
}

type goldenScenario struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Reference   bool              `json:"reference"`
	Steps       []json.RawMessage `json:"steps"`
}

type goldenCases struct {
	Scenarios []json.RawMessage `json:"scenarios"`
	Inspect   []json.RawMessage `json:"inspect"`
	Context   []json.RawMessage `json:"context"`
}

func loadCases(t *testing.T) goldenCases {
	t.Helper()
	var cases goldenCases
	if err := json.Unmarshal(golden.ReadFile(t, "cover-generation", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// encode — JSON.stringify значения Go без экранирования HTML.
func encode(t *testing.T, value any) string {
	t.Helper()
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

// object — JSON-объект с ключами в заданном порядке: порядок появления UUID в тексте задаёт их
// маркеры, поэтому он совпадает с порядком ключей скрипта съёмки.
type object struct{ parts []string }

func (o *object) add(t *testing.T, key string, raw string) {
	o.parts = append(o.parts, encode(t, key)+":"+raw)
}

func (o *object) String() string { return "{" + strings.Join(o.parts, ",") + "}" }

// expand — текст шага: строка или {repeat, count}.
func expand(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var repeat struct {
		Repeat string `json:"repeat"`
		Count  int    `json:"count"`
	}
	if err := json.Unmarshal(raw, &repeat); err != nil {
		t.Fatal(err)
	}
	return strings.Repeat(repeat.Repeat, repeat.Count)
}

func decodeBase64(t *testing.T, value string) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// writeSpec — writeSpec скрипта: путь от base или от корня сессии (<root>/).
func writeSpec(t *testing.T, base string, spec fileSpec, root string) {
	t.Helper()
	target := filepath.Join(base, spec.Path)
	if rest, ok := strings.CutPrefix(spec.Path, "<root>/"); ok {
		target = filepath.Join(root, rest)
	}
	if spec.Remove {
		_ = os.RemoveAll(target)
		return
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatal(err)
	}
	if spec.Symlink != "" {
		if err := os.Symlink(spec.Symlink, target); err != nil {
			t.Fatal(err)
		}
		return
	}
	data := []byte{}
	if spec.Base64 != nil {
		data = decodeBase64(t, *spec.Base64)
	} else if spec.Text != nil {
		data = []byte(*spec.Text)
	}
	if err := os.WriteFile(target, data, 0o666); err != nil {
		t.Fatal(err)
	}
}

var textFile = regexp.MustCompile(`(^|/)session\.json$|^source/manifest\.json$|^plan/cast\.json$|\.prompt\.txt$`)
var requestFile = regexp.MustCompile(`(^|/)request/`)

// tree — дерево папки в формате скрипта съёмки; nil — папки нет.
func tree(t *testing.T, directory string, skip func(string) bool) []map[string]any {
	t.Helper()
	if _, err := os.Stat(directory); err != nil {
		return nil
	}
	entries := []map[string]any{}
	var walk func(dir, prefix string)
	walk = func(dir, prefix string) {
		items, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			path := item.Name()
			if prefix != "" {
				path = prefix + "/" + item.Name()
			}
			if skip != nil && skip(path) {
				continue
			}
			full := filepath.Join(dir, item.Name())
			info, err := os.Lstat(full)
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case info.IsDir():
				entries = append(entries, map[string]any{"path": path + "/"})
				walk(full, path)
			case requestFile.MatchString(path):
				entries = append(entries, map[string]any{"path": path})
			case item.Name() == "accepted.png":
				var size any
				if width, height, ok := mediafile.Dimensions(full); ok {
					size = map[string]any{"width": width, "height": height}
				}
				entries = append(entries, map[string]any{"path": path, "size": size})
			default:
				data, err := os.ReadFile(full)
				if err != nil {
					t.Fatal(err)
				}
				if textFile.MatchString(path) {
					entries = append(entries, map[string]any{"path": path, "text": string(data)})
				} else {
					sum := sha256.Sum256(data)
					entries = append(entries, map[string]any{"path": path, "sha256": hex.EncodeToString(sum[:]), "bytes": info.Size()})
				}
			}
		}
	}
	walk(directory, "")
	return entries
}

// treeJSON — дерево как JSON в порядке ключей скрипта (path первым).
func treeJSON(t *testing.T, entries []map[string]any) string {
	t.Helper()
	if entries == nil {
		return "null"
	}
	items := make([]string, len(entries))
	for index, entry := range entries {
		item := &object{}
		item.add(t, "path", encode(t, entry["path"]))
		for _, key := range []string{"size", "text", "sha256", "bytes"} {
			if value, ok := entry[key]; ok {
				raw := encode(t, value)
				if key == "size" && value != nil {
					size := value.(map[string]any)
					raw = `{"width":` + encode(t, size["width"]) + `,"height":` + encode(t, size["height"]) + `}`
				}
				item.add(t, key, raw)
			}
		}
		items[index] = item.String()
	}
	return "[" + strings.Join(items, ",") + "]"
}

var (
	uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	coverDir    = regexp.MustCompile(`songframe-cover-[A-Za-z0-9]+`)
	isoTime     = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})`)
)

// normalize — normalize скрипта съёмки над JSON-текстом.
func normalize(text string, paths [][2]string, shas []string) string {
	for _, pair := range paths {
		text = strings.ReplaceAll(text, pair[0], pair[1])
	}
	text = coverDir.ReplaceAllString(text, "songframe-cover-<n>")
	for index, value := range shas {
		text = strings.ReplaceAll(text, value, "<request"+itoa(index+1)+">")
	}
	ids := map[string]string{}
	text = uuidPattern.ReplaceAllStringFunc(text, func(id string) string {
		if _, ok := ids[id]; !ok {
			ids[id] = "<id" + itoa(len(ids)+1) + ">"
		}
		return ids[id]
	})
	return isoTime.ReplaceAllString(text, "<time>")
}

func itoa(value int) string { return strconv.Itoa(value) }

// sortTrees упорядочивает деревья шагов по пути после нормализации (имена папок попыток — UUID).
func sortTrees(t *testing.T, text string) []byte {
	t.Helper()
	var scenario map[string]any
	if err := json.Unmarshal([]byte(text), &scenario); err != nil {
		t.Fatalf("неверный JSON шага: %v\n%s", err, text)
	}
	steps, _ := scenario["steps"].([]any)
	for _, step := range steps {
		entry := step.(map[string]any)
		for _, key := range []string{"rootTree", "projectTree"} {
			if items, ok := entry[key].([]any); ok {
				sort.SliceStable(items, func(i, j int) bool {
					return items[i].(map[string]any)["path"].(string) < items[j].(map[string]any)["path"].(string)
				})
			}
		}
	}
	data, err := json.Marshal(scenario)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// gate повторяет очередь событий оригинала: фоновая генерация CoverGeneration начинается только
// после того, как скрипт съёмки уступит управление (await в prepare, wait, waitStarted, close,
// shutdown). Шаги generate закрывают ворота, ожидающие шаги открывают; исполнитель агента и
// вызовы тестового сервиса ждут открытия, поэтому запуски и вызовы относятся к тем же шагам, что
// в эталоне, независимо от планировщика горутин.
type gate struct {
	mu     sync.Mutex
	closed bool
	ch     chan struct{}
}

func (g *gate) shut() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.closed {
		g.closed, g.ch = true, make(chan struct{})
	}
}

func (g *gate) open() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		g.closed = false
		close(g.ch)
	}
}

func (g *gate) wait(ctx context.Context) {
	g.mu.Lock()
	closed, ch := g.closed, g.ch
	g.mu.Unlock()
	if !closed {
		return
	}
	select {
	case <-ch:
	case <-ctx.Done():
	}
}

// testAgent — подставной исполнитель обложки test-agent: поведение берётся из очереди шага
// agent, запуск записывается в runs.
type testAgent struct {
	gate      *gate
	mu        sync.Mutex
	behaviors []behavior
	runs      []string
	started   atomic.Bool
}

type agentRunner struct {
	agent  *testAgent
	config agents.Settings
	t      *testing.T
}

func (r agentRunner) ValidateInput(agentexec.CoverInput) error {
	r.agent.mu.Lock()
	defer r.agent.mu.Unlock()
	if len(r.agent.behaviors) > 0 && r.agent.behaviors[0].ValidateError != "" {
		message := r.agent.behaviors[0].ValidateError
		r.agent.behaviors = r.agent.behaviors[1:]
		return errors.New(message)
	}
	return nil
}

func (r agentRunner) Run(ctx context.Context, input agentexec.CoverInput) (string, error) {
	r.agent.gate.wait(ctx)
	r.agent.mu.Lock()
	next := behavior{Error: "Нет поведения агента."}
	if len(r.agent.behaviors) > 0 {
		next = r.agent.behaviors[0]
		r.agent.behaviors = r.agent.behaviors[1:]
	}
	references := input.References
	if references == nil {
		references = []mediaapi.ReferenceImage{}
	}
	var purpose any
	if input.Purpose != "" {
		purpose = input.Purpose
	}
	run := &object{}
	run.add(r.t, "config", encode(r.t, r.config))
	run.add(r.t, "workDir", encode(r.t, input.WorkDir))
	run.add(r.t, "project", encode(r.t, input.Project))
	run.add(r.t, "prompt", encode(r.t, input.Prompt))
	run.add(r.t, "purpose", encode(r.t, purpose))
	run.add(r.t, "references", encode(r.t, references))
	r.agent.runs = append(r.agent.runs, run.String())
	r.agent.mu.Unlock()
	r.agent.started.Store(true)
	write := func(name string) error {
		data, err := base64.StdEncoding.DecodeString(next.Base64)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(input.WorkDir, name), data, 0o666)
	}
	switch {
	case next.Block:
		<-ctx.Done()
		if next.LateWrite != "" {
			if err := write(next.LateWrite); err != nil {
				return "", err
			}
		}
		if input.Purpose == agentexec.PurposeReference {
			return "", errors.New("Генерация референса остановлена.")
		}
		return "", errors.New("Генерация обложки остановлена.")
	case next.Error != "":
		return "", errors.New(next.Error)
	case next.Write != "":
		if err := write(next.Write); err != nil {
			return "", err
		}
		return next.Write, nil
	}
	return next.Path, nil
}

// rulesService — тестовый сервис с правилами testPaidAdapter оригинала (правила Kling без
// frameDefined, как в providers/golden_test.go).
type rulesService struct {
	*mediatest.Service
	gate *gate
}

func (s rulesService) Account(ctx context.Context, timeout time.Duration) (mediaapi.Account, error) {
	s.gate.wait(ctx)
	return s.Service.Account(ctx, timeout)
}

func (s rulesService) Submit(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (mediaapi.SubmitResult, error) {
	s.gate.wait(ctx)
	return s.Service.Submit(ctx, directory, request, state, timeout)
}

func (s rulesService) Poll(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (mediaapi.PollResult, error) {
	s.gate.wait(ctx)
	return s.Service.Poll(ctx, directory, request, state, timeout)
}

func (rulesService) RequestRules() mediaapi.RequestRules {
	rules := kling.RequestRules()
	rules.FrameDefined = nil
	return rules
}

// registerProviders подключает провайдеров test и test-agent на время теста.
func registerProviders(t *testing.T, agent *testAgent) {
	t.Helper()
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image, mediaproviders.Video}, Paid: true, DefaultImageResolution: "2k"}))
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	t.Cleanup(providers.RegisterAgent(providers.AgentAdapter{ID: "test-agent", Cover: func(config agents.Settings) providers.CoverRunner {
		return agentRunner{agent: agent, config: config, t: t}
	}}))
}

// realpath — каталог без символических ссылок (как realpathSync скрипта).
func realpath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func mkdirs(t *testing.T, paths ...string) {
	t.Helper()
	for _, path := range paths {
		if err := os.MkdirAll(path, 0o777); err != nil {
			t.Fatal(err)
		}
	}
}

// TestGoldenScenarios повторяет сценарии оригинала на Go-генераторе.
func TestGoldenScenarios(t *testing.T) {
	cases := loadCases(t)
	if len(cases.Scenarios) == 0 {
		t.Fatal("нет сценариев")
	}
	for _, raw := range cases.Scenarios {
		var scenario goldenScenario
		if err := json.Unmarshal(raw, &scenario); err != nil {
			t.Fatal(err)
		}
		t.Run(scenario.Name, func(t *testing.T) {
			got := runScenario(t, scenario)
			if dump := os.Getenv("COVER_DUMP"); dump != "" {
				_ = os.WriteFile(filepath.Join(dump, scenario.Name+".json"), got, 0o666)
			}
			diffs, err := golden.Diff(raw, got)
			if err != nil {
				t.Fatal(err)
			}
			if len(diffs) > 0 {
				t.Fatalf("сценарий отличается от оригинала (%d):\n%s", len(diffs), strings.Join(diffs, "\n"))
			}
		})
	}
}

// runScenario исполняет шаги сценария и возвращает нормализованный JSON в формате эталона.
func runScenario(t *testing.T, scenario goldenScenario) []byte {
	dir := realpath(t, t.TempDir())
	project := filepath.Join(dir, "project")
	service := filepath.Join(dir, "service")
	state := filepath.Join(dir, "state")
	temp := filepath.Join(dir, "tmp")
	mkdirs(t, filepath.Join(project, "plan"), service, state, temp)
	if err := os.WriteFile(filepath.Join(service, "service.json"), []byte("{}\n"), 0o666); err != nil {
		t.Fatal(err)
	}
	// media_request принимает рабочую папку платной попытки только внутри временной папки ОС.
	t.Setenv("TMPDIR", temp)
	t.Setenv("SONGFRAME_PRICING_FILE", "")
	gates := &gate{}
	agent := &testAgent{gate: gates}
	registerProviders(t, agent)
	t.Cleanup(mediaadapters.Register(mediatest.ID, rulesService{Service: &mediatest.Service{Dir: service}, gate: gates}))
	savedLocal, savedState := tools.LocalDir, mediaadapters.StateDir
	tools.LocalDir = func() (string, error) { return state, nil }
	mediaadapters.StateDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { tools.LocalDir, mediaadapters.StateDir = savedLocal, savedState })

	access := &agents.AccessChecker{Settings: agents.NewSettingsStore(filepath.Join(state, "settings"))}
	layer := providers.NewLayer(providers.Options{Paid: providers.PaidOptions{ValidateImage: mediafile.Decodes}})
	assert := func(project string) error { return access.AssertSelection(&project, agents.KindImage) }
	// Папки сессий, разрешённые медиасерверу: без этого окно не покажет превью опор и результата.
	allowedMedia := map[string]bool{}
	generator := covergen.New(covergen.Options{
		AllowMedia:      func(directory string) error { allowedMedia[directory] = true; return nil },
		Reference:       scenario.Reference,
		AssertSelection: assert,
		ReadImage:       covergen.ReadImage,
		CropImage:       covergen.CropImage,
		TempDir:         func() string { return temp },
		Prepare: func(ctx context.Context, input covergen.CandidateInput) (*covergen.Candidate, error) {
			return covergen.PrepareProject(ctx, input, covergen.ProjectOptions{
				AssertSelection: assert,
				Paid: func(ctx context.Context, input covergen.CandidateInput, provider string) (*covergen.Candidate, error) {
					media, err := layer.RequirePaidMedia(provider, mediaproviders.Image)
					if err != nil {
						return nil, err
					}
					return covergen.PreparePaid(ctx, input, covergen.PaidOptions{Media: media})
				},
			})
		},
	})
	t.Cleanup(func() { _ = generator.Shutdown() })

	paths := [][2]string{{temp, "<tmp>"}, {project, "<project>"}, {service, "<service>"}, {state, "<state>"}}
	var shas, tokens, requests []string
	id := ""
	lastRoot := ""
	seenRoots := map[string]bool{}
	callsSeen := 0
	previousSession, previousRoot, previousProject := "", "", ""
	view := func() string {
		if id == "" {
			return "null"
		}
		session, err := generator.View(id)
		if err != nil {
			return encode(t, map[string]string{"error": err.Error()})
		}
		return encode(t, session)
	}
	remember := func(session *covergen.Session) {
		if session == nil {
			return
		}
		if session.RequestSha != nil && !contains(shas, *session.RequestSha) {
			shas = append(shas, *session.RequestSha)
		}
		if session.ApprovalToken != nil && (len(tokens) == 0 || tokens[len(tokens)-1] != *session.ApprovalToken) {
			tokens = append(tokens, *session.ApprovalToken)
		}
		if session.RequestSha != nil && (len(requests) == 0 || requests[len(requests)-1] != *session.RequestSha) {
			requests = append(requests, *session.RequestSha)
		}
	}
	wait := func(done func() bool) {
		for attempt := 0; attempt < 3000 && !done(); attempt++ {
			time.Sleep(10 * time.Millisecond)
		}
	}
	previous := func(list []string) string {
		switch {
		case len(list) >= 2:
			return list[len(list)-2]
		case len(list) == 1:
			return list[0]
		}
		return ""
	}
	steps := []string{}
	for _, raw := range scenario.Steps {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		var step stepInput
		if err := json.Unmarshal(raw, &step); err != nil {
			t.Fatal(err)
		}
		entry := &object{}
		keys := []string{}
		for key := range fields {
			if !outputKeys[key] {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			entry.add(t, key, string(fields[key]))
		}
		switch step.Op {
		case "generate", "double":
			gates.shut()
		case "prepare", "wait", "waitStarted", "close", "shutdown":
			gates.open()
		}
		var result any
		var stepErr error
		switch step.Op {
		case "writeProject":
			generation, err := jscompat.Parse(step.Generation)
			if err != nil {
				t.Fatal(err)
			}
			document := jscompat.NewObject()
			document.Set("name", "Клип")
			document.Set("animatic_video", "animatic.mp4")
			document.Set("generation", generation)
			if err := os.WriteFile(filepath.Join(project, "plan", "project.json"), []byte(jscompat.StringifyIndent(document, "  ")+"\n"), 0o666); err != nil {
				t.Fatal(err)
			}
		case "files":
			for _, file := range step.Files {
				writeSpec(t, project, file, lastRoot)
			}
		case "tamper":
			value := step.Base64
			writeSpec(t, project, fileSpec{Path: step.Path, Base64: &value}, lastRoot)
		case "agent":
			agent.mu.Lock()
			agent.behaviors = append([]behavior{}, step.Behaviors...)
			agent.mu.Unlock()
		case "service":
			if err := os.WriteFile(filepath.Join(service, "service.json"), append(append([]byte{}, step.Config...), '\n'), 0o666); err != nil {
				t.Fatal(err)
			}
			if len(step.Pricing) > 0 {
				if err := os.WriteFile(filepath.Join(service, "pricing.json"), append(append([]byte{}, step.Pricing...), '\n'), 0o666); err != nil {
					t.Fatal(err)
				}
			}
		case "create":
			target := project
			if step.Project != nil {
				target = *step.Project
				if target == "<missing>" {
					target = filepath.Join(dir, "missing")
				}
			}
			var input *referenceimage.GenerationInput
			if len(step.Images) > 0 && string(step.Images) != "null" {
				var images []referenceimage.InputImage
				if err := json.Unmarshal(step.Images, &images); err != nil {
					t.Fatal(err)
				}
				for index := range images {
					images[index].Path = strings.Replace(images[index].Path, "<project>", project, 1)
				}
				input = &referenceimage.GenerationInput{Images: images}
			}
			session, err := generator.Create(target, expand(t, step.Prompt), input)
			if stepErr = err; err == nil {
				id = session.ID
				if !scenario.Reference {
					lastRoot = newRoot(t, temp, seenRoots)
					if !allowedMedia[lastRoot] {
						t.Fatalf("%s: папка сессии %s не разрешена медиасерверу", scenario.Name, lastRoot)
					}
				}
				result = session
			}
		case "prepare":
			session, err := generator.Prepare(id)
			if stepErr = err; err == nil {
				remember(&session)
				result = session
			}
		case "generate":
			current, err := generator.View(id)
			if stepErr = err; err != nil {
				break
			}
			token, sha := "", ""
			switch step.Token {
			case "", "current":
				if current.ApprovalToken != nil {
					token = *current.ApprovalToken
				}
			case "previous":
				token = previous(tokens)
			case "wrong":
				token = "wrong-token"
			}
			switch step.Sha {
			case "", "current":
				if current.RequestSha != nil {
					sha = *current.RequestSha
				}
			case "previous":
				sha = previous(requests)
			case "wrong":
				sha = strings.Repeat("b", 64)
			}
			approval := &covergen.Approval{ApprovalToken: token, PromptConfirmed: step.Confirmed == nil || *step.Confirmed}
			if step.AllowUnknownCost != nil {
				approval.AllowUnknownCost = *step.AllowUnknownCost
			}
			agent.started.Store(false)
			session, err := generator.Generate(id, sha, approval)
			if stepErr = err; err == nil {
				result = session
			}
		case "double":
			current, err := generator.View(id)
			if stepErr = err; err != nil {
				break
			}
			approval := &covergen.Approval{ApprovalToken: deref(current.ApprovalToken), PromptConfirmed: true}
			attempt := func() string {
				session, err := generator.Generate(id, deref(current.RequestSha), approval)
				if err != nil {
					return encode(t, map[string]string{"error": err.Error()})
				}
				return encode(t, session)
			}
			first := attempt()
			second := attempt()
			result = json.RawMessage(`{"first":` + first + `,"second":` + second + `}`)
		case "wait":
			wait(func() bool {
				session, err := generator.View(id)
				return id == "" || err != nil || (!session.Preparing && session.Status != covergen.StatusGenerating)
			})
		case "waitStarted":
			wait(agent.started.Load)
		case "view":
			session, err := generator.View(id)
			if stepErr = err; err == nil {
				result = session
			}
		case "accept":
			var crop *covergen.Crop
			if len(step.Crop) > 0 && string(step.Crop) != "null" {
				crop = &covergen.Crop{}
				if err := json.Unmarshal(step.Crop, crop); err != nil {
					t.Fatal(err)
				}
			}
			accepted, err := generator.Accept(id, crop)
			if stepErr = err; err == nil {
				result = accepted
			}
		case "acceptReference":
			accepted, err := generator.AcceptReference(id)
			if stepErr = err; err == nil {
				result = accepted
			}
		case "attach":
			accepted, err := generator.AcceptReference(id)
			if stepErr = err; err != nil {
				break
			}
			owner, err := generator.Project(id)
			if stepErr = err; err != nil {
				break
			}
			if stepErr = referenceimage.Attach(owner, step.Entity, accepted); stepErr == nil {
				result = accepted
			}
		case "close":
			stepErr = generator.Close(id)
		case "shutdown":
			stepErr = generator.Shutdown()
		default:
			t.Fatalf("неизвестный шаг %q", step.Op)
		}
		if stepErr != nil {
			entry.add(t, "error", encode(t, stepErr.Error()))
		} else if result != nil {
			entry.add(t, "result", encode(t, result))
		}
		session := view()
		if session != "null" && !strings.HasPrefix(session, `{"error"`) {
			var value covergen.Session
			if err := json.Unmarshal([]byte(session), &value); err != nil {
				t.Fatal(err)
			}
			remember(&value)
		}
		if session == previousSession {
			entry.add(t, "session", `"unchanged"`)
		} else {
			entry.add(t, "session", session)
		}
		previousSession = session
		rootTree := "null"
		if lastRoot != "" && !scenario.Reference {
			rootTree = treeJSON(t, tree(t, lastRoot, nil))
		}
		projectTree := treeJSON(t, tree(t, project, func(path string) bool { return path == "plan/project.json" }))
		for _, pair := range [][3]string{{"rootTree", rootTree, previousRoot}, {"projectTree", projectTree, previousProject}} {
			if pair[1] == pair[2] {
				entry.add(t, pair[0], `"unchanged"`)
			} else {
				entry.add(t, pair[0], pair[1])
			}
		}
		previousRoot, previousProject = rootTree, projectTree
		calls := []string{}
		if data, err := os.ReadFile(filepath.Join(service, "calls.jsonl")); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if line != "" {
					calls = append(calls, line)
				}
			}
		}
		entry.add(t, "calls", "["+strings.Join(calls[callsSeen:], ",")+"]")
		callsSeen = len(calls)
		agent.mu.Lock()
		entry.add(t, "runs", "["+strings.Join(agent.runs, ",")+"]")
		agent.runs = nil
		agent.mu.Unlock()
		steps = append(steps, entry.String())
	}
	gates.open()
	if err := generator.Shutdown(); err != nil {
		t.Fatal(err)
	}
	document := &object{}
	document.add(t, "name", encode(t, scenario.Name))
	document.add(t, "description", encode(t, scenario.Description))
	document.add(t, "reference", encode(t, scenario.Reference))
	document.add(t, "steps", "["+strings.Join(steps, ",")+"]")
	return sortTrees(t, normalize(document.String(), paths, shas))
}

// newRoot — временная папка обложки, созданная последним create (songframe-cover-* в temp).
func newRoot(t *testing.T, temp string, seen map[string]bool) string {
	t.Helper()
	entries, err := os.ReadDir(temp)
	if err != nil {
		t.Fatal(err)
	}
	found := ""
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "songframe-cover-") && !seen[entry.Name()] {
			if found != "" {
				t.Fatalf("несколько новых папок обложки: %s и %s", found, entry.Name())
			}
			found = entry.Name()
		}
	}
	if found == "" {
		t.Fatal("create не создал временную папку обложки")
	}
	seen[found] = true
	return filepath.Join(temp, found)
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// TestGoldenInspect — inspectReferenceImageInputs оригинала: порядок, повторы и отказы опор.
func TestGoldenInspect(t *testing.T) {
	for _, raw := range loadCases(t).Inspect {
		var item struct {
			Name   string                       `json:"name"`
			Files  []fileSpec                   `json:"files"`
			Images *[]referenceimage.InputImage `json:"images"`
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			t.Fatal(err)
		}
		t.Run(item.Name, func(t *testing.T) {
			dir := realpath(t, t.TempDir())
			for _, file := range item.Files {
				writeSpec(t, dir, file, "")
			}
			input := referenceimage.GenerationInput{}
			if item.Images != nil {
				input.Images = append([]referenceimage.InputImage{}, (*item.Images)...)
				for index := range input.Images {
					input.Images[index].Path = strings.Replace(input.Images[index].Path, "<project>", dir, 1)
				}
			}
			result, err := referenceimage.Inspect(input)
			assertOutcome(t, raw, result, err, nil, dir)
		})
	}
}

// TestGoldenContext — readReferenceImageContext оригинала: сохранённые файлы, черновики, пределы;
// дерево проекта после чтения не меняется.
func TestGoldenContext(t *testing.T) {
	for _, raw := range loadCases(t).Context {
		var item struct {
			Name   string                     `json:"name"`
			Files  []fileSpec                 `json:"files"`
			Drafts map[string]json.RawMessage `json:"drafts"`
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			t.Fatal(err)
		}
		t.Run(item.Name, func(t *testing.T) {
			dir := realpath(t, t.TempDir())
			for _, file := range item.Files {
				writeSpec(t, dir, file, "")
			}
			var drafts *referenceimage.ContextDrafts
			if item.Drafts != nil {
				drafts = &referenceimage.ContextDrafts{}
				if value, ok := item.Drafts["idea"]; ok {
					text := expand(t, value)
					drafts.Idea = &text
				}
				if value, ok := item.Drafts["lyrics"]; ok {
					text := expand(t, value)
					drafts.Lyrics = &text
				}
			}
			result, err := referenceimage.ReadContext(dir, drafts)
			after := json.RawMessage(treeJSON(t, tree(t, dir, nil)))
			assertOutcome(t, raw, result, err, after, dir)
		})
	}
}

// assertOutcome сверяет случай эталона с исходом Go: вход случая сохраняется, result или error
// (и after, если передан) заменяются полученными значениями.
func assertOutcome(t *testing.T, raw json.RawMessage, result any, err error, after json.RawMessage, dir string) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "result")
	delete(fields, "error")
	if err != nil {
		fields["error"] = json.RawMessage(encode(t, err.Error()))
	} else {
		fields["result"] = json.RawMessage(normalize(encode(t, result), [][2]string{{dir, "<project>"}}, nil))
	}
	if after != nil {
		fields["after"] = json.RawMessage(normalize(string(after), [][2]string{{dir, "<project>"}}, nil))
	}
	got, marshalErr := json.Marshal(fields)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	diffs, diffErr := golden.Diff(raw, got)
	if diffErr != nil {
		t.Fatal(diffErr)
	}
	if len(diffs) > 0 {
		t.Fatalf("случай отличается от оригинала (%d):\n%s", len(diffs), strings.Join(diffs, "\n"))
	}
}
