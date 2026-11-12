package animatic

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"

	"songframe/internal/dynvalue"
	"songframe/internal/jobs"
	"songframe/internal/tools"
)

// Тексты задания сборки и уведомления о проверке аниматика.
const (
	textUpdateViewsStep = "карточки и представления"
	textCheckInputsStep = "проверка входов"
	textBuildStep       = "сборка аниматика"
	textBuildTitle      = "Сборка аниматика"
	textCheckTitle      = "Проверка входов аниматика"
	textJobNotCreated   = "Менеджер заданий не подключён: задание не создано."
	textFragmentStep    = "сборка фрагмента"
	textShotInvalid     = "Неверный номер плана фрагмента."
)

// textFragmentTitle — заголовок задания фрагмента: один план или диапазон.
func textFragmentTitle(from, to string) string {
	if from == to {
		return "Фрагмент аниматика " + from
	}
	return "Фрагмент аниматика " + from + "–" + to
}

// shotID — номер плана реестра; иное значение не передаётся инструменту, чтобы не стать его опцией.
var shotID = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)

// Runner — запуск инструмента комплекса по имени (tools.RunContext); тесты подменяют его.
type Runner func(ctx context.Context, project, name string, args []string) (tools.Result, error)

// Service — сборка аниматика заданием менеджера. Сам ничего не пишет
// в проект; файлы меняют инструменты шагов (update_scene_views, build_animatic).
type Service struct {
	// start — Manager.Start; nil — менеджер не подключён. Тесты эталона подменяют его записью
	// аргументов задания.
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

// Fragment — задание просмотра планов from…to под участок песни: обновить карточки и
// представления, затем build_animatic --from --to. Это не сборка аниматика: вид задания tool,
// latest и принятие не меняются, страница «Аниматик» его не показывает.
func (s *Service) Fragment(project, from, to string) (jobs.Info, error) {
	if info, err := os.Stat(filepath.Join(project, "plan", "scenes.json")); err != nil || !info.Mode().IsRegular() {
		return jobs.Info{}, errors.New(scenarioRequired)
	}
	if !shotID.MatchString(from) || !shotID.MatchString(to) {
		return jobs.Info{}, errors.New(textShotInvalid)
	}
	if s.start == nil {
		return jobs.Info{}, errors.New(textJobNotCreated)
	}
	steps := []jobs.Step{
		s.toolStep(project, "update_scene_views", []string{}, textUpdateViewsStep),
		s.toolStep(project, "build_animatic", []string{"--from", from, "--to", to}, textFragmentStep),
	}
	return s.start(jobs.Spec{Kind: jobs.KindTool, Title: textFragmentTitle(from, to), Project: project, Steps: steps})
}

// toolStep — шаг, запускающий инструмент: вывод уходит в журнал задания, ненулевой код — сбой с
// причиной из stderr (иначе stdout), как у остальных шагов-инструментов; отмена — StoppedMessage.
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
			message := dynvalue.Trim(result.Stderr)
			if message == "" {
				message = dynvalue.Trim(result.Stdout)
			}
			return &jobs.StepError{Code: *result.Code, Message: message}
		},
	}
}
