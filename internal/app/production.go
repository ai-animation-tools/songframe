package app

import (
	"context"
	"errors"

	"songframe/internal/agents"
	"songframe/internal/dashboard"
	"songframe/internal/jobs"
	"songframe/internal/production"
	"songframe/internal/scenarioworkflow"
	"songframe/internal/speech"
	"songframe/internal/wire"
)

// Тексты ошибок маршрутов производства.
const (
	textPackageBusy            = "Для этого пакета уже выполняется задание. Дождитесь завершения."
	textShotBusy               = "Для этого кадра уже выполняется задание. Дождитесь завершения."
	textScenarioReviewRequired = "Кастинг, трактовка или исходники изменились: проверьте и утвердите актуальный сценарий на странице «Сценарий»."
)

func textScenarioReviewFailed(reason string) string {
	return "Не удалось проверить актуальность сценария: " + reason
}

// ProductionFlow — то, что маршрутам производства нужно от прохода агента производства:
// занятость плана и непринятые предложения агента. nil — прохода нет, планы не
// заняты и предложений нет.
type ProductionFlow interface {
	// Busy — у плана shot (и пакета packageDir, если задан) идёт задание прохода.
	Busy(project, shot, packageDir string) bool
	// Proposals — непринятые предложения агента по планам и подпись «Ждут вашего действия».
	Proposals(project string) map[string]Proposal
}

// Proposal — непринятое предложение агента для плана: сам документ и его подпись внимания.
type Proposal struct {
	Value     []byte
	Attention string
}

// ProductionService реализует window.api.production: просмотр пакетов, ответы на вопросы,
// оценку и одноразовое согласие стоимости, отправку, получение, повтор и приёмку. Состояние
// оценок и заданий принадлежит production.Service; здесь — проверки маршрутов:
// доступ к сохранённому запросу (выбор и вход провайдера), занятость прохода агента и проблема
// актуальности сценария.
type ProductionService struct {
	production *production.Service
	access     *agents.AccessChecker
	workflow   *scenarioworkflow.Workflow
	flow       ProductionFlow
}

// NewProductionService связывает группу с доменным сервисом, проверкой доступа и сценарным
// проходом (для проблемы «проверьте сценарий»); flow — проход агента производства или nil.
func NewProductionService(service *production.Service, access *agents.AccessChecker, workflow *scenarioworkflow.Workflow, flow ProductionFlow) *ProductionService {
	return &ProductionService{production: service, access: access, workflow: workflow, flow: flow}
}

// reviewProblem возвращает проблему актуальности сценария: он требует проверки после правки
// кастинга, трактовки или исходников.
func reviewProblem(workflow *scenarioworkflow.Workflow, project string) string {
	if workflow == nil {
		return ""
	}
	view, err := workflow.View(project)
	if err != nil {
		return textScenarioReviewFailed(err.Error())
	}
	if view.ScenesNeedReview {
		return textScenarioReviewRequired
	}
	return ""
}

// idle — productionIdle: пакет не занят проходом агента производства.
func (s *ProductionService) idle(project, packageDir string) error {
	if s.flow == nil {
		return nil
	}
	view, err := production.ReadPackage(project, packageDir)
	if err == nil && view != nil && s.flow.Busy(project, view.Shot, packageDir) {
		return errors.New(textPackageBusy)
	}
	return nil
}

// packageAccess — requirePackageAccess: выбор и вход провайдера сохранённого запроса.
func (s *ProductionService) packageAccess(ctx context.Context, project, packageDir string) error {
	return production.RequirePackageAccess(ctx, project, packageDir, func(ctx context.Context, project, kind string) error {
		if s.access == nil {
			return nil
		}
		selected := project
		return s.access.RequireAccess(ctx, &selected, kind)
	})
}

// View — production.view: планы, пакеты, сломанные папки и проблемы; непринятые предложения
// агента видны в списке и попадают в «Ждут вашего действия».
func (s *ProductionService) View(project string) (production.View, error) {
	view, err := production.ViewProduction(project)
	if err != nil {
		return wire.Done(view, err)
	}
	if problem := reviewProblem(s.workflow, project); problem != "" {
		view.Problems = append(view.Problems, problem)
	}
	if s.flow != nil {
		proposals := s.flow.Proposals(project)
		for _, shot := range view.Shots {
			if proposal, found := proposals[shot.ID]; found {
				shot.Proposal = proposal.Value
				if shot.Attention == nil && proposal.Attention != "" {
					attention := proposal.Attention
					shot.Attention = &attention
				}
			}
		}
	}
	return wire.Done(view, nil)
}

// Decide — ответ на вопрос пакета (кроме send).
func (s *ProductionService) Decide(project, packageDir, verdict, note, decisionToken, noteScope string) error {
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.Decide(project, packageDir, verdict, note, decisionToken, noteScope)
}

// ReopenFrame — вернуть утверждённую опору на доработку.
func (s *ProductionService) ReopenFrame(project, packageDir, frame, note, noteScope string) error {
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.ReopenFrame(project, packageDir, frame, note, noteScope)
}

// KeepPackageForScene — оставить неотправленный пакет в силе для текущей постановки.
func (s *ProductionService) KeepPackageForScene(project, packageDir string) error {
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.KeepPackageForScene(project, packageDir)
}

// AddKeyframeNote — необязательное указание к опоре до её создания.
func (s *ProductionService) AddKeyframeNote(project, packageDir, frame, note, noteScope string) error {
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.AddKeyframeNote(project, packageDir, frame, note, noteScope)
}

// SetKeyframeNote — включить или снять замечание к опорам.
func (s *ProductionService) SetKeyframeNote(project, packageDir string, id float64, active bool) error {
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.SetKeyframeNote(project, packageDir, id, active)
}

// Quote — оценка стоимости показанного запроса и одноразовый token согласия.
func (s *ProductionService) Quote(ctx context.Context, project, packageDir, expectedSha, decisionToken string) (production.Quote, error) {
	if err := s.packageAccess(ctx, project, packageDir); err != nil {
		return production.Quote{}, err
	}
	if err := s.idle(project, packageDir); err != nil {
		return production.Quote{}, err
	}
	return wire.Done(s.production.Quote(project, packageDir, expectedSha, decisionToken))
}

// Submit — платная отправка по показанной оценке; новое согласие на каждую отправку.
func (s *ProductionService) Submit(ctx context.Context, project, packageDir, expectedSha, decisionToken, quoteToken, unknownCostConsentToken string) (jobs.Info, error) {
	if err := s.packageAccess(ctx, project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	if err := s.idle(project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	return wire.Done(s.production.Submit(project, packageDir, expectedSha, decisionToken, quoteToken, unknownCostConsentToken))
}

// Resume — получение по сохранённому ID задания без новой отправки.
func (s *ProductionService) Resume(ctx context.Context, project, packageDir string) (jobs.Info, error) {
	if err := s.packageAccess(ctx, project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	if err := s.idle(project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	return wire.Done(s.production.Resume(project, packageDir))
}

// AttachResult — неизвестный исход: файл из истории генераций сервиса становится оригиналом.
func (s *ProductionService) AttachResult(ctx context.Context, project, packageDir string, files []string) (jobs.Info, error) {
	if err := s.packageAccess(ctx, project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	if err := s.idle(project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	return wire.Done(s.production.AttachResult(project, packageDir, files))
}

// AttachManual — видео, созданное вне приложения по пакету ручной генерации, становится оригиналом.
// Вход в сервис провайдера не нужен: видео уже создано и только копируется в попытку.
func (s *ProductionService) AttachManual(project, packageDir string, result production.ManualResult) (jobs.Info, error) {
	if err := s.idle(project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	return wire.Done(s.production.AttachManual(project, packageDir, result))
}

// MarkNotCreated — неизвестный исход: генерации нет, попытка снова ждёт подтверждения.
func (s *ProductionService) MarkNotCreated(ctx context.Context, project, packageDir string) error {
	if err := s.packageAccess(ctx, project, packageDir); err != nil {
		return err
	}
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.MarkNotCreated(project, packageDir)
}

// SelectImage — выбор кандидата опоры.
func (s *ProductionService) SelectImage(project, packageDir string, index float64, expectedResultToken string) error {
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.SelectImage(project, packageDir, index, expectedResultToken)
}

// Regenerate — подготовка повтора по сохранённому запросу; выбор провайдера проверяется без входа
// в сервис. Повтор не создаёт пакет одновременно с применением предложения того же кадра.
func (s *ProductionService) Regenerate(project, shot string) (jobs.Info, error) {
	if s.flow != nil && s.flow.Busy(project, shot, "") {
		return jobs.Info{}, errors.New(textShotBusy)
	}
	return wire.Done(s.production.Regenerate(project, shot))
}

// Accept — приёмка полученного видео в assets.
func (s *ProductionService) Accept(project, shot, packageDir string, options production.AcceptOptions) (jobs.Info, error) {
	if err := s.idle(project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	return wire.Done(s.production.Accept(project, shot, packageDir, options))
}

// ContactSheet — техническая сводка пакета: задание contact_sheet с одним шагом.
func (s *ProductionService) ContactSheet(project, packageDir string) (jobs.Info, error) {
	if err := s.idle(project, packageDir); err != nil {
		return jobs.Info{}, err
	}
	return wire.Done(s.production.ContactSheet(project, packageDir))
}

// Park — отложить пакет в очередь.
func (s *ProductionService) Park(project, packageDir string) error {
	if err := s.idle(project, packageDir); err != nil {
		return err
	}
	return s.production.Park(project, packageDir)
}

// speechLimits — длительность запроса пакета и lipSync провайдера видео проекта из реестра.
func speechLimits(project, packageDir string) (speech.Limits, error) {
	seconds, lipSync, err := production.SpeechLimits(project, packageDir)
	limits := speech.Limits{RequestSeconds: seconds}
	if lipSync != nil {
		limits.LipSync = &speech.Range{Min: lipSync.Min, Max: lipSync.Max}
	}
	return limits, err
}

// SpeechPlan — строки песни в окне речевого плана и предложенные границы среза.
func (s *ProductionService) SpeechPlan(project, shot, packageDir string) (speech.Plan, error) {
	limits, err := speechLimits(project, packageDir)
	if err != nil {
		return speech.Plan{}, err
	}
	return wire.Done(speech.PlanFor(project, shot, limits))
}

// PrepareSpeech — точный срез WAV липсинка инструментом cut_speech; прежний срез пакета заменяется.
func (s *ProductionService) PrepareSpeech(project, packageDir string, bounds *production.Bounds) (*production.PackageView, error) {
	if err := s.idle(project, packageDir); err != nil {
		return nil, err
	}
	limits, err := speechLimits(project, packageDir)
	if err != nil {
		return nil, err
	}
	// Без липсинка у провайдера видео создаётся вручную вне приложения: допустимую длину звука
	// приложение не знает и не ограничивает.
	if bounds != nil && limits.LipSync != nil && (bounds.End-bounds.Start < limits.LipSync.Min-1e-6 || bounds.End-bounds.Start > limits.LipSync.Max+1e-6) {
		return nil, errors.New(production.TextSpeechDuration(limits.LipSync.Min, limits.LipSync.Max))
	}
	return wire.Done(s.production.PrepareSpeech(project, packageDir, bounds))
}

// ReopenQuestion — снова задать вопрос о полученном результате.
func (s *ProductionService) ReopenQuestion(project, packageDir string) error {
	return s.production.ReopenQuestion(project, packageDir)
}

// DiscardAttempt — удалить пакет попытки целиком.
func (s *ProductionService) DiscardAttempt(project, packageDir string) error {
	return s.production.DiscardAttempt(project, packageDir)
}

// ExportBundleOptions — ExportBundleOptions контракта.
type ExportBundleOptions struct {
	Target string `json:"target"`
	Copy   bool   `json:"copy"`
}

// ExportBundle — задание сборки пакета для монтажёра в пустую папку; проверок доступа маршрут не
// имеет: пакет собирается из уже принятых материалов без провайдеров.
func (s *ProductionService) ExportBundle(project string, options ExportBundleOptions) (jobs.Info, error) {
	return wire.Done(s.production.ExportBundle(project, options.Target, options.Copy))
}

// ListBundles — собранные пакеты для монтажёра внутри plan/batches.
func (s *ProductionService) ListBundles(project string) ([]production.Bundle, error) {
	return wire.Done(production.ListBundles(project))
}

// RemoveBundle — удаление собранного пакета для монтажёра.
func (s *ProductionService) RemoveBundle(project, path string) error {
	return s.production.RemoveBundle(project, path)
}

// DashboardService реализует window.api.dashboard: карточки планов на странице «Сцены».
type DashboardService struct {
	workflow *scenarioworkflow.Workflow
}

// NewDashboardService — дашборд с проблемой актуальности сценария из сценарного прохода.
func NewDashboardService(workflow *scenarioworkflow.Workflow) *DashboardService {
	return &DashboardService{workflow: workflow}
}

// View — dashboard.view: только чтение файлов проекта.
func (s *DashboardService) View(project string) (dashboard.View, error) {
	view, err := dashboard.ViewDashboard(project)
	if err != nil {
		return wire.Done(view, err)
	}
	if problem := reviewProblem(s.workflow, project); problem != "" {
		view.Problems = append(view.Problems, problem)
	}
	return wire.Done(view, nil)
}
