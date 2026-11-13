package buildreview

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"

	"songframe/internal/mediacmd"
)

// TestAvailableFramesVariableRate — видео с переменной частотой (запись экрана, телефон): ffprobe
// сообщает r_frame_rate 30/1, но кадров меньше, чем длительность × 30. Рендер приводит видео к
// шкале фильтром fps по времени, поэтому доступная длина считается по длительности, а не по
// nb_frames: иначе участок на всю длину видео отвергался как «выходящий за пределы видео».
func TestAvailableFramesVariableRate(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg не найден в PATH")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe не найден в PATH")
	}
	saved := mediacmd.Programs
	mediacmd.Programs = func() (string, string) { return ffmpeg, ffprobe }
	t.Cleanup(func() { mediacmd.Programs = saved })
	dir := t.TempDir()
	render := func(name string, filter ...string) string {
		t.Helper()
		path := filepath.Join(dir, name)
		args := append([]string{"-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2"}, filter...)
		args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path)
		if output, err := exec.Command(ffmpeg, args...).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v %s", name, err, output)
		}
		return path
	}
	// Каждый четвёртый кадр выброшен с сохранением времени: 45 кадров за ~1,97 с.
	variable := render("variable.mp4", "-vf", "select='mod(n\\,4)'", "-fps_mode", "vfr")
	got, err := availableFrames(context.Background(), variable, 30)
	if err != nil {
		t.Fatal(err)
	}
	if got.Int64() < 58 || got.Int64() > 60 {
		t.Fatalf("переменная частота: доступно %s кадров шкалы, ожидалось ~59 по длительности", got)
	}
	// Постоянная частота проекта по-прежнему считается точно по nb_frames.
	constant := render("constant.mp4")
	if got, err := availableFrames(context.Background(), constant, 30); err != nil || got.Int64() != 60 {
		t.Fatalf("постоянная частота: %v %v", got, err)
	}
}
