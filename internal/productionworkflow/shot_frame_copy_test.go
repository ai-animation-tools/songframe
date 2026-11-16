package productionworkflow

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/production"
)

// TestShotFrameCopy — первая опора M02 — копия последнего кадра принятого M01: путь допустим только
// из allowedPaths задания, кадр извлекается в пакет при применении описания, копия заполняется и
// утверждается вместе с описанием, следующей создаётся K02, а вернуть копию отдельно нельзя.
func TestShotFrameCopy(t *testing.T) {
	run := ownRun(t)
	ctx := context.Background()
	c, err := ReadContext(run.project, "M02", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	target := "plan/batches/M02-attempt-01"
	frame := target + "/continuity/M01-last.png"
	description := func(copyOf string) string {
		return `{"schemaVersion":1,"stage":"description","description":"Продолжение без смены точки.","requestSeconds":` + dynvalue.NumberToString(seconds) + `,"keyframes":[` +
			`{"id":"K01","role":"first","timeSeconds":0,"prompt":"","referencePaths":[],"copyOf":"` + copyOf + `"},` +
			`{"id":"K02","role":"last","timeSeconds":` + dynvalue.NumberToString(seconds) + `,"prompt":"Финал","referencePaths":[]}]}`
	}
	rules := c.RulesFor("description")
	if _, err := ParseProposal(description(frame), rules); err == nil || err.Error() != textFrameCopyInvalid {
		t.Fatalf("кадр вне allowedPaths: %v", err)
	}
	rules.AllowedPaths = append(rules.AllowedPaths, frame)
	if _, err := ParseProposal(description(frame), rules); err != nil {
		t.Fatalf("копия кадра M01: %v", err)
	}
	if _, err := ParseProposal(description("source/heroes/mira.png"), rules); err == nil || err.Error() != textFrameCopyInvalid {
		t.Fatalf("копия исходника: %v", err)
	}

	// Своё описание с референсом на кадр извлекает его в пакет; затем план опор — как ответ агента.
	frames := ownFrames(2, seconds)
	frames[0].ReferencePaths = []string{frame}
	view, err := run.workflow.SaveOwn(ctx, OwnInput{Project: run.project, Shot: "M02", Stage: "description",
		Description: "Продолжение без смены точки.", RequestSeconds: seconds, Keyframes: frames})
	if err != nil {
		t.Fatal(err)
	}
	dir := *view.PackageDir
	folder := dir
	if !filepath.IsAbs(folder) {
		folder = filepath.Join(run.project, filepath.FromSlash(dir))
	}
	prompts, err := readJSON(filepath.Join(folder, "keyframe-prompts.json"))
	if err != nil {
		t.Fatal(err)
	}
	items, _ := dynvalue.AsArray(prompts)
	first := items[0].(*dynvalue.Object)
	first.Set("prompt", "")
	first.Set("referencePaths", &dynvalue.Array{Items: []any{}})
	first.Set("copyOf", frame)
	if err := writeProjectJSON(filepath.Join(folder, "keyframe-prompts.json"), prompts); err != nil {
		t.Fatal(err)
	}
	pkg, err := production.ReadPackage(run.project, dir)
	if err != nil {
		t.Fatal(err)
	}
	service := production.New(production.Options{})
	if err := service.Decide(run.project, dir, "approve", "", pkg.DecisionToken, ""); err != nil {
		t.Fatalf("утверждение описания: %v", err)
	}
	workflow, err := readJSON(filepath.Join(folder, "workflow.json"))
	if err != nil {
		t.Fatal(err)
	}
	keyframes, _ := dynvalue.AsArray(dynvalue.Get(workflow, "keyframes"))
	if !dynvalue.Truthy(dynvalue.Get(keyframes[0], "approved")) || dynvalue.Get(keyframes[0], "path") != "frames/K01.png" {
		t.Fatalf("K01 после утверждения описания: %v", keyframes[0])
	}
	data, err := os.ReadFile(filepath.Join(folder, "frames", "K01.png"))
	if err != nil || string(data) != "M01:last:0" {
		t.Fatalf("файл K01: %q %v", data, err)
	}
	if c, err = ReadContext(run.project, "M02", dir); err != nil {
		t.Fatal(err)
	}
	if next := c.NextFrame(); next != "K02" {
		t.Fatalf("следующая опора: %v", next)
	}
	// Применение ответа агента извлекает и кадр, названный только источником копии.
	placed := filepath.Join(folder, "continuity", "M01-last.png")
	if err := os.Remove(placed); err != nil {
		t.Fatal(err)
	}
	if err := run.workflow.placeShotFrames(ctx, run.project, folder, items); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(placed); err != nil || string(data) != "M01:last:0" {
		t.Fatalf("кадр источника копии: %q %v", data, err)
	}
	if err := service.ReopenFrame(run.project, dir, "K01", "Другой свет", "frame"); err == nil || err.Error() != "Опора K01 — последний кадр плана M01: чтобы её заменить, доработайте описание." {
		t.Fatalf("возврат копии кадра: %v", err)
	}
}
