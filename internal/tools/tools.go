// Package tools — метод контракта tools.run(project, name, args) → ToolResult: запуск инструмента
// комплекса по имени на папке проекта. В оригинале (src/main/tools.ts, python-launcher.ts) каждый
// вызов запускал Python-скрипт tools/<name>/<name>.py с `--project <папка>`; здесь известные
// инструменты перенесены на Go и выполняются в процессе приложения без Python.
//
// Результат повторяет то, что видел renderer: код завершения, stdout и stderr процесса Python
// (тексты, коды и форматы вывода инструмента), поэтому разбор в интерфейсе не меняется. Перед
// инструментом выполняется выбор проекта tools/common.py: путь разрешается до реального
// (Path.resolve), отсутствующая папка — код 2 с текстом оригинала.
package tools

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/checkassets"
	"songframe-go/internal/checkworkspace"
	"songframe-go/internal/continuitybrief"
	"songframe-go/internal/lintregistry"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/scenescaffold"
	"songframe-go/internal/sceneviews"
	"songframe-go/internal/shotstatus"
)

// Result — ToolResult контракта (frontend/src/shared/types.ts). Code — nil, если процесс не
// завершился сам (в Go-версии не бывает: инструменты выполняются в процессе). Command — строка
// запуска для диагностики: имя инструмента и аргументы в кавычках JSON, как в оригинале.
type Result struct {
	Code    *int   `json:"code"`
	Stdout  string `json:"stdout"`
	Stderr  string `json:"stderr"`
	Command string `json:"command"`
}

// Тексты, которые видит пользователь. toolNameInvalid — environmentTexts.main.toolNameInvalid
// оригинала; NO_PROJECT_MESSAGE и «Папка проекта не найдена» — tools/common.py.
const (
	textNoProject = "Проект клипа не выбран. Укажите `--project <папка>`, задайте переменную окружения " +
		"SONGFRAME_PROJECT или выберите проект: `python3 -B tools/current_project/current_project.py set <папка>`."
)

func textToolNameInvalid(name string) string {
	return "Недопустимое имя инструмента: " + name
}
func textToolNotMigrated(name string) string {
	return "Инструмент " + name + " ещё не перенесён в Go-версию SongFrame."
}
func textProjectNotFound(root string) string {
	return "Папка проекта не найдена: " + root + " (источник: argument)."
}

// toolName — допустимое имя инструмента (проверка PythonLauncher.run).
var toolName = regexp.MustCompile(`^[a-z_]+$`)

// tool — перенесённый инструмент: main() на разрешённом корне проекта.
type tool func(root string, args []string) pytool.Output

// registry — инструменты, перенесённые на Go. Остальные имена оригинала — ошибка «не перенесён».
var registry = map[string]tool{
	"scene_scaffold":     scenescaffold.Run,
	"lint_registry":      lintregistry.Run,
	"check_assets":       checkassets.Run,
	"check_workspace":    checkworkspace.Run,
	"shot_status":        shotstatus.Run,
	"continuity_brief":   continuitybrief.Run,
	"update_scene_views": sceneviews.Run,
}

// Available — перенесён ли инструмент с таким именем.
func Available(name string) bool {
	_, ok := registry[name]
	return ok
}

// resolve — Path(path).resolve() без strict: абсолютный путь, ссылки разыменованы в существующей
// части, несуществующий хвост добавляется как есть.
func resolve(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	rest := []string{}
	for current := absolute; ; current = filepath.Dir(current) {
		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			return filepath.Join(append([]string{resolved}, rest...)...)
		}
		if filepath.Dir(current) == current {
			return absolute
		}
		rest = append([]string{filepath.Base(current)}, rest...)
	}
}

// quote — JSON.stringify(part) для строки запуска.
func quote(part string) string {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(part)
	return strings.TrimSuffix(builder.String(), "\n")
}

// Run — tools.run: проверка имени, выбор проекта и запуск перенесённого инструмента. Ошибка —
// отказ вызова (неверное или не перенесённое имя), как исключение оригинала до запуска процесса;
// отказ самого инструмента — Result с ненулевым кодом.
func Run(project, name string, args []string) (Result, error) {
	if !toolName.MatchString(name) {
		return Result{}, errors.New(textToolNameInvalid(name))
	}
	run, ok := registry[name]
	if !ok {
		return Result{}, errors.New(textToolNotMigrated(name))
	}
	parts := []string{name}
	finish := func(code int, stdout, stderr string) (Result, error) {
		quoted := make([]string, len(parts))
		for index, part := range parts {
			quoted[index] = quote(part)
		}
		return Result{Code: &code, Stdout: stdout, Stderr: stderr, Command: strings.Join(quoted, " ")}, nil
	}
	if project == "" {
		parts = append(parts, args...)
		return finish(2, "", pycompat.TextMode(textNoProject+"\n"))
	}
	root := resolve(project)
	parts = append(append(parts, "--project", root), args...)
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return finish(2, "", pycompat.TextMode(textProjectNotFound(root)+"\n"))
	}
	output := run(root, append([]string(nil), args...))
	return finish(output.Code, output.Stdout, output.Stderr)
}

// String — краткое описание результата для журналов.
func (r Result) String() string {
	code := "null"
	if r.Code != nil {
		code = fmt.Sprint(*r.Code)
	}
	return r.Command + " → " + code
}
