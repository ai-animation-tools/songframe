package app

import (
	"context"
	"errors"

	"songframe-go/internal/agents"
	"songframe-go/internal/components"
	"songframe-go/internal/tools"
	"songframe-go/internal/videoreview"
	"songframe-go/internal/wire"
)

// VideoReviewService реализует window.api.videoReview: проверку полученного видео агентом без
// автоматического принятия. Состояние (подготовки кадров) принадлежит videoreview.Service; запуск
// дополнительно проверяет явный выбор и доступность агента (KindAgent).
type VideoReviewService struct {
	review *videoreview.Service
	access *agents.AccessChecker
}

// NewVideoReviewService связывает группу с доменным сервисом и общей проверкой доступа ИИ.
func NewVideoReviewService(review *videoreview.Service, access *agents.AccessChecker) *VideoReviewService {
	return &VideoReviewService{review: review, access: access}
}

// View — сохранённое состояние проверки пакета; агента и FFmpeg не запускает.
func (s *VideoReviewService) View(project, packageDir string) (videoreview.View, error) {
	return wire.Done(s.review.View(project, packageDir))
}

// Start проверяет доступ к агенту и запускает подготовку кадров; агент стартует после неё.
func (s *VideoReviewService) Start(ctx context.Context, project, packageDir string) (videoreview.View, error) {
	selected := project
	if err := s.access.RequireAccess(ctx, &selected, agents.KindAgent); err != nil {
		return videoreview.View{}, err
	}
	return wire.Done(s.review.Start(project, packageDir))
}

// Cancel останавливает подготовку и задание агента пакета.
func (s *VideoReviewService) Cancel(project, packageDir string) (videoreview.View, error) {
	return wire.Done(s.review.Cancel(project, packageDir))
}

// ServiceShutdown останавливает идущие подготовки при закрытии приложения: их итог записывается
// как «остановлено», при следующем открытии проверку можно запустить заново.
func (s *VideoReviewService) ServiceShutdown() error {
	s.review.Shutdown()
	return nil
}

// VideoReviewTools — пара FFmpeg/ffprobe менеджера компонентов (выбранная, управляемая или из
// PATH). Обнаружение — только состояние менеджера, без запуска программ.
func VideoReviewTools(manager *components.Manager) func() (videoreview.Tools, bool) {
	return func() (videoreview.Tools, bool) {
		for _, component := range manager.State().Components {
			if component.ID == "ffmpeg" {
				pair := videoreview.Tools{FFmpeg: component.Paths["ffmpeg"], FFprobe: component.Paths["ffprobe"]}
				return pair, pair.FFmpeg != "" && pair.FFprobe != ""
			}
		}
		return videoreview.Tools{}, false
	}
}

// VideoReviewBudget — бюджет изображений проверки выбранного текстового агента (Codex, если агент
// не выбран).
func VideoReviewBudget(settings *agents.SettingsStore) func() int {
	return func() int {
		provider := agents.Codex
		if config, err := settings.Agent(); err == nil && config != nil && agents.IsProvider(config.Provider) {
			provider = config.Provider
		}
		return agents.Providers[provider].ReviewImageBudgetBytes
	}
}

// ContinuityBrief — continuity_brief <shot> --phase <phase> --json через общий tools.run: инструмент
// зарегистрирован в internal/tools, отказ вызова или ненулевой код завершают подготовку его текстом.
func ContinuityBrief(_ context.Context, project, shot, phase string) (string, error) {
	result, err := tools.Run(project, "continuity_brief", []string{shot, "--phase", phase, "--json"})
	if err != nil {
		return "", err
	}
	if result.Code == nil || *result.Code != 0 {
		return "", errors.New(result.Stderr)
	}
	return result.Stdout, nil
}
