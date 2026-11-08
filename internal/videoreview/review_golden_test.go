package videoreview

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe-go/internal/agents"
	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
)

// Эталон video-review задан на подставных инструментах и модели: поддельный video_review пишет
// кадры F001–F003 (0; 0,5; 0,9 с) и копии опор, continuity_brief возвращает {phase, entities}.
// Тест повторяет каждый сценарий эталона и сравнивает представления (job — только id и статус),
// ошибки, вызовы инструментов, вход агента (задача, промпт, изображения, строка контекста) и
// точные байты latest.json после каждого шага. Пути проекта заменены <project>,
// UUID выборки — <id>.

const onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII="

var uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)

type goldenStep struct {
	Op     string          `json:"op"`
	View   json.RawMessage `json:"view"`
	Throws *string         `json:"throws"`
	Latest *string         `json:"latest"`
}

type goldenStart struct {
	Project       string   `json:"project"`
	Task          string   `json:"task"`
	PromptIsSkill bool     `json:"promptIsSkill"`
	Images        []string `json:"images"`
	Context       string   `json:"context"`
}

type goldenScenario struct {
	Name        string          `json:"name"`
	Steps       []goldenStep    `json:"steps"`
	ToolCalls   json.RawMessage `json:"toolCalls"`
	AgentStarts []goldenStart   `json:"agentStarts"`
}

type goldenParse struct {
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	Duration float64         `json:"duration"`
	Result   json.RawMessage `json:"result"`
	Throws   *string         `json:"throws"`
}

type reviewGolden struct {
	Frames    []Frame          `json:"frames"`
	Parse     []goldenParse    `json:"parse"`
	Scenarios []goldenScenario `json:"scenarios"`
}

func loadReviewGolden(t *testing.T) reviewGolden {
	var document reviewGolden
	if err := json.Unmarshal(golden.ReadFile(t, "video-review", "cases.json"), &document); err != nil {
		t.Fatal(err)
	}
	return document
}

func TestParseReportGolden(t *testing.T) {
	document := loadReviewGolden(t)
	for _, item := range document.Parse {
		t.Run(item.Name, func(t *testing.T) {
			var input any
			var text string
			if json.Unmarshal(item.Input, &text) == nil {
				input = text
			} else {
				parsed, err := jscompat.Parse(item.Input)
				if err != nil {
					t.Fatal(err)
				}
				input = parsed
			}
			report, err := ParseReport(input, document.Frames, item.Duration)
			if item.Throws != nil {
				if err == nil || err.Error() != *item.Throws {
					t.Fatalf("ожидалась ошибка %q, получено %v", *item.Throws, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := jscompat.Stringify(report); !sameJSON(t, []byte(got), item.Result) {
				t.Fatalf("отчёт %s, ожидался %s", got, item.Result)
			}
		})
	}
}

// sameJSON сравнивает JSON по значению.
func sameJSON(t *testing.T, left, right []byte) bool {
	var a, b any
	if err := json.Unmarshal(left, &a); err != nil {
		t.Fatalf("%v: %s", err, left)
	}
	if err := json.Unmarshal(right, &b); err != nil {
		t.Fatalf("%v: %s", err, right)
	}
	return reflect.DeepEqual(a, b)
}

// fakeAgents — подставной менеджер заданий агента в памяти теста: запоминает запуски и их входы.
type fakeAgents struct {
	mu     sync.Mutex
	jobs   map[string]*agents.Job
	order  []string
	starts []agents.StartInput
}

func newFakeAgents() *fakeAgents { return &fakeAgents{jobs: map[string]*agents.Job{}} }

func (f *fakeAgents) Start(input agents.StartInput) (agents.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, input)
	job := &agents.Job{SchemaVersion: 1, ID: fmt.Sprintf("job-%d", len(f.jobs)+1), Project: input.Project, Provider: "codex", Task: input.Task, Status: "running"}
	f.jobs[job.ID] = job
	f.order = append(f.order, job.ID)
	return *job, nil
}

func (f *fakeAgents) Get(id string) (agents.Job, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	job, ok := f.jobs[id]
	if !ok {
		return agents.Job{}, false
	}
	return *job, true
}

func (f *fakeAgents) List(project string) []agents.Job {
	f.mu.Lock()
	defer f.mu.Unlock()
	result := []agents.Job{}
	for _, id := range f.order {
		if job := f.jobs[id]; job != nil && (project == "" || job.Project == project) {
			result = append(result, *job)
		}
	}
	return result
}

func (f *fakeAgents) Cancel(id string) (agents.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	job := f.jobs[id]
	job.Status = "cancelled"
	return *job, nil
}

// update меняет задание под блокировкой (index — порядок запуска).
func (f *fakeAgents) update(index int, change func(job *agents.Job)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f.jobs[f.order[index]])
}

// harness — проект и подставное окружение одного сценария.
type harness struct {
	t          *testing.T
	project    string
	directory  string
	original   string
	references []string
	agents     *fakeAgents
	mu         sync.Mutex
	toolCalls  []map[string]any
	gate       chan struct{}
	available  bool
	busy       bool
	// extractHook и briefHook подменяют поведение инструментов сценария.
	extractHook func(input ExtractInput, manifest *Manifest) error
	briefHook   func(phase string) (string, error)
	services    []*Service
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

var pixel, _ = base64.StdEncoding.DecodeString(onePixelPNG)

func newHarness(t *testing.T) *harness {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, project: root, agents: newFakeAgents(), available: true}
	sample := filepath.Join(goldenRoot(t), "video-review", "project", "plan")
	for _, name := range []string{"scenes.json", "cast.json", "project.json"} {
		writeFile(t, filepath.Join(root, "plan", name), readFile(t, filepath.Join(sample, name)))
	}
	h.directory = filepath.Join(root, "plan", "batches", "review-M01")
	request := filepath.Join(h.directory, "requests", "one")
	h.original = filepath.Join(request, "original.mp4")
	writeFile(t, h.original, []byte("Локальные байты оригинала; декодирование заменено подставным инструментом."))
	h.references = []string{filepath.Join(h.directory, "K01.png"), filepath.Join(h.directory, "K02.png")}
	for _, path := range h.references {
		writeFile(t, path, pixel)
	}
	writeFile(t, filepath.Join(h.directory, "description.md"), []byte("Лодка у причала."))
	writeFile(t, filepath.Join(h.directory, "video-prompt.txt"), []byte("Редактируемый черновик, который уже отличается."))
	writeFile(t, filepath.Join(request, "prompt.txt"), []byte("Замороженный промпт: лодка у причала."))
	writeFile(t, filepath.Join(request, "request.json"), []byte(`{"provider":"test","kind":"video","model":"test","prompt":"prompt.txt","parameters":{},"inputs":[]}`))
	writeFile(t, filepath.Join(request, "attempt.json"), []byte(`{"status":"downloaded","request_sha256":"`+strings.Repeat("a", 64)+`","downloads":[{"path":"original.mp4"}]}`))
	writeFile(t, filepath.Join(h.directory, "workflow.json"), []byte(`{"schema_version":1,"shot":"M01","stage":"downloaded","request_dir":"requests/one","timing":{"request_seconds":5},"keyframes":[{"id":"K01","role":"first","time_seconds":0,"path":"K01.png","approved":true},{"id":"K02","role":"last","time_seconds":1,"path":"K02.png","approved":true},{"id":"K03","role":"middle","time_seconds":0.5,"path":"K03.png","approved":false}]}`))
	t.Cleanup(func() {
		h.open()
		for _, service := range h.services {
			service.Shutdown()
		}
	})
	return h
}

func goldenRoot(t *testing.T) string {
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// open снимает блокировку подготовки (gate), если она стоит.
func (h *harness) open() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.gate != nil {
		close(h.gate)
		h.gate = nil
	}
}

func (h *harness) block() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.gate = make(chan struct{})
}

func (h *harness) record(name string, args []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	items := make([]any, len(args))
	for index, arg := range args {
		items[index] = arg
	}
	h.toolCalls = append(h.toolCalls, map[string]any{"name": name, "args": items})
}

// extract — поддельный video_review: пишет кадры и копии опор эталона без FFmpeg.
func (h *harness) extract(ctx context.Context, input ExtractInput) (Manifest, error) {
	args := []string{"--video", input.Video, "--out", input.Out, "--json", "--image-budget-bytes", fmt.Sprint(input.BudgetBytes)}
	for _, path := range input.References {
		args = append(args, "--reference", path)
	}
	h.record("video_review", args)
	h.mu.Lock()
	gate := h.gate
	h.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			<-gate
		}
	}
	manifest := Manifest{SchemaVersion: 1, DurationSeconds: 1}
	if h.extractHook != nil {
		if err := h.extractHook(input, nil); err != nil {
			return Manifest{}, err
		}
	}
	if err := os.MkdirAll(input.Out, 0o755); err != nil {
		return Manifest{}, err
	}
	for index, at := range []float64{0, 0.5, 0.9} {
		id := fmt.Sprintf("F%03d", index+1)
		path := filepath.Join(input.Out, id+".png")
		if err := os.WriteFile(path, append(append([]byte{}, pixel...), id...), 0o644); err != nil {
			return Manifest{}, err
		}
		manifest.Frames = append(manifest.Frames, ManifestFrame{ID: id, TimeSeconds: at, Path: path})
	}
	for index, source := range input.References {
		id := fmt.Sprintf("R%03d", index+1)
		path := filepath.Join(input.Out, id+".png")
		data, err := os.ReadFile(source)
		if err != nil {
			return Manifest{}, err
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return Manifest{}, err
		}
		manifest.References = append(manifest.References, ManifestReference{ID: id, SourcePath: source, Path: path})
	}
	if h.extractHook != nil {
		if err := h.extractHook(input, &manifest); err != nil {
			return Manifest{}, err
		}
	}
	return manifest, nil
}

func (h *harness) brief(_ context.Context, _ string, shot, phase string) (string, error) {
	h.record("continuity_brief", []string{shot, "--phase", phase, "--json"})
	if h.briefHook != nil {
		return h.briefHook(phase)
	}
	return `{"phase":"` + phase + `","entities":{}}`, nil
}

func (h *harness) service(budget *int) *Service {
	options := Options{
		Agents:        h.agents,
		Tools:         func() (Tools, bool) { return Tools{FFmpeg: "ffmpeg", FFprobe: "ffprobe"}, h.available },
		Extract:       h.extract,
		Brief:         h.brief,
		IsPackageBusy: func(string, string) bool { return h.busy },
	}
	if budget != nil {
		value := *budget
		options.ImageBudgetBytes = func() int { return value }
	}
	service := New(options)
	h.services = append(h.services, service)
	return service
}

func (h *harness) normalize(text string) string {
	return uuidPattern.ReplaceAllString(strings.ReplaceAll(text, h.project, "<project>"), "<id>")
}

func (h *harness) latest() *string {
	data, err := os.ReadFile(filepath.Join(h.directory, "video-review", "latest.json"))
	if err != nil {
		return nil
	}
	text := h.normalize(string(data))
	return &text
}

// viewJSON — представление в форме эталона: job сокращено до id и статуса.
func (h *harness) viewJSON(view View) []byte {
	value := map[string]any{
		"status": view.Status, "report": view.Report, "frames": view.Frames, "stale": view.Stale, "canStart": view.CanStart,
		"reason": view.Reason, "error": view.Error, "durationSeconds": view.DurationSeconds, "job": nil,
	}
	if view.Job != nil {
		value["job"] = map[string]any{"id": view.Job.ID, "status": view.Job.Status}
	}
	data, err := json.Marshal(value)
	if err != nil {
		h.t.Fatal(err)
	}
	return []byte(h.normalize(string(data)))
}

// steps накапливает шаги сценария в форме эталона.
type steps struct {
	h     *harness
	items []goldenStep
}

func (s *steps) do(op string, run func() (View, error)) View {
	view, err := run()
	step := goldenStep{Op: op, Latest: s.h.latest()}
	if err != nil {
		message := s.h.normalize(err.Error())
		step.Throws = &message
	} else {
		step.View = s.h.viewJSON(view)
	}
	s.items = append(s.items, step)
	return view
}

// note — шаг без представления (изменение окружения).
func (s *steps) note(op string) {
	s.items = append(s.items, goldenStep{Op: op, Latest: s.h.latest()})
}

func (h *harness) wait(service *Service, status string) {
	for attempt := 0; attempt < 400; attempt++ {
		view, err := service.View(h.project, h.directory)
		if err == nil && view.Status == status {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("не дождались состояния %s", status)
}

func reportJSON() string {
	return `{"schemaVersion":1,"summary":"Лодка видна у причала.","findings":[{"verdict":"match","timeSeconds":0.5,"description":"Лодка остаётся у причала.","frameIds":["F002"]}],"limitations":["Проверена выборка кадров; звук и движение между ними не оценены."]}`
}

// changeJSON — JSON.parse → изменение → JSON.stringify без отступов, как changeJson теста.
func changeJSON(t *testing.T, path string, change func(value *jscompat.Object)) {
	value, err := jscompat.Parse(readFile(t, path))
	if err != nil {
		t.Fatal(err)
	}
	change(value.(*jscompat.Object))
	writeFile(t, path, []byte(jscompat.Stringify(value)))
}

func complete(h *harness, index int, result string) {
	h.agents.update(index, func(job *agents.Job) {
		job.Status = "completed"
		job.Result = result
	})
}

func intPointer(value int) *int { return &value }

// scenarios — действия сценариев эталона video-review по их именам.
var scenarios = map[string]func(h *harness, s *steps){
	"complete": func(h *harness, s *steps) {
		review := h.service(nil)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusRunning)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		complete(h, 0, reportJSON())
		s.note("complete-job")
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		s.do("view-new-service", func() (View, error) { return h.service(nil).View(h.project, h.directory) })
	},
	"budget-claude": func(h *harness, s *steps) {
		review := h.service(intPointer(6 * 1024 * 1024))
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusRunning)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"busy-repeat": func(h *harness, s *steps) {
		h.block()
		review := h.service(nil)
		other := filepath.Join(h.project, "plan", "batches", "другой-пакет")
		copyTree(h.t, h.directory, other)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		s.do("view-other", func() (View, error) { return review.View(h.project, other) })
		s.do("start-again", func() (View, error) { return review.Start(h.project, h.directory) })
		writeFile(h.t, h.original, []byte("Оригинал заменён во время извлечения"))
		h.open()
		h.wait(review, StatusFailed)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"cancel-preparing": func(h *harness, s *steps) {
		h.block()
		review := h.service(nil)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		s.do("cancel", func() (View, error) { return review.Cancel(h.project, h.directory) })
		h.open()
		review.Shutdown()
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusRunning)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"cancel-running": func(h *harness, s *steps) {
		review := h.service(nil)
		_, _ = review.Start(h.project, h.directory)
		h.wait(review, StatusRunning)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		s.do("cancel", func() (View, error) { return review.Cancel(h.project, h.directory) })
		s.do("cancel-again", func() (View, error) { return review.Cancel(h.project, h.directory) })
	},
	"tool-failure": func(h *harness, s *steps) {
		first := true
		h.extractHook = func(_ ExtractInput, manifest *Manifest) error {
			if manifest == nil && first {
				first = false
				return errors.New("Не удалось прочитать видео.\n")
			}
			return nil
		}
		review := h.service(nil)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusFailed)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"tool-failure-empty": func(h *harness, s *steps) {
		h.extractHook = func(_ ExtractInput, manifest *Manifest) error {
			if manifest == nil {
				return errors.New("  ")
			}
			return nil
		}
		review := h.service(nil)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusFailed)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"brief-failure": func(h *harness, s *steps) {
		h.briefHook = func(phase string) (string, error) {
			if phase == "after" {
				return "", errors.New("Нет плана M01.\n")
			}
			return `{"phase":"` + phase + `","entities":{}}`, nil
		}
		review := h.service(nil)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusFailed)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"agent-failed": func(h *harness, s *steps) {
		review := h.service(nil)
		_, _ = review.Start(h.project, h.directory)
		h.wait(review, StatusRunning)
		h.agents.update(0, func(job *agents.Job) { job.Status, job.Message = "failed", "Лимит агента" })
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"agent-failed-silent": func(h *harness, s *steps) {
		review := h.service(nil)
		_, _ = review.Start(h.project, h.directory)
		h.wait(review, StatusRunning)
		h.agents.update(0, func(job *agents.Job) { job.Status = "failed" })
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"invalid-json": func(h *harness, s *steps) {
		review := h.service(nil)
		_, _ = review.Start(h.project, h.directory)
		h.wait(review, StatusRunning)
		complete(h, 0, "Ответ без JSON")
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		s.do("restart", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusRunning)
		complete(h, 1, strings.Replace(reportJSON(), `"timeSeconds":0.5`, `"timeSeconds":0.25`, 1))
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"missing-hash": func(h *harness, s *steps) {
		review := h.service(nil)
		_, _ = review.Start(h.project, h.directory)
		h.wait(review, StatusRunning)
		complete(h, 0, reportJSON())
		_, _ = review.View(h.project, h.directory)
		changeJSON(h.t, filepath.Join(h.directory, "video-review", "latest.json"), func(value *jscompat.Object) {
			frames, _ := jscompat.AsArray(value.Value("frames"))
			path, _ := jscompat.Get(frames[0], "path").(string)
			value.Value("imageHashes").(*jscompat.Object).Delete(path)
		})
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		s.do("cancel", func() (View, error) { return review.Cancel(h.project, h.directory) })
	},
	"frame-outside": func(h *harness, s *steps) {
		h.extractHook = func(_ ExtractInput, manifest *Manifest) error {
			if manifest != nil {
				manifest.Frames[0].Path = h.original
			}
			return nil
		}
		review := h.service(nil)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusFailed)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"frame-invalid-time": func(h *harness, s *steps) {
		h.extractHook = func(_ ExtractInput, manifest *Manifest) error {
			if manifest != nil {
				manifest.Frames[2].TimeSeconds = 0.5
			}
			return nil
		}
		review := h.service(nil)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusFailed)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
	"interrupted": func(h *harness, s *steps) {
		review := h.service(nil)
		_, _ = review.Start(h.project, h.directory)
		h.wait(review, StatusRunning)
		complete(h, 0, reportJSON())
		_, _ = review.View(h.project, h.directory)
		file := filepath.Join(h.directory, "video-review", "latest.json")
		saved := readFile(h.t, file)
		changeJSON(h.t, file, func(value *jscompat.Object) {
			value.Set("status", "preparing")
			value.Set("report", nil)
			value.Set("jobId", nil)
			value.Set("frames", &jscompat.Array{})
			value.Set("durationSeconds", nil)
			value.Set("imageHashes", jscompat.NewObject())
		})
		s.do("view-preparing", func() (View, error) { return h.service(nil).View(h.project, h.directory) })
		writeFile(h.t, file, saved)
		changeJSON(h.t, file, func(value *jscompat.Object) {
			value.Set("status", "running")
			value.Set("report", nil)
			value.Set("jobId", "потерянное-задание")
		})
		s.do("view-lost-job", func() (View, error) { return h.service(nil).View(h.project, h.directory) })
	},
	"reasons": func(h *harness, s *steps) {
		review := h.service(nil)
		view := func() (View, error) { return review.View(h.project, h.directory) }
		start := func() (View, error) { return review.Start(h.project, h.directory) }
		s.do("relative-project", func() (View, error) { return review.View("relative/project", h.directory) })
		s.do("outside-package", func() (View, error) { return review.View(h.project, filepath.Join(h.project, "plan")) })
		s.do("escaping-package", func() (View, error) { return review.View(h.project, "../elsewhere") })
		s.do("missing-workflow", func() (View, error) {
			return review.View(h.project, filepath.Join(h.project, "plan", "batches", "нет"))
		})
		h.available = false
		s.do("tools-missing", view)
		s.do("tools-missing-start", start)
		h.available = true
		h.busy = true
		s.do("package-busy", view)
		h.busy = false
		h.agents.mu.Lock()
		h.agents.jobs["other"] = &agents.Job{ID: "other", Project: h.project, Status: "running"}
		h.agents.order = append(h.agents.order, "other")
		h.agents.mu.Unlock()
		s.do("agent-running", view)
		h.agents.mu.Lock()
		h.agents.jobs, h.agents.order = map[string]*agents.Job{}, nil
		h.agents.mu.Unlock()
		workflow := filepath.Join(h.directory, "workflow.json")
		saved := readFile(h.t, workflow)
		changeJSON(h.t, workflow, func(value *jscompat.Object) { value.Set("stage", "submitted") })
		s.do("stage-submitted", view)
		writeFile(h.t, workflow, saved)
		changeJSON(h.t, workflow, func(value *jscompat.Object) { value.Set("stage", "edit_review") })
		s.do("stage-edit-review", view)
		writeFile(h.t, workflow, saved)
		changeJSON(h.t, workflow, func(value *jscompat.Object) {
			frames, _ := jscompat.AsArray(value.Value("keyframes"))
			for _, frame := range frames {
				frame.(*jscompat.Object).Set("approved", false)
			}
		})
		s.do("no-approved", view)
		s.do("no-approved-start", start)
		writeFile(h.t, workflow, saved)
		changeJSON(h.t, workflow, func(value *jscompat.Object) { value.Set("shot", "M99") })
		s.do("unknown-shot", view)
		writeFile(h.t, workflow, saved)
		changeJSON(h.t, workflow, func(value *jscompat.Object) { value.Set("stage", 7.0) })
		s.do("stage-number", view)
		writeFile(h.t, workflow, saved)
		request := filepath.Join(h.directory, "requests", "one")
		writeFile(h.t, filepath.Join(request, "original-2.mp4"), []byte("Второй файл"))
		s.do("two-downloads", view)
		_ = os.Remove(filepath.Join(request, "original-2.mp4"))
		frozen := readFile(h.t, filepath.Join(request, "request.json"))
		changeJSON(h.t, filepath.Join(request, "request.json"), func(value *jscompat.Object) { value.Set("kind", "image") })
		s.do("image-request", view)
		writeFile(h.t, filepath.Join(request, "request.json"), frozen)
		attempt := readFile(h.t, filepath.Join(request, "attempt.json"))
		_ = os.Remove(filepath.Join(request, "attempt.json"))
		s.do("no-attempt", view)
		writeFile(h.t, filepath.Join(request, "attempt.json"), attempt)
		castFile := filepath.Join(h.project, "plan", "cast.json")
		castBytes := readFile(h.t, castFile)
		writeFile(h.t, castFile, []byte("{"))
		s.do("cast-damaged", view)
		writeFile(h.t, castFile, castBytes)
		scenesFile := filepath.Join(h.project, "plan", "scenes.json")
		scenes := readFile(h.t, scenesFile)
		changeJSON(h.t, scenesFile, func(value *jscompat.Object) { value.Set("fps", 25.0) })
		s.do("registry-invalid", view)
		writeFile(h.t, scenesFile, scenes)
		writeFile(h.t, filepath.Join(h.directory, "video-review", "latest.json"), []byte(`{"schemaVersion":1`))
		s.do("latest-corrupted", view)
		s.do("latest-corrupted-cancel", func() (View, error) { return review.Cancel(h.project, h.directory) })
		s.do("latest-corrupted-start", start)
		h.wait(review, StatusRunning)
		s.do("view", view)
	},
	"prompt-fallback": func(h *harness, s *steps) {
		_ = os.Remove(filepath.Join(h.directory, "requests", "one", "prompt.txt"))
		_ = os.Remove(filepath.Join(h.directory, "description.md"))
		changeJSON(h.t, filepath.Join(h.directory, "workflow.json"), func(value *jscompat.Object) { value.Delete("timing") })
		review := h.service(nil)
		s.do("start", func() (View, error) { return review.Start(h.project, h.directory) })
		h.wait(review, StatusRunning)
		s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
	},
}

func init() {
	for _, source := range []string{"original", "reference", "scenario", "cast", "frame", "prepared-reference"} {
		scenarios["stale-"+source] = func(h *harness, s *steps) {
			review := h.service(nil)
			_, _ = review.Start(h.project, h.directory)
			h.wait(review, StatusRunning)
			complete(h, 0, reportJSON())
			done := s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
			changed := append(append([]byte{}, pixel...), []byte("Новая опора")...)
			switch source {
			case "original":
				writeFile(h.t, h.original, []byte("Другой оригинал"))
			case "reference":
				writeFile(h.t, h.references[0], changed)
			case "scenario":
				changeJSON(h.t, filepath.Join(h.project, "plan", "scenes.json"), func(value *jscompat.Object) {
					scenes, _ := jscompat.AsArray(value.Value("scenes"))
					scenes[0].(*jscompat.Object).Set("action", "Лодка уходит от причала.")
				})
			case "cast":
				changeJSON(h.t, filepath.Join(h.project, "plan", "cast.json"), func(value *jscompat.Object) {
					entities, _ := jscompat.AsArray(value.Value("entities"))
					entities[0].(*jscompat.Object).Set("appearance", "Новый облик")
				})
			case "frame":
				writeFile(h.t, done.Frames[0].Path, append(append([]byte{}, pixel...), []byte("Другой кадр")...))
			default:
				writeFile(h.t, h.agents.starts[0].Images[3], append(append([]byte{}, pixel...), []byte("Другая подготовленная опора")...))
			}
			s.note("change-" + source)
			s.do("view", func() (View, error) { return review.View(h.project, h.directory) })
		}
	}
}

// copyTree — cpSync(recursive) для пакета сценария.
func copyTree(t *testing.T, from, to string) {
	err := filepath.Walk(from, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(to, strings.TrimPrefix(path, from))
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

func TestReviewGolden(t *testing.T) {
	document := loadReviewGolden(t)
	if len(document.Scenarios) != len(scenarios) {
		t.Fatalf("в эталоне %d сценариев, в тесте %d", len(document.Scenarios), len(scenarios))
	}
	for _, item := range document.Scenarios {
		t.Run(item.Name, func(t *testing.T) {
			run, ok := scenarios[item.Name]
			if !ok {
				t.Fatalf("сценарий %s не реализован", item.Name)
			}
			h := newHarness(t)
			s := &steps{h: h}
			run(h, s)
			for _, service := range h.services {
				service.Shutdown()
			}
			if len(s.items) != len(item.Steps) {
				t.Fatalf("шагов %d, ожидалось %d", len(s.items), len(item.Steps))
			}
			for index, want := range item.Steps {
				got := s.items[index]
				label := fmt.Sprintf("шаг %d %s", index, want.Op)
				if got.Op != want.Op {
					t.Fatalf("%s: операция %s", label, got.Op)
				}
				if (want.Throws == nil) != (got.Throws == nil) || (want.Throws != nil && *want.Throws != *got.Throws) {
					t.Errorf("%s: ошибка %v, ожидалась %v", label, deref(got.Throws), deref(want.Throws))
				}
				if want.View != nil && string(want.View) != "null" && !sameJSON(t, got.View, want.View) {
					t.Errorf("%s: представление\n got %s\nwant %s", label, got.View, want.View)
				}
				if deref(want.Latest) != deref(got.Latest) {
					t.Errorf("%s: latest.json\n got %s\nwant %s", label, deref(got.Latest), deref(want.Latest))
				}
			}
			calls, _ := json.Marshal(h.toolCalls)
			if !sameJSON(t, []byte(h.normalize(string(calls))), item.ToolCalls) {
				t.Errorf("вызовы инструментов\n got %s\nwant %s", h.normalize(string(calls)), item.ToolCalls)
			}
			if len(h.agents.starts) != len(item.AgentStarts) {
				t.Fatalf("запусков агента %d, ожидалось %d", len(h.agents.starts), len(item.AgentStarts))
			}
			for index, want := range item.AgentStarts {
				got := h.agents.starts[index]
				images := []string{}
				for _, path := range got.Images {
					images = append(images, h.normalize(path))
				}
				if h.normalize(got.Project) != want.Project || got.Task != want.Task || (got.Prompt == prompt) != want.PromptIsSkill ||
					strings.Join(images, "\n") != strings.Join(want.Images, "\n") {
					t.Errorf("запуск %d: %s %s %v %v", index, got.Project, got.Task, images, want.Images)
				}
				if context := h.normalize(got.Context); context != want.Context {
					t.Errorf("запуск %d: контекст\n got %s\nwant %s", index, context, want.Context)
				}
			}
		})
	}
}

func deref(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}
