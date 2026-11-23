package staticshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/assetpackage"
	"songframe/internal/checkassets"
	"songframe/internal/golden"
	"songframe/internal/lintregistry"
	"songframe/internal/mediacmd"
	"songframe/internal/sceneviews"
)

// project — копия общего образца проверок, где план M03 отмечен планом из опор, а его попытка
// M03-attempt-01 несёт две утверждённые опоры: базовую и состояние с 1,5 с.
func project(t *testing.T) (string, string) {
	t.Helper()
	return projectStates(t, 0, 1.5)
}

// projectStates — тот же образец с утверждёнными опорами на секундах seconds: первая — K01 на 0,
// следующие — состояния.
func projectStates(t *testing.T, seconds ...float64) (string, string) {
	t.Helper()
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(root, os.DirFS(filepath.Join(base, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	scenesPath := filepath.Join(root, "plan", "scenes.json")
	var scenes map[string]any
	readJSON(t, scenesPath, &scenes)
	for _, raw := range scenes["scenes"].([]any) {
		scene := raw.(map[string]any)
		if scene["id"] == "M03" {
			scene["static_shot"] = true
		}
	}
	writeJSON(t, scenesPath, scenes)
	directory := filepath.Join(root, "plan", "batches", "M03-attempt-01")
	workflowPath := filepath.Join(directory, "workflow.json")
	var workflow map[string]any
	readJSON(t, workflowPath, &workflow)
	frames := []any{}
	for index, seconds := range seconds {
		id := fmt.Sprintf("K%02d", index+1)
		name := "frames/" + id + ".png"
		shade := uint8(40 + 120*index)
		writePNG(t, filepath.Join(directory, filepath.FromSlash(name)), shade)
		frames = append(frames, map[string]any{
			"id": id, "role": map[bool]string{true: "first", false: "middle"}[index == 0], "time_seconds": seconds, "note": "состояние",
			"path": name, "sha256": digest(t, filepath.Join(directory, filepath.FromSlash(name))), "approved": true,
		})
	}
	workflow["keyframes"] = frames
	workflow["scene_sha256"] = nil
	writeJSON(t, workflowPath, workflow)
	return root, directory
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
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// writePNG — опора 64×36: серый фон и квадрат «лампы» яркостью shade, которая меняется между
// состояниями.
func writePNG(t *testing.T, path string, shade uint8) {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 64, 36))
	for y := 0; y < 36; y++ {
		for x := 0; x < 64; x++ {
			value := color.RGBA{90, 90, 90, 255}
			if x >= 28 && x < 36 && y >= 14 && y < 22 {
				value = color.RGBA{shade, shade, 20, 255}
			}
			picture.Set(x, y, value)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := png.Encode(file, picture); err != nil {
		t.Fatal(err)
	}
}

func digest(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// TestReadDefaults — без рецепта моменты смены берутся из времени опор, параметры — по умолчанию.
func TestReadDefaults(t *testing.T) {
	root, directory := project(t)
	view, err := Read(root, directory)
	if err != nil {
		t.Fatal(err)
	}
	if view.Shot != "M03" || view.FPS != 30 || view.Frames != 120 || view.Problem != "" || view.Saved || view.Preview != nil {
		t.Fatalf("вид: %+v", view)
	}
	if len(view.States) != 2 || view.States[0].FromFrame != 0 || view.States[1].FromFrame != 45 {
		t.Fatalf("состояния: %+v", view.States)
	}
	if view.Params["dilate"] != 14 {
		t.Fatalf("параметры: %v", view.Params)
	}
}

// TestFrameSize — своя картинка состояния другого размера объясняется до сборки.
func TestFrameSize(t *testing.T) {
	root, directory := project(t)
	path := filepath.Join(directory, "frames", "K02.png")
	picture := image.NewRGBA(image.Rect(0, 0, 32, 18))
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(file, picture); err != nil {
		t.Fatal(err)
	}
	file.Close()
	view, err := Read(root, directory)
	if err != nil {
		t.Fatal(err)
	}
	if view.Problem != textFrameSize("K02", 32, 18, "K01", 64, 36) {
		t.Fatalf("причина: %q", view.Problem)
	}
	if _, err := Build(context.Background(), root, directory, nil); err == nil || err.Error() != view.Problem {
		t.Fatalf("сборка: %v", err)
	}
}

// TestNotStatic — попытка плана без static_shot не собирается как план из опор.
func TestNotStatic(t *testing.T) {
	root, directory := project(t)
	scenesPath := filepath.Join(root, "plan", "scenes.json")
	var scenes map[string]any
	readJSON(t, scenesPath, &scenes)
	for _, raw := range scenes["scenes"].([]any) {
		delete(raw.(map[string]any), "static_shot")
	}
	writeJSON(t, scenesPath, scenes)
	if _, err := Read(root, directory); err == nil || err.Error() != textNotStatic("M03") {
		t.Fatalf("ошибка: %v", err)
	}
}

// TestRecipeChecks — рецепт сохраняет моменты смены, но отвергает чужие опоры, порядок и диапазон.
func TestRecipeChecks(t *testing.T) {
	root, directory := project(t)
	recipe := Recipe{States: []RecipeState{{Frame: "K01"}, {Frame: "K02", FromFrame: 60}}, Params: map[string]float64{"transition": 5}}
	view, err := SaveRecipe(root, directory, recipe)
	if err != nil {
		t.Fatal(err)
	}
	if !view.Saved || view.States[1].FromFrame != 60 || view.Params["transition"] != 5 {
		t.Fatalf("после сохранения: %+v", view)
	}
	for name, bad := range map[string]Recipe{
		"чужая опора": {States: []RecipeState{{Frame: "K01"}, {Frame: "K09", FromFrame: 60}}},
		"после конца": {States: []RecipeState{{Frame: "K01"}, {Frame: "K02", FromFrame: 120}}},
		"база не с 0": {States: []RecipeState{{Frame: "K01", FromFrame: 3}, {Frame: "K02", FromFrame: 60}}},
		"вне диапазона": {States: []RecipeState{{Frame: "K01"}, {Frame: "K02", FromFrame: 60}},
			Params: map[string]float64{"dilate": -5}},
	} {
		if _, err := SaveRecipe(root, directory, bad); err == nil {
			t.Errorf("%s: рецепт принят", name)
		}
	}
}

// TestBuildAndAccept — предпросмотр собирается, устаревает при правке рецепта, а свежий
// принимается в комплект static_video, который проходит проверку комплекта.
func TestBuildAndAccept(t *testing.T) {
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err != nil {
		t.Skip("нет FFmpeg")
	}
	root, directory := project(t)
	ctx := context.Background()
	if _, err := Accept(ctx, root, directory, AcceptOptions{}); err == nil || err.Error() != textPreviewMissing {
		t.Fatalf("приёмка без предпросмотра: %v", err)
	}
	view, err := Build(ctx, root, directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	if view.Preview == nil || !view.Preview.Fresh {
		t.Fatalf("предпросмотр: %+v", view.Preview)
	}
	recipe := Recipe{States: []RecipeState{{Frame: "K01"}, {Frame: "K02", FromFrame: 50}}}
	if view, err = SaveRecipe(root, directory, recipe); err != nil || view.Preview == nil || view.Preview.Fresh {
		t.Fatalf("после правки рецепта: %+v, %v", view.Preview, err)
	}
	if _, err := Accept(ctx, root, directory, AcceptOptions{}); err == nil || err.Error() != textPreviewStale {
		t.Fatalf("приёмка устаревшего: %v", err)
	}
	first, err := Build(ctx, root, directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Повторная сборка по тому же рецепту даёт тот же файл.
	second, err := Build(ctx, root, directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Preview.Version == "" || first.Preview.Version != second.Preview.Version {
		t.Fatalf("версии сборок: %q и %q", first.Preview.Version, second.Preview.Version)
	}
	result, err := Accept(ctx, root, directory, AcceptOptions{Clean: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Value("shot") != "M03" {
		t.Fatalf("итог: %v", result)
	}
	manifest := filepath.Join(root, "assets", "shots", "M03", "manifest.json")
	if _, err := assetpackage.ValidatePackage(manifest, "M03", root); err != nil {
		t.Fatal(err)
	}
	var kit map[string]any
	readJSON(t, manifest, &kit)
	generation := kit["generation"].(map[string]any)
	states := generation["static"].(map[string]any)["states"].([]any)
	if kit["kind"] != Kind || len(states) != 2 || states[1].(map[string]any)["from_frame"] != 50.0 {
		t.Fatalf("манифест: %v", kit)
	}
	lint := lintregistry.Run(root, []string{})
	if strings.Contains(string(lint.Stdout)+string(lint.Stderr), "assets/shots/M03") {
		t.Fatalf("lint комплекта: %s%s", lint.Stdout, lint.Stderr)
	}
	// Проверка «Комплекты планов» читает комплект как любой принятый: файлы, хеши, повтор монтажа.
	assets := checkassets.Run(root, []string{"M03"})
	if assets.Code != 0 {
		t.Fatalf("check_assets: %d\n%s%s", assets.Code, assets.Stdout, assets.Stderr)
	}
	// Комплект хранит сведения ролика и подготовки, README комплекта ссылается на опоры-состояния.
	if generation["original_media"] == nil || generation["preparation"] == nil {
		t.Fatalf("generation без original_media или preparation: %v", generation)
	}
	if views := sceneviews.Run(root, []string{}); views.Code != 0 {
		t.Fatalf("update_scene_views: %s", views.Stderr)
	}
	readme, err := os.ReadFile(filepath.Join(root, "assets", "shots", "M03", "README.md"))
	if err != nil || !strings.Contains(string(readme), "[Состояние 2](state-02.png)") || strings.Contains(string(readme), "Промпт") {
		t.Fatalf("README комплекта: %s, %v", readme, err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("попытка не удалена: %v", err)
	}
	if _, err := Accept(ctx, root, directory, AcceptOptions{}); err == nil {
		t.Fatal("повторная приёмка удалённой попытки прошла")
	}
}

// TestSingleState — план из опор из одной K01: неподвижный кадр с наездом сборки без смен.
// Он собирается, принимается и проходит проверки комплекта, как кадр с состояниями.
func TestSingleState(t *testing.T) {
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err != nil {
		t.Skip("нет FFmpeg")
	}
	root, directory := projectStates(t, 0)
	ctx := context.Background()
	view, err := Build(ctx, root, directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	if view.Problem != "" || len(view.States) != 1 || view.Preview == nil || !view.Preview.Fresh {
		t.Fatalf("сборка из одной опоры: %+v", view)
	}
	if _, err := Accept(ctx, root, directory, AcceptOptions{Clean: true}); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(root, "assets", "shots", "M03", "manifest.json")
	if _, err := assetpackage.ValidatePackage(manifest, "M03", root); err != nil {
		t.Fatal(err)
	}
	if assets := checkassets.Run(root, []string{"M03"}); assets.Code != 0 {
		t.Fatalf("check_assets: %d\n%s%s", assets.Code, assets.Stdout, assets.Stderr)
	}
}
