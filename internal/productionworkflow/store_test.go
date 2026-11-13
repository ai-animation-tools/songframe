package productionworkflow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaproviders"
	"songframe/internal/mediatest"
	"songframe/internal/tools"
)

// Предложение принадлежит проекту: папку проекта копируют в другое место, и новый проход с пустым
// каталогом состояния и без истории заданий агента видит те же предложения (описание от агента и
// импортированные опоры) и применяет их. Импортированные файлы к этому моменту удалены: опоры
// предложения живут копиями в проекте, а Apply и отклонение эти копии убирают.
func TestProposalSurvivesProjectCopy(t *testing.T) {
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image, mediaproviders.Video},
		Paid: true, DefaultImageResolution: "2k", LipSync: &mediaproviders.LipSync{Min: 5, Max: 30}}))
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	t.Cleanup(mediaadapters.Register(mediatest.ID, testRules{Service: &mediatest.Service{Dir: t.TempDir()}}))
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
	var steps []applyStep
	for _, scenario := range file.Scenarios {
		if scenario.Name == "apply-chain" {
			steps = scenario.Steps
		}
	}
	// Настройки проекта, подготовка описания M01 и ответ агента — первые шаги сценария apply-chain.
	if len(steps) < 3 || steps[0].Op != "write" || steps[1].Op != "start" || steps[2].Op != "finish" {
		t.Fatal("сценарий apply-chain эталона изменился")
	}
	original := &applyRun{goldenRun: newRun(t, filepath.Join(root, "checks-base", "project"), file.Blobs), config: applyConfig{ScenarioApproved: true}}
	original.goldenRun.workflow = original.create()
	for _, step := range steps[:3] {
		if _, err := original.execute(t, step); err != nil {
			t.Fatal(err)
		}
	}
	// Ответ задания становится готовым предложением при показе плана на исходной машине.
	readyProposal(t, original, "", "description")
	ctx := context.Background()

	// Готовое описание видно в копии проекта и применяется без задания агента.
	first := relocate(t, original)
	id := readyProposal(t, first, "", "description")
	if _, err := first.workflow.Apply(ctx, first.project, "M01", "", id); err != nil {
		t.Fatal(err)
	}
	packageDir := filepath.Join(first.project, "plan", "batches", "M01-attempt-01")
	runTool(t, first.project, "shot_workflow", "decide", "--dir", packageDir, "--verdict", "approve")

	// Опоры импортируются из файлов вне проекта и копируются в него.
	incoming := t.TempDir()
	boat, err := os.ReadFile(filepath.Join(first.project, "source", "vehicles", "boat.png"))
	if err != nil {
		t.Fatal(err)
	}
	images := []FrameCandidate{{ID: "K01", Path: filepath.Join(incoming, "first.png")}, {ID: "K02", Path: filepath.Join(incoming, "last.PNG")}}
	for _, image := range images {
		if err := os.WriteFile(image.Path, boat, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := first.workflow.ImportFrames(first.project, "M01", packageDir, images); err != nil {
		t.Fatal(err)
	}
	record, err := os.ReadFile(Store{}.Path(first.project, "M01"))
	if err != nil {
		t.Fatal(err)
	}
	for _, foreign := range []string{first.project, incoming, `"project"`} {
		if strings.Contains(string(record), foreign) {
			t.Fatalf("запись зависит от места проекта или исходных файлов (%s):\n%s", foreign, record)
		}
	}
	for _, path := range []string{`"path": "plan/batches/proposals/M01/K01.png"`, `"plan/batches/proposals/M01/K02.png": "`, `"target": "plan/batches/M01-attempt-01"`} {
		if !strings.Contains(string(record), path) {
			t.Fatalf("в записи нет %s:\n%s", path, record)
		}
	}
	if err := os.RemoveAll(incoming); err != nil {
		t.Fatal(err)
	}

	// Готовые опоры видны и применяются во второй копии; копии кандидатов после применения убраны.
	second := relocate(t, first)
	secondPackage := filepath.Join(second.project, "plan", "batches", "M01-attempt-01")
	id = readyProposal(t, second, secondPackage, "frames")
	if _, err := second.workflow.Apply(ctx, second.project, "M01", secondPackage, id); err != nil {
		t.Fatal(err)
	}
	workflow, ok := dynvalue.ReadJSONFile(filepath.Join(secondPackage, "workflow.json"))
	if !ok {
		t.Fatal("нет workflow.json пакета")
	}
	keyframes, _ := dynvalue.AsArray(dynvalue.Get(workflow, "keyframes"))
	if len(keyframes) != 2 || dynvalue.Get(keyframes[0], "path") != "frames/K01.png" || dynvalue.Get(keyframes[1], "path") != "frames/K02.png" {
		t.Fatalf("кандидаты не зарегистрированы в пакете: %s", dynvalue.Stringify(keyframes))
	}
	if dynvalue.Exists(Store{}.CopiesDir(second.project, "M01")) {
		t.Fatal("копии кандидатов остались после применения")
	}
	if stored := (Store{}).Read(second.project, "M01"); stored == nil || stored.Status() != "applied" {
		t.Fatal("запись не отмечена применённой")
	}

	// Отклонение в первой копии тоже убирает копии кандидатов.
	if _, err := first.workflow.Discard(first.project, "M01", packageDir, id); err != nil {
		t.Fatal(err)
	}
	if dynvalue.Exists(Store{}.CopiesDir(first.project, "M01")) {
		t.Fatal("копии кандидатов остались после отклонения")
	}
	if (Store{}).Read(first.project, "M01") != nil {
		t.Fatal("отклонённое предложение читается")
	}
}

// relocate — копия проекта прогона в новой папке с пустым каталогом состояния, новым менеджером
// агентов без истории и новым проходом (другая машина или перенесённая папка проекта).
func relocate(t *testing.T, from *applyRun) *applyRun {
	t.Helper()
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := &applyRun{goldenRun: &goldenRun{project: filepath.Join(work, "project"), local: filepath.Join(work, "local"), blobs: from.blobs,
		agents: &fakeAgents{}, config: captureConfig{ScenarioApproved: true}, expectedLocal: map[string]string{}}, config: applyConfig{ScenarioApproved: true}}
	if err := os.CopyFS(run.project, os.DirFS(from.project)); err != nil {
		t.Fatal(err)
	}
	run.goldenRun.workflow = run.create()
	return run
}

// readyProposal — ID готового неустаревшего предложения этапа stage в виде плана M01.
func readyProposal(t *testing.T, run *applyRun, packageDir, stage string) string {
	t.Helper()
	view, err := run.workflow.View(run.project, "M01", packageDir)
	if err != nil {
		t.Fatal(err)
	}
	proposal, err := dynvalue.Parse(view.Proposal)
	if err != nil {
		t.Fatal(err)
	}
	if dynvalue.Get(proposal, "status") != "ready" || dynvalue.Get(proposal, "stale") != false || dynvalue.Get(proposal, "stage") != stage {
		t.Fatalf("предложение в копии проекта: %s", view.Proposal)
	}
	images, _ := dynvalue.AsArray(dynvalue.GetPath(proposal, "after", "images"))
	for _, image := range images {
		if path, _ := dynvalue.Get(image, "path").(string); !strings.HasPrefix(path, Store{}.CopiesDir(run.project, "M01")+string(filepath.Separator)) {
			t.Fatalf("кандидат вне папки копий проекта: %s", path)
		}
	}
	id, _ := dynvalue.Get(proposal, "id").(string)
	return id
}

// runTool — прямой вызов инструмента комплекса с проверкой кода завершения.
func runTool(t *testing.T, project, name string, args ...string) {
	t.Helper()
	result, err := tools.RunContext(context.Background(), project, name, args)
	if err != nil {
		t.Fatal(err)
	}
	if result.Code == nil || *result.Code != 0 {
		t.Fatalf("%s: %s%s", name, result.Stderr, result.Stdout)
	}
}

// Запись с путём вне проекта не пишется, а запись с абсолютным путём на диске не читается: место
// записи и пути от проекта — единственный формат.
func TestStorePathsStayInsideProject(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan", "batches", "M01-attempt-01"), 0o755); err != nil {
		t.Fatal(err)
	}
	stored := &Stored{Tree: dynvalue.NewObject()}
	stored.Tree.Set("proposal", proposalTree("id", "", "frames", "[]"))
	stored.Tree.Set("packageDir", filepath.Join(project, "plan", "batches", "M01-attempt-01"))
	stored.Tree.Set("target", filepath.Join(project, "plan", "batches", "M01-attempt-01"))
	stored.Tree.Set("hashes", dynvalue.NewObject())
	stored.Tree.Set("rules", Rules{Project: project, Stage: "frames"}.Tree())
	outside := dynvalue.NewObject()
	outside.Set(filepath.Join(t.TempDir(), "K01.png"), "0")
	stored.Tree.Set("imageHashes", outside)
	if err := (Store{}).Write(project, "M01", stored); err == nil {
		t.Fatal("записан путь вне проекта")
	}
	stored.Tree.Delete("imageHashes")
	if err := (Store{}).Write(project, "M01", stored); err != nil {
		t.Fatal(err)
	}
	if err := (Store{}).Write(project, "../M01", stored); err == nil {
		t.Fatal("записан файл вне папки предложений")
	}
	read := (Store{}).Read(project, "M01")
	if read == nil || read.Target() != filepath.Join(project, "plan", "batches", "M01-attempt-01") || read.Rules().Project != project {
		t.Fatal("запись не прочитана с абсолютными путями")
	}
	value, _ := dynvalue.ReadJSONFile(Store{}.Path(project, "M01"))
	value.(*dynvalue.Object).Set("target", filepath.Join(project, "plan", "batches", "M01-attempt-01"))
	if err := writeJSON(Store{}.Path(project, "M01"), value); err != nil {
		t.Fatal(err)
	}
	if (Store{}).Read(project, "M01") != nil {
		t.Fatal("прочитана запись с абсолютным путём")
	}
}
