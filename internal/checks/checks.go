// Package checks — перенос группы checks.list/run/runAll из src/main/checks.ts замороженного
// оригинала: проверки проекта запускаются заданиями общего менеджера с журналом и кодом
// завершения. Каждая проверка — один шаг с инструментом комплекса; в Go-версии перенесённые
// инструменты (internal/tools) выполняются в процессе приложения, поэтому проверкам не нужны
// Python и FFmpeg (оригинал перед запуском требовал оба, см. requireMediaBinaries).
//
// Журнал повторяет оригинал: строка «$ <подпись> <аргументы>» (пишет менеджер), затем stdout и
// stderr инструмента; причина сбоя шага — stderr, иначе stdout (после trim), иначе «Шаг … завершился
// с кодом N.». Проверка «Карточки и списки» (update_scene_views --check) ещё не перенесена: список её
// показывает, запуск отдельно отклоняется, а «Все проверки» выполняют только перенесённые.
package checks

import (
	"context"
	"errors"
	"strings"
	"unicode"

	"songframe-go/internal/jobs"
	"songframe-go/internal/tools"
)

// ID — CheckId контракта (frontend/src/shared/types.ts).
type ID string

const (
	Lint      ID = "lint"
	Views     ID = "views"
	Assets    ID = "assets"
	Workspace ID = "workspace"
	Status    ID = "status"
)

// Info — CheckInfo контракта: проверка, её подписи и инструмент комплекса.
type Info struct {
	ID          ID     `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Tool        string `json:"tool"`
	// NeedsScenes — проверка осмысленна только при наличии реестра сцен.
	NeedsScenes bool `json:"needsScenes"`
}

// Options — CheckOptions контракта: lint_registry --strict и shot_status --next.
type Options struct {
	Strict bool `json:"strict,omitempty"`
	Next   bool `json:"next,omitempty"`
}

// all — CHECKS оригинала в том же порядке и с теми же текстами.
var all = []Info{
	{ID: Lint, Label: textSceneDataLabel, Description: textSceneDataDescription, Tool: "lint_registry", NeedsScenes: true},
	{ID: Views, Label: textViewsLabel, Description: textViewsDescription, Tool: "update_scene_views", NeedsScenes: true},
	{ID: Assets, Label: textAssetsLabel, Description: textAssetsDescription, Tool: "check_assets", NeedsScenes: true},
	{ID: Workspace, Label: textWorkspaceLabel, Description: textWorkspaceDescription, Tool: "check_workspace", NeedsScenes: true},
	{ID: Status, Label: textStatusLabel, Description: textStatusDescription, Tool: "shot_status", NeedsScenes: true},
}

// List — CHECKS: все проверки контракта, включая ещё не перенесённую; доступность запуска
// renderer узнаёт из адаптера (frontend/src/platform/api.ts), а не из этого списка.
func List() []Info { return append([]Info(nil), all...) }

// Migrated — перенесена ли проверка (её инструмент выполняется в Go).
func Migrated(id ID) bool {
	for _, info := range all {
		if info.ID == id {
			return tools.Available(info.Tool)
		}
	}
	return false
}

// find — проверка по ID; неизвестный ID — ошибка вызова с текстом оригинала.
func find(id ID) (Info, error) {
	for _, info := range all {
		if info.ID == id {
			return info, nil
		}
	}
	return Info{}, errors.New(textUnknownCheck(string(id)))
}

// args — checkStep оригинала: аргументы инструмента по проверке и параметрам.
func args(id ID, options Options) []string {
	result := []string{}
	switch {
	case id == Lint && options.Strict:
		result = append(result, "--strict")
	case id == Views:
		result = append(result, "--check")
	case id == Status && options.Next:
		result = append(result, "--next")
	}
	return result
}

// step — шаг задания для перенесённой проверки: инструмент на папке проекта, вывод в журнал.
func step(project string, info Info, options Options, continueOnFailure bool) jobs.Step {
	arguments := args(info.ID, options)
	return jobs.Step{
		Tool: info.Tool, Label: info.Label, Args: arguments, Continue: continueOnFailure,
		Run: func(_ context.Context, journal *jobs.StepContext) error {
			result, err := tools.Run(project, info.Tool, arguments)
			if err != nil {
				return err
			}
			// Инструменты печатают stdout до stderr (отказы parser.exit и трассировка — в конце),
			// поэтому последовательная запись совпадает с порядком журнала PYTHONUNBUFFERED.
			journal.Log(result.Stdout)
			journal.Log(result.Stderr)
			if result.Code == nil || *result.Code == 0 {
				return nil
			}
			message := jsTrim(result.Stderr)
			if message == "" {
				message = jsTrim(result.Stdout)
			}
			return &jobs.StepError{Code: *result.Code, Message: message}
		},
	}
}

// Service запускает проверки заданиями общего менеджера; состояния, кроме менеджера, нет.
type Service struct{ jobs *jobs.Manager }

// New связывает проверки с менеджером заданий приложения.
func New(manager *jobs.Manager) *Service { return &Service{jobs: manager} }

// Run — checks.run(project, id, options): одна проверка заданием «Проверка: <подпись>».
// Неизвестная или ещё не перенесённая проверка — ошибка вызова без задания.
func (s *Service) Run(project string, id ID, options Options) (jobs.Info, error) {
	info, err := find(id)
	if err != nil {
		return jobs.Info{}, err
	}
	if !Migrated(id) {
		return jobs.Info{}, errors.New(textCheckNotMigrated(info.Label))
	}
	return s.jobs.Start(jobs.Spec{Kind: jobs.KindCheck, Title: textCheckJobTitle(info.Label), Project: project,
		Steps: []jobs.Step{step(project, info, options, false)}})
}

// RunAll — checks.runAll(project, options): все перенесённые проверки одним заданием «Все
// проверки»; неудача одной не отменяет остальные, но делает задание неудачным. Отличие от
// оригинала на время миграции: шаг «Карточки и списки» не входит, пока update_scene_views не
// перенесён (renderer сообщает об этом под кнопкой), иначе задание всегда завершалось бы ошибкой.
func (s *Service) RunAll(project string, options Options) (jobs.Info, error) {
	steps := []jobs.Step{}
	for _, info := range all {
		if Migrated(info.ID) {
			steps = append(steps, step(project, info, options, true))
		}
	}
	return s.jobs.Start(jobs.Spec{Kind: jobs.KindCheck, Title: textAllChecksJobTitle, Project: project, Steps: steps})
}

// jsTrim — String.prototype.trim причины сбоя, как в PythonLauncher оригинала: пробельные
// символы Unicode и BOM, кроме U+0085.
func jsTrim(text string) string {
	return strings.TrimFunc(text, func(r rune) bool { return r == 0xFEFF || (r != '\u0085' && unicode.IsSpace(r)) })
}
