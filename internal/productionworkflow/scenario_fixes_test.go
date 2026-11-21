package productionworkflow

import (
	"context"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
)

// refuse запускает описание плана shot и завершает задание ответом result; возвращает запись.
func refuse(t *testing.T, run *goldenRun, shot, result string) *Stored {
	t.Helper()
	if _, err := run.workflow.Start(context.Background(), StartInput{Project: run.project, Shot: shot, Action: "prepare"}); err != nil {
		t.Fatal(err)
	}
	job := run.agents.last(t)
	job.Result, job.Status = result, "completed"
	code := 0
	job.ExitCode = &code
	if _, err := run.workflow.View(run.project, shot, ""); err != nil {
		t.Fatal(err)
	}
	return run.workflow.store.Read(run.project, shot)
}

// TestScenarioFixes — отказ описания со списком противоречий: контекст описания несёт источники
// значений врезок; приложение дополняет противоречия текущим значением и источником, «Исправить
// сценарий» пишет предложенное значение в state_changes плана и отклоняет отказ. Правка, задевающая
// принятый план, и неверная форма списка отклоняются.
func TestScenarioFixes(t *testing.T) {
	run := ownRun(t)
	blocked := `{"schemaVersion":1,"stage":"blocked","reason":"Лодка на первом кадре сухая по действию.","problems":[` +
		`{"phase":"before","entity":"boat","property":"dirt","conflict":"«с каплями воды» из M01 против сухой лодки в действии.","fix":"сухая"},` +
		`{"field":"camera","conflict":"Камера не видит лодку."},` +
		`{"field":"viewpoint","conflict":"Причал по точке съёмки под нижним краем кадра."}]}`
	stored := refuse(t, run, "M03", blocked)
	if sources := dynvalue.GetPath(mustParse(t, []byte(run.agents.starts[0].Context)), "stateSources", "before", "boat", "dirt"); sources != "M01.after" {
		t.Fatalf("источник значения в контексте: %v", sources)
	}
	proposal := stored.Proposal()
	problems, _ := dynvalue.AsArray(proposal.Value("problems"))
	if proposal.Value("status") != "invalid" || proposal.Value("refused") != true || len(problems) != 3 ||
		proposal.Value("agentText") != "Лодка на первом кадре сухая по действию." {
		t.Fatalf("отказ: %s", dynvalue.Stringify(proposal))
	}
	first := problems[0]
	if dynvalue.Get(first, "current") != "с каплями воды" || dynvalue.GetPath(first, "source", "shot") != "M01" ||
		dynvalue.GetPath(first, "source", "phase") != "after" || dynvalue.Get(first, "entityName") == "" || dynvalue.Get(first, "propertyLabel") == "" {
		t.Fatalf("противоречие: %s", dynvalue.Stringify(first))
	}
	if _, err := run.workflow.FixScenario(run.project, "M03", "", stored.ID()); err != nil {
		t.Fatal(err)
	}
	registry, err := readJSON(filepath.Join(run.project, "plan", "scenes.json"))
	if err != nil {
		t.Fatal(err)
	}
	scenes, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	if got := dynvalue.GetPath(scenes[2], "state_changes", "before", "boat", "dirt"); got != "сухая" {
		t.Fatalf("исправление в сценарии: %v", got)
	}
	if run.workflow.store.Read(run.project, "M03") != nil {
		t.Fatal("отказ не отклонён")
	}
	if _, err := run.workflow.FixScenario(run.project, "M03", "", stored.ID()); err == nil || err.Error() != textFixUnavailable {
		t.Fatalf("повторное исправление: %v", err)
	}

	// Итог M01 наследует принятый M02 (state_from M01): такая правка в производстве не вносится.
	touching := `{"schemaVersion":1,"stage":"blocked","reason":"Лодка грязная.","problems":[` +
		`{"phase":"after","entity":"boat","property":"dirt","conflict":"Лодка в конце в иле.","fix":"в иле"}]}`
	stored = refuse(t, run, "M01", touching)
	if _, err := run.workflow.FixScenario(run.project, "M01", "", stored.ID()); err == nil || err.Error() != textFixTouchesAccepted([]string{"M02"}) {
		t.Fatalf("правка, задевающая принятый план: %v", err)
	}
	if run.workflow.store.Read(run.project, "M01") == nil {
		t.Fatal("отказ отклонён без исправления")
	}

	// Неверная форма: свойство не из словаря кастинга.
	stored = refuse(t, run, "M04", `{"schemaVersion":1,"stage":"blocked","reason":"Нет.","problems":[{"phase":"before","entity":"boat","property":"color","conflict":"x","fix":"y"}]}`)
	if stored.Proposal().Value("message") != textBlockedInvalid || stored.Proposal().Value("refused") == true {
		t.Fatalf("неверная форма: %s", dynvalue.Stringify(stored.Proposal()))
	}
}
