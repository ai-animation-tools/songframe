package scenarioworkflow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe/internal/golden"
	"songframe/internal/scenarioapply"
	"songframe/internal/tools"
)

// Проверки сбоев сценарного прохода: отмена и недопустимый ответ ничего не пишут в проект, сбой
// любой фазы применения не оставляет полупримененного состояния, повтор не создаёт дубликата,
// занятый проект отклоняет действия. Вход — образец checks-base (как у эталонов scenario-workflow).

// sampleProject — копия образца во временной папке (реальный путь).
func sampleProject(t *testing.T) string {
	t.Helper()
	for _, item := range golden.Load(t, "scenario-workflow") {
		if item.Name == "view-sample" {
			project, err := filepath.EvalSymlinks(item.BuildProject(t))
			if err != nil {
				t.Fatal(err)
			}
			return project
		}
	}
	t.Fatal("нет случая view-sample")
	return ""
}

// treeDigest — SHA-256 дерева проекта (пути и байты) без .git.
func treeDigest(t *testing.T, root string) string {
	t.Helper()
	files := treeFiles(t, root)
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	hash := sha256.New()
	for _, path := range paths {
		sum := sha256.Sum256(files[path])
		hash.Write([]byte(path + "\x00" + hex.EncodeToString(sum[:]) + "\n"))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// prepared — проект с готовым предложением прохода pass.
type prepared struct {
	project, localDir string
	agents            *fakeAgents
	workflow          *Workflow
	id                string
}

const revisePatch = `{"schemaVersion":1,"pass":"revise","patches":[{"id":"M03","action":"Порыв ветра раскачивает фонарики над водой."}]}`

// prepare запускает проход и завершает задание ответом result; options дополняет зависимости.
func prepare(t *testing.T, pass, result string, configure func(*Options)) prepared {
	t.Helper()
	project := sampleProject(t)
	agents := &fakeAgents{}
	options := Options{LocalDir: filepath.Join(t.TempDir(), "state"), Agents: agents}
	if configure != nil {
		configure(&options)
	}
	workflow := New(options)
	input := StartInput{Project: project, Pass: pass}
	if pass == "revise" {
		note := "Больше ветра"
		input.Note, input.SelectedIDs = &note, []string{"M03"}
	}
	if pass != "treatment" {
		if _, err := workflow.ApproveCurrent(project); err != nil {
			t.Fatal(err)
		}
	}
	if result == "" {
		result = treatmentAnswer(t, project)
	}
	view, err := workflow.Start(input)
	if err != nil {
		t.Fatal(err)
	}
	agents.update(func(job *AgentJob) { job.Status, job.ExitCode, job.Result = "completed", new(int), result })
	if view, err = workflow.View(project); err != nil || view.Proposal == nil {
		t.Fatalf("вид: %v", err)
	}
	return prepared{project: project, localDir: options.LocalDir, agents: agents, workflow: workflow, id: view.Proposal.ID}
}

// treatmentAnswer — ответ прохода трактовки: текущие документы с новым логлайном и описанием.
func treatmentAnswer(t *testing.T, project string) string {
	t.Helper()
	castData, err := os.ReadFile(filepath.Join(project, "plan", "cast.json"))
	if err != nil {
		t.Fatal(err)
	}
	treatment, err := os.ReadFile(filepath.Join(project, "plan", "treatment.json"))
	if err != nil {
		t.Fatal(err)
	}
	// Новое описание сущности меняет и опись исходников: публикация пишет три файла.
	castText := strings.Replace(string(castData), `"appearance": "Музыкант, держит фонарик"`, `"appearance": "Музыкант с фонариком"`, 1)
	text := strings.Replace(string(treatment), `"logline": "`, `"logline": "Новый логлайн. `, 1)
	return `{"schemaVersion":1,"pass":"treatment","cast":` + castText + `,"treatment":` + text + `}`
}

func TestCancelAndInvalidAnswerWriteNothing(t *testing.T) {
	for _, result := range []string{"не JSON", `{"schemaVersion":1,"pass":"treatment"}`, `{"schemaVersion":1,"pass":"scenes","scenes":{}}`} {
		project := sampleProject(t)
		digest := treeDigest(t, project)
		agents := &fakeAgents{}
		workflow := New(Options{LocalDir: t.TempDir(), Agents: agents})
		if _, err := workflow.Start(StartInput{Project: project, Pass: "treatment"}); err != nil {
			t.Fatal(err)
		}
		agents.update(func(job *AgentJob) { job.Status, job.ExitCode, job.Result = "completed", new(int), result })
		view, err := workflow.View(project)
		if err != nil || view.Proposal.Status != "invalid" {
			t.Fatalf("%q: %v %+v", result, err, view.Proposal)
		}
		if _, err := workflow.Apply(project, view.Proposal.ID); err == nil || err.Error() != textProposalNotApplicable {
			t.Fatalf("применение недопустимого ответа: %v", err)
		}
		if treeDigest(t, project) != digest {
			t.Fatalf("%q: проект изменился", result)
		}
	}
	project := sampleProject(t)
	digest := treeDigest(t, project)
	agents := &fakeAgents{}
	workflow := New(Options{LocalDir: t.TempDir(), Agents: agents})
	if _, err := workflow.Start(StartInput{Project: project, Pass: "treatment"}); err != nil {
		t.Fatal(err)
	}
	agents.update(func(job *AgentJob) { job.Status = "cancelled" })
	view, err := workflow.View(project)
	if err != nil || view.Proposal.Status != "cancelled" || view.Proposal.Message != textProposalCancelled {
		t.Fatalf("отмена: %v %+v", err, view.Proposal)
	}
	if _, err := workflow.Discard(project, view.Proposal.ID); err != nil {
		t.Fatal(err)
	}
	if treeDigest(t, project) != digest {
		t.Fatal("отмена изменила проект")
	}
}

func TestAgentRefusalStoresNothing(t *testing.T) {
	project := sampleProject(t)
	agents := &fakeAgents{refuse: errors.New("Проект занят другим заданием.")}
	localDir := t.TempDir()
	workflow := New(Options{LocalDir: localDir, Agents: agents})
	if _, err := workflow.Start(StartInput{Project: project, Pass: "treatment"}); err == nil || err.Error() != "Проект занят другим заданием." {
		t.Fatalf("отказ менеджера: %v", err)
	}
	if _, err := os.Stat(statePath(localDir, project)); !os.IsNotExist(err) {
		t.Fatalf("после отказа появилась локальная запись: %v", err)
	}
	access := errors.New("Выберите агента в настройках.")
	workflow = New(Options{LocalDir: localDir, Agents: &fakeAgents{}, RequireAgentAccess: func(string) error { return access }})
	if _, err := workflow.Start(StartInput{Project: project, Pass: "treatment"}); !errors.Is(err, access) {
		t.Fatalf("проверка доступа к агенту: %v", err)
	}
}

// TestApplyFaults — сбой каждой фазы применения оставляет проект прежним, предложение готовым к
// повтору и не оставляет журнала; повтор после устранения сбоя применяет ровно один раз.
func TestApplyFaults(t *testing.T) {
	type fault struct {
		name  string
		pass  string
		setup func(t *testing.T, p prepared) (restore func())
	}
	failTool := func(name string, args ...string) func(*testing.T, prepared) func() {
		return func(t *testing.T, p prepared) func() {
			previous := runTool
			runTool = func(root, tool string, given []string) (tools.Result, error) {
				if tool == name && strings.Join(given, " ") == strings.Join(args, " ") {
					code := 1
					return tools.Result{Code: &code, Stderr: "сбой " + name}, nil
				}
				return previous(root, tool, given)
			}
			return func() { runTool = previous }
		}
	}
	readOnly := func(relative string) func(*testing.T, prepared) func() {
		return func(t *testing.T, p prepared) func() {
			// root пишет и в папку без права записи: сбой не воспроизвести (контейнерные раннеры CI).
			if os.Geteuid() == 0 {
				t.Skip("права доступа не ограничивают root")
			}
			path := filepath.Join(p.project, filepath.FromSlash(relative))
			if err := os.Chmod(path, 0o555); err != nil {
				t.Fatal(err)
			}
			return func() { _ = os.Chmod(path, 0o755) }
		}
	}
	faults := []fault{
		{"lint", "revise", failTool("lint_registry")},
		{"brief", "revise", failTool("continuity_brief", "M03", "--phase", "after", "--json")},
		{"views", "revise", failTool("update_scene_views")},
		{"views-check", "revise", failTool("update_scene_views", "--check")},
		{"change-during-staging", "revise", func(t *testing.T, p prepared) func() {
			previous := runTool
			runTool = func(root, tool string, given []string) (tools.Result, error) {
				if tool == "update_scene_views" && len(given) == 0 {
					if err := os.WriteFile(filepath.Join(p.project, "source", "description.md"), []byte("Правка во время проверки.\n"), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				return previous(root, tool, given)
			}
			original, _ := os.ReadFile(filepath.Join(p.project, "source", "description.md"))
			return func() {
				runTool = previous
				_ = os.WriteFile(filepath.Join(p.project, "source", "description.md"), original, 0o644)
			}
		}},
		{"before-publish", "revise", func(t *testing.T, p prepared) func() {
			beforePublish = func(string) error { return errors.New("сбой перед публикацией") }
			return func() { beforePublish = func(string) error { return nil } }
		}},
		{"replace-cards", "revise", readOnly("plan/animatic/cards")},
		{"replace-storyboard", "revise", readOnly("plan")},
		{"treatment-before-publish", "treatment", func(t *testing.T, p prepared) func() {
			beforePublish = func(string) error { return errors.New("сбой перед публикацией") }
			return func() { beforePublish = func(string) error { return nil } }
		}},
		{"treatment-replace-manifest", "treatment", readOnly("source")},
	}
	for _, item := range faults {
		t.Run(item.name, func(t *testing.T) {
			result := ""
			if item.pass == "revise" {
				result = revisePatch
			}
			p := prepare(t, item.pass, result, nil)
			digest := treeDigest(t, p.project)
			restore := item.setup(t, p)
			_, err := p.workflow.Apply(p.project, p.id)
			restore()
			if err == nil {
				t.Fatal("сбой не остановил применение")
			}
			if treeDigest(t, p.project) != digest {
				t.Fatalf("после сбоя %q проект изменился", err)
			}
			if scenarioapply.NewStore(p.localDir).Pending(p.project) {
				t.Fatal("остался журнал применения")
			}
			view, err := p.workflow.View(p.project)
			if err != nil || view.Proposal.Status != "ready" || view.Busy {
				t.Fatalf("после сбоя предложение не готово к повтору: %v %+v", err, view)
			}
			// Повтор после устранения сбоя применяет предложение ровно один раз.
			if view, err = p.workflow.Apply(p.project, p.id); err != nil || view.Proposal.Status != "applied" {
				t.Fatalf("повтор: %v", err)
			}
			applied := treeDigest(t, p.project)
			if applied == digest {
				t.Fatal("повтор ничего не применил")
			}
			if _, err := p.workflow.Apply(p.project, p.id); err == nil || err.Error() != textProposalNotApplicable {
				t.Fatalf("второе применение: %v", err)
			}
			if treeDigest(t, p.project) != applied {
				t.Fatal("второе применение изменило проект")
			}
		})
	}
}

func TestPendingRecoveryBlocksApply(t *testing.T) {
	p := prepare(t, "revise", revisePatch, nil)
	digest := treeDigest(t, p.project)
	sum := sha256.Sum256([]byte(p.project))
	directory := filepath.Join(p.localDir, "scenario-apply", hex.EncodeToString(sum[:]))
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "pending.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.workflow.Apply(p.project, p.id); err == nil || err.Error() != textRecoveryPending {
		t.Fatalf("незавершённое восстановление: %v", err)
	}
	if treeDigest(t, p.project) != digest {
		t.Fatal("проект изменился")
	}
}

// TestBusyWhilePreparing — пока готовится каркас, вид сообщает busy, а запуск и применение
// отклоняются; после подготовки проект снова свободен.
func TestBusyWhilePreparing(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	p := prepare(t, "revise", revisePatch, func(options *Options) {
		options.Scaffold = func(project string) (any, error) {
			close(entered)
			<-release
			return defaultScaffold(project)
		}
	})
	if _, err := p.workflow.Discard(p.project, p.id); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	wait.Add(1)
	var startErr error
	go func() {
		defer wait.Done()
		_, startErr = p.workflow.Start(StartInput{Project: p.project, Pass: "scenes"})
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("каркас не начал готовиться")
	}
	view, err := p.workflow.View(p.project)
	if err != nil || !view.Busy || view.CanStartScenes || view.CanStartTreatment {
		t.Fatalf("во время подготовки: %v %+v", err, view)
	}
	if _, err := p.workflow.Start(StartInput{Project: p.project, Pass: "treatment"}); err == nil || err.Error() != textWorkflowStartBlocked {
		t.Fatalf("второй запуск: %v", err)
	}
	close(release)
	wait.Wait()
	if startErr != nil {
		t.Fatal(startErr)
	}
	view, err = p.workflow.View(p.project)
	if err != nil || !view.Busy || view.Proposal.Status != "running" || view.Proposal.Pass != "scenes" {
		t.Fatalf("после подготовки: %v %+v", err, view)
	}
	if _, err := p.workflow.Apply(p.project, view.Proposal.ID); err == nil || err.Error() != textProposalNotApplicable {
		t.Fatalf("применение работающего задания: %v", err)
	}
}

// TestCorruptStateIgnored — повреждённая локальная запись не даёт утверждения и не мешает виду.
func TestCorruptStateIgnored(t *testing.T) {
	project := sampleProject(t)
	localDir := t.TempDir()
	path := statePath(localDir, project)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"{", `{"schemaVersion":1,"approval":{"/abs":null}}`, `{"schemaVersion":1,"pending":{"duration":0}}`} {
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		view, err := New(Options{LocalDir: localDir, Agents: &fakeAgents{}}).View(project)
		if err != nil || view.TreatmentApproved || view.Proposal != nil || !view.CanApproveCurrent {
			t.Fatalf("%s: %v %+v", text, err, view)
		}
		if data, _ := os.ReadFile(path); !bytes.Equal(data, []byte(text)) {
			t.Fatal("вид переписал повреждённую запись")
		}
	}
}
