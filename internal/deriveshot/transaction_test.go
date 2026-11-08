package deriveshot

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/assetpackage"
	"songframe-go/internal/pycompat"
)

// Тесты сбоев: точки подмены выбирают момент отказа, эталоны
// CLI не могут его воспроизвести. Рецепт still кодируется быстрее других режимов.

// fixture — проект с коротким окном M05 и рецептом still, сборка которого уже выполнена.
type fixture struct {
	project string
	token   string
	work    string
}

// newFixture — копия образца с короткой M05 и собранной пробой.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	file, same := loadGolden(t)
	if !same {
		t.Skip("версия FFmpeg отличается от съёмки")
	}
	project := filepath.Join(t.TempDir(), "project")
	copyDir(t, baseProject(t, file.Base), project)
	item := findCase(t, file, "build-still")
	applyOps(t, project, "", item.Setup)
	applyOps(t, project, "", item.Steps[0].Setup)
	output := Run(context.Background(), project, item.Steps[0].Args)
	if output.Code != 0 {
		t.Fatalf("сборка: %s %s", output.Stdout, output.Stderr)
	}
	var result struct {
		Token string `json:"result_token"`
		Work  string `json:"work_dir"`
	}
	if err := json.Unmarshal([]byte(output.Stdout), &result); err != nil {
		t.Fatal(err)
	}
	return &fixture{project: project, token: result.Token, work: result.Work}
}

// findCase — случай эталона по имени.
func findCase(t *testing.T, file goldenFile, name string) goldenCase {
	t.Helper()
	for _, item := range file.Cases {
		if item.Name == name {
			return item
		}
	}
	t.Fatalf("нет случая %s", name)
	return goldenCase{}
}

// accept запускает приёмку; args — дополнительные флаги.
func (f *fixture) accept(ctx context.Context, args ...string) (code int, message string) {
	output := Run(ctx, f.project, append([]string{"accept", "--work-dir", f.work, "--confirm", f.token, "--json"}, args...))
	var result struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal([]byte(output.Stdout), &result)
	return output.Code, result.Message + output.Stderr
}

// journal — единственный журнал проекта или журнал с индексом index.
func (f *fixture) journal(t *testing.T, index int) (string, *pycompat.Dict) {
	t.Helper()
	paths := journals(f.project)
	if index >= len(paths) {
		t.Fatalf("журналов %d", len(paths))
	}
	value, err := readJSON(paths[index])
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Dir(paths[index]), value.(*pycompat.Dict)
}

// state — tree-снимок проекта без истории транзакций и рабочих папок.
func (f *fixture) state(t *testing.T) map[string]treeEntry {
	t.Helper()
	result := treeSnapshot(t, f.project, f.project)
	for name := range result {
		if strings.HasPrefix(name, History) || strings.HasPrefix(name, "assets/replaced") {
			delete(result, name)
		}
	}
	return result
}

// sameState сверяет снимки дерева.
func sameState(t *testing.T, want, got map[string]treeEntry) {
	t.Helper()
	for name, entry := range want {
		if other, ok := got[name]; !ok || !sameEntry(entry, other) {
			t.Errorf("изменился %s", name)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			t.Errorf("лишний %s", name)
		}
	}
}

// replaced подменяет значение на время теста.
func replaced[T any](t *testing.T, target *T, value T) {
	t.Helper()
	previous := *target
	*target = value
	t.Cleanup(func() { *target = previous })
}

var errInjected = errors.New("сбой")

// TestPublishFailureRollsBack — сбой на каждой фазе публикации возвращает проект к прежнему виду:
// до и после переноса папки, на каждом файле, при проверке опубликованного комплекта.
func TestPublishFailureRollsBack(t *testing.T) {
	failFile := func(number int) func(string, string) error {
		count := 0
		return func(source, target string) error {
			if count++; count == number {
				return errInjected
			}
			return publishFile2(source, target)
		}
	}
	for name, prepare := range map[string]func(*testing.T, *fixture){
		"папка до переноса": func(t *testing.T, _ *fixture) {
			replaced(t, &publishDirectory, func(string, string, string) error { return errInjected })
		},
		"папка между переносами": func(t *testing.T, _ *fixture) {
			replaced(t, &publishDirectory, func(_, target, retired string) error {
				if err := os.MkdirAll(filepath.Dir(retired), 0o777); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(target, retired); err != nil {
					t.Fatal(err)
				}
				return errInjected
			})
		},
		"первый файл": func(t *testing.T, _ *fixture) { replaced(t, &publishFile, failFile(1)) },
		"второй файл": func(t *testing.T, _ *fixture) { replaced(t, &publishFile, failFile(2)) },
		"третий файл": func(t *testing.T, _ *fixture) { replaced(t, &publishFile, failFile(3)) },
		"проверка итога": func(t *testing.T, _ *fixture) {
			replaced(t, &validatePublished, func(string, string, string) (*pycompat.Dict, error) { return nil, errInjected })
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			if name != "папка до переноса" && name != "первый файл" {
				// Прежний комплект есть: откат обязан вернуть именно его.
				if err := os.MkdirAll(pycompat.JoinPath(f.project, "assets/shots/M05"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(pycompat.JoinPath(f.project, "assets/shots/M05/old.txt"), []byte("прежний"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			before := f.state(t)
			prepare(t, f)
			if code, message := f.accept(context.Background(), "--replace"); code != 1 {
				t.Fatalf("код %d %s", code, message)
			}
			sameState(t, before, f.state(t))
			directory, journal := f.journal(t, 0)
			if journal.Value("state") != "rolled_back" {
				t.Errorf("журнал %v", journal.Value("state"))
			}
			if pycompat.Exists(filepath.Join(directory, "staging")) {
				t.Error("staging остался")
			}
			if pycompat.Exists(pycompat.JoinPath(f.project, "assets/replaced/M05", journal.Value("id").(string))) {
				t.Error("архив остался")
			}
			// Откаченную приёмку можно повторить тем же подтверждением.
			restoreOriginals(t)
			if code, message := f.accept(context.Background(), "--replace"); code != 0 {
				t.Fatalf("повтор: %d %s", code, message)
			}
		})
	}
}

// publishFile2 — настоящая публикация файла для обёрток сбоя.
var publishFile2 = publishFile

// restoreOriginals возвращает настоящие функции публикации до конца теста.
func restoreOriginals(t *testing.T) {
	t.Helper()
	publishFile, publishDirectory, validatePublished = publishFile2, moveDirectory, assetpackage.ValidatePackage
}

// TestForeignEditStopsRollback — файл, изменённый после сбоя, останавливает откат: журнал остаётся
// publishing, данные не теряются, а после возврата файла восстановление завершается.
func TestForeignEditStopsRollback(t *testing.T) {
	f := newFixture(t)
	status := pycompat.JoinPath(f.project, "plan/production-status.json")
	original, err := os.ReadFile(status)
	if err != nil {
		t.Fatal(err)
	}
	before := f.state(t)
	replaced(t, &publishFile, func(source, target string) error {
		if err := os.WriteFile(status, []byte("{\"чужая\": true}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return errInjected
	})
	code, message := f.accept(context.Background())
	if code != 1 || !strings.HasPrefix(message, "После аварии изменён файл plan/production-status.json; журнал: ") {
		t.Fatalf("код %d %q", code, message)
	}
	directory, journal := f.journal(t, 0)
	if journal.Value("state") != "publishing" || !pycompat.IsDir(filepath.Join(directory, "staging")) {
		t.Fatalf("журнал %v", journal.Value("state"))
	}
	if !pycompat.Exists(pycompat.JoinPath(f.project, "assets/shots/M05/manifest.json")) {
		t.Fatal("опубликованный комплект потерян")
	}
	if _, err := Recover(f.project); err == nil {
		t.Fatal("восстановление не остановлено")
	}
	if data, _ := os.ReadFile(status); !strings.Contains(string(data), "чужая") {
		t.Fatal("чужая правка затёрта")
	}
	if err := os.WriteFile(status, original, 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := Recover(f.project)
	if err != nil {
		t.Fatal(err)
	}
	if list := result.Value("transactions").([]any); len(list) != 1 {
		t.Fatalf("транзакции %v", list)
	}
	sameState(t, before, f.state(t))
}

// TestRepeatedRecovery — откат, прерванный сбоем, и повторное восстановление безопасны: второй
// проход завершает работу, третий ничего не находит.
func TestRepeatedRecovery(t *testing.T) {
	f := newFixture(t)
	before := f.state(t)
	replaced(t, &publishFile, func(string, string) error { return errInjected })
	calls := 0
	real := restore
	replaced(t, &restoreHook, func(directory string, journal *pycompat.Dict, root string) error {
		if calls++; calls == 1 {
			return errInjected // Процесс умер: журнал остался publishing.
		}
		return real(directory, journal, root)
	})
	if code, _ := f.accept(context.Background()); code == 0 {
		t.Fatal("приёмка должна упасть")
	}
	if _, journal := f.journal(t, 0); journal.Value("state") != "publishing" {
		t.Fatalf("журнал %v", journal.Value("state"))
	}
	first, err := Recover(f.project)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Recover(f.project)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Value("transactions").([]any)) != 1 || len(second.Value("transactions").([]any)) != 0 {
		t.Fatalf("первый %v, второй %v", first.Value("transactions"), second.Value("transactions"))
	}
	sameState(t, before, f.state(t))
}

// TestInterruptedRestoreResumes — журнал publishing с уже откаченной папкой и остатком restore-kit:
// повторный откат не трогает готовое и убирает остаток.
func TestInterruptedRestoreResumes(t *testing.T) {
	f := newFixture(t)
	before := f.state(t)
	replaced(t, &restoreHook, func(string, *pycompat.Dict, string) error { return errInjected })
	replaced(t, &publishFile, func(string, string) error { return errInjected })
	if code, _ := f.accept(context.Background()); code == 0 {
		t.Fatal("приёмка должна упасть")
	}
	restoreHook = restore
	directory, journal := f.journal(t, 0)
	if err := restore(directory, journal, f.project); err != nil {
		t.Fatal(err)
	}
	journal.Set("state", "publishing")
	if err := saveJournal(directory, journal); err != nil {
		t.Fatal(err)
	}
	if err := restore(directory, journal, f.project); err != nil {
		t.Fatal(err)
	}
	sameState(t, before, f.state(t))
}

// TestBuildNoticesChangesDuringRender — трек, заменённый во время кодирования, отменяет пробу без
// следов: ни рабочей папки, ни временной.
func TestBuildNoticesChangesDuringRender(t *testing.T) {
	f := newFixture(t)
	if err := os.RemoveAll(pycompat.JoinPath(f.project, f.work)); err != nil {
		t.Fatal(err)
	}
	song := pycompat.JoinPath(f.project, "source/track.mp3")
	render := renderEdit
	replaced(t, &renderEdit, func(ctx context.Context, original, filter string, frames pycompat.Int, target string) error {
		if err := render(ctx, original, filter, frames, target); err != nil {
			return err
		}
		file, err := os.OpenFile(song, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = file.Write(make([]byte, 16)) // Трек другой, но FFmpeg по-прежнему его читает.
		return err
	})
	output := Run(context.Background(), f.project, []string{"build", "--shot", "M05", "--recipe", "plan/derived/M05/recipes/run-1.json", "--work-dir", f.work, "--json"})
	if output.Code != 1 || !strings.Contains(output.Stdout, textChangedBuild) {
		t.Fatalf("%d %s %s", output.Code, output.Stdout, output.Stderr)
	}
	entries, err := os.ReadDir(pycompat.JoinPath(f.project, "plan/derived/M05"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != "recipes" {
			t.Errorf("лишняя папка %s", entry.Name())
		}
	}
}

// TestCancelBeforePublishing — отмена задания до публикации оставляет журнал failed и проект без
// изменений; staging удалён.
func TestCancelBeforePublishing(t *testing.T) {
	f := newFixture(t)
	before := f.state(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if code, _ := f.accept(ctx); code == 0 {
		t.Fatal("приёмка должна остановиться")
	}
	directory, journal := f.journal(t, 0)
	if journal.Value("state") != "failed" || pycompat.Exists(filepath.Join(directory, "staging")) {
		t.Fatalf("журнал %v", journal.Value("state"))
	}
	sameState(t, before, f.state(t))
}

// TestCancelDuringBuild — отмена сборки не оставляет временную папку.
func TestCancelDuringBuild(t *testing.T) {
	f := newFixture(t)
	if err := os.RemoveAll(pycompat.JoinPath(f.project, f.work)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	replaced(t, &renderEdit, func(ctx context.Context, _, _ string, _ pycompat.Int, _ string) error {
		cancel()
		return ctx.Err()
	})
	output := Run(ctx, f.project, []string{"build", "--shot", "M05", "--recipe", "plan/derived/M05/recipes/run-1.json", "--work-dir", f.work, "--json"})
	if output.Code == 0 {
		t.Fatal("сборка должна остановиться")
	}
	entries, _ := os.ReadDir(pycompat.JoinPath(f.project, "plan/derived/M05"))
	if len(entries) != 1 {
		t.Fatalf("лишние папки: %v", entries)
	}
}

// TestActiveDuringCommand — признак выполняющейся команды виден на время работы и только для её
// проекта; восстановление при открытии смотрит на него, чтобы не откатить живую публикацию.
func TestActiveDuringCommand(t *testing.T) {
	f := newFixture(t)
	seen, other := false, true
	publish := publishDirectory
	replaced(t, &publishDirectory, func(source, target, retired string) error {
		seen, other = Active(f.project), Active(f.project+"-другой")
		return publish(source, target, retired)
	})
	if code, message := f.accept(context.Background(), "--replace"); code != 0 {
		t.Fatalf("%d %s", code, message)
	}
	if !seen || other || Active(f.project) {
		t.Fatalf("активен %v, другой %v, после %v", seen, other, Active(f.project))
	}
}
