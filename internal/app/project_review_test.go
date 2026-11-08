package app

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/scenarioworkflow"
	"songframe-go/internal/status"
)

// noAgents — менеджер агентов без заданий: проверка свежести сценария агента не запускает.
type noAgents struct{}

func (noAgents) Start(scenarioworkflow.AgentStartInput) (scenarioworkflow.AgentJob, error) {
	return scenarioworkflow.AgentJob{}, errors.New("запуск агента в тесте не ожидается")
}

func (noAgents) Get(string) (scenarioworkflow.AgentJob, bool) {
	return scenarioworkflow.AgentJob{}, false
}

func (noAgents) List(string) []scenarioworkflow.AgentJob { return []scenarioworkflow.AgentJob{} }

// TestStatusScenarioReview — projects.status добавляет проблему «проверьте сценарий», когда после
// утверждения трактовки изменился кастинг (reviewProblem), и снимает свежесть аниматика.
// Открытие проекта этой проверки не делает.
func TestStatusScenarioReview(t *testing.T) {
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(t.TempDir(), "Клип")
	if err := os.CopyFS(project, os.DirFS(filepath.Join(root, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	local := t.TempDir()
	workflow := scenarioworkflow.New(scenarioworkflow.Options{LocalDir: local, Agents: noAgents{}})
	service := NewProjectService(nil, local)
	ConnectScenarioReview(service, workflow)

	before, err := service.Status(project)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(before.Problems, textScenarioReviewRequired) {
		t.Fatalf("без утверждения сценарий не требует проверки: %v", before.Problems)
	}
	if _, err := workflow.ApproveCurrent(project); err != nil {
		t.Fatal(err)
	}
	approved, err := service.Status(project)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(approved.Problems, textScenarioReviewRequired) {
		t.Fatalf("утверждённый сценарий не требует проверки: %v", approved.Problems)
	}

	cast := filepath.Join(project, "plan", "cast.json")
	data, err := os.ReadFile(cast)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cast, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := service.Status(project)
	if err != nil {
		t.Fatal(err)
	}
	if changed.Problems[len(changed.Problems)-1] != textScenarioReviewRequired || changed.Checks.AnimaticFresh || changed.Checks.AnimaticApproved || changed.State == status.StateComplete {
		t.Fatalf("после правки кастинга: %+v", changed)
	}
	base, err := status.Compute(project)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(base.Problems, textScenarioReviewRequired) {
		t.Fatalf("проверка без сценарного прохода не читает запись согласования: %v", base.Problems)
	}
}
