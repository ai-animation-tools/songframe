package productionworkflow

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/spend"
	"songframe/internal/tools"
)

// TestFrameProviderMark — принятый кандидат задания провайдера изображений помечается в
// workflow.json его ID и в учёте расхода не считается своей опорой; файл, загруженный пользователем
// вместо него, отметку снимает и становится своей опорой.
func TestFrameProviderMark(t *testing.T) {
	run := ownRun(t)
	ctx := context.Background()
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	view, err := run.workflow.SaveOwn(ctx, OwnInput{Project: run.project, Shot: "M01", Stage: "description",
		Description: "Герой идёт к воротам.", RequestSeconds: seconds, Keyframes: ownFrames(2, seconds)})
	if err != nil {
		t.Fatal(err)
	}
	dir := *view.PackageDir
	if result, err := tools.Run(run.project, "shot_workflow", []string{"decide", "--dir", dir, "--verdict", "approve"}); err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("принятие описания: %+v %v", result, err)
	}
	source, err := os.ReadFile(filepath.Join(run.project, "source", "heroes", "mira.png"))
	if err != nil {
		t.Fatal(err)
	}
	image := func(name string, tail byte) string {
		path := filepath.Join(t.TempDir(), name)
		// Лишний байт после PNG меняет SHA, изображение остаётся читаемым.
		if err := os.WriteFile(path, append(append([]byte(nil), source...), tail), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// propose — готовое предложение опор; provider — как после сбора задания провайдера (accept).
	propose := func(id, path, provider string) {
		t.Helper()
		if _, err := run.workflow.ImportFrames(run.project, "M01", dir, []FrameCandidate{{ID: id, Path: path}}); err != nil {
			t.Fatal(err)
		}
		stored := run.workflow.store.Read(run.project, "M01")
		if provider != "" {
			stored.Tree.Set("imageProvider", provider)
			if err := run.workflow.store.Write(run.project, "M01", stored); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := run.workflow.Apply(ctx, run.project, "M01", dir, dynvalue.ToString(stored.Proposal().Value("id"))); err != nil {
			t.Fatal(err)
		}
	}
	keyframe := func(id string) any {
		t.Helper()
		folder := dir
		if !filepath.IsAbs(folder) {
			folder = filepath.Join(run.project, filepath.FromSlash(dir))
		}
		workflow, err := readJSON(filepath.Join(folder, "workflow.json"))
		if err != nil {
			t.Fatal(err)
		}
		frames, _ := dynvalue.AsArray(dynvalue.Get(workflow, "keyframes"))
		for _, frame := range frames {
			if dynvalue.Get(frame, "id") == id {
				return frame
			}
		}
		t.Fatalf("нет опоры %s в %s: %s", id, folder, dynvalue.Stringify(workflow))
		return nil
	}
	approve := func(id string) {
		t.Helper()
		if result, err := tools.Run(run.project, "shot_workflow", []string{"decide", "--dir", dir, "--verdict", "approve"}); err != nil || result.Code == nil || *result.Code != 0 {
			t.Fatalf("принятие %s: %+v %v", id, result, err)
		}
	}
	ownImages := func() int {
		t.Helper()
		entries, err := spend.Entries(run.project)
		if err != nil {
			t.Fatal(err)
		}
		return spend.Summarize(entries, "M01", nil).OwnImages
	}

	propose("K01", image("k01.png", 1), "codex")
	if got := dynvalue.Get(keyframe("K01"), "provider"); got != "codex" {
		t.Fatalf("кандидат провайдера без отметки: %v", got)
	}
	approve("K01")
	if got := dynvalue.Get(keyframe("K01"), "provider"); got != "codex" || ownImages() != 0 {
		t.Fatalf("принятая опора провайдера: provider %v, своих %d", got, ownImages())
	}
	// Свой файл для второй опоры: отметки нет, опора своя.
	propose("K02", image("k02.png", 2), "")
	approve("K02")
	if got := dynvalue.Get(keyframe("K02"), "provider"); !dynvalue.IsNullish(got) || ownImages() != 1 {
		t.Fatalf("своя опора: provider %v, своих %d", got, ownImages())
	}
	// Кандидат на месте помеченной опоры заменяет и отметку: инструмент её снимает.
	if result, err := tools.Run(run.project, "shot_workflow", []string{"propose", "--dir", dir, "K01", image("k01-own.png", 3)}); err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("новый кандидат K01: %+v %v", result, err)
	}
	if got := dynvalue.Get(keyframe("K01"), "provider"); !dynvalue.IsNullish(got) {
		t.Fatalf("отметка провайдера пережила замену файла: %v", got)
	}
}
