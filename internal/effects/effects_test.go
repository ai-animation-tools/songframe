package effects

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/process"
)

// solid — кадр одного цвета sRGB.
func solid(w, h int, r, g, b uint8) *Frame {
	f := NewFrame(w, h)
	for i := 0; i < w*h; i++ {
		f.Pix[i*3], f.Pix[i*3+1], f.Pix[i*3+2] = toLinear[r], toLinear[g], toLinear[b]
	}
	return f
}

// setRect закрашивает прямоугольник цветом sRGB.
func setRect(f *Frame, x0, y0, x1, y1 int, r, g, b uint8) {
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			i := (y*f.Width + x) * 3
			f.Pix[i], f.Pix[i+1], f.Pix[i+2] = toLinear[r], toLinear[g], toLinear[b]
		}
	}
}

// pixel — пиксель кадра в sRGB.
func pixel(f *Frame, x, y int) [3]uint8 {
	i := (y*f.Width + x) * 3
	return [3]uint8{encode(f.Pix[i]), encode(f.Pix[i+1]), encode(f.Pix[i+2])}
}

func digest(f *Frame) string {
	buffer := make([]byte, f.Width*f.Height*3)
	f.RGB24(buffer)
	sum := sha256.Sum256(buffer)
	return hex.EncodeToString(sum[:])
}

func TestResolve(t *testing.T) {
	specs := []ParamSpec{{"a", "", 0, 10, 3, 1}, {"b", "", -1, 1, 0, 0.1}}
	got, err := Resolve(specs, map[string]float64{"b": 0.5})
	if err != nil || got["a"] != 3 || got["b"] != 0.5 {
		t.Fatalf("Resolve = %v, %v", got, err)
	}
	for name, given := range map[string]map[string]float64{
		"вне диапазона": {"a": 11},
		"бесконечность": {"b": math.Inf(1)},
		"неизвестный":   {"c": 1},
		"дробное целое": {"a": 2.5},
	} {
		if _, err := Resolve(specs, given); err == nil {
			t.Errorf("%s: нет ошибки", name)
		}
	}
}

// TestRegistry — у каждого эффекта значения по умолчанию в диапазоне, имена параметров не
// повторяются, а неизвестный эффект в рецепте — ошибка.
func TestRegistry(t *testing.T) {
	kinds := Kinds()
	var ids []string
	for _, kind := range kinds {
		ids = append(ids, kind.ID)
		if kind.Version < 1 || kind.Title == "" {
			t.Errorf("%s: версия %d, подпись %q", kind.ID, kind.Version, kind.Title)
		}
		seen := map[string]bool{}
		for _, spec := range kind.Params {
			if seen[spec.Name] || spec.Title == "" || spec.Default < spec.Min || spec.Default > spec.Max {
				t.Errorf("%s: параметр %+v", kind.ID, spec)
			}
			seen[spec.Name] = true
		}
	}
	if strings.Join(ids, ",") != "light,rain,grain" {
		t.Fatalf("эффекты %v", ids)
	}
	if _, err := Build([]Step{{ID: "snow"}}, Size{4, 4, 1}); err == nil {
		t.Fatal("неизвестный эффект без ошибки")
	}
	if _, err := Build([]Step{{ID: "rain", Params: map[string]float64{"density": -1}}}, Size{4, 4, 1}); err == nil {
		t.Fatal("параметр вне диапазона без ошибки")
	}
}

// TestDiffMaskCatchesFaintGlow — слабое свечение в темноте (разница 4 из 255) входит в маску,
// хотя в линейном свете эта разница меньше тысячной.
func TestDiffMaskCatchesFaintGlow(t *testing.T) {
	a := solid(40, 20, 2, 2, 2)
	b := a.Clone()
	setRect(b, 5, 5, 8, 8, 6, 6, 6)
	mask := DiffMask(a, b, 0.012, 0, 0)
	if mask[6*40+6] != 1 || mask[15*40+30] != 0 {
		t.Fatalf("маска %v / %v", mask[6*40+6], mask[15*40+30])
	}
}

// TestStaticShot — вне области смены кадр повторяет базовую опору, внутри — состояние;
// переход идёт между состояниями; ошибки состояний.
func TestStaticShot(t *testing.T) {
	base := solid(64, 36, 10, 20, 30)
	setRect(base, 10, 10, 16, 16, 0, 200, 0)
	red := base.Clone()
	setRect(red, 10, 10, 16, 16, 0, 0, 0)
	setRect(red, 40, 10, 46, 16, 220, 0, 0)
	params := map[string]float64{"push_in": 0, "dilate": 2, "feather": 0, "transition": 3}
	shot, err := NewStaticShot(base, []State{{base, 0}, {red, 10}}, params, Size{64, 36, 20})
	if err != nil {
		t.Fatal(err)
	}
	if got := pixel(shot.Frame(0), 42, 12); got != [3]uint8{10, 20, 30} {
		t.Errorf("до смены %v", got)
	}
	if got := pixel(shot.Frame(15), 42, 12); got != [3]uint8{220, 0, 0} {
		t.Errorf("после смены %v", got)
	}
	if got := pixel(shot.Frame(15), 30, 30); got != [3]uint8{10, 20, 30} {
		t.Errorf("фон после смены %v", got)
	}
	if got := pixel(shot.Frame(11), 42, 12); got[0] <= 30 || got[0] >= 220 {
		t.Errorf("переход %v", got)
	}
	for name, states := range map[string][]State{
		"нет состояний":     nil,
		"начало не с нуля":  {{base, 1}},
		"не по возрастанию": {{base, 0}, {red, 0}},
		"за концом плана":   {{base, 0}, {red, 20}},
		"другого размера":   {{base, 0}, {solid(10, 10, 0, 0, 0), 5}},
	} {
		if _, err := NewStaticShot(base, states, nil, Size{64, 36, 20}); err == nil {
			t.Errorf("%s: нет ошибки", name)
		}
	}
}

// TestDeterministic — один рецепт даёт одинаковые кадры в любом порядке расчёта, другой
// вариант случайной картины дождя — другие.
func TestDeterministic(t *testing.T) {
	base := solid(160, 90, 8, 8, 12)
	setRect(base, 70, 30, 90, 50, 0, 180, 40)
	size := Size{160, 90, 12}
	build := func(seed float64) (Source, []Effect) {
		shot, err := NewStaticShot(base, []State{{base, 0}}, nil, size)
		if err != nil {
			t.Fatal(err)
		}
		chain, err := Build([]Step{
			{ID: "light", Params: map[string]float64{"start": 0}},
			{ID: "rain", Params: map[string]float64{"seed": seed, "density": 3000, "angle": -8}},
			{ID: "grain"},
		}, size)
		if err != nil {
			t.Fatal(err)
		}
		return shot, chain
	}
	source, chain := build(1)
	forward := digest(RenderFrame(source, chain, 30, 7))
	source, chain = build(1)
	RenderFrame(source, chain, 30, 11)
	if again := digest(RenderFrame(source, chain, 30, 7)); again != forward {
		t.Fatal("кадр зависит от порядка расчёта")
	}
	source, chain = build(2)
	if other := digest(RenderFrame(source, chain, 30, 7)); other == forward {
		t.Fatal("другой вариант дождя дал тот же кадр")
	}
}

// TestScreenAngle — наклон дождя на экране по ветру на схеме и направлению камеры.
func TestScreenAngle(t *testing.T) {
	near := func(a, b float64) bool { return math.Abs(a-b) < 1e-9 }
	if a := ScreenAngle(0, 0.2, 90, 0); a == 0 {
		t.Fatal("боковой ветер без наклона")
	}
	// камера смотрит на север, ветер на восток: капли уходят вправо
	if a := ScreenAngle(0, 0.2, 90, 0); !(a > 0) {
		t.Errorf("ветер на восток при взгляде на север: %v", a)
	}
	if a, b := ScreenAngle(0, 0.2, 90, 0), ScreenAngle(0, 0.2, 270, 0); !near(a, -b) {
		t.Errorf("разворот на 180°: %v и %v", a, b)
	}
	if a := ScreenAngle(45, 0.3, 45, 0); !near(a, 0) {
		t.Errorf("ветер вдоль взгляда: %v", a)
	}
	if a := ScreenAngle(10, 0, 200, 30); !near(a, 0) {
		t.Errorf("без ветра: %v", a)
	}
	if a := ScreenAngle(0, 0.2, 90, 0); !near(a, math.Atan(0.2)*180/math.Pi) {
		t.Errorf("величина наклона %v", a)
	}
}

func requireFFmpeg(t *testing.T) {
	t.Helper()
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skip(name + " не найден в PATH")
		}
	}
}

// TestRender — ролик нужного размера, длины и частоты; отмена останавливает FFmpeg.
func TestRender(t *testing.T) {
	requireFFmpeg(t)
	base := solid(64, 36, 10, 10, 10)
	size := Size{64, 36, 15}
	shot, err := NewStaticShot(base, []State{{base, 0}}, nil, size)
	if err != nil {
		t.Fatal(err)
	}
	chain, err := Build([]Step{{ID: "rain"}}, size)
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "out.mp4")
	var last int
	if err := Render(context.Background(), Job{Source: shot, Chain: chain, FPS: 30, Output: output}, func(done, total int) {
		last = done
	}); err != nil {
		t.Fatal(err)
	}
	if last != size.Frames {
		t.Errorf("прогресс %d из %d", last, size.Frames)
	}
	probe, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
		"-show_entries", "stream=width,height,r_frame_rate,nb_read_frames", "-of", "json", output).Output()
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		Streams []struct {
			Width, Height int
			Rate          string `json:"r_frame_rate"`
			Frames        string `json:"nb_read_frames"`
		}
	}
	if err := json.Unmarshal(probe, &info); err != nil || len(info.Streams) != 1 {
		t.Fatalf("ffprobe: %s", probe)
	}
	if s := info.Streams[0]; s.Width != 64 || s.Height != 36 || s.Rate != "30/1" || s.Frames != "15" {
		t.Errorf("ролик %+v", s)
	}

	ctx, cancel := context.WithCancel(context.Background())
	long, _ := NewStaticShot(base, []State{{base, 0}}, nil, Size{64, 36, 100000})
	err = Render(ctx, Job{Source: long, FPS: 30, Output: filepath.Join(t.TempDir(), "cancel.mp4")}, func(done, total int) {
		if done == 5 {
			cancel()
		}
	})
	if !errors.Is(err, process.ErrCanceled) && !errors.Is(err, context.Canceled) {
		t.Fatalf("отмена: %v", err)
	}
}

// meanYUV — средние Y, U, V первого кадра ролика.
func meanYUV(t *testing.T, path string) [3]float64 {
	t.Helper()
	data, err := exec.Command("ffmpeg", "-v", "error", "-i", path, "-frames:v", "1", "-vf", "format=yuv444p", "-f", "rawvideo", "-").Output()
	if err != nil {
		t.Fatal(err)
	}
	plane := len(data) / 3
	var mean [3]float64
	for channel := range mean {
		for _, value := range data[channel*plane : (channel+1)*plane] {
			mean[channel] += float64(value)
		}
		mean[channel] /= float64(plane)
	}
	return mean
}

// TestVideoRoundTrip — ролик с пометкой bt709 после декодирования и кодирования без эффекта
// сохраняет значения YUV (матрица на обоих концах одна); ролик короче нужного — ошибка Close.
func TestVideoRoundTrip(t *testing.T) {
	requireFFmpeg(t)
	directory := t.TempDir()
	source := filepath.Join(directory, "tagged.mp4")
	if output, err := exec.Command("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x20C040:size=320x180:rate=30",
		"-frames:v", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", source).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, output)
	}
	size := Size{320, 180, 4}
	video, err := OpenVideo(context.Background(), source, size)
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "out.mp4")
	renderErr := Render(context.Background(), Job{Source: video, FPS: 30, Output: output}, nil)
	if err := video.Close(); renderErr == nil {
		renderErr = err
	}
	if renderErr != nil {
		t.Fatal(renderErr)
	}
	want, got := meanYUV(t, source), meanYUV(t, output)
	for channel := range want {
		if math.Abs(want[channel]-got[channel]) > 1.5 {
			t.Fatalf("YUV до %v, после %v", want, got)
		}
	}

	short, err := OpenVideo(context.Background(), source, Size{320, 180, 10})
	if err != nil {
		t.Fatal(err)
	}
	for frame := 0; frame < 10; frame++ {
		short.Frame(frame)
	}
	if err := short.Close(); err == nil || !strings.Contains(err.Error(), "меньше кадров") {
		t.Fatalf("короткий ролик: %v", err)
	}
}
