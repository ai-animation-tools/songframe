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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/acceptshot"
	"songframe-go/internal/applymontage"
	"songframe-go/internal/buildanimatic"
	"songframe-go/internal/buildreview"
	"songframe-go/internal/checkassets"
	"songframe-go/internal/checkworkspace"
	"songframe-go/internal/contactsheet"
	"songframe-go/internal/continuitybrief"
	"songframe-go/internal/costcheck"
	"songframe-go/internal/cutspeech"
	"songframe-go/internal/deriveshot"
	"songframe-go/internal/exportbundle"
	"songframe-go/internal/lintregistry"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediarequest"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/regenerateshot"
	"songframe-go/internal/scenescaffold"
	"songframe-go/internal/sceneviews"
	"songframe-go/internal/shotstatus"
	"songframe-go/internal/shotworkflow"
	"songframe-go/internal/verifyassetreplay"
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
// оригинала, «Папка проекта не найдена» — tools/common.py. textNoProject направляет к выбору
// проекта в приложении: инструменты выполняются только внутри SongFrame, без отдельного CLI.
const (
	textNoProject = "Проект клипа не выбран. Откройте проект в SongFrame кнопкой «Открыть папку проекта»."
)

func textToolNameInvalid(name string) string {
	return "Недопустимое имя инструмента: " + name
}

// textToolUnknown — имя допустимо по форме, но такого инструмента в реестре приложения нет.
func textToolUnknown(name string) string {
	return "Неизвестный инструмент: " + name + "."
}
func textProjectNotFound(root string) string {
	return "Папка проекта не найдена: " + root + " (источник: argument)."
}

// toolName — допустимое имя инструмента (проверка PythonLauncher.run).
var toolName = regexp.MustCompile(`^[a-z_]+$`)

// tool — перенесённый инструмент: main() на разрешённом корне проекта.
type tool func(root string, args []string) pytool.Output

// registry — инструменты приложения по имени. Имя вне реестра — ошибка «Неизвестный инструмент».
var registry = map[string]tool{
	"scene_scaffold":      scenescaffold.Run,
	"lint_registry":       lintregistry.Run,
	"check_assets":        checkassets.Run,
	"check_workspace":     checkworkspace.Run,
	"shot_status":         shotstatus.Run,
	"continuity_brief":    continuitybrief.Run,
	"update_scene_views":  sceneviews.Run,
	"shot_workflow":       shotworkflow.Run,
	"verify_asset_replay": verifyassetreplay.Run,
}

// contextTool — перенесённый инструмент, обращающийся к сервису провайдера или ждущий его:
// получает контекст отмены задания.
type contextTool func(ctx context.Context, root string, args []string) pytool.Output

// LocalDir — каталог состояния Go-версии для инструментов, которые пишут в него (наблюдения
// цен cost_check). По умолчанию — профиль store, как у приложения (SONGFRAME_GO_LOCAL_DIR либо
// стандартная папка ОС); сервисы приложения подменяют mediaadapters.StateDir своим профилем, и
// наблюдения цен попадают туда же, где лежит вход провайдера.
var LocalDir = func() (string, error) { return mediaadapters.StateDir() }

// contextual — инструменты платной попытки и её продолжения (media_request, cost_check,
// regenerate_shot, accept_shot), медиаинструменты с долгими вызовами FFmpeg (derive_shot, build_animatic,
// build_review, contact_sheet, cut_speech) и копирование медиа пакета для монтажёра
// (export_edit_bundle): получают контекст отмены задания.
var contextual = map[string]contextTool{
	"media_request": func(ctx context.Context, root string, args []string) pytool.Output {
		return mediarequest.Run(ctx, root, args, nil)
	},
	"cost_check":         withLocalDir(costcheck.Run),
	"regenerate_shot":    withLocalDir(regenerateshot.Run),
	"accept_shot":        withLocalDir(acceptshot.Run),
	"apply_montage":      applymontage.Run,
	"build_animatic":     buildanimatic.Run,
	"build_review":       buildreview.Run,
	"contact_sheet":      contactsheet.Run,
	"cut_speech":         cutspeech.Run,
	"derive_shot":        deriveshot.Run,
	"export_edit_bundle": exportbundle.Run,
}

// withLocalDir — инструмент, которому нужен каталог состояния (наблюдения цен cost_check).
func withLocalDir(run func(ctx context.Context, root string, args []string, localDir string) pytool.Output) contextTool {
	return func(ctx context.Context, root string, args []string) pytool.Output {
		dir, err := LocalDir()
		if err != nil {
			return pytool.Output{Code: 1, Stderr: pycompat.TextMode(err.Error() + "\n")}
		}
		return run(ctx, root, args, dir)
	}
}

// projectFree — действия инструментов без проекта (PROJECT_FREE_ACTIONS оригинала): вход к
// провайдеру со страницы «Среда» выполняется без выбранного клипа.
var projectFree = map[string]map[string]bool{"media_request": mediarequest.ProjectFreeActions}

// Available — есть ли инструмент с таким именем в реестре приложения.
func Available(name string) bool {
	_, ok := registry[name]
	_, withContext := contextual[name]
	return ok || withContext
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

// Run — tools.run: проверка имени, выбор проекта и запуск инструмента из реестра. Ошибка —
// отказ вызова (неверное или неизвестное имя), как исключение оригинала до запуска процесса;
// отказ самого инструмента — Result с ненулевым кодом.
func Run(project, name string, args []string) (Result, error) {
	return RunContext(context.Background(), project, name, args)
}

// RunContext — Run с отменой: инструменты платной попытки прерывают вызов сервиса и ожидание.
// Отменённый запуск возвращает Code nil, как процесс оригинала, завершённый сигналом.
func RunContext(ctx context.Context, project, name string, args []string) (Result, error) {
	if !toolName.MatchString(name) {
		return Result{}, errors.New(textToolNameInvalid(name))
	}
	run, ok := registry[name]
	if withContext, found := contextual[name]; found {
		ok = true
		run = func(root string, args []string) pytool.Output { return withContext(ctx, root, args) }
	}
	if !ok {
		return Result{}, errors.New(textToolUnknown(name))
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
		if len(args) > 0 && projectFree[name][args[0]] {
			output := run("", append([]string(nil), args...))
			return finish(output.Code, output.Stdout, output.Stderr)
		}
		return finish(2, "", pycompat.TextMode(textNoProject+"\n"))
	}
	root := resolve(project)
	parts = append(append(parts, "--project", root), args...)
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return finish(2, "", pycompat.TextMode(textProjectNotFound(root)+"\n"))
	}
	output := run(root, append([]string(nil), args...))
	if ctx.Err() != nil {
		result, err := finish(output.Code, output.Stdout, output.Stderr)
		result.Code = nil
		return result, err
	}
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
