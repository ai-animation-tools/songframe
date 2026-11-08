package app

import (
	"errors"

	"songframe/internal/animatic"
	"songframe/internal/jobs"
	"songframe/internal/scenarioworkflow"
	"songframe/internal/wire"
)

// AnimaticService реализует window.api.animatic страницы «Аниматик»: вид сборки latest, задание
// сборки или проверки входов и принятие. Логика — в internal/animatic; здесь проверки маршрутов
// и проблема актуальности сценария (reviewProblem): она добавляется к виду и снимает признаки
// свежести, запрещает сборку и принятие, но не возврат на просмотр.
type AnimaticService struct {
	service  *animatic.Service
	workflow *scenarioworkflow.Workflow
}

// NewAnimaticService связывает группу с менеджером заданий (шаги update_scene_views и
// build_animatic идут через tools.RunContext) и сценарным проходом для reviewProblem; workflow
// nil — проверки сценария нет.
func NewAnimaticService(manager *jobs.Manager, workflow *scenarioworkflow.Workflow) *AnimaticService {
	return &AnimaticService{service: animatic.NewService(manager, nil), workflow: workflow}
}

// View — animatic:view: вид сборки; при неутверждённом сценарии сборка и карточки считаются
// несвежими, принятие — не текущим, а проблема становится blockedReason.
func (s *AnimaticService) View(project string) (animatic.View, error) {
	view, err := animatic.ViewAnimatic(project)
	if err != nil {
		return wire.Done(animatic.View{}, err)
	}
	if problem := reviewProblem(s.workflow, project); problem != "" {
		view.Problems = append(view.Problems, problem)
		if view.Built != nil {
			view.Built.Fresh = false
		}
		view.CardsFresh = false
		view.Approval.Current = false
		view.BlockedReason = &problem
	}
	return wire.Done(view, nil)
}

// Build — animatic:build: задание сборки (planOnly — только проверка входов). Неутверждённый
// сценарий останавливает вызов до создания задания.
func (s *AnimaticService) Build(project string, planOnly bool) (jobs.Info, error) {
	if problem := reviewProblem(s.workflow, project); problem != "" {
		return wire.Done(jobs.Info{}, errors.New(problem))
	}
	return wire.Done(s.service.Build(project, planOnly))
}

// SetStatus — animatic:setStatus: status approved принимает текущую свежую сборку, review
// возвращает её на просмотр. Проблема сценария запрещает только принятие.
func (s *AnimaticService) SetStatus(project, status string) (animatic.View, error) {
	if status == "approved" {
		if problem := reviewProblem(s.workflow, project); problem != "" {
			return wire.Done(animatic.View{}, errors.New(problem))
		}
	}
	return wire.Done(animatic.SetStatus(project, status))
}
