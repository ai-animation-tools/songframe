package shoteffects

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/filedigest"
	"songframe/internal/golden"
	"songframe/internal/mediacmd"
)

// project — копия общего образца проверок. У плана M01 есть принятый комплект; plan/scenes.json
// получает точку съёмки M01 с камерой, смотрящей на север (heading 90°), так что ветер на восток
// сдвигает капли вправо.
func project(t *testing.T) string {
	t.Helper()
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(root, os.DirFS(filepath.Join(base, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	setViewpoint(t, root, map[string]any{
		"location": "street", "side": "front", "size": "wide",
		"camera": map[string]any{"start": []float64{0, 0}}, "heading": map[string]any{"start": 90},
	})
	return root
}

// setViewpoint меняет точку съёмки M01; nil — убирает её.
func setViewpoint(t *testing.T, root string, viewpoint map[string]any) {
	t.Helper()
	path := filepath.Join(root, "plan", "scenes.json")
	var scenes map[string]any
	readJSON(t, path, &scenes)
	for _, raw := range scenes["scenes"].([]any) {
		scene := raw.(map[string]any)
		if scene["id"] == "M01" {
			if viewpoint == nil {
				delete(scene, "viewpoint")
			} else {
				scene["viewpoint"] = viewpoint
			}
		}
	}
	writeJSON(t, path, scenes)
}

// shortKit заменяет принятое видео M01 коротким роликом 1920×1080 из шести кадров, чтобы рендер
// в тесте шёл быстро; манифест комплекта получает его SHA-256 и длину.
func shortKit(t *testing.T, root string) {
	t.Helper()
	directory := filepath.Join(root, "assets", "shots", "M01")
	video := filepath.Join(directory, "video.mp4")
	command := exec.Command(mediacmd.FFmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
		"-i", "testsrc2=size=1920x1080:rate=30", "-frames:v", "6", "-pix_fmt", "yuv420p", video)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, output)
	}
	digest, ok := filedigest.File(video)
	if !ok {
		t.Fatal("нет видео")
	}
	path := filepath.Join(directory, "manifest.json")
	var manifest map[string]any
	readJSON(t, path, &manifest)
	edit := manifest["accepted_edit"].(map[string]any)
	edit["frames"] = 6
	edit["video"].(map[string]any)["sha256"] = digest
	writeJSON(t, path, manifest)
}

func readJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, value); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestApply — наклон дождя из ветра и камеры, свой наклон важнее ветра, ошибки рецепта.
func TestApply(t *testing.T) {
	root := project(t)
	wind := &Wind{Direction: 0, Strength: 0.5}
	steps, err := Apply(root, "M01", []Step{{Effect: "rain", Given: map[string]float64{"density": 1200}, Wind: wind}, {Effect: "grain"}})
	if err != nil {
		t.Fatal(err)
	}
	// Камера смотрит на север, ветер дует на восток — вправо по экрану: atan(0,5) ≈ 26,6°.
	if got := steps[0].Params["angle"]; got != 26.6 {
		t.Fatalf("наклон из ветра: %v", got)
	}
	if steps[0].Params["density"] != 1200 || steps[0].Version != 1 || steps[1].Params["amount"] != 0.025 {
		t.Fatalf("параметры: %+v", steps)
	}
	// Тот же ветер при камере на юг сдвигает капли влево.
	setViewpoint(t, root, map[string]any{
		"location": "street", "side": "front", "size": "wide",
		"camera": map[string]any{"start": []float64{0, 0}}, "heading": map[string]any{"start": 270},
	})
	if steps, err = Apply(root, "M01", []Step{{Effect: "rain", Wind: wind}}); err != nil || steps[0].Params["angle"] != -26.6 {
		t.Fatalf("камера на юг: %+v, %v", steps, err)
	}
	own, err := Apply(root, "M01", []Step{{Effect: "rain", Given: map[string]float64{"angle": -5}, Wind: wind}})
	if err != nil || own[0].Params["angle"] != -5 {
		t.Fatalf("свой наклон: %+v, %v", own, err)
	}
	setViewpoint(t, root, nil)
	if _, err := Apply(root, "M01", []Step{{Effect: "rain", Wind: wind}}); err == nil || err.Error() != textNoViewpoint {
		t.Fatalf("ветер без точки съёмки: %v", err)
	}
	if steps, err := Apply(root, "M01", []Step{{Effect: "rain"}}); err != nil || steps[0].Params["angle"] != 0 {
		t.Fatalf("без ветра дождь вертикален: %+v, %v", steps, err)
	}
	failures := map[string][]Step{
		"нет эффектов":        nil,
		"неизвестный эффект":  {{Effect: "snow"}},
		"ветер у зерна":       {{Effect: "grain", Wind: wind}},
		"ветер вне диапазона": {{Effect: "rain", Wind: &Wind{Direction: 400}}},
		"параметр вне схемы":  {{Effect: "rain", Given: map[string]float64{"density": -1}}},
	}
	for name, steps := range failures {
		if _, err := Apply(root, "M01", steps); err == nil {
			t.Errorf("%s: ошибки нет", name)
		}
	}
}

// TestMontageVideoWithoutEffect — без эффекта монтаж берёт принятое видео комплекта.
func TestMontageVideoWithoutEffect(t *testing.T) {
	root := project(t)
	video, err := MontageVideo(root, "M01")
	if err != nil || video.Effect || video.Path != "assets/shots/M01/video.mp4" {
		t.Fatalf("%+v, %v", video, err)
	}
	if _, err := MontageVideo(root, "M03"); err == nil || err.Error() != textNoKit("M03") {
		t.Fatalf("план без комплекта: %v", err)
	}
	if _, err := MontageVideo(root, "../M01"); err == nil {
		t.Fatal("путь вместо идентификатора")
	}
}

// TestRender — рендер не меняет комплект, ролик с эффектом идёт в монтаж, пока свеж: смена точки
// съёмки, порча ролика и смена принятого видео делают эффект устаревшим; Remove возвращает чистое.
func TestRender(t *testing.T) {
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err != nil {
		t.Skip("нет FFmpeg")
	}
	root := project(t)
	shortKit(t, root)
	kitFiles := map[string]string{}
	kit := filepath.Join(root, "assets", "shots", "M01")
	entries, _ := os.ReadDir(kit)
	for _, entry := range entries {
		kitFiles[entry.Name()], _ = filedigest.File(filepath.Join(kit, entry.Name()))
	}
	ctx := context.Background()
	steps := []Step{{Effect: "light"}, {Effect: "rain", Wind: &Wind{Direction: 0, Strength: 0.5}}, {Effect: "grain"}}
	var lines []string
	state, err := Render(ctx, root, "M01", steps, func(line string) { lines = append(lines, line) })
	if err != nil {
		t.Fatal(err)
	}
	if !state.Applied || state.Stale != "" || len(state.Steps) != 3 || len(lines) == 0 {
		t.Fatalf("состояние: %+v, %v", state, lines)
	}
	for name, digest := range kitFiles {
		if current, _ := filedigest.File(filepath.Join(kit, name)); current != digest {
			t.Errorf("комплект изменён: %s", name)
		}
	}
	video, err := MontageVideo(root, "M01")
	if err != nil || !video.Effect || !strings.HasPrefix(video.Path, "assets/effects/M01/video-") || video.SHA256 != state.Version {
		t.Fatalf("видео для монтажа: %+v, %v", video, err)
	}
	if digest, _ := filedigest.File(video.Absolute); digest != video.SHA256 || video.Absolute != state.Output {
		t.Fatal("ролик с эффектом не совпадает с рецептом")
	}
	var recipe Recipe
	readJSON(t, filepath.Join(root, "assets", "effects", "M01", "recipe.json"), &recipe)
	if recipe.Steps[1].Params["angle"] != 26.6 || recipe.Steps[1].Wind == nil || recipe.Frames != 6 || recipe.FPS != 30 || recipe.FFmpeg == "" {
		t.Fatalf("рецепт: %+v", recipe)
	}

	// Повторный рендер того же рецепта даёт тот же ролик и не оставляет прежних файлов.
	again, err := Render(ctx, root, "M01", steps, nil)
	if err != nil || again.Output != state.Output {
		t.Fatalf("повтор: %+v, %v", again, err)
	}

	// Камера развернулась — наклон из ветра другой: эффект устарел, монтаж берёт чистое видео.
	setViewpoint(t, root, map[string]any{
		"location": "street", "side": "front", "size": "wide",
		"camera": map[string]any{"start": []float64{0, 0}}, "heading": map[string]any{"start": 270},
	})
	if state, _ := Read(root, "M01"); state.Stale != textParamsChanged {
		t.Fatalf("после разворота камеры: %q", state.Stale)
	}
	if video, _ := MontageVideo(root, "M01"); video.Effect {
		t.Fatal("устаревший эффект попал в монтаж")
	}
	setViewpoint(t, root, map[string]any{
		"location": "street", "side": "front", "size": "wide",
		"camera": map[string]any{"start": []float64{0, 0}}, "heading": map[string]any{"start": 90},
	})
	if state, _ := Read(root, "M01"); state.Stale != "" {
		t.Fatalf("точка съёмки возвращена: %q", state.Stale)
	}

	// Испорченный ролик с эффектом.
	if err := os.WriteFile(state.Output, []byte("испорчено"), 0o644); err != nil {
		t.Fatal(err)
	}
	if state, _ := Read(root, "M01"); state.Stale != textOutputChanged {
		t.Fatalf("испорченный ролик: %q", state.Stale)
	}

	// Новое принятое видео плана.
	if _, err := Render(ctx, root, "M01", steps, nil); err != nil {
		t.Fatal(err)
	}
	shortKitChanged(t, root)
	if state, _ := Read(root, "M01"); state.Stale != textSourceChanged {
		t.Fatalf("новое принятое видео: %q", state.Stale)
	}

	if err := Remove(root, "M01"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "assets", "effects", "M01")); !os.IsNotExist(err) {
		t.Fatalf("папка эффектов осталась: %v", err)
	}
	if state, _ := Read(root, "M01"); state.Applied {
		t.Fatal("эффект не убран")
	}
}

// shortKitChanged записывает в комплект M01 другой SHA-256 видео, как после повторной приёмки.
func shortKitChanged(t *testing.T, root string) {
	t.Helper()
	path := filepath.Join(root, "assets", "shots", "M01", "manifest.json")
	var manifest map[string]any
	readJSON(t, path, &manifest)
	manifest["accepted_edit"].(map[string]any)["video"].(map[string]any)["sha256"] = strings.Repeat("0", 64)
	writeJSON(t, path, manifest)
}

// TestListAndPreview — список принятых планов по порядку сценария с направлением камеры; превью
// кадра с эффектом отличается от кадра без эффекта и не пишет файлов.
func TestListAndPreview(t *testing.T) {
	root := project(t)
	shots, err := List(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(shots) != 2 || shots[0].Shot != "M01" || shots[1].Shot != "M02" || !shots[0].Camera || shots[0].Heading != 90 || shots[1].Camera {
		t.Fatalf("список: %+v", shots)
	}
	if shots[0].Title == "" || shots[0].End <= shots[0].Start || shots[0].Applied {
		t.Fatalf("план: %+v", shots[0])
	}
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err != nil {
		t.Skip("нет FFmpeg")
	}
	shortKit(t, root)
	before := snapshot(t, root)
	clean, err := Preview(context.Background(), root, "M01", nil, 3, 480)
	if err != nil {
		t.Fatal(err)
	}
	rain, err := Preview(context.Background(), root, "M01", []Step{{Effect: "rain", Given: map[string]float64{"density": 3000}}}, 3, 480)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(clean, "data:image/jpeg;base64,") || clean == rain {
		t.Fatal("превью без эффекта и с дождём совпадают")
	}
	if _, err := Preview(context.Background(), root, "M01", nil, 6, 480); err == nil {
		t.Fatal("кадр за концом плана")
	}
	if after := snapshot(t, root); after != before {
		t.Fatal("превью записало файлы")
	}
}

// snapshot — пути и размеры всех файлов проекта.
func snapshot(t *testing.T, root string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		lines = append(lines, path+" "+info.ModTime().String())
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(lines, "\n")
}
