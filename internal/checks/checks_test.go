package checks_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"songframe-go/internal/checks"
	"songframe-go/internal/golden"
	"songframe-go/internal/jobs"
	"songframe-go/internal/pycompat"
)

// sample — вход и ожидаемый вывод снятого с оригинала случая домена проверок.
func sample(t *testing.T, domain, name string) (golden.Case, string, string) {
	t.Helper()
	for _, c := range golden.Load(t, domain) {
		if c.Name == name {
			expected := c.PyRead(t, "expected.json")
			return c, golden.PyString(t, expected, "stdout"), golden.PyString(t, expected, "stderr")
		}
	}
	t.Fatalf("нет случая %s/%s", domain, name)
	return golden.Case{}, "", ""
}

// waiter — ожидание завершения задания, запущенного вызовом сервиса (info, err).
func waiter(t *testing.T, manager *jobs.Manager) func(jobs.Info, error) jobs.Info {
	return func(info jobs.Info, err error) jobs.Info {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		done, err := manager.Wait(ctx, info.ID)
		if err != nil {
			t.Fatal(err)
		}
		return done
	}
}

// TestListMatchesOriginal — CHECKS оригинала: порядок, инструменты и тексты.
func TestListMatchesOriginal(t *testing.T) {
	list := checks.List()
	want := []struct{ id, label, tool string }{
		{"lint", "Данные сцен", "lint_registry"},
		{"views", "Карточки и списки", "update_scene_views"},
		{"assets", "Комплекты сцен", "check_assets"},
		{"workspace", "Порядок в папке проекта", "check_workspace"},
		{"status", "Статусы планов", "shot_status"},
	}
	if len(list) != len(want) {
		t.Fatalf("проверок %d", len(list))
	}
	for index, item := range want {
		got := list[index]
		if string(got.ID) != item.id || got.Label != item.label || got.Tool != item.tool || !got.NeedsScenes || got.Description == "" {
			t.Errorf("%d: %+v", index, got)
		}
	}
	if checks.Migrated(checks.Views) || !checks.Migrated(checks.Lint) || !checks.Migrated(checks.Status) {
		t.Error("перенесены lint, assets, workspace и status; views — нет")
	}
}

// TestRunAllJournal — «Все проверки» на образце: перенесённые шаги по порядку, журнал
// «$ подпись аргументы» + вывод инструмента, как в оригинале; strict делает lint неудачным, но
// остальные шаги выполняются, а причина задания — вывод первого неудачного шага.
func TestRunAllJournal(t *testing.T) {
	lintCase, lint, _ := sample(t, "lint-registry", "sample")
	_, assets, _ := sample(t, "check-assets", "sample")
	_, workspace, _ := sample(t, "check-workspace", "sample")
	_, status, _ := sample(t, "shot-status", "sample")
	_, next, _ := sample(t, "shot-status", "next")
	project := lintCase.BuildProject(t)
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	service := checks.New(manager)

	finish := waiter(t, manager)
	done := finish(service.RunAll(project, checks.Options{}))
	wantLog := "\n$ Данные сцен \n" + lint + "\n$ Комплекты сцен \n" + assets + "\n$ Порядок в папке проекта \n" + workspace + "\n$ Статусы планов \n" + status
	if done.Status != jobs.StatusDone || done.Title != "Все проверки" || done.Kind != jobs.KindCheck || done.Log != wantLog {
		t.Fatalf("задание %+v\n--- журнал\n%s", done, done.Log)
	}
	if len(done.Steps) != 4 || done.Steps[0].Tool != "lint_registry" || done.Steps[3].Label != "Статусы планов" {
		t.Fatalf("шаги %+v", done.Steps)
	}

	done = finish(service.RunAll(project, checks.Options{Strict: true, Next: true}))
	if done.Status != jobs.StatusFailed || done.Code == nil || *done.Code != 1 || done.Error == nil || *done.Error != strings.TrimSpace(lint) {
		t.Fatalf("strict: %+v", done)
	}
	if !strings.HasPrefix(done.Log, "\n$ Данные сцен --strict\n"+lint+"\nШаг «Данные сцен» завершился с кодом 1.\n") ||
		!strings.HasSuffix(done.Log, "\n$ Статусы планов --next\n"+next) {
		t.Fatalf("журнал strict:\n%s", done.Log)
	}
}

// TestRunFailure — одна проверка с отказом: задание «Проверка: …» остановлено, причина — stderr.
func TestRunFailure(t *testing.T) {
	c, _, stderr := sample(t, "shot-status", "no-scenes")
	project := c.BuildProject(t)
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	done := waiter(t, manager)(checks.New(manager).Run(project, checks.Status, checks.Options{}))
	stderr = strings.ReplaceAll(stderr, golden.ProjectMarker, project)
	if done.Title != "Проверка: Статусы планов" || done.Status != jobs.StatusFailed || done.Error == nil || *done.Error != strings.TrimSpace(stderr) {
		t.Fatalf("задание %+v", done)
	}
	if want := "\n$ Статусы планов \n" + stderr + "\nШаг «Статусы планов» завершился с кодом 1; задание остановлено.\n"; done.Log != want {
		t.Fatalf("журнал:\n%q\n%q", done.Log, want)
	}
	if code := pycompat.NewInt(int64(*done.Code)).String(); code != "1" {
		t.Fatalf("код %s", code)
	}
}

// TestRunRejects — неизвестная и ещё не перенесённая проверки отклоняются без задания.
func TestRunRejects(t *testing.T) {
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	service := checks.New(manager)
	if _, err := service.Run(t.TempDir(), "bogus", checks.Options{}); err == nil || err.Error() != "Неизвестная проверка: bogus" {
		t.Errorf("неизвестная: %v", err)
	}
	if _, err := service.Run(t.TempDir(), checks.Views, checks.Options{}); err == nil || err.Error() != "Проверка «Карточки и списки» ещё не перенесена в Go-версию SongFrame." {
		t.Errorf("views: %v", err)
	}
	if len(manager.List()) != 0 {
		t.Error("отказ не должен создавать задание")
	}
}
