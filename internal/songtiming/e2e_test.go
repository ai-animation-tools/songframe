package songtiming

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"songframe/internal/components"
	"songframe/internal/jobs"
)

// TestEndToEnd — ручная проверка полного пути на копии настоящего клипа (по умолчанию пропускается):
// выделение вокала Voc FT → явный выбор → CTC-разметка → plan/audio/timing.json.
//
//	SONGFRAME_E2E_PROJECT=<копия клипа во временной папке> SONGFRAME_E2E_PROFILE=<отдельный профиль> \
//	[SONGFRAME_E2E_SELECTION='<components.Selection JSON>'] go test ./internal/songtiming -run EndToEnd -v -timeout 60m
//
// Тест пишет в проект и профиль, поэтому принимает только явно переданные пути.
func TestEndToEnd(t *testing.T) {
	project, profile := os.Getenv("SONGFRAME_E2E_PROJECT"), os.Getenv("SONGFRAME_E2E_PROFILE")
	if project == "" || profile == "" {
		t.Skip("задайте SONGFRAME_E2E_PROJECT и SONGFRAME_E2E_PROFILE")
	}
	manager, err := components.NewManager(profile)
	if err != nil {
		t.Fatal(err)
	}
	if raw := os.Getenv("SONGFRAME_E2E_SELECTION"); raw != "" {
		var selection components.Selection
		if err := json.Unmarshal([]byte(raw), &selection); err != nil {
			t.Fatal(err)
		}
		if _, err := manager.Configure(selection); err != nil {
			t.Fatal(err)
		}
	}
	tasks := jobs.New(profile, jobs.Options{SkipRestore: true})
	service := New(tasks, manager, profile, nil)
	run := func(info jobs.Info, err error) jobs.Info {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		final, err := tasks.Wait(context.Background(), info.ID)
		if err != nil {
			t.Fatal(err)
		}
		full, _ := tasks.Get(info.ID)
		t.Logf("%s: %s за %.1f с\n%s", info.Title, final.Status, time.Since(started).Seconds(), tasks.ReadLog(info.ID, 1<<20))
		if final.Status != jobs.StatusDone {
			t.Fatalf("%+v %s", final, full.Log)
		}
		return final
	}
	if os.Getenv("SONGFRAME_E2E_SKIP_SEPARATION") == "" {
		run(service.SeparateVocals(project, "voc-ft"))
	}
	view := service.VocalsView(project)
	if len(view.Results) == 0 {
		t.Fatalf("нет вокала: %+v", view)
	}
	if _, err := service.SelectVocal(project, view.Results[0].ID); err != nil {
		t.Fatal(err)
	}
	t.Logf("вокал %s SHA-256 %s", view.Results[0].Path, view.Results[0].SHA256)
	run(service.Start(project, GenerateOptions{Vocals: true, Reset: os.Getenv("SONGFRAME_E2E_RESET") != ""}))
	data, err := os.ReadFile(filepath.Join(project, "plan", "audio", "timing.json"))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("timing.json: %d байт", len(data))
}
