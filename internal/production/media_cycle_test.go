package production_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/jobs"
	"songframe/internal/mediacmd"
	"songframe/internal/production"
	"songframe/internal/shoteffects"
	"songframe/internal/tools"
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

// frameDigests — MD5 декодированных кадров видеопотока по порядку (framemd5 FFmpeg).
func frameDigests(t *testing.T, ffmpeg, path string) []string {
	t.Helper()
	output, err := exec.Command(ffmpeg, "-v", "error", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-").Output()
	if err != nil {
		t.Fatalf("framemd5 %s: %v", path, err)
	}
	digests := []string{}
	for _, line := range strings.Split(string(output), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, ",")
		digests = append(digests, strings.TrimSpace(fields[len(fields)-1]))
	}
	return digests
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
	// Предпросмотр участка до приёмки: тот же рендер, ровно окно плана; кадры сверяются с
	// принятым видео после приёмки.
	preview, err := production.CutPreviewFor(t.Context(), e.project, e.pkg, production.AcceptOptions{Mode: "cut", CutStart: &start, CutEnd: &end})
	if err != nil {
		t.Fatal(err)
	}
	if preview.Frames != 120 || !strings.HasPrefix(preview.Path, filepath.Join(e.pkg, "preview")+string(filepath.Separator)) {
		t.Fatalf("предпросмотр %+v", preview)
	}
	previewFrames := frameDigests(t, ffmpeg, preview.Path)
	if again, err := production.CutPreviewFor(t.Context(), e.project, e.pkg, production.AcceptOptions{Mode: "cut", CutStart: &start, CutEnd: &end}); err != nil || again.Path != preview.Path {
		t.Fatalf("повторный предпросмотр %+v, %v", again, err)
	}
	if _, err := production.CutPreviewFor(t.Context(), e.project, e.pkg, production.AcceptOptions{Mode: "cut", CutStart: &start, CutEnd: &end, Speed: "0.8"}); err == nil {
		t.Fatal("участок не по окну принят предпросмотром")
	}
	view = e.view()
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
	if accepted := frameDigests(t, ffmpeg, filepath.Join(kit, "video.mp4")); strings.Join(accepted, "\n") != strings.Join(previewFrames, "\n") {
		t.Fatalf("кадры предпросмотра (%d) и принятого видео (%d) различаются", len(previewFrames), len(accepted))
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
	// Очистка удалила попытку, но её отправка в журнале расходов: принятый дубль, 4 с материала.
	summary, err := production.SpendFor(e.project, "M03")
	if err != nil || summary.Videos != 1 || summary.Rejected != 0 || summary.AcceptedSeconds == nil || *summary.AcceptedSeconds != 4 {
		t.Fatalf("расход принятого плана: %+v %v", summary, err)
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

	// «Изменить участок»: эффект плана применён к принятому видео, затем участок меняется из
	// оригинала комплекта с удержанием первого кадра. Меняются только видео и рецепт участка;
	// оригинал, сведения о генерации, отпечаток постановки и расход прежние, эффект устаревает
	// с прежней цепочкой.
	if _, err := shoteffects.Render(t.Context(), e.project, "M03", []shoteffects.Step{{Effect: "reverse"}}, func(string) {}); err != nil {
		t.Fatal(err)
	}
	statusBefore, err := os.ReadFile(filepath.Join(e.project, "plan", "production-status.json"))
	if err != nil {
		t.Fatal(err)
	}
	recutStart, recutEnd := 1.0, 4.0
	recutOptions := production.AcceptOptions{Mode: "cut", CutStart: &recutStart, CutEnd: &recutEnd, HoldFirst: 30}
	recutPreview, err := e.prod.RecutPreview(t.Context(), e.project, "M03", recutOptions)
	if err != nil || recutPreview.Frames != 120 {
		t.Fatalf("предпросмотр нового участка %+v, %v", recutPreview, err)
	}
	recut, err := e.prod.Recut(e.project, "M03", recutOptions)
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(recut); finished.Status != jobs.StatusDone {
		t.Fatalf("новый участок: %s", finished.Log)
	}
	if got := frameDigests(t, ffmpeg, filepath.Join(kit, "video.mp4")); strings.Join(got, "\n") != strings.Join(frameDigests(t, ffmpeg, recutPreview.Path), "\n") {
		t.Fatal("кадры нового участка и его предпросмотра различаются")
	}
	if strings.Join(frameDigests(t, ffmpeg, filepath.Join(kit, "video.mp4")), "\n") == strings.Join(previewFrames, "\n") {
		t.Fatal("видео комплекта не изменилось")
	}
	recutRaw, err := os.ReadFile(filepath.Join(kit, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var recutManifest map[string]any
	if err := json.Unmarshal(recutRaw, &recutManifest); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(manifest["generation"])
	after, _ := json.Marshal(recutManifest["generation"])
	if string(before) != string(after) {
		t.Fatal("сведения о генерации комплекта изменились")
	}
	acceptedEdit := recutManifest["accepted_edit"].(map[string]any)
	if acceptedEdit["hold_first_seconds"] != 1.0 || acceptedEdit["frames"] != 120.0 {
		t.Fatalf("рецепт участка: %v", acceptedEdit)
	}
	if copied, err := os.ReadFile(filepath.Join(kit, "original.mp4")); err != nil || string(copied) != string(data) {
		t.Fatal("оригинал комплекта изменился")
	}
	if statusAfter, err := os.ReadFile(filepath.Join(e.project, "plan", "production-status.json")); err != nil || string(statusAfter) != string(statusBefore) {
		t.Fatalf("отпечаток постановки изменился: %v", err)
	}
	if summary, err := production.SpendFor(e.project, "M03"); err != nil || summary.Videos != 1 || summary.Attempts != 1 {
		t.Fatalf("расход после нового участка: %+v %v", summary, err)
	}
	effect, err := shoteffects.Read(e.project, "M03")
	if err != nil || effect.Stale == "" || len(effect.Steps) != 1 || effect.Steps[0].Effect != "reverse" {
		t.Fatalf("эффект после нового участка: %+v %v", effect, err)
	}
	if e.paid() != 1 {
		t.Fatalf("новый участок отправил запрос: %d", e.paid())
	}
}
