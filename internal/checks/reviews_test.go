package checks

import (
	"context"
	"encoding/json"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"songframe-go/internal/golden"
	"songframe-go/internal/jobs"
	"songframe-go/internal/tools"
)

// Эталон build-review/checks: сценарий checks.buildReview/listReviews/removeReview, снятый с
// src/main/checks.ts оригинала с подставным менеджером заданий (скрипт съёмки
// 46a-review/capture-checks-reviews.ts). Здесь менеджер настоящий: задание сборки сверяется по
// виду, названию, проекту, подписи шага и строке «$ подпись аргументы» журнала; «ещё собирается»
// воспроизводится отдельным заданием, которое ждёт команды сценария.

// reviewStep — шаг сценария: действие и исход оригинала.
type reviewStep struct {
	Op      string            `json:"op"`
	Path    string            `json:"path"`
	Text    string            `json:"text"`
	Target  string            `json:"target"`
	Seconds float64           `json:"seconds"`
	Suffix  string            `json:"suffix"`
	Job     int               `json:"job"`
	Status  string            `json:"status"`
	Options ReviewOptions     `json:"options"`
	Result  json.RawMessage   `json:"result"`
	Error   *string           `json:"error"`
	Tree    map[string]string `json:"tree"`
	Started *struct {
		Kind    string `json:"kind"`
		Title   string `json:"title"`
		Project string `json:"project"`
		Steps   []struct {
			Tool  string   `json:"tool"`
			Args  []string `json:"args"`
			Label string   `json:"label"`
		} `json:"steps"`
	} `json:"started"`
}

var reviewStamp = regexp.MustCompile(`-\d{8}-\d{6}`)

func TestReviewsGolden(t *testing.T) {
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "build-review", "checks", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var domain struct {
		Steps []reviewStep `json:"steps"`
	}
	if err := json.Unmarshal(data, &domain); err != nil {
		t.Fatal(err)
	}
	saved := tools.LocalDir
	state := t.TempDir()
	tools.LocalDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { tools.LocalDir = saved })
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(work, "project")
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	service := New(manager)
	mark := func(text string) string {
		return reviewStamp.ReplaceAllString(strings.ReplaceAll(text, project, "<project>"), "-<stamp>")
	}
	wait := func(id string) jobs.Info {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		info, err := manager.Wait(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return info
	}
	checkError := func(index int, step reviewStep, err error) {
		t.Helper()
		switch {
		case step.Error == nil && err != nil:
			t.Fatalf("шаг %d %s: ошибка %v", index, step.Op, err)
		case step.Error != nil && (err == nil || mark(err.Error()) != *step.Error):
			t.Fatalf("шаг %d %s: ошибка %v, ожидалась %q", index, step.Op, err, *step.Error)
		}
	}
	// Задания сборки по порядку и их состояние в сценарии оригинала (running до op status).
	outputs := []string{}
	running := map[int]chan struct{}{}
	for index, step := range domain.Steps {
		target := filepath.Join(project, filepath.FromSlash(step.Path))
		switch step.Op {
		case "list":
			list, err := ListReviews(project)
			checkError(index, step, err)
			encoded, _ := json.Marshal(list)
			var got, want any
			_ = json.Unmarshal([]byte(mark(string(encoded))), &got)
			_ = json.Unmarshal(step.Result, &want)
			// NaN оригинала (Number нечислового total_frames) Wails не передаёт: в Go это 0.
			for _, item := range want.([]any) {
				if entry := item.(map[string]any); entry["totalFrames"] == nil {
					entry["totalFrames"] = 0.0
				}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("шаг %d list:\n%v\nожидалось\n%v", index, got, want)
			}
		case "write":
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte(step.Text), 0o644); err != nil {
				t.Fatal(err)
			}
		case "symlink":
			if err := os.Symlink(step.Target, target); err != nil {
				t.Fatal(err)
			}
		case "mtime":
			if _, err := os.Lstat(target); err != nil {
				if err := os.WriteFile(target, []byte("video"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			whole, fraction := math.Modf(step.Seconds)
			moment := time.Unix(int64(whole), int64(fraction*1e9))
			if err := os.Chtimes(target, moment, moment); err != nil {
				t.Fatal(err)
			}
		case "build":
			info, err := service.BuildReview(project, step.Options)
			checkError(index, step, err)
			if step.Started == nil {
				break
			}
			if err != nil {
				t.Fatalf("шаг %d: задание не запущено", index)
			}
			done := wait(info.ID)
			want := step.Started
			command := "$ " + want.Steps[0].Label + " " + strings.Join(want.Steps[0].Args, " ")
			if string(done.Kind) != want.Kind || done.Title != want.Title || done.Project == nil || mark(*done.Project) != want.Project ||
				len(done.Steps) != 1 || done.Steps[0].Tool != want.Steps[0].Tool || done.Steps[0].Label != want.Steps[0].Label ||
				!strings.Contains(mark(manager.ReadLog(info.ID, 1<<20)), command) {
				t.Fatalf("шаг %d: задание %+v, журнал %q; ожидалось %+v, %q", index, done, manager.ReadLog(info.ID, 1<<20), want, command)
			}
			args := want.Steps[0].Args
			output := mark(args[slicesIndex(args, "--output")+1])
			// Настоящая метка папки — из журнала Go-задания.
			for _, line := range strings.Split(manager.ReadLog(info.ID, 1<<20), "\n") {
				if fields := strings.Fields(line); len(fields) > 0 && fields[0] == "$" {
					outputs = append(outputs, fields[slicesIndex(fields, "--output")+1])
				}
			}
			if mark(outputs[len(outputs)-1]) != output {
				t.Fatalf("шаг %d: выход %s, ожидался %s", index, outputs[len(outputs)-1], output)
			}
			// Сценарий оригинала считает задание выполняющимся до op status: подставляется
			// задание, которое ждёт этой команды.
			release := make(chan struct{})
			blocker, err := manager.Start(jobs.Spec{Kind: jobs.KindReview, Title: "ожидание", Project: project, Steps: []jobs.Step{{
				Tool: "wait", Run: func(ctx context.Context, _ *jobs.StepContext) error {
					select {
					case <-release:
					case <-ctx.Done():
					}
					return nil
				},
			}}})
			if err != nil {
				t.Fatal(err)
			}
			job := len(outputs) - 1
			running[job] = release
			service.reviews.mu.Lock()
			service.reviews.jobs[outputs[job]] = blocker.ID
			service.reviews.mu.Unlock()
			t.Cleanup(func() {
				if channel := running[job]; channel != nil {
					close(channel)
					running[job] = nil
				}
				wait(blocker.ID)
			})
		case "remove":
			checkError(index, step, service.RemoveReview(project, strings.ReplaceAll(step.Path, "<project>", project)))
		case "writeOutput":
			path := strings.TrimSuffix(outputs[step.Job], ".mp4")
			if step.Suffix == "" {
				path += ".mp4"
			} else {
				path += step.Suffix
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(step.Text), 0o644); err != nil {
				t.Fatal(err)
			}
			moment := time.Unix(1_800_000_200, 0)
			if err := os.Chtimes(path, moment, moment); err != nil {
				t.Fatal(err)
			}
		case "removeOutput":
			checkError(index, step, service.RemoveReview(project, outputs[step.Job]))
		case "status":
			if channel := running[step.Job]; channel != nil {
				close(channel)
				running[step.Job] = nil
				service.reviews.mu.Lock()
				id := service.reviews.jobs[outputs[step.Job]]
				service.reviews.mu.Unlock()
				wait(id)
			}
		default:
			t.Fatalf("шаг %d: неизвестная операция %s", index, step.Op)
		}
		if step.Tree != nil {
			if got := reviewsTree(t, filepath.Join(project, "plan", "batches"), mark); !reflect.DeepEqual(got, step.Tree) {
				t.Fatalf("шаг %d %s: дерево\n%v\nожидалось\n%v", index, step.Op, got, step.Tree)
			}
		}
	}
}

// slicesIndex — позиция значения в списке (-1 — нет).
func slicesIndex(list []string, value string) int {
	for index, item := range list {
		if item == value {
			return index
		}
	}
	return -1
}

// reviewsTree — tree() скрипта съёмки: ссылки — "symlink", каталоги — "dir", файлы — текст.
func reviewsTree(t *testing.T, folder string, mark func(string) string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(folder, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == folder {
			return err
		}
		relative, _ := filepath.Rel(folder, path)
		name := mark(filepath.ToSlash(relative))
		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			result[name] = "symlink"
		case entry.IsDir():
			result[name] = "dir"
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			result[name] = string(data)
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return result
}
