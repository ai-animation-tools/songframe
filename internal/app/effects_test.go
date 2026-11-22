package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"songframe/internal/filedigest"
	"songframe/internal/golden"
	"songframe/internal/jobs"
	"songframe/internal/shoteffects"
)

// TestEffectsService — эффекты в порядке цепочки, принятые планы образца, ошибка рецепта до
// задания, одно задание на план (повтор и снятие во время рендера — отказ), рендер и снятие.
func TestEffectsService(t *testing.T) {
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(project, os.DirFS(filepath.Join(base, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	service := NewEffectsService(manager)
	view, err := service.View(project)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Kinds) != 3 || view.Kinds[0].ID != "light" || view.Kinds[1].WindAngle != "angle" || view.Kinds[2].ID != "grain" {
		t.Fatalf("эффекты: %+v", view.Kinds)
	}
	if len(view.Shots) != 2 || view.Shots[0].State.Shot != "M01" || view.Shots[0].Applied {
		t.Fatalf("планы: %+v", view.Shots)
	}
	if _, err := service.Render(project, "M01", []shoteffects.Step{{Effect: "snow"}}); err == nil {
		t.Fatal("неизвестный эффект без ошибки")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("нет FFmpeg")
	}
	shortKit(t, project)
	steps := []shoteffects.Step{{Effect: "grain"}}
	info, err := service.Render(project, "M01", steps)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Render(project, "M01", steps); err == nil || err.Error() != textEffectBusy {
		t.Fatalf("второй рендер плана: %v", err)
	}
	if _, err := service.Remove(project, "M01"); err == nil || err.Error() != textEffectBusy {
		t.Fatalf("снятие во время рендера: %v", err)
	}
	if view, _ = service.View(project); view.Shots[0].JobID != info.ID {
		t.Fatalf("задание плана в снимке: %+v", view.Shots[0])
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if done, err := manager.Wait(ctx, info.ID); err != nil || done.Status != jobs.StatusDone {
		t.Fatalf("задание: %v %+v %s", err, done, done.Log)
	}
	if view, _ = service.View(project); !view.Shots[0].Applied || view.Shots[0].Stale != "" || view.Shots[0].JobID != "" {
		t.Fatalf("после рендера: %+v", view.Shots[0])
	}
	if view, err = service.Remove(project, "M01"); err != nil || view.Shots[0].Applied {
		t.Fatalf("снятие: %+v, %v", view.Shots[0], err)
	}
}

// shortKit заменяет принятое видео M01 роликом 1920×1080 из шести кадров: задание рендера в тесте
// идёт секунды и под нагрузкой полного прогона проверок.
func shortKit(t *testing.T, project string) {
	t.Helper()
	directory := filepath.Join(project, "assets", "shots", "M01")
	video := filepath.Join(directory, "video.mp4")
	if output, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
		"-i", "testsrc2=size=1920x1080:rate=30", "-frames:v", "6", "-pix_fmt", "yuv420p", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, output)
	}
	digest, ok := filedigest.File(video)
	if !ok {
		t.Fatal("нет видео")
	}
	path := filepath.Join(directory, "manifest.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	edit := manifest["accepted_edit"].(map[string]any)
	edit["frames"] = 6
	edit["video"].(map[string]any)["sha256"] = digest
	if data, err = json.Marshal(manifest); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
