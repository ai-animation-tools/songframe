package animatic

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"songframe-go/internal/jobs"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/tools"
)

// Тексты задания сборки: animaticTexts.main и notificationsTexts.animaticCheckTitle оригинала.
const (
	textUpdateViewsStep = "карточки и представления"
	textCheckInputsStep = "проверка входов"
	textBuildStep       = "сборка аниматика"
	textBuildTitle      = "Сборка аниматика"
	textCheckTitle      = "Проверка входов аниматика"
	textJobNotCreated   = "Менеджер заданий не подключён: задание не создано."
)

// Runner — запуск инструмента комплекса по имени (tools.RunContext); тесты подменяют его.
type Runner func(ctx context.Context, project, name string, args []string) (tools.Result, error)

// Service — класс Animatic оригинала: сборка аниматика заданием менеджера. Сам ничего не пишет
// в проект; файлы меняют инструменты шагов (update_scene_views, build_animatic).
type Service struct {
	// start — Manager.Start; nil — менеджер не подключён. Тесты эталона подменяют его записью
	// аргументов, как подставной jobs.start при съёмке.
	start func(jobs.Spec) (jobs.Info, error)
	run   Runner
}

// NewService создаёт сервис сборки. run == nil — tools.RunContext.
func NewService(manager *jobs.Manager, run Runner) *Service {
	if run == nil {
		run = tools.RunContext
	}
	service := &Service{run: run}
	if manager != nil {
		service.start = manager.Start
	}
	return service
}

// Build — задание из двух шагов: обновить карточки и представления (иначе build_animatic
// остановится на устаревших карточках), затем собрать latest или при planOnly только проверить
// входы (--plan-only). Без plan/scenes.json задание не создаётся: у нового проекта ещё нет сценария.
func (s *Service) Build(project string, planOnly bool) (jobs.Info, error) {
	if info, err := os.Stat(filepath.Join(project, "plan", "scenes.json")); err != nil || !info.Mode().IsRegular() {
		return jobs.Info{}, errors.New(scenarioRequired)
	}
	if s.start == nil {
		return jobs.Info{}, errors.New(textJobNotCreated)
	}
	args, label, title := []string{}, textBuildStep, textBuildTitle
	if planOnly {
		args, label, title = []string{"--plan-only"}, textCheckInputsStep, textCheckTitle
	}
	steps := []jobs.Step{
		s.toolStep(project, "update_scene_views", []string{}, textUpdateViewsStep),
		s.toolStep(project, "build_animatic", args, label),
	}
	return s.start(jobs.Spec{Kind: jobs.KindAnimatic, Title: title, Project: project, Steps: steps})
}

// toolStep — шаг, запускающий инструмент: вывод уходит в журнал задания, ненулевой код — сбой с
// причиной из stderr (иначе stdout), как у шагов Python оригинала; отмена — StoppedMessage.
func (s *Service) toolStep(project, tool string, args []string, label string) jobs.Step {
	return jobs.Step{
		Tool: tool, Label: label, Args: args,
		Run: func(ctx context.Context, step *jobs.StepContext) error {
			result, err := s.run(ctx, project, tool, args)
			if err != nil {
				return err
			}
			step.Log(result.Stdout)
			step.Log(result.Stderr)
			if ctx.Err() != nil || result.Code == nil {
				return &jobs.StepError{Code: -1, Message: jobs.StoppedMessage, Err: ctx.Err()}
			}
			if *result.Code == 0 {
				return nil
			}
			message := jscompat.Trim(result.Stderr)
			if message == "" {
				message = jscompat.Trim(result.Stdout)
			}
			return &jobs.StepError{Code: *result.Code, Message: message}
		},
	}
}
