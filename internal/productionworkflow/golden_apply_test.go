package productionworkflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/mediatest"
	"songframe-go/internal/providers"
	"songframe-go/internal/shotworkflow"
	"songframe-go/internal/tools"
)

// Эталон production-workflow-apply/cases.json снят скриптом capture-production-workflow-apply.ts
// (этап 45g.2, см. README эталонов) с копии оригинала с точечным исправлением: сценарии 45g1
// дополнены операциями Apply, обрыва процесса на границе вызова инструмента, восстановления при
// старте и прямого журнала замены пакета. shot_workflow, continuity_brief и media_request prepare —
// настоящие инструменты (здесь их Go-порты), каталог моделей тестового провайдера подставной.
// После шагов, меняющих проект, сверяются все файлы plan/ (права и содержимое) и каталог журнала.

// applyStep — шаг эталона Apply: операции 45g1 и новые поля.
type applyStep struct {
	goldenStep
	Crash *struct {
		Call int    `json:"call"`
		When string `json:"when"`
	} `json:"crash"`
	Args   []string `json:"args"`
	Suffix string   `json:"suffix"`
	IDs    []string `json:"ids"`
	Seed   string   `json:"seed"`
	Writes []struct {
		Path string          `json:"path"`
		Text *string         `json:"text"`
		JSON json.RawMessage `json:"json"`
	} `json:"writes"`
	Removes []string        `json:"removes"`
	Fail    string          `json:"fail"`
	Hang    bool            `json:"hang"`
	Remove  bool            `json:"remove"`
	Tree    json.RawMessage `json:"tree"`
	State   json.RawMessage `json:"state"`
}

// applyConfig — Config скрипта съёмки 45g.2.
type applyConfig struct {
	ScenarioApproved bool `json:"scenarioApproved"`
	PackageBusy      bool `json:"packageBusy"`
	FailAsk          bool `json:"failAsk"`
}

// crashPoint — обрыв процесса перед или после n-го вызова инструмента с начала applyCrash.
type crashPoint struct {
	call    int
	when    string
	reached chan struct{}
}

var (
	preparePattern = regexp.MustCompile(`[^"\s]*songframe-media-prepare-[^/"\s]+`)
	applyVideoCmds = []string{"text_to_video", "image_to_video", "omni_ref_video", "motion_control"}
	// fixedProposalID — ID предложения из seed импорта опор (в эталоне он нормализован в <id>).
	fixedProposalID = "00000000-0000-4000-8000-000000000001"
)

func TestGoldenProductionWorkflowApply(t *testing.T) {
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image, mediaproviders.Video},
		Paid: true, DefaultImageResolution: "2k", LipSync: &mediaproviders.LipSync{Min: 5, Max: 30}}))
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	fixUmask(t)
	t.Cleanup(mediaadapters.Register(mediatest.ID, testRules{Service: &mediatest.Service{Dir: t.TempDir()}}))
	now := shotworkflow.Now
	shotworkflow.Now = func() string { return "2026-11-04T12:00:00+00:00" }
	t.Cleanup(func() { shotworkflow.Now = now })
	var file struct {
		Blobs     map[string]string `json:"blobs"`
		Scenarios []struct {
			Name  string      `json:"name"`
			Steps []applyStep `json:"steps"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "production-workflow-apply", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(root, "checks-base", "project")
	for _, scenario := range file.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			run := &applyRun{goldenRun: newRun(t, base, file.Blobs), config: applyConfig{ScenarioApproved: true}}
			preserveModes(t, base, run.project)
			run.goldenRun.workflow = run.create()
			run.tree, run.state = run.snapshotTexts(t)
			for index, step := range scenario.Steps {
				run.step(t, index, step)
			}
		})
	}
}

// preserveModes — права файлов копии как у cpSync оригинала при съёмке эталона: образец распакован
// из Git с umask 002, поэтому обычный файл — 0664, исполняемый — 0775. Права checkout не берутся:
// Git хранит только бит исполнения, а остальное зависит от umask клонирования (на CI — 022).
func preserveModes(t *testing.T, base, project string) {
	err := filepath.WalkDir(base, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(base, path)
		mode := os.FileMode(0o664)
		if info.Mode().Perm()&0o111 != 0 {
			mode = 0o775
		}
		return os.Chmod(filepath.Join(project, rel), mode)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// applyRun — сценарий эталона Apply поверх состояния 45g1 (проект, каталог состояния, агенты).
type applyRun struct {
	*goldenRun
	config applyConfig
	guard  sync.Mutex
	crash  *crashPoint
	count  int
	// tree и state — снимки plan/ и production-apply после предыдущего шага.
	tree, state map[string]string
	// lastTexts — нормализованные тексты последнего снимка для диагностики расхождений.
	lastTexts map[string]string
}

// create — новый экземпляр прохода с платным адаптером видео тестового провайдера, как
// prepareVideoRequest ipc.ts без ai.requireAccess.
func (r *applyRun) create() *Workflow {
	paid, ok := providers.PaidAdapter(mediatest.ID)
	if !ok {
		panic("нет платного адаптера test")
	}
	video := providers.NewPaidMedia(paid, mediaproviders.Video, providers.PaidOptions{
		Catalogs: &providers.Catalogs{Run: r.runTool}, Run: r.runTool, ValidateImage: func(string) bool { return true },
	})
	return New(Options{
		LocalDir: r.local, Agents: r.agents, Run: r.runTool, Catalog: &providers.Catalogs{Run: r.runTool},
		IsScenarioApproved: func(string) bool { return r.config.ScenarioApproved },
		IsPackageBusy:      func(string, string) bool { return r.config.PackageBusy },
		VideoMedia: func(provider string) (*providers.PaidMedia, bool) {
			return video, provider == mediatest.ID
		},
	})
}

// runTool — launcher.run скрипта съёмки: подставные capabilities (с limits) и сбой ask, остальное —
// настоящие инструменты. Обрыв процесса имитируется вечным ожиданием вызова: незавершённый Apply
// остаётся висеть, как промис оригинала, а сценарий продолжает новый экземпляр.
func (r *applyRun) runTool(ctx context.Context, project, name string, args []string) (tools.Result, error) {
	r.guard.Lock()
	r.calls = append(r.calls, toolCall{Name: name, Args: slices.Clone(args)})
	crash := r.crash
	if crash != nil {
		r.count++
		if r.count == crash.call && crash.when == "before" {
			r.crash = nil
			r.guard.Unlock()
			close(crash.reached)
			select {}
		}
	}
	count, failAsk := r.count, r.config.FailAsk
	r.guard.Unlock()
	var result tools.Result
	var err error
	switch {
	case name == "media_request" && len(args) > 0 && args[0] == "capabilities":
		reports := []string{}
		for _, command := range applyVideoCmds {
			reports = append(reports, `{"command":"`+command+`","models":{"test-video":{"arguments":{"duration":{"allowed":["9"]},"resolution":{"allowed":["1080p"]}},"slots":{"first_image":{"required":true},"tail_image":{}},"limits":{}}}}`)
		}
		code := 0
		result = tools.Result{Code: &code, Stdout: `{"reports":[` + strings.Join(reports, ",") + `],"problems":[]}`}
	case name == "shot_workflow" && len(args) > 0 && args[0] == "ask" && failAsk:
		code := 1
		result = tools.Result{Code: &code, Stderr: "Прервано согласование"}
	default:
		result, err = tools.RunContext(ctx, project, name, args)
	}
	if crash != nil && crash.when == "after" && count == crash.call {
		r.guard.Lock()
		r.crash = nil
		r.guard.Unlock()
		close(crash.reached)
		select {}
	}
	return result, err
}

// normalize — normalize скрипта съёмки 45g.2: пути, временные папки подготовки, UUID.
func (r *applyRun) normalize(text string) string {
	text = strings.ReplaceAll(text, r.local, "<local>")
	text = strings.ReplaceAll(text, r.project, "<project>")
	text = preparePattern.ReplaceAllString(text, "<prepare>")
	return uuidPattern.ReplaceAllString(text, "<id>")
}

// expand — <project> и <local> шага в пути сценария.
func (r *applyRun) expand(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "<project>", r.project), "<local>", r.local)
}

// currentID — ID предложения из записи плана или "".
func (r *applyRun) currentID(shot string) string {
	if value, ok := jscompat.ReadJSONFile(r.recordPath(shot)); ok {
		id, _ := jscompat.GetPath(value, "proposal", "id").(string)
		return id
	}
	return ""
}

// journalPath — каталог журнала пакета (SHA-256 «проект\0пакет»).
func (r *applyRun) journalPath(packageDir string) string {
	sum := sha256.Sum256([]byte(r.project + "\x00" + filepath.Join(r.project, packageDir)))
	return filepath.Join(r.local, ApplyFolder, hex.EncodeToString(sum[:]))
}

// entry — запись файла дерева: "dir", либо права и SHA-256 нормализованного текста (blob эталона)
// или байтов; texts получает нормализованный текст для диагностики.
func (r *applyRun) entry(t *testing.T, path string, texts map[string]string) string {
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.IsDir() {
		return "dir"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	mode := strconv.FormatUint(uint64(info.Mode().Perm()), 8)
	if utf8.Valid(data) {
		text := r.normalize(string(data))
		sum := sha256.Sum256([]byte(text))
		key := hex.EncodeToString(sum[:])
		texts[key] = text
		return mode + ":text:" + key
	}
	sum := sha256.Sum256(data)
	return mode + ":bin:" + hex.EncodeToString(sum[:])
}

// walk — walk скрипта съёмки: файлы folder в порядке имён с путями от prefix.
func (r *applyRun) walk(t *testing.T, folder, prefix string, result, texts map[string]string, rename func(string) string) {
	entries, err := os.ReadDir(folder)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range entries {
		path := filepath.Join(folder, item.Name())
		name := item.Name()
		if prefix != "" {
			name = prefix + "/" + name
		} else {
			name = rename(name)
		}
		result[name] = r.entry(t, path, texts)
		if item.IsDir() {
			r.walk(t, path, name, result, texts, rename)
		}
	}
}

// snapshotInto — дерево plan/ и каталог журнала с именами pkg:<пакет>; texts получает
// нормализованные тексты файлов по SHA-256.
func (r *applyRun) snapshotInto(t *testing.T, texts map[string]string) (map[string]string, map[string]string) {
	tree, state := map[string]string{}, map[string]string{}
	r.walk(t, filepath.Join(r.project, "plan"), "plan", tree, texts, nil)
	names := map[string]string{}
	for _, folder := range []string{"batches", "awaiting"} {
		for _, shot := range []string{"M01", "M02", "M03", "M04"} {
			for index := 1; index <= 6; index++ {
				rel := "plan/" + folder + "/" + shot + "-attempt-0" + strconv.Itoa(index)
				names[filepath.Base(r.journalPath(rel))] = "pkg:" + rel
			}
		}
	}
	r.walk(t, filepath.Join(r.local, ApplyFolder), "", state, texts, func(name string) string {
		if mapped, ok := names[name]; ok {
			return mapped
		}
		return name
	})
	return tree, state
}

// compareFiles сверяет снимок с эталоном (или с прежним снимком при "unchanged").
func (r *applyRun) compareFiles(t *testing.T, label, kind string, want json.RawMessage, previous, got map[string]string) {
	t.Helper()
	expected := previous
	if string(want) != `"unchanged"` {
		expected = map[string]string{}
		if err := json.Unmarshal(want, &expected); err != nil {
			t.Fatalf("%s: %s %s", label, kind, want)
		}
	}
	problems := []string{}
	for _, name := range keysOf(expected) {
		if got[name] != expected[name] {
			problems = append(problems, name+": "+got[name]+" вместо "+expected[name]+r.blobDifference(got[name], expected[name]))
		}
	}
	for _, name := range keysOf(got) {
		if _, ok := expected[name]; !ok {
			problems = append(problems, name+": лишний "+got[name])
		}
	}
	if len(problems) > 0 {
		t.Fatalf("%s: %s отличается:\n%s", label, kind, strings.Join(problems, "\n"))
	}
}

// blobDifference — окрестность расхождения текстов двух записей дерева.
func (r *applyRun) blobDifference(got, want string) string {
	gotParts, wantParts := strings.Split(got, ":"), strings.Split(want, ":")
	if len(gotParts) != 3 || len(wantParts) != 3 || wantParts[1] != "text" {
		return ""
	}
	text, ok := r.lastTexts[gotParts[2]]
	if !ok {
		return ""
	}
	return "\n" + firstDifference(text, r.blobs[wantParts[2]])
}

// step исполняет шаг и сверяет результат, ошибку, записи состояния, запуски, вызовы и файлы.
func (r *applyRun) step(t *testing.T, index int, step applyStep) {
	t.Helper()
	label := strconv.Itoa(index) + " " + step.Op
	startsBefore := len(r.agents.starts)
	r.guard.Lock()
	callsBefore := len(r.calls)
	r.guard.Unlock()
	manager := r.agents
	result, err := r.execute(t, step)
	if manager != r.agents {
		startsBefore = 0
	}
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
	r.compareLocal(t, label, step.Local)
	starts := r.agents.starts[startsBefore:]
	if len(starts) != len(step.Starts) {
		t.Fatalf("%s: запусков агента %d, ожидалось %d", label, len(starts), len(step.Starts))
	}
	for position, start := range starts {
		want := step.Starts[position]
		if r.normalize(start.Project) != want.Project || start.Task != want.Task || r.normalize(start.Prompt) != r.blobs[want.Prompt] ||
			r.normalize(start.Context) != r.blobs[want.Context] {
			t.Fatalf("%s: запуск агента %d отличается", label, position)
		}
	}
	r.guard.Lock()
	calls := []toolCall{}
	for _, call := range r.calls[callsBefore:] {
		args := []string{}
		for _, arg := range call.Args {
			args = append(args, r.normalize(arg))
		}
		calls = append(calls, toolCall{Name: call.Name, Args: args})
	}
	r.guard.Unlock()
	if len(calls) > 0 || len(step.Tools) > 0 {
		gotCalls, _ := json.Marshal(calls)
		wantCalls, _ := json.Marshal(step.Tools)
		if string(gotCalls) != string(wantCalls) {
			t.Fatalf("%s: вызовы инструментов\n got %s\nwant %s", label, gotCalls, wantCalls)
		}
	}
	tree, state := r.snapshotTexts(t)
	if len(step.Tree) > 0 {
		r.compareFiles(t, label, "дерево plan/", step.Tree, r.tree, tree)
		r.compareFiles(t, label, "каталог журнала", step.State, r.state, state)
	}
	r.tree, r.state = tree, state
}

// snapshotTexts — snapshot с запоминанием нормализованных текстов для диагностики.
func (r *applyRun) snapshotTexts(t *testing.T) (map[string]string, map[string]string) {
	r.lastTexts = map[string]string{}
	return r.snapshotInto(t, r.lastTexts)
}

// execute — execute скрипта съёмки 45g.2; операции 45g1 исполняет goldenRun.
func (r *applyRun) execute(t *testing.T, step applyStep) (any, error) {
	t.Helper()
	ctx := context.Background()
	switch step.Op {
	case "write":
		// writeFileSync (0666 & umask) или cpSync с правами источника.
		path := filepath.Join(r.project, step.Path)
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			t.Fatal(err)
		}
		var data []byte
		perm := os.FileMode(0o666)
		switch {
		case step.Copy != "":
			source := filepath.Join(r.project, step.Copy)
			info, err := os.Stat(source)
			if err != nil {
				t.Fatal(err)
			}
			if data, err = os.ReadFile(source); err != nil {
				t.Fatal(err)
			}
			perm = info.Mode().Perm()
		case len(step.JSON) > 0:
			data = []byte(jscompat.StringifyIndent(mustParse(t, step.JSON), "  ") + "\n")
		default:
			data = []byte(*step.Text)
		}
		if err := os.WriteFile(path, data, perm); err != nil {
			t.Fatal(err)
		}
		if step.Copy != "" {
			if err := os.Chmod(path, perm); err != nil {
				t.Fatal(err)
			}
		}
		return nil, nil
	case "set":
		data, _ := json.Marshal(step.Config)
		r.guard.Lock()
		defer r.guard.Unlock()
		if err := json.Unmarshal(data, &r.config); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	case "restart":
		if step.FreshAgents {
			r.agents = &fakeAgents{}
		}
		r.goldenRun.workflow = r.create()
		return nil, nil
	case "apply":
		id := step.ID
		if id == "current" {
			id = r.currentID(step.Shot)
		}
		return r.goldenRun.workflow.Apply(ctx, r.project, step.Shot, r.packagePath(step.PackageDir), id)
	case "applyCrash":
		id := r.currentID(step.Shot)
		crash := &crashPoint{call: step.Crash.Call, when: step.Crash.When, reached: make(chan struct{})}
		r.guard.Lock()
		r.count, r.crash = 0, crash
		r.guard.Unlock()
		done := make(chan error, 1)
		workflow := r.goldenRun.workflow
		go func() {
			_, err := workflow.Apply(ctx, r.project, step.Shot, r.packagePath(step.PackageDir), id)
			if err == nil {
				err = errors.New("apply завершился без обрыва")
			}
			done <- err
		}()
		defer func() {
			r.guard.Lock()
			r.crash = nil
			r.guard.Unlock()
		}()
		select {
		case <-crash.reached:
			return nil, nil
		case err := <-done:
			return nil, err
		}
	case "recover":
		return nil, RecoverInterrupted(r.local)
	case "tool":
		args := []string{}
		for _, arg := range step.Args {
			args = append(args, r.expand(arg))
		}
		result, err := tools.RunContext(ctx, r.project, step.Name, args)
		if err != nil {
			return nil, err
		}
		if result.Code == nil || *result.Code != 0 {
			message := result.Stderr
			if message == "" {
				message = result.Stdout
			}
			return nil, errors.New(step.Name + ": " + message)
		}
		return nil, nil
	case "candidate":
		data, err := os.ReadFile(filepath.Join(r.project, "source/vehicles/boat.png"))
		if err != nil {
			t.Fatal(err)
		}
		folder := filepath.Join(r.local, "candidates")
		if err := os.MkdirAll(folder, 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(folder, step.ID+".png"), append(data, step.Suffix...), 0o666); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	case "importFrames":
		// Импорт опор переносит 45g.3: здесь записывается запись предложения, снятая с оригинала.
		path := r.recordPath(step.Shot)
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(r.expand(strings.ReplaceAll(step.Seed, "<id>", fixedProposalID))), 0o666); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	case "journal":
		return nil, r.journal(t, step)
	case "writeState":
		path := filepath.Join(r.journalPath(step.PackageDir), step.Path)
		if step.Remove {
			if err := os.RemoveAll(path); err != nil {
				t.Fatal(err)
			}
			return nil, nil
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			t.Fatal(err)
		}
		text := ""
		if len(step.JSON) > 0 {
			text = r.expand(jscompat.Stringify(mustParse(t, step.JSON)))
		} else {
			text = *step.Text
		}
		if err := os.WriteFile(path, []byte(text), 0o666); err != nil {
			t.Fatal(err)
		}
		return nil, nil
	}
	return r.goldenRun.execute(t, step.goldenStep)
}

// journal — прямой applyPackage: колбэк пишет и удаляет файлы пакета, затем падает или виснет
// (обрыв процесса внутри Apply).
func (r *applyRun) journal(t *testing.T, step applyStep) error {
	target := filepath.Join(r.project, step.PackageDir)
	reached := make(chan struct{})
	action := func() error {
		for _, item := range step.Writes {
			path := filepath.Join(target, item.Path)
			if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
				return err
			}
			text := ""
			if len(item.JSON) > 0 {
				text = jscompat.Stringify(mustParse(t, item.JSON))
			} else {
				text = *item.Text
			}
			if err := os.WriteFile(path, []byte(text), 0o666); err != nil {
				return err
			}
		}
		for _, path := range step.Removes {
			if err := os.RemoveAll(filepath.Join(target, path)); err != nil {
				return err
			}
		}
		if step.Fail != "" {
			return errors.New(step.Fail)
		}
		if step.Hang {
			close(reached)
			select {}
		}
		return nil
	}
	if !step.Hang {
		return applyPackage(r.local, r.project, target, action)
	}
	done := make(chan error, 1)
	go func() { done <- applyPackage(r.local, r.project, target, action) }()
	select {
	case <-reached:
		return nil
	case err := <-done:
		if err == nil {
			err = errors.New("done")
		}
		return err
	}
}
