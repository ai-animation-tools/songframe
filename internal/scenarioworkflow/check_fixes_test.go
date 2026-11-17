package scenarioworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/production"
	"songframe/internal/scenario"
)

// fixReport — ответ агента с двумя проблемами: правка положения Миры в M02 и проблема сюжета без
// правок.
const fixReport = `{"schemaVersion":1,"summary":"Итог.","issues":[` +
	`{"group":"state","severity":"high","shots":["M02"],"entities":["mira"],"title":"Мира у края","problem":"П","why":"П","fix":"И",` +
	`"changes":[{"shot":"M02","phase":"before","entity":"mira","property":"position","value":"на середине причала"}]},` +
	`{"group":"story","severity":"low","shots":["M04"],"entities":[],"title":"Сюжет","problem":"П","why":"П","fix":"И","changes":[]}]}`

// fixProject — проект эталона ready с готовым отчётом fixReport.
func fixProject(t *testing.T) (string, *Workflow) {
	t.Helper()
	var ready golden.Case
	for _, item := range golden.Load(t, "scenario-check") {
		if item.Name == "ready" {
			ready = item
		}
	}
	project, err := filepath.EvalSymlinks(ready.BuildProject(t))
	if err != nil {
		t.Fatal(err)
	}
	agents := &fakeAgents{}
	workflow := New(Options{LocalDir: t.TempDir(), Agents: agents})
	if _, err := workflow.StartCheck(project); err != nil {
		t.Fatal(err)
	}
	agents.update(func(job *AgentJob) { job.Status, job.ExitCode, job.Result = "completed", new(int), fixReport })
	if view, err := workflow.CheckView(project); err != nil || view.Status != CheckReady {
		t.Fatalf("отчёт не готов: %v %+v", err, view)
	}
	return project, workflow
}

// fingerprints — текущие отпечатки планов проекта.
func fingerprints(t *testing.T, project string) *dynvalue.Object {
	t.Helper()
	read := func(path string) any {
		data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		value, err := dynvalue.Parse(data)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	initial, err := cast.InitialStates(read("plan/cast.json"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := scenario.SceneFingerprints(read("plan/scenes.json"), initial)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// accept — принятое видео планов shots по текущим отпечаткам: манифест с видео и запись статуса.
func accept(t *testing.T, project string, shots ...string) {
	t.Helper()
	current := fingerprints(t, project)
	status := dynvalue.NewObject()
	status.Set("schema_version", 1.0)
	status.Set("current_animatic", nil)
	status.Set("current_animatic_status", "none")
	entries := dynvalue.NewObject()
	for _, shot := range shots {
		dir := filepath.Join(project, "assets", "shots", shot)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		video := []byte("video " + shot)
		sum := sha256.Sum256(video)
		if err := os.WriteFile(filepath.Join(dir, "video.mp4"), video, 0o644); err != nil {
			t.Fatal(err)
		}
		manifest := `{"schema_version":1,"shot":"` + shot + `","kind":"generated_video","accepted_edit":{"fps":30,"frames":90,"video":{"path":"video.mp4","sha256":"` + hex.EncodeToString(sum[:]) + `"}}}`
		if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
		entry := dynvalue.NewObject()
		entry.Set("scene_sha256", current.Value(shot))
		entries.Set(shot, entry)
	}
	status.Set("shots", entries)
	if err := os.WriteFile(filepath.Join(project, "plan", "production-status.json"), []byte(dynvalue.StringifyIndent(status, "  ")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestCheckFixes — правка проблемы состояния: предпросмотр называет текущее и новое значение и задетые
// принятые планы, применение пишет state_changes, оставляет принятым только выбранный план, отмечает
// проблему исправленной и не делает отчёт устаревшим. Проблема без правок и повтор отклоняются.
func TestCheckFixes(t *testing.T) {
	project, workflow := fixProject(t)
	accept(t, project, "M02", "M03")
	states, err := production.ShotStates(project)
	if err != nil || states["M02"].State != production.StateCompleted || states["M03"].State != production.StateCompleted {
		t.Fatalf("планы не приняты: %v %+v", err, states)
	}

	if _, err := workflow.CheckFixPreview(project, []int{1}); err == nil || !strings.Contains(err.Error(), "не может исправить это само") {
		t.Fatalf("проблема без правок: %v", err)
	}
	preview, err := workflow.CheckFixPreview(project, []int{0})
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Changes) != 1 {
		t.Fatalf("правки %+v", preview.Changes)
	}
	change := preview.Changes[0]
	if change.Shot != "M02" || change.EntityName != "Мира" || change.PropertyLabel != "Положение" || change.Current == nil || *change.Value != "на середине причала" {
		t.Fatalf("правка %+v", change)
	}
	ids := []string{}
	for _, shot := range preview.Accepted {
		ids = append(ids, shot.ID)
		if shot.Direct != (shot.ID == "M02") {
			t.Fatalf("прямая правка %+v", shot)
		}
	}
	if !slices.Contains(ids, "M02") || !slices.Contains(ids, "M03") {
		t.Fatalf("задетые принятые %v", ids)
	}

	if _, err := workflow.ApplyCheckFixes(CheckFixInput{Project: project, Issues: []int{0}, Keep: []string{"M05"}}); err == nil || !strings.Contains(err.Error(), "План M05") {
		t.Fatalf("незадетый план в keep: %v", err)
	}
	before := fingerprints(t, project)
	view, err := workflow.ApplyCheckFixes(CheckFixInput{Project: project, Issues: []int{0}, Keep: []string{"M03"}})
	if err != nil {
		t.Fatal(err)
	}
	if view.Stale || !view.Report.Issues[0].Fixed || view.Report.Issues[1].Fixed {
		t.Fatalf("вид после правки: stale %v, fixed %v %v", view.Stale, view.Report.Issues[0].Fixed, view.Report.Issues[1].Fixed)
	}
	after := fingerprints(t, project)
	if dynvalue.StrictEqual(before.Value("M02"), after.Value("M02")) || dynvalue.StrictEqual(before.Value("M03"), after.Value("M03")) {
		t.Fatal("правка не изменила отпечатки M02 и M03")
	}
	states, err = production.ShotStates(project)
	if err != nil || states["M02"].State != production.StateStale || states["M03"].State != production.StateCompleted {
		t.Fatalf("после правки M02 должен устареть, M03 остаться принятым: %v %+v", err, states)
	}
	data, err := os.ReadFile(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		t.Fatal(err)
	}
	scenes, _ := dynvalue.Parse(data)
	for _, scene := range arrayItems(dynvalue.Get(scenes, "scenes")) {
		if dynvalue.Get(scene, "id") == "M02" {
			if got := dynvalue.GetPath(scene, "state_changes", "before", "mira", "position"); got != "на середине причала" {
				t.Fatalf("state_changes M02: %v", got)
			}
		}
	}
	if _, err := workflow.CheckFixPreview(project, []int{0}); err == nil || !strings.Contains(err.Error(), "уже внесены") {
		t.Fatalf("повтор правки: %v", err)
	}
}

// TestCheckResolve — отметка «решено вручную» ставится и снимается, закрывает проблему для правок и
// не трогает исправленную приложением.
func TestCheckResolve(t *testing.T) {
	project, workflow := fixProject(t)
	view, err := workflow.ResolveCheckIssue(CheckResolveInput{Project: project, Issue: 1, Resolved: true})
	if err != nil || !view.Report.Issues[1].Resolved || view.Report.Issues[0].Resolved {
		t.Fatalf("отметка: %v %+v", err, view.Report)
	}
	if _, err := workflow.CheckFixPreview(project, []int{1}); err == nil {
		t.Fatal("решённая вручную проблема принята к исправлению")
	}
	if view, err = workflow.ResolveCheckIssue(CheckResolveInput{Project: project, Issue: 1}); err != nil || view.Report.Issues[1].Resolved {
		t.Fatalf("снятие отметки: %v", err)
	}
	if _, err := workflow.ApplyCheckFixes(CheckFixInput{Project: project, Issues: []int{0}}); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.ResolveCheckIssue(CheckResolveInput{Project: project, Issue: 0, Resolved: true}); err == nil || !strings.Contains(err.Error(), "уже внесены") {
		t.Fatalf("отметка исправленной: %v", err)
	}
	if _, err := workflow.ResolveCheckIssue(CheckResolveInput{Project: project, Issue: 5, Resolved: true}); err == nil {
		t.Fatal("неизвестная проблема принята")
	}
}

// TestReviseMarksCheckIssue — применённая доработка, запущенная из проблемы отчёта, отмечает её
// исправленной; доработка без связи и связь с другим отчётом отметок не ставят.
func TestReviseMarksCheckIssue(t *testing.T) {
	for _, item := range []struct {
		name  string
		issue *int
		job   string
		want  string
	}{
		{"связь", new(int), "check-1", "[0]"},
		{"без связи", nil, "check-1", "[]"},
		{"другой отчёт", new(int), "check-2", "[]"},
	} {
		t.Run(item.name, func(t *testing.T) {
			project := sampleProject(t)
			record := `{"schemaVersion":1,"status":"ready","jobId":"check-1","shots":["M03"],"entities":[],"properties":{},"hashes":{},` +
				`"report":{"schemaVersion":1,"summary":"Итог.","issues":[{"group":"story","severity":"medium","shots":["M03"],"entities":[],"title":"Т","problem":"П","why":"П","fix":"И","changes":[]}]},` +
				`"message":null,"fixed":[],"resolved":[]}`
			path := filepath.Join(project, filepath.FromSlash(CheckPath))
			if err := os.WriteFile(path, []byte(record), 0o644); err != nil {
				t.Fatal(err)
			}
			agents := &fakeAgents{}
			workflow := New(Options{LocalDir: filepath.Join(t.TempDir(), "state"), Agents: agents})
			if _, err := workflow.ApproveCurrent(project); err != nil {
				t.Fatal(err)
			}
			note := "Больше ветра"
			if _, err := workflow.Start(StartInput{Project: project, Pass: "revise", Note: &note, SelectedIDs: []string{"M03"}, CheckIssue: item.issue}); err != nil {
				t.Fatal(err)
			}
			agents.update(func(job *AgentJob) { job.Status, job.ExitCode, job.Result = "completed", new(int), revisePatch })
			view, err := workflow.View(project)
			if err != nil || view.Proposal == nil {
				t.Fatalf("вид: %v", err)
			}
			if item.job != "check-1" {
				data, _ := os.ReadFile(path)
				if err := os.WriteFile(path, []byte(strings.Replace(string(data), `"check-1"`, `"`+item.job+`"`, 1)), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := workflow.Apply(project, view.Proposal.ID); err != nil {
				t.Fatal(err)
			}
			stored := readCheck(project)
			if got := dynvalue.Stringify(stored.doc.Value("fixed")); got != item.want {
				t.Fatalf("fixed %s, ожидалось %s", got, item.want)
			}
		})
	}
}
