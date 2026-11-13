package production_test

import (
	"context"
	"encoding/json"
	"errors"
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

// TestDiscardManualAttemptForgetsCost — «Удалить попытку» с загруженным своим видео и указанной
// стоимостью убирает и папку, и запись расхода: журнал не хранит цифру, от которой отказался
// пользователь, а расход плана снова пуст.
func TestDiscardManualAttemptForgetsCost(t *testing.T) {
	ffmpeg, _ := realMedia(t)
	e := newEnv(t, "test-video")
	original := filepath.Join(t.TempDir(), "phone.mp4")
	command := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", original)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("своё видео: %v %s", err, output)
	}
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
	amount := 180.0
	info, err := e.prod.AttachManual(e.project, dir, production.ManualResult{File: original, Source: "Проба", CostAmount: &amount, CostUnit: "RUB"})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusDone {
		t.Fatalf("загрузка своего видео: %s", finished.Log)
	}
	if summary, err := production.SpendFor(e.project, "M04"); err != nil || summary.Manual != 1 {
		t.Fatalf("расход до удаления: %+v %v", summary, err)
	}
	// Окно приёмки узнаёт настоящие кадр, частоту и длину своего видео: «целиком» для него недоступно.
	media, err := production.ResultMediaFor(context.Background(), e.project, dir)
	if err != nil || media == nil || media.Width != 640 || media.Height != 360 || media.FrameRate != "30/1" || media.Seconds < 1.9 || media.Seconds > 2.1 {
		t.Fatalf("параметры своего видео: %+v %v", media, err)
	}
	if err := e.prod.DiscardAttempt(e.project, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("папка попытки осталась: %v", err)
	}
	summary, err := production.SpendFor(e.project, "M04")
	if err != nil || summary.Videos != 0 || summary.Attempts != 0 || len(summary.Totals) != 0 {
		t.Fatalf("расход после удаления: %+v %v", summary, err)
	}
}

// TestReplaceManualVideo — по ошибке загружено не то видео: «Заменить видео» сначала проверяет
// новый файл (не-MP4 отклоняется, прежнее видео остаётся), затем заменяет копию в попытке. Новый
// результат получает свой токен и параметры, источник берётся из формы замены; после приёмки
// замена недоступна.
func TestReplaceManualVideo(t *testing.T) {
	ffmpeg, _ := realMedia(t)
	e := newEnv(t, "test-video")
	videos := t.TempDir()
	render := func(name, size string) string {
		t.Helper()
		path := filepath.Join(videos, name)
		command := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size="+size+":rate=30:duration=2",
			"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("%s: %v %s", name, err, output)
		}
		return path
	}
	wrong, right := render("wrong.mp4", "640x360"), render("right.mp4", "1280x720")
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
	info, err := e.prod.AttachManual(e.project, dir, production.ManualResult{File: wrong, Source: "Не тот файл"})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusDone {
		t.Fatalf("загрузка: %s", finished.Log)
	}
	before, err := production.ReadPackage(e.project, dir)
	if err != nil || before == nil || before.ResultToken == "" {
		t.Fatalf("первое видео: %+v %v", before, err)
	}
	mov := filepath.Join(videos, "phone.mov")
	if err := os.WriteFile(mov, []byte("\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00видео"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := e.prod.ReplaceManual(e.project, dir, production.ManualResult{File: mov, Source: "Телефон"}); err == nil || !strings.Contains(err.Error(), "MP4") {
		t.Fatalf("замена на MOV: %v", err)
	}
	if kept, _ := production.ReadPackage(e.project, dir); kept == nil || kept.ResultToken != before.ResultToken {
		t.Fatal("отказ замены тронул загруженное видео")
	}
	// Файл сводки прежнего видео: замена убирает её целиком, новая сводка собирается заданием.
	stale := filepath.Join(dir, "preview", "stale-frame.png")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("прежний кадр"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err = e.prod.ReplaceManual(e.project, dir, production.ManualResult{File: right, Source: "Нужный файл"})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusDone {
		t.Fatalf("замена: %s", finished.Log)
	}
	after, err := production.ReadPackage(e.project, dir)
	if err != nil || after == nil || after.Stage != "downloaded" || after.ResultToken == "" || after.ResultToken == before.ResultToken ||
		!strings.Contains(string(after.Request.ManualGeneration), "Нужный файл") {
		t.Fatalf("после замены: %+v %v", after, err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("сводка прежнего видео осталась: %v", err)
	}
	for _, path := range after.Preview {
		if filepath.Base(path) == "stale-frame.png" {
			t.Fatalf("в сводке нового видео кадр прежнего: %v", after.Preview)
		}
	}
	media, err := production.ResultMediaFor(context.Background(), e.project, dir)
	if err != nil || media == nil || media.Width != 1280 {
		t.Fatalf("параметры нового видео: %+v %v", media, err)
	}
	start, end := 0.0, 2.0
	// Видео 2 с короче окна M04 (4 с): недостающее удерживается последним кадром.
	accepted, err := e.prod.Accept(e.project, "M04", dir, production.AcceptOptions{Mode: "cut", ExpectedResultToken: after.ResultToken, CutStart: &start, CutEnd: &end, HoldLast: 60})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(accepted); finished.Status != jobs.StatusDone {
		t.Fatalf("приёмка: %s", finished.Log)
	}
	if _, err := e.prod.ReplaceManual(e.project, dir, production.ManualResult{File: wrong, Source: "Поздно"}); err == nil {
		t.Fatal("замена после приёмки выполнена")
	}
}
