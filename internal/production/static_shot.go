package production

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/jobs"
	"songframe/internal/sceneviews"
	"songframe/internal/spend"
	"songframe/internal/staticshot"
)

// StaticShot — шаг «Сборка» попытки плана из опор (staticshot.Read) с идущим заданием этой
// попытки, если оно есть. Только чтение.
func (s *Service) StaticShot(project, packageDir string) (staticshot.View, error) {
	directory, err := checkedPackage(project, packageDir)
	if err != nil {
		return staticshot.View{}, err
	}
	view, err := staticshot.Read(project, directory)
	if err != nil {
		return staticshot.View{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if id := s.packageJobs[directory]; s.running(id) {
		view.JobID = id
	}
	return view, nil
}

// SaveStaticRecipe — моменты смены и параметры сборки попытки; пакет должен быть свободен.
func (s *Service) SaveStaticRecipe(project, packageDir string, recipe staticshot.Recipe) (staticshot.View, error) {
	directory, release, err := s.claim(project, packageDir)
	if err != nil {
		return staticshot.View{}, err
	}
	defer release()
	return staticshot.SaveRecipe(project, directory, recipe)
}

// BuildStatic — задание «Сборка Mxx»: предпросмотр плана из опор из утверждённых опор по
// рецепту попытки. Задание отмечается за пакетом: до его конца другие операции получают «пакет
// занят». Пишет только static/ попытки.
func (s *Service) BuildStatic(project, packageDir string) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return jobs.Info{}, err
	}
	view, err := staticshot.Read(project, directory)
	if err != nil {
		return jobs.Info{}, err
	}
	if view.Problem != "" {
		return jobs.Info{}, errors.New(view.Problem)
	}
	step := jobs.Step{
		Tool: "static_shot", Label: textStaticBuildStep,
		Run: func(ctx context.Context, step *jobs.StepContext) error {
			_, err := staticshot.Build(ctx, project, directory, func(line string) { step.Log(line + "\n") })
			if ctx.Err() != nil {
				return &jobs.StepError{Code: -1, Message: jobs.StoppedMessage, Err: ctx.Err()}
			}
			return err
		},
	}
	info, err := s.start(jobs.KindTool, textStaticBuildJob(view.Shot), project, []jobs.Step{step})
	if err != nil {
		return jobs.Info{}, err
	}
	s.packageJobs[directory] = info.ID
	return info, nil
}

// AcceptStatic — задание «Приёмка Mxx» плана из опор: свежий предпросмотр становится комплектом
// static_video, представления сцены обновляются, попытки плана удаляются (их расход сначала
// переносится в журнал). Замена принятого комплекта — только с явным согласием replace.
func (s *Service) AcceptStatic(project, shot, packageDir string, replace bool) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := s.availableLocked(project, packageDir)
	if err != nil {
		return jobs.Info{}, err
	}
	view, err := staticshot.Read(project, directory)
	if err != nil {
		return jobs.Info{}, err
	}
	if view.Shot != shot {
		return jobs.Info{}, errors.New(textPackageShotMismatch)
	}
	if view.Preview == nil || !view.Preview.Fresh {
		return jobs.Info{}, errors.New(textStaticPreviewRequired)
	}
	accepted := dynvalue.Exists(filepath.Join(project, "assets", "shots", shot, "manifest.json"))
	if accepted && !replace {
		return jobs.Info{}, errors.New(textReplacementConsentRequired)
	}
	label := textMoveAssetsStep
	if accepted {
		label = textReplaceAssetsStep
	}
	step := jobs.Step{
		Tool: "static_shot", Label: label,
		Before: func(context.Context) error { return spend.Sync(project) },
		Run: func(ctx context.Context, step *jobs.StepContext) error {
			result, err := staticshot.Accept(ctx, project, directory, staticshot.AcceptOptions{Replace: accepted, Clean: true})
			if err != nil {
				return err
			}
			if warnings, ok := result.Value("warnings").([]any); ok {
				for _, warning := range warnings {
					step.Log(fmt.Sprint(warning) + "\n")
				}
			}
			if views := sceneviews.Run(project, []string{}); views.Code != 0 {
				return &jobs.StepError{Code: views.Code, Message: dynvalue.Trim(string(views.Stderr))}
			}
			return nil
		},
	}
	info, err := s.start(jobs.KindAccept, textAcceptJob(shot), project, []jobs.Step{step})
	if err != nil {
		return jobs.Info{}, err
	}
	s.packageJobs[directory] = info.ID
	return info, nil
}
