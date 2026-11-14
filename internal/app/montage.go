package app

import (
	"context"
	"encoding/json"
	"errors"
	"songframe/internal/projectgit"

	"github.com/wailsapp/wails/v3/pkg/application"

	"songframe/internal/dynvalue"
	"songframe/internal/jobs"
	"songframe/internal/montage"
	"songframe/internal/scenarioworkflow"
	"songframe/internal/wire"
)

// MontageService реализует window.api.montage страницы ручного монтажа (маршруты montage:*):
// каталог материалов, черновики, экспорт пробы, применение к сценам и сохранение
// готовой пробы MP4 через системный диалог. Логика — в internal/montage; применение к файлам
// сцен выполняет задание apply_montage (internal/applymontage). Черновик приходит и уходит сырым
// JSON (json.RawMessage, в bindings — any): неизвестные поля и порядок ключей сохраняются.
type MontageService struct {
	montage  *montage.Service
	workflow *scenarioworkflow.Workflow
	// saveDialog — системный диалог сохранения MP4 для окна вызова; nil до ConfigureMontageDesktop.
	saveDialog func(window application.Window) (string, error)
}

// NewMontageService связывает монтаж с менеджером заданий (шаги build_review и apply_montage идут
// через tools.RunContext) и сценарным проходом для reviewProblem; workflow nil — проверки нет.
func NewMontageService(manager *jobs.Manager, workflow *scenarioworkflow.Workflow) *MontageService {
	return &MontageService{montage: montage.New(manager), workflow: workflow}
}

// ConfigureMontageDesktop подключает системный диалог сохранения готового приложения Wails.
// Диалог привязывается к окну, из которого пришёл вызов SaveVideo (главное или окно плеера).
func ConfigureMontageDesktop(s *MontageService, desktop *application.App) {
	s.saveDialog = func(window application.Window) (string, error) {
		return desktop.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
			Title: textSaveMontageVideo, Filename: montageVideoName, Window: window,
			Filters: []application.FileFilter{{DisplayName: textMontageVideoFilter, Pattern: "*.mp4"}},
		}).PromptForSingleSelection()
	}
}

// Тексты диалога сохранения пробы и имя файла по умолчанию.
const (
	textSaveMontageVideo   = "Сохранить видеопробу"
	textMontageVideoFilter = "Видео MP4"
	montageVideoName       = "Монтажная проба.mp4"
)

// View — montage:view: каталог сцен, источников, строк песни и сохранённых черновиков. При
// неутверждённом сценарии (reviewProblem) проблема добавляется к виду и становится blockedReason:
// страница заранее выключает применение, в котором Apply откажет, а правка, сохранение и проба
// остаются доступны.
func (s *MontageService) View(project string) (*montage.View, error) {
	view, err := montage.ViewProject(project)
	if err != nil {
		return wire.Done(view, err)
	}
	if problem := reviewProblem(s.workflow, project); problem != "" {
		view.Problems = append(view.Problems, problem)
		view.BlockedReason = &problem
	}
	return wire.Done(view, nil)
}

// Load — montage:load: сохранённый черновик plan/montage/<id>.json после проверки.
func (s *MontageService) Load(project, id string) (json.RawMessage, error) {
	value, err := montage.Load(project, id)
	if err != nil {
		return nil, err
	}
	return wire.Done(dynvalue.Raw(value), nil)
}

// Remove удаляет сохранённый черновик; принятые сцены и история применения остаются.
func (s *MontageService) Remove(project, id string) error {
	return montage.RemoveDraft(project, id)
}

// Save — montage:save: незавершённый черновик в plan/montage/<id>.json; id nil — новый UUID.
func (s *MontageService) Save(project string, draft json.RawMessage, id *string) (montage.Saved, error) {
	value, err := montage.ParseDraft(draft)
	if err != nil {
		return montage.Saved{}, err
	}
	return wire.Done(montage.Save(project, value, id))
}

// Export — montage:export: полный черновик и рецепт пробы в plan/batches/review-manual-<uuid>,
// задание сборки build_review; video — путь будущего MP4 от корня проекта.
func (s *MontageService) Export(project string, draft json.RawMessage) (montage.Export, error) {
	value, err := montage.ParseDraft(draft)
	if err != nil {
		return montage.Export{}, err
	}
	return wire.Done(s.montage.Export(project, value))
}

// Apply — montage:apply: при неутверждённом сценарии (reviewProblem) отказ до проверки черновика,
// иначе задание apply_montage по снимку текущих реестра и манифестов.
func (s *MontageService) Apply(project string, draft json.RawMessage) (jobs.Info, error) {
	if problem := reviewProblem(s.workflow, project); problem != "" {
		return jobs.Info{}, errors.New(problem)
	}
	value, err := montage.ParseDraft(draft)
	if err != nil {
		return jobs.Info{}, err
	}
	projectgit.Before(context.Background(), project, projectgit.OperationMontageApply)
	return wire.Done(s.montage.Apply(project, value))
}

// SaveVideo — montage:saveVideo: готовая проба проверяется до диалога (рецепт build_review с SHA
// и числом кадров), затем копируется в выбранный пользователем MP4 вне source/assets/plan.
// Отмена диалога — nil без ошибки.
func (s *MontageService) SaveVideo(ctx context.Context, project, video string) (*string, error) {
	source, err := montage.VideoPath(project, video)
	if err != nil {
		return nil, err
	}
	if s.saveDialog == nil {
		return nil, errors.New("нативное приложение ещё не запущено")
	}
	destination, err := s.saveDialog(window(ctx))
	if err != nil || destination == "" {
		return nil, err
	}
	target, err := montage.CopyVideo(project, source, destination)
	if err != nil {
		return nil, err
	}
	return &target, nil
}
