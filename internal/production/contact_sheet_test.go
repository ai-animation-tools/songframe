package production_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"songframe-go/internal/jobs"
)

// TestContactSheet — contactSheet(project, packageDir): задание «Сводка <пакет>» с одним шагом
// contact_sheet --package <пакет> --json пишет preview/ пакета по скачанному видео; отказ
// инструмента — неудача задания с его текстом, пакет вне проекта отклоняется до задания.
func TestContactSheet(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg не найден в PATH")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe не найден в PATH")
	}
	e := newEnv(t, "test-video")
	quote := e.quote()
	info, err := e.submit(quote, "")
	if err != nil {
		t.Fatal(err)
	}
	e.wait(info)
	downloads, _ := attempt(t, e.pkg)["downloads"].([]any)
	if len(downloads) == 0 {
		t.Fatal("попытка без скачанного файла")
	}
	video := filepath.Join(e.pkg, "request", downloads[0].(map[string]any)["path"].(string))

	// Подставное видео сервиса не декодируется: шаг завершается отказом с текстом инструмента.
	failed, err := e.prod.ContactSheet(e.project, e.pkg)
	if err != nil {
		t.Fatal(err)
	}
	if finished := e.wait(failed); finished.Status != jobs.StatusFailed || finished.Error == nil || *finished.Error == "" {
		t.Fatalf("сводка по битому видео: %+v", finished)
	}

	command := exec.Command(ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10", "-frames:v", "5",
		"-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", video)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("видео: %v %s", err, output)
	}
	started, err := e.prod.ContactSheet(e.project, e.pkg)
	if err != nil {
		t.Fatal(err)
	}
	if started.Kind != jobs.KindContactSheet || started.Title != "Сводка M03-attempt-01" || len(started.Steps) != 1 ||
		started.Steps[0].Tool != "contact_sheet" || started.Steps[0].Label != "контактный лист" {
		t.Fatalf("задание %+v", started)
	}
	if finished := e.wait(started); finished.Status != jobs.StatusDone {
		t.Fatalf("сводка %+v", finished)
	}
	for _, name := range []string{"contact-sheet.png", "first-frame.png", "last-frame.png", "preview-2x.mp4"} {
		if _, err := os.Stat(filepath.Join(e.pkg, "preview", name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := e.prod.ContactSheet(e.project, filepath.Join(t.TempDir(), "чужой")); err == nil {
		t.Fatal("пакет вне проекта")
	}
}
