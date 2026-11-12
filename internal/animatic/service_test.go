package animatic

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"songframe/internal/jobs"
	"songframe/internal/tools"
)

// TestBuildJobSteps — задание через настоящий менеджер: шаги запускают инструменты по порядку с
// аргументами из эталона, сбой build_animatic даёт причину из stderr и код шага.
func TestBuildJobSteps(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "scenes.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	run := func(ctx context.Context, root, name string, args []string) (tools.Result, error) {
		calls = append(calls, append([]string{name}, args...))
		code := 0
		if name == "build_animatic" {
			code = 1
			return tools.Result{Code: &code, Stdout: "M01 подготовлена\n", Stderr: "Карточки устарели\n"}, nil
		}
		return tools.Result{Code: &code, Stdout: "готово\n"}, nil
	}
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	info, err := NewService(manager, run).Build(project, true)
	if err != nil {
		t.Fatal(err)
	}
	final, err := manager.Wait(context.Background(), info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := [][]string{{"update_scene_views"}, {"build_animatic", "--plan-only"}}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("вызовы %v", calls)
	}
	if final.Status != jobs.StatusFailed || final.Error == nil || *final.Error != "Карточки устарели" || final.Kind != jobs.KindAnimatic || final.Title != textCheckTitle {
		t.Fatalf("итог %+v", final)
	}
}

// TestFragmentJobSteps — задание фрагмента: вид tool, аргументы диапазона и отказ без задания
// при номере плана, похожем на опцию.
func TestFragmentJobSteps(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "scenes.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	run := func(ctx context.Context, root, name string, args []string) (tools.Result, error) {
		calls = append(calls, append([]string{name}, args...))
		code := 0
		return tools.Result{Code: &code}, nil
	}
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	service := NewService(manager, run)
	if _, err := service.Fragment(project, "--plan-only", "M02"); err == nil || err.Error() != textShotInvalid {
		t.Fatalf("ошибка %v", err)
	}
	info, err := service.Fragment(project, "M02", "M04")
	if err != nil {
		t.Fatal(err)
	}
	final, err := manager.Wait(context.Background(), info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := [][]string{{"update_scene_views"}, {"build_animatic", "--from", "M02", "--to", "M04"}}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("вызовы %v", calls)
	}
	if final.Status != jobs.StatusDone || final.Kind != jobs.KindTool || final.Title != "Фрагмент аниматика M02–M04" {
		t.Fatalf("итог %+v", final)
	}
}
