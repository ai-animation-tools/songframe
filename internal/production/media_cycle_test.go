package production_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/jobs"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/production"
	"songframe-go/internal/tools"
)

// realMedia подставляет настоящие FFmpeg/ffprobe из PATH; без них тест пропускается.
func realMedia(t *testing.T) (ffmpeg, ffprobe string) {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg не найден в PATH")
	}
	ffprobe, err = exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe не найден в PATH")
	}
	saved := mediacmd.Programs
	mediacmd.Programs = func() (string, string) { return ffmpeg, ffprobe }
	t.Cleanup(func() { mediacmd.Programs = saved })
	return ffmpeg, ffprobe
}

// probeVideo — число кадров, частота и размер первого видеопотока по ffprobe.
func probeVideo(t *testing.T, ffprobe, path string) (frames, rate, size string, audio bool) {
	t.Helper()
	output, err := exec.Command(ffprobe, "-v", "error", "-count_frames", "-show_streams", "-of", "json", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	var info struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Frames    string `json:"nb_read_frames"`
			Rate      string `json:"r_frame_rate"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(output, &info); err != nil {
		t.Fatal(err)
	}
	for _, stream := range info.Streams {
		switch stream.CodecType {
		case "video":
			frames, rate = stream.Frames, stream.Rate
			size = strings.Join([]string{itoa(stream.Width), itoa(stream.Height)}, "x")
		case "audio":
			audio = true
		}
	}
	return frames, rate, size, audio
}

func itoa(value int) string {
	data, _ := json.Marshal(value)
	return string(data)
}

// TestPaidCycleWithRealRender — на тестовом провайдере полный цикл оценка → согласие → отправка →
// скачивание → техническая сводка → приёмка участка с настоящим рендером FFmpeg. Скачанный оригинал длиннее окна плана и со звуком генератора; комплект плана
// получает отрендеренный участок ровно в окно (120 кадров на 30 к/с, 1920×1080, без звука),
// побайтную копию оригинала, манифест режима и обновлённые представления, а пакет очищается.
func TestPaidCycleWithRealRender(t *testing.T) {
	ffmpeg, ffprobe := realMedia(t)
	e := newEnv(t, "test-video")
	// Результат сервиса — 5 с видео 1920×1080 25 к/с с тоном: частота и длина отличаются от шкалы
	// монтажа, поэтому рендер обязан пересчитать кадры, а не скопировать файл.
	original := filepath.Join(t.TempDir(), "video.mp4")
	command := exec.Command(ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-fflags", "+bitexact", original)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("видео сервиса: %v %s", err, output)
	}
	data, err := os.ReadFile(original)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.service.Dir, "video.mp4"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	info, err := e.submit(e.quote(), "")
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(info); finished.Status != jobs.StatusDone {
		t.Fatalf("отправка и скачивание: %s", finished.Log)
	}
	if e.paid() != 1 {
		t.Fatalf("платных отправок %d", e.paid())
	}
	view := e.view()
	if view.ResultToken == "" {
		t.Fatal("нет скачанного результата")
	}

	sheet, err := e.prod.ContactSheet(e.project, e.pkg)
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(sheet); finished.Status != jobs.StatusDone {
		t.Fatalf("сводка: %s", finished.Log)
	}

	start, end := 0.5, 4.5
	accepted, err := e.prod.Accept(e.project, "M03", e.pkg, production.AcceptOptions{Mode: "cut", ExpectedResultToken: view.ResultToken, CutStart: &start, CutEnd: &end})
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(accepted); finished.Status != jobs.StatusDone {
		t.Fatalf("приёмка участка: %s", finished.Log)
	}
	kit := filepath.Join(e.project, "assets", "shots", "M03")
	frames, rate, size, audio := probeVideo(t, ffprobe, filepath.Join(kit, "video.mp4"))
	if frames != "120" || rate != "30/1" || size != "1920x1080" || audio {
		t.Fatalf("рендер участка: %s кадров, %s, %s, звук %v", frames, rate, size, audio)
	}
	copied, err := os.ReadFile(filepath.Join(kit, "original.mp4"))
	if err != nil || string(copied) != string(data) {
		t.Fatalf("оригинал не сохранён побайтно: %v", err)
	}
	var manifest map[string]any
	raw, err := os.ReadFile(filepath.Join(kit, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"filter"`) || !strings.Contains(string(raw), "ffmpeg_version") {
		t.Fatalf("манифест без рецепта рендера: %s", raw)
	}
	if _, err := os.Stat(e.pkg); !os.IsNotExist(err) {
		t.Fatalf("пакет не очищен: %v", err)
	}
	productionView, err := production.ViewProduction(e.project)
	if err != nil {
		t.Fatal(err)
	}
	for _, shot := range productionView.Shots {
		if shot.ID == "M03" && shot.State != production.StateCompleted {
			t.Fatalf("M03 после приёмки участка: %s", shot.State)
		}
	}
	// accept_shot обновляет представления до очистки пакета: карточки и документы планов свежие, а
	// ROADMAP.md (перечисляет пакеты plan/batches) отстаёт до следующего обновления представлений.
	// Статус проекта это не затрагивает.
	result, err := tools.Run(e.project, "update_scene_views", []string{"--check"})
	if err != nil || result.Code == nil || *result.Code != 1 || strings.TrimSpace(result.Stderr) != "Устарели представления: ROADMAP.md" {
		t.Fatalf("представления после приёмки: %v\n%s\n%s", err, result.Stdout, result.Stderr)
	}
	if e.paid() != 1 {
		t.Fatalf("приёмка отправила запрос: %d", e.paid())
	}
}
