package productionworkflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/production"
	"songframe/internal/tools"
)

// copyDescription — ответ агента description с тремя опорами; frames[2] — третья опора.
func copyDescription(seconds float64, third string) string {
	time := dynvalue.NumberToString(seconds)
	return `{"schemaVersion":1,"stage":"description","description":"Касание и удержание.","requestSeconds":` + time + `,"keyframes":[` +
		`{"id":"K01","role":"first","timeSeconds":0,"prompt":"Часы","referencePaths":[]},` +
		`{"id":"K02","role":"middle","timeSeconds":3,"prompt":"Касание","referencePaths":[]},` +
		`{"id":"K03","role":"last","timeSeconds":` + time + `,` + third + `}]}`
}

// TestParseFrameCopy — копия ссылается на более раннюю опору-не-копию, без своего промпта и
// референсов; остальные варианты отклоняются понятной ошибкой.
func TestParseFrameCopy(t *testing.T) {
	run := ownRun(t)
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	rules := c.RulesFor("description")
	if _, err := ParseProposal(copyDescription(seconds, `"prompt":"","referencePaths":[],"copyOf":"K02"`), rules); err != nil {
		t.Fatalf("копия K02: %v", err)
	}
	for name, third := range map[string]string{
		"свой промпт":   `"prompt":"Удержание","referencePaths":[],"copyOf":"K02"`,
		"на себя":       `"prompt":"","referencePaths":[],"copyOf":"K03"`,
		"нет источника": `"prompt":"","referencePaths":[],"copyOf":"K09"`,
		"не строка":     `"prompt":"","referencePaths":[],"copyOf":2`,
		"с референсами": `"prompt":"","referencePaths":["source/heroes/mira.png"],"copyOf":"K02"`,
	} {
		if _, err := ParseProposal(copyDescription(seconds, third), rules); err == nil || err.Error() != textFrameCopyInvalid {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Копия копии: источник должен создаваться сам.
	chain := `{"schemaVersion":1,"stage":"description","description":"Удержание.","requestSeconds":` + dynvalue.NumberToString(seconds) + `,"keyframes":[` +
		`{"id":"K01","role":"first","timeSeconds":0,"prompt":"Часы","referencePaths":[]},` +
		`{"id":"K02","role":"middle","timeSeconds":2,"prompt":"","referencePaths":[],"copyOf":"K01"},` +
		`{"id":"K03","role":"last","timeSeconds":` + dynvalue.NumberToString(seconds) + `,"prompt":"","referencePaths":[],"copyOf":"K02"}]}`
	if _, err := ParseProposal(chain, rules); err == nil || err.Error() != textFrameCopyInvalid {
		t.Fatalf("копия копии: %v", err)
	}
}

// TestFrameCopyFollowsSource — копия не создаётся и не загружается; утверждение источника
// переносит в неё его байты и утверждение, возврат копии на доработку отклоняется, а новое
// утверждение источника после возврата обновляет копию.
func TestFrameCopyFollowsSource(t *testing.T) {
	run := ownRun(t)
	ctx := context.Background()
	c, err := ReadContext(run.project, "M01", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	view, err := run.workflow.SaveOwn(ctx, OwnInput{Project: run.project, Shot: "M01", Stage: "description",
		Description: "Касание и удержание.", RequestSeconds: seconds, Keyframes: ownFrames(3, seconds)})
	if err != nil {
		t.Fatal(err)
	}
	dir := *view.PackageDir
	folder := dir
	if !filepath.IsAbs(folder) {
		folder = filepath.Join(run.project, filepath.FromSlash(dir))
	}
	// План опор как после ответа агента: K03 — копия K02.
	prompts, err := readJSON(filepath.Join(folder, "keyframe-prompts.json"))
	if err != nil {
		t.Fatal(err)
	}
	items, _ := dynvalue.AsArray(prompts)
	third := items[2].(*dynvalue.Object)
	third.Set("prompt", "")
	third.Set("copyOf", "K02")
	if err := writeProjectJSON(filepath.Join(folder, "keyframe-prompts.json"), prompts); err != nil {
		t.Fatal(err)
	}
	if result, err := tools.Run(run.project, "shot_workflow", []string{"decide", "--dir", dir, "--verdict", "approve"}); err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("принятие описания: %+v %v", result, err)
	}
	source, err := os.ReadFile(filepath.Join(run.project, "source", "heroes", "mira.png"))
	if err != nil {
		t.Fatal(err)
	}
	service := production.New(production.Options{})
	accept := func(id string, tail byte) {
		t.Helper()
		path := filepath.Join(t.TempDir(), id+".png")
		if err := os.WriteFile(path, append(append([]byte(nil), source...), tail), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := run.workflow.ImportFrames(run.project, "M01", dir, []FrameCandidate{{ID: id, Path: path}}); err != nil {
			t.Fatalf("загрузка %s: %v", id, err)
		}
		stored := run.workflow.store.Read(run.project, "M01")
		if _, err := run.workflow.Apply(ctx, run.project, "M01", dir, dynvalue.ToString(stored.Proposal().Value("id"))); err != nil {
			t.Fatal(err)
		}
		pkg, err := production.ReadPackage(run.project, dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := service.Decide(run.project, dir, "approve", "", pkg.DecisionToken, ""); err != nil {
			t.Fatalf("утверждение %s: %v", id, err)
		}
	}
	frame := func(id string) (bool, string) {
		t.Helper()
		workflow, err := readJSON(filepath.Join(folder, "workflow.json"))
		if err != nil {
			t.Fatal(err)
		}
		frames, _ := dynvalue.AsArray(dynvalue.Get(workflow, "keyframes"))
		for _, item := range frames {
			if dynvalue.Get(item, "id") == id {
				sha, _ := dynvalue.Get(item, "sha256").(string)
				return dynvalue.Truthy(dynvalue.Get(item, "approved")), sha
			}
		}
		t.Fatalf("нет опоры %s", id)
		return false, ""
	}
	next := func() any {
		t.Helper()
		c, err := ReadContext(run.project, "M01", dir)
		if err != nil {
			t.Fatal(err)
		}
		return c.NextFrame()
	}

	accept("K01", 1)
	if got := next(); got != "K02" {
		t.Fatalf("следующая после K01: %v", got)
	}
	accept("K02", 2)
	approved, sha := frame("K03")
	_, sourceSHA := frame("K02")
	if !approved || sha != sourceSHA {
		t.Fatalf("копия K03 после утверждения K02: %v %s / %s", approved, sha, sourceSHA)
	}
	data, err := os.ReadFile(filepath.Join(folder, "frames", "K03.png"))
	if err != nil {
		t.Fatal(err)
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != sourceSHA {
		t.Fatal("файл K03 — не байты K02")
	}
	if got := next(); got != nil {
		t.Fatalf("после копии создавать нечего, а следующая %v", got)
	}
	// Копию не загружают и не возвращают отдельно.
	if _, err := run.workflow.ImportFrames(run.project, "M01", dir, []FrameCandidate{{ID: "K03", Path: filepath.Join(folder, "frames", "K03.png")}}); err == nil {
		t.Fatal("загрузка копии принята")
	}
	if err := service.ReopenFrame(run.project, dir, "K03", "Другой свет", "frame"); err == nil || err.Error() != "Опора K03 — копия K02: верните на доработку K02, копия обновится после её утверждения." {
		t.Fatalf("возврат копии: %v", err)
	}
	// Источник возвращён и утверждён заново другим файлом: копия повторяет новые байты.
	if err := service.ReopenFrame(run.project, dir, "K02", "Другой свет", "frame"); err != nil {
		t.Fatal(err)
	}
	accept("K02", 3)
	approved, sha = frame("K03")
	_, sourceSHA = frame("K02")
	if !approved || sha != sourceSHA {
		t.Fatalf("копия после нового K02: %v %s / %s", approved, sha, sourceSHA)
	}
}
