package projectgit

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// isolate отделяет тест от настроек Git пользователя: свой HOME без глобального конфига, автор
// задан окружением. Без Git тест пропускается — пакет рассчитан на необязательный Git.
func isolate(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git не установлен")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Тест")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Тест")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.invalid")
	autoErrors = map[string]string{}
}

// git выполняет команду в папке и падает тестом при ошибке.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// write создаёт файл проекта вместе с папками.
func write(t *testing.T, project, path, content string) {
	t.Helper()
	full := filepath.Join(project, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// read — содержимое файла проекта.
func read(t *testing.T, project, path string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(path)))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// repo — проект-репозиторий с первой точкой: название и пустой сценарий.
func repo(t *testing.T) string {
	t.Helper()
	isolate(t)
	project := t.TempDir()
	git(t, project, "init", "-q")
	write(t, project, "plan/project.json", `{"schema_version":1,"name":"Тест"}`)
	write(t, project, "plan/scenes.json", `{"scenes":[{"id":"M01"},{"id":"M02"}]}`)
	git(t, project, "add", "-A")
	git(t, project, "commit", "-qm", "Начало")
	return project
}

func TestSectionOf(t *testing.T) {
	cases := map[string]Section{
		"plan/project.json":                   SectionProject,
		"source/track.mp3":                    SectionSources,
		"plan/audio/timing.json":              SectionTiming,
		"plan/audio/timing.md":                SectionViews,
		"plan/cast.json":                      SectionCast,
		"plan/scenes.json":                    SectionScenario,
		"plan/scenario-workflow.json":         SectionScenario,
		"plan/batches/proposals/M01.json":     SectionProduction,
		"plan/spend.json":                     SectionProduction,
		"assets/shots/M01/original.mp4":       SectionScenes,
		"plan/montage-history/1/montage.json": SectionMontage,
		"plan/animatic/cards/M01.png":         SectionViews,
		"plan/animatic/latest/manifest.json":  SectionAnimatic,
		"plan/prompt-log/1.json":              SectionPrompts,
		"ROADMAP.md":                          SectionViews,
		".gitattributes":                      SectionOther,
		"plan/scenes.json.bak":                SectionOther,
	}
	for path, want := range cases {
		if got := SectionOf(path); got != want {
			t.Errorf("%s: раздел %q, ожидался %q", path, got, want)
		}
	}
}

func TestWithoutRepository(t *testing.T) {
	isolate(t)
	project := t.TempDir()
	status, err := GetStatus(context.Background(), project)
	if err != nil || status.Available {
		t.Fatalf("вне репозитория: %+v %v", status, err)
	}
	if err := Checkpoint(context.Background(), project, OperationScenarioApply); err != nil {
		t.Fatalf("автоматическая точка без Git должна молча пропускаться: %v", err)
	}
	// Вложенная папка чужого репозитория — тоже не проект с историей.
	outer := repo(t)
	inner := filepath.Join(outer, "clip")
	write(t, outer, "clip/plan/project.json", `{}`)
	if status, _ := GetStatus(context.Background(), inner); status.Available {
		t.Fatal("папка внутри чужого репозитория не должна считаться репозиторием проекта")
	}
}

func TestStatusSaveHistory(t *testing.T) {
	project := repo(t)
	ctx := context.Background()
	write(t, project, "plan/scenes.json", `{"scenes":[{"id":"M01"}]}`)
	write(t, project, "plan/audio/timing.json", `{}`)
	status, err := GetStatus(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Available || strings.Join(status.Sections, ",") != "timing,scenario" || status.ChangedFiles != 2 {
		t.Fatalf("статус: %+v", status)
	}
	if status.Head == nil || status.Head.Message != "Начало" {
		t.Fatalf("последняя точка: %+v", status.Head)
	}
	if _, err := Save(ctx, project, "  "); err == nil {
		t.Fatal("пустая подпись должна отклоняться")
	}
	status, err = Save(ctx, project, "Тайминги, сценарий")
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Sections) != 0 || status.ChangedFiles != 0 || status.Head.Message != "Тайминги, сценарий" {
		t.Fatalf("после сохранения: %+v", status)
	}
	// Повторное сохранение без изменений коммит не создаёт.
	if _, err := Save(ctx, project, "Пусто"); err != nil {
		t.Fatal(err)
	}
	points, err := History(ctx, project, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 2 || points[0].Message != "Тайминги, сценарий" || strings.Join(points[0].Sections, ",") != "timing,scenario" {
		t.Fatalf("история: %+v", points)
	}
	if strings.Join(points[1].Sections, ",") != "project,scenario" {
		t.Fatalf("разделы первой точки: %+v", points[1])
	}
}

func TestCheckpoint(t *testing.T) {
	project := repo(t)
	ctx := context.Background()
	if err := Checkpoint(ctx, project, OperationScenarioApply); err != nil {
		t.Fatal(err)
	}
	if count := strings.TrimSpace(git(t, project, "rev-list", "--count", "HEAD")); count != "1" {
		t.Fatalf("без изменений точка не нужна, коммитов %s", count)
	}
	write(t, project, "plan/cast.json", `{}`)
	if err := Checkpoint(ctx, project, OperationScenarioApply); err != nil {
		t.Fatal(err)
	}
	subject := strings.TrimSpace(git(t, project, "log", "-1", "--format=%s"))
	if subject != "Автоматическая точка перед применением сценария" {
		t.Fatalf("подпись: %q", subject)
	}
	if err := Checkpoint(ctx, project, "неизвестно"); err == nil {
		t.Fatal("неизвестная операция должна отклоняться")
	}
}

func TestCheckpointFailureIsReported(t *testing.T) {
	project := repo(t)
	ctx := context.Background()
	// Без автора Git не сможет создать коммит: user.useConfigOnly запрещает угадывать почту.
	git(t, project, "config", "user.useConfigOnly", "true")
	for _, name := range []string{"GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"} {
		os.Unsetenv(name)
	}
	write(t, project, "plan/cast.json", `{}`)
	Before(ctx, project, OperationMontageApply)
	status, err := GetStatus(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(status.AutoError, "применением монтажа") || !strings.Contains(status.AutoError, "автора") {
		t.Fatalf("ошибка автоматической точки: %q", status.AutoError)
	}
}

func TestLFSWithoutProgram(t *testing.T) {
	project := repo(t)
	write(t, project, ".gitattributes", "*.mp4 filter=lfs diff=lfs merge=lfs -text\n")
	lookPath = func(name string) (string, error) {
		if name == "git-lfs" {
			return "", exec.ErrNotFound
		}
		return exec.LookPath(name)
	}
	t.Cleanup(func() { lookPath = exec.LookPath })
	if _, err := Save(context.Background(), project, "С LFS"); err == nil || !strings.Contains(err.Error(), "git-lfs") {
		t.Fatalf("ожидалась понятная ошибка про git-lfs: %v", err)
	}
}

func TestRestoreScenario(t *testing.T) {
	project := repo(t)
	ctx := context.Background()
	first := strings.TrimSpace(git(t, project, "rev-parse", "HEAD"))
	write(t, project, "plan/scenes.json", `{"scenes":[{"id":"M01"},{"id":"M02"},{"id":"M03"}]}`)
	write(t, project, "plan/scenario-workflow.json", `{}`)
	write(t, project, "assets/shots/M01/original.mp4", "видео")
	if _, err := Save(ctx, project, "Три плана"); err != nil {
		t.Fatal(err)
	}
	// Несохранённая правка должна попасть в автоматическую точку перед возвратом.
	write(t, project, "plan/scenes.json", `{"scenes":[]}`)
	if _, err := Restore(ctx, project, first, SectionSources); err == nil {
		t.Fatal("исходники возвращать нельзя")
	}
	result, err := Restore(ctx, project, first, SectionScenario)
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, project, "plan/scenes.json"); got != `{"scenes":[{"id":"M01"},{"id":"M02"}]}` {
		t.Fatalf("сценарий не возвращён: %s", got)
	}
	if _, err := os.Stat(filepath.Join(project, "plan/scenario-workflow.json")); !os.IsNotExist(err) {
		t.Fatal("файл, которого не было в точке, должен удалиться")
	}
	if read(t, project, "assets/shots/M01/original.mp4") != "видео" {
		t.Fatal("медиа не должны меняться")
	}
	subject := strings.TrimSpace(git(t, project, "log", "-1", "--format=%s"))
	if subject != "Автоматическая точка перед возвратом раздела к точке" {
		t.Fatalf("перед возвратом нужна точка с текущим состоянием: %q", subject)
	}
	if strings.Join(result.Status.Sections, ",") != "scenario" {
		t.Fatalf("возврат остаётся несохранённым: %+v", result.Status)
	}
	if _, err := Restore(ctx, project, "нет-такой", SectionScenario); err == nil {
		t.Fatal("несуществующая точка должна отклоняться")
	}
}

func TestCompareScenario(t *testing.T) {
	project := repo(t)
	ctx := context.Background()
	first := strings.TrimSpace(git(t, project, "rev-parse", "HEAD"))
	write(t, project, "plan/scenes.json", `{"scenes":[{"id":"M01"},{"id":"M02"},{"id":"M03"}]}`)
	comparison, err := CompareScenario(ctx, project, first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(comparison.Removed, ",") != "M03" || comparison.Missing {
		t.Fatalf("сравнение: %+v", comparison)
	}
	git(t, project, "rm", "-q", "--cached", "plan/scenes.json")
	git(t, project, "commit", "-qm", "Без сценария")
	comparison, err = CompareScenario(ctx, project, "HEAD")
	if err != nil || !comparison.Missing {
		t.Fatalf("в точке нет сценария: %+v %v", comparison, err)
	}
}
