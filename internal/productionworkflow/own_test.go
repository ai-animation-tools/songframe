package productionworkflow

import (
	"context"
	"math"
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

// ownRun — проект-образец с провайдером test и проход без агента для проверки своего текста.
func ownRun(t *testing.T) *goldenRun {
	t.Helper()
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image, mediaproviders.Video},
		Paid: true, DefaultImageResolution: "2k"}))
	t.Cleanup(mediaproviders.Register("test-agent", mediaproviders.Info{Title: "Тестовый агент изображений", Kinds: []string{mediaproviders.Image}, Executor: "codex"}))
	t.Cleanup(mediaadapters.Register(mediatest.ID, testRules{Service: &mediatest.Service{Dir: t.TempDir()}}))
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	run := newRun(t, filepath.Join(root, "checks-base", "project"), map[string]string{})
	project := `{"schema_version":1,"name":"Пробный клип","animatic_video":"sample-animatic.mp4","fps":30,"generation":{` +
		`"video":{"provider":"test","resolution":"1080p","aspect_ratio":"16:9","watermark":false,"duration_rule":"min_supported_strictly_greater_than_window","provider_selected":true},` +
		`"image":{"provider":"test-agent","provider_selected":true}}}`
	if err := os.WriteFile(filepath.Join(run.project, "plan", "project.json"), []byte(project), 0o644); err != nil {
		t.Fatal(err)
	}
	return run
}

// ownFrames — свой план опор count штук на запрос seconds: K01 first, KNN last, middle между.
func ownFrames(count int, seconds float64) []OwnKeyframe {
	frames := []OwnKeyframe{}
	for index := 0; index < count; index++ {
		frame := OwnKeyframe{ID: "K" + twoDigits(index+1), Role: "middle", TimeSeconds: float64(index), Prompt: "Кадр " + twoDigits(index+1), ReferencePaths: []string{}}
		switch {
		case index == 0:
			frame.Role, frame.TimeSeconds = "first", 0
		case index == count-1:
			frame.Role, frame.TimeSeconds = "last", seconds
		}
		frames = append(frames, frame)
	}
	return frames
}

// TestSaveOwnDescription — своё описание без агента создаёт попытку с планом опор, которую после
// принятия ведут к первой опоре; неверные ID и время опор отклоняются до записи.
func TestSaveOwnDescription(t *testing.T) {
	run := ownRun(t)
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	input := OwnInput{Project: run.project, Shot: "M01", Stage: "description", Description: "Герой идёт к воротам.", RequestSeconds: seconds}
	wrongID := input
	wrongID.Keyframes = ownFrames(3, seconds)
	wrongID.Keyframes[1].ID = "K05"
	if _, err := run.workflow.SaveOwn(context.Background(), wrongID); err == nil || err.Error() != textFramePlanInvalid {
		t.Fatalf("неверный ID опоры: %v", err)
	}
	late := input
	late.Keyframes = ownFrames(2, seconds)
	late.Keyframes[1].TimeSeconds = seconds - 1
	if _, err := run.workflow.SaveOwn(context.Background(), late); err == nil || err.Error() != textFrameBoundariesInvalid {
		t.Fatalf("последняя опора не на конце запроса: %v", err)
	}
	if _, err := os.Stat(filepath.Join(run.project, "plan", "batches", "M01-attempt-01")); !os.IsNotExist(err) {
		t.Fatalf("отклонённый текст создал попытку: %v", err)
	}
	input.Keyframes = ownFrames(3, seconds)
	view, err := run.workflow.SaveOwn(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if view.PackageDir == nil || len(run.agents.starts) != 0 {
		t.Fatalf("попытка без агента: %v, запусков %d", view.PackageDir, len(run.agents.starts))
	}
	dir := *view.PackageDir
	description, _ := os.ReadFile(filepath.Join(dir, "description.md"))
	if strings.TrimSpace(string(description)) != input.Description {
		t.Fatalf("description.md: %q", description)
	}
	workflow, err := readJSON(filepath.Join(dir, "workflow.json"))
	if err != nil {
		t.Fatal(err)
	}
	frames, _ := dynvalue.AsArray(dynvalue.Get(workflow, "keyframes"))
	if dynvalue.Get(workflow, "stage") != "description_review" || len(frames) != 3 || dynvalue.Get(workflow, "keyframe_count") != float64(3) {
		t.Fatalf("workflow.json: %s", dynvalue.Stringify(workflow))
	}
	if result, err := tools.Run(run.project, "shot_workflow", []string{"decide", "--dir", dir, "--verdict", "approve"}); err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("принятие описания: %+v %v", result, err)
	}
	view, err = run.workflow.View(run.project, "M01", dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(view.NextFrame), `"K01"`) || !view.CanGenerateFrames {
		t.Fatalf("после своего описания следующий шаг — опора K01: %s %v", view.NextFrame, view.CanGenerateFrames)
	}
	single := input
	single.PackageDir, single.Keyframes = dir, ownFrames(1, seconds)
	view, err = run.workflow.SaveOwn(context.Background(), single)
	if err != nil {
		t.Fatalf("правка описания на одну опору: %v", err)
	}
	if *view.PackageDir != dir {
		t.Fatalf("правка неоплаченной попытки пишет в неё же: %s", *view.PackageDir)
	}
	prompts, _ := readJSON(filepath.Join(dir, "keyframe-prompts.json"))
	if items, _ := dynvalue.AsArray(prompts); len(items) != 1 {
		t.Fatalf("keyframe-prompts.json после правки: %s", dynvalue.Stringify(prompts))
	}
}
