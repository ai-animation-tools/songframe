package production_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe/internal/golden"
	"songframe/internal/jobs"
	"songframe/internal/production"
	"songframe/internal/tools"
)

// bundleStep — шаг домена export-bundle-job: подготовка, вызов exportBundle или removeBundle,
// ожидаемый исход и наличие путей после него. Пути содержат <tmp>.
type bundleStep struct {
	Label string `json:"label"`
	Setup struct {
		Write          map[string]string `json:"write"`
		Mkdir          []string          `json:"mkdir"`
		RemoveFile     []string          `json:"removeFile"`
		RestoreBatches bool              `json:"restoreBatches"`
		Bundle         string            `json:"bundle"`
		Link           map[string]string `json:"link"`
	} `json:"setup"`
	Status []string `json:"status"`
	Export *struct {
		Target string `json:"target"`
		Copy   bool   `json:"copy"`
	} `json:"export"`
	Remove  *string `json:"remove"`
	Error   *string `json:"error"`
	Removed bool    `json:"removed"`
	Job     *struct {
		Kind  string `json:"kind"`
		Title string `json:"title"`
		Steps []struct {
			Tool     string   `json:"tool"`
			Args     []string `json:"args"`
			Label    string   `json:"label"`
			Required *bool    `json:"required"`
		} `json:"steps"`
	} `json:"job"`
	Exists map[string]bool `json:"exists"`
	// RejectedBeforeRun — пояснение шага, который отклоняет проверка цели до запуска: Job шага
	// не применяется, проверяются текст отказа и то, что папки из Exists не созданы.
	RejectedBeforeRun string `json:"rejectedBeforeRun"`
}

// gatedRuns — подмена запуска инструментов: export_edit_bundle ждёт разрешения своей цели (задание
// остаётся running), код задаётся сценарием; записывает аргументы запусков.
type gatedRuns struct {
	mu    sync.Mutex
	gates map[string]chan int
	calls map[string][]string
	// changed закрывается и заменяется при каждой записи в calls: так args ждёт событие запуска,
	// а не опрашивает по времени (под нагрузкой фиксированный опрос не успевал).
	changed chan struct{}
}

func newGatedRuns() *gatedRuns {
	return &gatedRuns{gates: map[string]chan int{}, calls: map[string][]string{}, changed: make(chan struct{})}
}

// record запоминает аргументы вызова и будит ожидающих args. Вызывается под g.mu.
func (g *gatedRuns) record(key string, args []string) {
	g.calls[key] = args
	close(g.changed)
	g.changed = make(chan struct{})
}

func (g *gatedRuns) gate(target string) chan int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.gates[target] == nil {
		g.gates[target] = make(chan int, 1)
	}
	return g.gates[target]
}

func (g *gatedRuns) run(ctx context.Context, project, name string, args []string) (tools.Result, error) {
	if name != "export_edit_bundle" {
		g.mu.Lock()
		g.record(name, args)
		g.mu.Unlock()
		code := 0
		return tools.Result{Code: &code}, nil
	}
	g.mu.Lock()
	g.record(args[1], args)
	g.mu.Unlock()
	select {
	case code := <-g.gate(args[1]):
		return tools.Result{Code: &code}, nil
	case <-ctx.Done():
		return tools.Result{}, ctx.Err()
	}
}

// args — аргументы запуска инструмента для цели, дождавшись начала шага.
func (g *gatedRuns) args(t *testing.T, target string) []string {
	t.Helper()
	// Запуск инструмента — событие задания в другой горутине. Ждём его без опроса; верхняя граница
	// нужна только чтобы не зависнуть, если шаг так и не начался.
	guard := time.After(time.Minute)
	if deadline, ok := t.Deadline(); ok {
		guard = time.After(time.Until(deadline) - time.Second)
	}
	for {
		g.mu.Lock()
		found, ok := g.calls[target]
		changed := g.changed
		g.mu.Unlock()
		if ok {
			return found
		}
		select {
		case <-changed:
		case <-guard:
			t.Fatalf("инструмент не запущен для %s", target)
			return nil
		}
	}
}

// TestExportBundleGolden — ExportBundle и RemoveBundle: отказы, вид и шаги задания, создание
// папки, занятость пакета до конца задания и проверки удаления. Шаг batches-prefix: соседняя с
// plan/batches папка отклоняется сервисом до запуска инструмента.
func TestExportBundleGolden(t *testing.T) {
	var document struct {
		Steps []bundleStep `json:"steps"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "export-bundle-job", "steps.json"), &document); err != nil {
		t.Fatal(err)
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(base, "w")
	project := filepath.Join(tmp, "project")
	sample := filepath.Join("..", "..", "testdata", "golden", "checks-base", "project")
	copyTree(t, sample, project)
	fill := func(text string) string { return strings.ReplaceAll(text, "<tmp>", tmp) }
	norm := func(text string) string { return strings.ReplaceAll(text, tmp, "<tmp>") }
	manager := jobs.New(filepath.Join(base, "jobs-state"), jobs.Options{SkipRestore: true})
	t.Cleanup(func() { _ = manager.Shutdown(context.Background(), "конец теста") })
	runs := newGatedRuns()
	service := production.New(production.Options{Jobs: manager, Run: runs.run})
	started := map[string]string{}

	for _, step := range document.Steps {
		for path, text := range step.Setup.Write {
			path = fill(path)
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		for _, path := range step.Setup.Mkdir {
			if err := os.MkdirAll(fill(path), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		for _, path := range step.Setup.RemoveFile {
			path = fill(path)
			if !filepath.IsAbs(path) {
				path = filepath.Join(project, path)
			}
			if err := os.RemoveAll(path); err != nil {
				t.Fatal(err)
			}
		}
		if step.Setup.RestoreBatches {
			copyTree(t, filepath.Join(sample, "plan", "batches"), filepath.Join(project, "plan", "batches"))
		}
		if step.Setup.Bundle != "" {
			result, err := tools.Run(project, "export_edit_bundle", []string{"--out", fill(step.Setup.Bundle)})
			if err != nil || result.Code == nil || *result.Code != 0 {
				t.Fatalf("%s: сборка %v %+v", step.Label, err, result)
			}
		}
		for path, target := range step.Setup.Link {
			if err := os.Symlink(fill(target), fill(path)); err != nil {
				t.Fatal(err)
			}
		}
		if len(step.Status) == 2 {
			target := fill(step.Status[0])
			code := 0
			if step.Status[1] == "failed" {
				code = 1
			}
			runs.args(t, target)
			runs.gate(target) <- code
			if _, err := manager.Wait(context.Background(), started[target]); err != nil {
				t.Fatal(err)
			}
		}

		var failure error
		var info jobs.Info
		if step.Export != nil {
			info, failure = service.ExportBundle(project, fill(step.Export.Target), step.Export.Copy)
		} else {
			failure = service.RemoveBundle(project, fill(*step.Remove))
		}
		if step.RejectedBeforeRun != "" {
			want := "Внутри проекта пакет можно собирать только в plan/batches; иначе выберите папку вне проекта."
			if failure == nil || failure.Error() != want {
				t.Errorf("%s: %v", step.Label, failure)
			}
			for path := range step.Exists {
				if _, err := os.Stat(fill(path)); !os.IsNotExist(err) {
					t.Errorf("%s: папка создана: %v", step.Label, err)
				}
			}
			continue
		}
		switch {
		case step.Error != nil:
			if failure == nil || norm(failure.Error()) != *step.Error {
				t.Errorf("%s: ошибка %v, ожидалась %q", step.Label, failure, *step.Error)
			}
		case failure != nil:
			t.Errorf("%s: %v", step.Label, failure)
		case step.Job != nil:
			if string(info.Kind) != step.Job.Kind || info.Title != step.Job.Title || len(info.Steps) != len(step.Job.Steps) {
				t.Errorf("%s: задание %+v", step.Label, info)
				break
			}
			for index, expected := range step.Job.Steps {
				if info.Steps[index].Tool != expected.Tool || info.Steps[index].Label != expected.Label {
					t.Errorf("%s: шаг %d %+v", step.Label, index, info.Steps[index])
				}
			}
			last := step.Job.Steps[len(step.Job.Steps)-1]
			target := fill(last.Args[1])
			started[target] = info.ID
			got := runs.args(t, target)
			if strings.Join(got, "\x00") != fill(strings.Join(last.Args, "\x00")) {
				t.Errorf("%s: аргументы %q", step.Label, got)
			}
		}
		for path, want := range step.Exists {
			if _, err := os.Stat(fill(path)); (err == nil) != want {
				t.Errorf("%s: %s существует=%v, ожидалось %v", step.Label, path, err == nil, want)
			}
		}
	}
}

// TestExportBundleJob — настоящее задание с копированием: сбой необязательного шага представлений
// не отменяет сборку, сводка попадает в журнал, пакет виден в списке и удаляется после завершения.
func TestExportBundleJob(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "Проект клипа")
	copyTree(t, filepath.Join("..", "..", "testdata", "golden", "checks-base", "project"), project)
	for _, shot := range []string{"M01", "M02"} {
		if err := os.WriteFile(filepath.Join(project, "plan", "animatic", "cards", shot+".png"), []byte("карточка"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manager := jobs.New(filepath.Join(root, "jobs-state"), jobs.Options{SkipRestore: true})
	t.Cleanup(func() { _ = manager.Shutdown(context.Background(), "конец теста") })
	service := production.New(production.Options{Jobs: manager, Run: func(ctx context.Context, project, name string, args []string) (tools.Result, error) {
		if name == "update_scene_views" {
			code := 1
			return tools.Result{Code: &code, Stderr: "сбой представлений\n"}, nil
		}
		return tools.RunContext(ctx, project, name, args)
	}})
	target := filepath.Join(project, "plan", "batches", "edit-bundle-1")
	info, err := service.ExportBundle(project, target, true)
	if err != nil {
		t.Fatal(err)
	}
	finished, err := manager.Wait(context.Background(), info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != jobs.StatusDone {
		t.Fatalf("задание %+v", finished)
	}
	if text := manager.ReadLog(info.ID, 1<<20); !strings.Contains(text, `"copied_files":`) || !strings.Contains(text, `"target": `) {
		t.Fatalf("журнал без сводки:\n%s", text)
	}
	bundles, err := production.ListBundles(project)
	if err != nil {
		t.Fatal(err)
	}
	if len(bundles) != 1 || bundles[0].Dir != target || !bundles[0].Copied || bundles[0].Shots != 5 || bundles[0].Videos != 2 {
		t.Fatalf("список %+v", bundles)
	}
	if err := service.RemoveBundle(project, target); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("пакет не удалён: %v", err)
	}
}
