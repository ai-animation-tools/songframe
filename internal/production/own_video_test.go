package production_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/jobs"
	"songframe/internal/mediaproviders"
	"songframe/internal/production"
	"songframe/internal/requestsnapshot"
	"songframe/internal/shotworkflow"
	"songframe/internal/tools"
)

// TestOwnVideoCycle — своё видео речевого плана M04 без описания, опор, промпта и среза речи:
// MOV и не-видео отклоняются до записей, MP4 загружается в попытку своего видео, приёмка с настоящим
// рендером даёт комплект с отметкой own_video без входов и speech.wav, а проверка проекта не находит
// ошибок формы ни в запросе попытки, ни в манифесте комплекта.
func TestOwnVideoCycle(t *testing.T) {
	ffmpeg, _ := realMedia(t)
	e := newEnv(t, "test-video")
	videoDir := t.TempDir()
	mov := filepath.Join(videoDir, "phone.mov")
	if err := os.WriteFile(mov, []byte("\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00видео"), 0o644); err != nil {
		t.Fatal(err)
	}
	text := filepath.Join(videoDir, "notes.txt")
	if err := os.WriteFile(text, []byte("не видео"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{mov, text} {
		if err := production.CheckManualResult(production.ManualResult{File: file, Source: "Телефон"}); err == nil || !strings.Contains(err.Error(), "MP4") {
			t.Fatalf("%s принят как MP4: %v", filepath.Base(file), err)
		}
	}
	original := filepath.Join(videoDir, "phone.mp4")
	command := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=5",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-fflags", "+bitexact", original)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("своё видео: %v %s", err, output)
	}
	if err := production.CheckManualResult(production.ManualResult{File: original, Source: "  "}); err == nil {
		t.Fatal("своё видео без источника принято")
	}
	for _, cost := range []float64{1.5, -1} {
		if err := production.CheckManualResult(production.ManualResult{File: original, Source: "Телефон", CostAmount: &cost, CostUnit: "RUB"}); err == nil {
			t.Fatalf("стоимость %v принята", cost)
		}
	}

	// Попытка своего видео: те же шаги, что productionworkflow.CreateOwnVideo.
	dir := filepath.Join(e.project, "plan", "batches", "M04-attempt-01")
	e.tool("shot_workflow", "init", "M04", "--dir", dir, "--mode", "shot")
	if _, err := requestsnapshot.PrepareManual(filepath.Join(dir, "request-01"), requestsnapshot.ManualSpec{
		Shot: "M04", Provider: mediaproviders.ManualID(), OwnVideo: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := shotworkflow.StartOwnVideo(dir, "request-01"); err != nil {
		t.Fatal(err)
	}
	if err := shotworkflow.StartOwnVideo(dir, "request-01"); err == nil {
		t.Fatal("отметка своего видео поставлена повторно")
	}
	view, err := production.ReadPackage(e.project, dir)
	if err != nil || view == nil || view.Request == nil || !view.Request.OwnVideo || view.Request.Mode != "manual" || len(view.Request.Inputs) != 0 {
		t.Fatalf("вид попытки своего видео: %+v %v", view, err)
	}

	amount := 300.0
	info, err := e.prod.AttachManual(e.project, dir, production.ManualResult{File: original, Source: "Снято на телефон", CostAmount: &amount, CostUnit: "RUB"})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusDone {
		t.Fatalf("загрузка своего видео: %s", finished.Log)
	}
	lint := func() string {
		t.Helper()
		result, err := tools.Run(e.project, "lint_registry", []string{})
		if err != nil {
			t.Fatal(err)
		}
		return result.Stdout + result.Stderr
	}
	if report := lint(); strings.Contains(report, "M04") {
		t.Fatalf("проверка проекта нашла ошибки в попытке своего видео:\n%s", report)
	}
	view, err = production.ReadPackage(e.project, dir)
	if err != nil || view == nil || view.ResultToken == "" || view.Stage != "downloaded" {
		t.Fatalf("результат своего видео: %+v %v", view, err)
	}
	start, end := 0.0, 4.0
	accepted, err := e.prod.Accept(e.project, "M04", dir, production.AcceptOptions{Mode: "cut", ExpectedResultToken: view.ResultToken, CutStart: &start, CutEnd: &end})
	if err != nil {
		t.Fatalf("приёмка речевого плана без среза речи: %v", err)
	}
	if finished := e.wait(accepted); finished.Status != jobs.StatusDone {
		t.Fatalf("приёмка своего видео: %s", finished.Log)
	}
	kit := filepath.Join(e.project, "assets", "shots", "M04")
	raw, err := os.ReadFile(filepath.Join(kit, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Generation struct {
			OwnVideo bool  `json:"own_video"`
			Inputs   []any `json:"inputs"`
			Lipsync  bool  `json:"lipsync"`
			Audio    any   `json:"audio"`
		} `json:"generation"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if !manifest.Generation.OwnVideo || len(manifest.Generation.Inputs) != 0 || manifest.Generation.Lipsync || manifest.Generation.Audio != nil {
		t.Fatalf("манифест своего видео: %s", raw)
	}
	if _, err := os.Stat(filepath.Join(kit, "speech.wav")); !os.IsNotExist(err) {
		t.Fatalf("в комплекте своего видео есть срез речи: %v", err)
	}
	if report := lint(); strings.Contains(report, "M04") {
		t.Fatalf("проверка проекта нашла ошибки в комплекте своего видео:\n%s", report)
	}
	kitView, err := production.AcceptedKitFor(e.project, "M04")
	if err != nil || kitView == nil || !kitView.OwnVideo || len(kitView.Images) != 0 || kitView.Speech != nil {
		t.Fatalf("принятый комплект своего видео: %+v %v", kitView, err)
	}
	summary, err := production.SpendFor(e.project, "M04")
	if err != nil || summary.Videos != 1 {
		t.Fatalf("расход своего видео: %+v %v", summary, err)
	}
}
