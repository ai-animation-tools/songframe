package tools_test

import (
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/tools"
)

// TestRunRejectsName — неверное и не перенесённое имя отклоняются до запуска, как исключение
// PythonLauncher оригинала (renderer получает отказ вызова, а не ToolResult).
func TestRunRejectsName(t *testing.T) {
	for name, want := range map[string]string{
		"../scene_scaffold": "Недопустимое имя инструмента: ../scene_scaffold",
		"SceneScaffold":     "Недопустимое имя инструмента: SceneScaffold",
		"":                  "Недопустимое имя инструмента: ",
		"current_project":   "Инструмент current_project ещё не перенесён в Go-версию SongFrame.",
	} {
		if _, err := tools.Run(t.TempDir(), name, nil); err == nil || err.Error() != want {
			t.Errorf("%q: ожидалось %q, получено %v", name, want, err)
		}
	}
	if !tools.Available("scene_scaffold") || !tools.Available("shot_status") || tools.Available("current_project") || !tools.Available("build_animatic") {
		t.Error("Available не соответствует реестру перенесённых инструментов")
	}
}

// TestRunWithoutProject — пустой путь проекта: NO_PROJECT_MESSAGE tools/common.py и код 2.
func TestRunWithoutProject(t *testing.T) {
	result, err := tools.Run("", "scene_scaffold", []string{"--json"})
	if err != nil || result.Code == nil || *result.Code != 2 || result.Stdout != "" {
		t.Fatalf("ожидался код 2 без вывода, получено %+v, %v", result, err)
	}
	want := "Проект клипа не выбран. Укажите `--project <папка>`, задайте переменную окружения SONGFRAME_PROJECT " +
		"или выберите проект: `python3 -B tools/current_project/current_project.py set <папка>`.\n"
	if result.Stderr != want {
		t.Fatalf("stderr: %q", result.Stderr)
	}
}

// TestRunCommand — строка запуска: имя, разрешённый --project (ссылки разыменованы) и аргументы
// в кавычках JSON, как command в ToolResult оригинала.
func TestRunCommand(t *testing.T) {
	real := filepath.Join(t.TempDir(), "клип")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "ссылка")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("символические ссылки недоступны:", err)
	}
	resolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	result, err := tools.Run(link, "scene_scaffold", []string{"--json", `a "b"`})
	if err != nil {
		t.Fatal(err)
	}
	want := `"scene_scaffold" "--project" "` + resolved + `" "--json" "a \"b\""`
	if result.Command != want {
		t.Fatalf("command:\n  ожидалось %s\n  получено  %s", want, result.Command)
	}
	if result.Code == nil || *result.Code != 2 {
		t.Fatalf("неизвестный аргумент должен дать код 2: %+v", result)
	}
}
