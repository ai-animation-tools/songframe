// Package checks запускает проверки проекта (checks.list/run/runAll) заданиями общего менеджера
// с журналом и кодом завершения. Каждая проверка — один шаг с инструментом комплекса; инструменты
// (internal/tools) выполняются в процессе приложения, поэтому проверкам не нужны внешние программы и FFmpeg.
//
// Журнал: строка «$ <подпись> <аргументы>» (пишет менеджер), затем stdout и
// stderr инструмента; причина сбоя шага — stderr, иначе stdout (после trim), иначе «Шаг … завершился
// с кодом N.». Пересборка карточек и списков (checks.updateViews) — задание вида tool с одним шагом
// update_scene_views без --check. Пробы стыков (buildReview, listReviews,
// removeReview) — в reviews.go.
package checks

import (
	"context"
	"errors"
	"strings"
	"unicode"

	"songframe/internal/jobs"
	"songframe/internal/tools"
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

// all — проверки контракта; порядок и тексты видны в UI и сверяются TestListMatchesGolden.
var all = []Info{
	{ID: Lint, Label: textSceneDataLabel, Description: textSceneDataDescription, Tool: "lint_registry", NeedsScenes: true},
	{ID: Views, Label: textViewsLabel, Description: textViewsDescription, Tool: "update_scene_views", NeedsScenes: true},
	{ID: Assets, Label: textAssetsLabel, Description: textAssetsDescription, Tool: "check_assets", NeedsScenes: true},
	{ID: Workspace, Label: textWorkspaceLabel, Description: textWorkspaceDescription, Tool: "check_workspace", NeedsScenes: true},
	{ID: Status, Label: textStatusLabel, Description: textStatusDescription, Tool: "shot_status", NeedsScenes: true},
}

// List — все проверки контракта в порядке показа (копия, вызывающий может её менять).
func List() []Info { return append([]Info(nil), all...) }

// find — проверка по ID; неизвестный ID — ошибка вызова с текстом textUnknownCheck.
func find(id ID) (Info, error) {
	for _, info := range all {
		if info.ID == id {
			return info, nil
		}
	}
	return Info{}, errors.New(textUnknownCheck(string(id)))
}

// args — аргументы инструмента по проверке и параметрам.
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

// step — шаг задания проверки: инструмент на папке проекта, вывод в журнал.
func step(project string, info Info, options Options, continueOnFailure bool) jobs.Step {
	arguments := args(info.ID, options)
	return jobs.Step{
		Tool: info.Tool, Label: info.Label, Args: arguments, Continue: continueOnFailure,
		Run: func(_ context.Context, journal *jobs.StepContext) error {
			result, err := tools.Run(project, info.Tool, arguments)
			if err != nil {
				return err
			}
			// Инструменты печатают stdout до stderr (отказы разбора аргументов и необработанные
			// ошибки — в конце), поэтому последовательная запись даёт тот же порядок, что вывод
			// процесса без буфера.
			journal.Log(result.Stdout)
			journal.Log(result.Stderr)
			if result.Code == nil || *result.Code == 0 {
				return nil
			}
			message := trimReason(result.Stderr)
			if message == "" {
				message = trimReason(result.Stdout)
			}
			return &jobs.StepError{Code: *result.Code, Message: message}
		},
	}
}

// Service запускает проверки и пробы заданиями общего менеджера; собственное состояние — только
// связь путей проб с заданиями их сборки.
type Service struct {
	jobs    *jobs.Manager
	reviews reviews
}

// New связывает проверки с менеджером заданий приложения.
func New(manager *jobs.Manager) *Service {
	return &Service{jobs: manager, reviews: reviews{jobs: map[string]string{}}}
}

// Run — checks.run(project, id, options): одна проверка заданием «Проверка: <подпись>».
// Неизвестная проверка — ошибка вызова без задания.
func (s *Service) Run(project string, id ID, options Options) (jobs.Info, error) {
	info, err := find(id)
	if err != nil {
		return jobs.Info{}, err
	}
	return s.jobs.Start(jobs.Spec{Kind: jobs.KindCheck, Title: textCheckJobTitle(info.Label), Project: project,
		Steps: []jobs.Step{step(project, info, options, false)}})
}

// RunAll — checks.runAll(project, options): все пять проверок одним заданием «Все проверки»;
// неудача одной не отменяет остальные, но делает задание неудачным.
func (s *Service) RunAll(project string, options Options) (jobs.Info, error) {
	steps := []jobs.Step{}
	for _, info := range all {
		steps = append(steps, step(project, info, options, true))
	}
	return s.jobs.Start(jobs.Spec{Kind: jobs.KindCheck, Title: textAllChecksJobTitle, Project: project, Steps: steps})
}

// UpdateViews — checks.updateViews(project): задание «Обновление карточек и списков» вида tool с
// одним шагом update_scene_views без аргументов (запись представлений, карточек и квитанции).
func (s *Service) UpdateViews(project string) (jobs.Info, error) {
	info := Info{Label: textUpdateViewsJobTitle, Tool: "update_scene_views"}
	return s.jobs.Start(jobs.Spec{Kind: jobs.KindTool, Title: textUpdateViewsJobTitle, Project: project,
		Steps: []jobs.Step{step(project, info, Options{}, false)}})
}

// trimReason — обрезка причины сбоя по краям: пробельные символы Unicode и BOM, кроме U+0085;
// от неё зависит текст причины задания.
func trimReason(text string) string {
	return strings.TrimFunc(text, func(r rune) bool { return r == 0xFEFF || (r != '\u0085' && unicode.IsSpace(r)) })
}
