package productionworkflow

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"songframe/internal/mediaapi"
)

// shotFramesProject — проект с реестром scenes и принятыми планами accepted (video.mp4 и
// manifest.json в assets/shots).
func shotFramesProject(t *testing.T, scenes string, accepted ...string) string {
	t.Helper()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "scenes.json"), []byte(`{"fps":30,"scenes":[`+scenes+`]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, shot := range accepted {
		folder := filepath.Join(project, "assets", "shots", shot)
		if err := os.MkdirAll(folder, 0o777); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"video.mp4", "manifest.json"} {
			if err := os.WriteFile(filepath.Join(folder, name), []byte("{}"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return project
}

// TestShotFramesRules — кандидаты кадров: предшественник state_from по фазе, более ранние планы
// из continuity (ссылки вперёд и сам план не берутся), непринятые — в missing, без повторов.
func TestShotFramesRules(t *testing.T) {
	scenes := `{"id":"M01","start_frame":0,"continuity":"Начало."},` +
		`{"id":"M02","start_frame":100,"continuity":"Как в M01."},` +
		`{"id":"M03","start_frame":200,"state_from":null,"continuity":"Жёсткая склейка после M02; в M05 продолжится; M030 не план."},` +
		`{"id":"M04","start_frame":300,"state_from":{"scene":"M01","phase":"before"},"continuity":"Планировка как в M01 и M03, сам M04."},` +
		`{"id":"M05","start_frame":400,"state_from":{"scene":"M02","phase":"same"},"continuity":"Повтор M02."}`
	project := shotFramesProject(t, scenes, "M01", "M02", "M05")
	cases := map[string]struct {
		frames  []ShotFrame
		missing []string
	}{
		// Без state_from — предыдущий план реестра; M01 назван ещё и в тексте.
		"M02": {[]ShotFrame{{"M01", "last", "state_from"}, {"M01", "first", "continuity"}}, []string{}},
		// state_from: null — предшественника нет; упоминание M02 раньше, M05 — ссылка вперёд.
		"M03": {[]ShotFrame{{"M02", "first", "continuity"}, {"M02", "last", "continuity"}}, []string{}},
		// before — первый кадр источника; M03 не принят.
		"M04": {[]ShotFrame{{"M01", "first", "state_from"}, {"M01", "last", "continuity"}}, []string{"M03"}},
		// same — оба кадра источника, повторное упоминание их не дублирует.
		"M05": {[]ShotFrame{{"M02", "first", "state_from"}, {"M02", "last", "state_from"}}, []string{}},
		"M01": {[]ShotFrame{}, []string{}},
	}
	for shot, want := range cases {
		frames, missing, err := shotFrames(project, shot)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(frames, want.frames) || !reflect.DeepEqual(missing, want.missing) {
			t.Errorf("%s: кадры %v, нет %v; ожидалось %v, %v", shot, frames, missing, want.frames, want.missing)
		}
	}
}

// TestShotFramesLimit — не больше shotFramesLimit кадров, предшественник первым.
func TestShotFramesLimit(t *testing.T) {
	scenes := `{"id":"M01","start_frame":0},{"id":"M02","start_frame":10},{"id":"M03","start_frame":20},{"id":"M04","start_frame":30},` +
		`{"id":"M05","start_frame":40,"continuity":"M01, M02, M03 и M04."}`
	project := shotFramesProject(t, scenes, "M01", "M02", "M03", "M04")
	frames, _, err := shotFrames(project, "M05")
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != shotFramesLimit || frames[0] != (ShotFrame{"M04", "last", "state_from"}) {
		t.Fatalf("кадры %v", frames)
	}
}

// TestShotFrameReference — опора своего описания M02 называет последний кадр принятого M01:
// путь разрешён только описанию, кадр извлекается в пакет при применении, а задание опор
// подписывает его кадром плана, а не сущностью кастинга.
func TestShotFrameReference(t *testing.T) {
	run := ownRun(t)
	ctx := context.Background()
	c, err := ReadContext(run.project, "M02", "")
	if err != nil {
		t.Fatal(err)
	}
	seconds := math.Floor(c.Window) + 1
	frames := ownFrames(2, seconds)
	target := "plan/batches/M02-attempt-01"
	frames[0].ReferencePaths = []string{target + "/continuity/M01-last.png"}
	view, err := run.workflow.SaveOwn(ctx, OwnInput{Project: run.project, Shot: "M02", Stage: "description",
		Description: "Продолжение вечера.", RequestSeconds: seconds, Keyframes: frames})
	if err != nil {
		t.Fatal(err)
	}
	if view.PackageDir == nil || !strings.HasSuffix(filepath.ToSlash(*view.PackageDir), target) {
		t.Fatalf("пакет %v", view.PackageDir)
	}
	data, err := os.ReadFile(filepath.Join(run.project, filepath.FromSlash(target), "continuity", "M01-last.png"))
	if err != nil || string(data) != "M01:last:0" {
		t.Fatalf("кадр в пакете: %q %v", data, err)
	}
	// Вне задания описания кадры других планов не входят в разрешённые пути: видео их не получает.
	c, err = ReadContext(run.project, "M02", target)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range c.AllowedPaths {
		if strings.Contains(path, "/continuity/") {
			t.Fatalf("кадр другого плана разрешён не только описанию: %s", path)
		}
	}
	entities := addShotFrameEntities(c, map[string]mediaapi.ReferenceEntity{})
	want := mediaapi.ReferenceEntity{ID: "M01", Name: "Последний кадр плана M01", Kind: shotFrameKind}
	if got := entities[target+"/continuity/M01-last.png"]; got != want {
		t.Fatalf("подпись %+v", got)
	}
}
