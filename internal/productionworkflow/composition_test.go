package productionworkflow

import (
	"context"
	"encoding/base64"
	"math"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/tools"
)

// compositionRun — попытка плана M01 с принятым описанием и точкой съёмки с камерой на схеме локации.
func compositionRun(t *testing.T) (*goldenRun, string) {
	t.Helper()
	run := ownRun(t)
	scenesPath := filepath.Join(run.project, "plan", "scenes.json")
	data, err := os.ReadFile(scenesPath)
	if err != nil {
		t.Fatal(err)
	}
	scenes, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := dynvalue.AsArray(dynvalue.Get(scenes, "scenes"))
	viewpoint, _ := dynvalue.Parse([]byte(`{"location":"pier","side":"south","size":"wide","camera":{"start":[0,0]},"subjects":[{"entity":"boat","start":[0,10]}]}`))
	list[0].(*dynvalue.Object).Set("viewpoint", viewpoint)
	if err := os.WriteFile(scenesPath, []byte(dynvalue.Stringify(scenes)), 0o644); err != nil {
		t.Fatal(err)
	}
	schemesFile := `{"schemes":[{"id":"s1","location":"pier","title":"Причал","objects":[` +
		`{"id":"o1","name":"Настил","shape":{"type":"rect","center":[0,15],"size":[20,4]},"height":1,"color":"#795548"}]}]}`
	if err := os.WriteFile(filepath.Join(run.project, "plan", "schemes.json"), []byte(schemesFile), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	view, err := run.workflow.SaveOwn(context.Background(), OwnInput{Project: run.project, Shot: "M01", Stage: "description", Description: "Лодка у причала.",
		RequestSeconds: seconds, Keyframes: ownFrames(2, seconds)})
	if err != nil {
		t.Fatal(err)
	}
	dir := *view.PackageDir
	if result, err := tools.Run(run.project, "shot_workflow", []string{"decide", "--dir", dir, "--verdict", "approve"}); err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("принятие описания: %+v %v", result, err)
	}
	return run, dir
}

// TestComposition — вид плана с камерой на схеме отдаёт снимок вида из камеры: включён по умолчанию, без файлов,
// пока интерфейс их не сохранил; сохранение по чужому отпечатку отклоняется, по своему — делает снимок свежим;
// выключатель пишет composition_snapshot: false; смена точки съёмки снимок устаревает.
func TestComposition(t *testing.T) {
	run, dir := compositionRun(t)
	view, err := run.workflow.View(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	composition := view.Composition
	if composition == nil || !composition.Enabled || len(composition.Frames) != 0 || len(composition.Phases) != 1 || composition.Phases[0] != "start" {
		t.Fatalf("снимок в виде плана: %+v", composition)
	}
	if _, _, err := compositionFor(composition, "first"); err == nil || err.Error() != textCompositionStale {
		t.Fatalf("включённый снимок без файлов останавливает генерацию: %v", err)
	}
	image := []CompositionImage{{Phase: "start", Data: base64.StdEncoding.EncodeToString(tinyPNG)}}
	if _, err := run.workflow.SaveComposition(run.project, "M01", dir, "чужой", image); err == nil || err.Error() != textCompositionStale {
		t.Fatalf("чужой отпечаток: %v", err)
	}
	if _, err := run.workflow.SaveComposition(run.project, "M01", dir, composition.Digest, []CompositionImage{{Phase: "start", Data: "не png"}}); err == nil ||
		err.Error() != textCompositionInvalid {
		t.Fatalf("не PNG: %v", err)
	}
	view, err = run.workflow.SaveComposition(run.project, "M01", dir, composition.Digest, image)
	if err != nil {
		t.Fatal(err)
	}
	if frames := view.Composition.Frames; len(frames) != 1 || frames[0].Path != filepath.Join(dir, "composition-start.png") {
		t.Fatalf("свежий снимок: %+v", view.Composition)
	}
	if snapshot, ok, err := compositionFor(view.Composition, "last"); err != nil || !ok || snapshot.Phase != "start" {
		t.Fatalf("снимок последней опоры неподвижной камеры — первый кадр: %+v %v %v", snapshot, ok, err)
	}
	view, err = run.workflow.SetComposition(run.project, "M01", dir, false)
	if err != nil {
		t.Fatal(err)
	}
	workflow, _ := readJSON(filepath.Join(dir, "workflow.json"))
	if view.Composition.Enabled || dynvalue.Get(workflow, compositionKey) != false {
		t.Fatalf("выключатель: %+v %s", view.Composition, dynvalue.Stringify(workflow))
	}
	if _, ok, err := compositionFor(view.Composition, "first"); ok || err != nil {
		t.Fatalf("выключенный снимок не передаётся: %v %v", ok, err)
	}
	if view, err = run.workflow.SetComposition(run.project, "M01", dir, true); err != nil || !view.Composition.Enabled {
		t.Fatalf("включение: %+v %v", view.Composition, err)
	}
	// Камера проехала: снимок устарел, кадров теперь два.
	scenesPath := filepath.Join(run.project, "plan", "scenes.json")
	data, _ := os.ReadFile(scenesPath)
	scenes, _ := dynvalue.Parse(data)
	list, _ := dynvalue.AsArray(dynvalue.Get(scenes, "scenes"))
	camera, _ := dynvalue.Parse([]byte(`{"start":[0,0],"end":[4,0]}`))
	dynvalue.Get(list[0], "viewpoint").(*dynvalue.Object).Set("camera", camera)
	if err := os.WriteFile(scenesPath, []byte(dynvalue.Stringify(scenes)), 0o644); err != nil {
		t.Fatal(err)
	}
	view, err = run.workflow.View(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if view.Composition.Digest == composition.Digest || len(view.Composition.Frames) != 0 || len(view.Composition.Phases) != 2 {
		t.Fatalf("после сдвига камеры: %+v", view.Composition)
	}
}
