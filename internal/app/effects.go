package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"songframe/internal/effects"
	"songframe/internal/jobs"
	"songframe/internal/shoteffects"
)

// EffectsService реализует window.api.effects (страница «Эффекты»): принятые планы с их эффектами,
// схема эффектов, превью кадра, рендер ролика с эффектом заданием и снятие эффекта. Логика и файлы
// — в internal/shoteffects; сервис только ведёт задания рендера, по одному на план.
type EffectsService struct {
	manager *jobs.Manager
	mu      sync.Mutex
	// running — задание рендера по ключу «реальный путь проекта + план»: повторный запуск и снятие
	// эффекта во время рендера получают понятный отказ, открытая заново страница видит задание.
	running map[string]string
}

// NewEffectsService связывает страницу с менеджером заданий.
func NewEffectsService(manager *jobs.Manager) *EffectsService {
	return &EffectsService{manager: manager, running: map[string]string{}}
}

// EffectKind — эффект для панели параметров: идентификатор, название, подсказка «когда и зачем»,
// схема параметров и параметр наклона, который можно считать из ветра ("" — эффект от ветра не зависит).
type EffectKind struct {
	ID        string              `json:"id"`
	Title     string              `json:"title"`
	Hint      string              `json:"hint"`
	Params    []effects.ParamSpec `json:"params"`
	WindAngle string              `json:"windAngle"`
}

// EffectShot — принятый план страницы с идущим заданием рендера ("" — задания нет).
type EffectShot struct {
	shoteffects.Shot
	JobID string `json:"jobId"`
}

// EffectsView — effects:view.
type EffectsView struct {
	Kinds []EffectKind `json:"kinds"`
	Shots []EffectShot `json:"shots"`
}

const textEffectBusy = "Эффект плана сейчас пересчитывается: дождитесь конца задания."

func textEffectJob(shot string) string { return fmt.Sprintf("Эффект %s", shot) }

// key — ключ задания плана: реальный путь проекта и план.
func (s *EffectsService) key(project, shot string) string {
	root, err := filepath.EvalSymlinks(project)
	if err != nil {
		root = project
	}
	return filepath.Clean(root) + "\x00" + shot
}

// busyLocked — идущее задание рендера плана; "" — нет.
func (s *EffectsService) busyLocked(key string) string {
	id := s.running[key]
	if id == "" || s.manager == nil {
		return ""
	}
	if info, found := s.manager.Get(id); found && info.Status == jobs.StatusRunning {
		return id
	}
	delete(s.running, key)
	return ""
}

// View — effects:view: эффекты из реестра и принятые планы проекта по порядку сценария.
func (s *EffectsService) View(project string) (EffectsView, error) {
	shots, err := shoteffects.List(project)
	if err != nil {
		return EffectsView{}, err
	}
	view := EffectsView{Kinds: []EffectKind{}, Shots: make([]EffectShot, 0, len(shots))}
	for _, kind := range effects.Kinds() {
		view.Kinds = append(view.Kinds, EffectKind{ID: kind.ID, Title: kind.Title, Hint: kind.Hint, Params: kind.Params, WindAngle: kind.WindAngle})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, shot := range shots {
		view.Shots = append(view.Shots, EffectShot{Shot: shot, JobID: s.busyLocked(s.key(project, shot.State.Shot))})
	}
	return view, nil
}

// Preview — effects:preview: кадр frame принятого видео плана с цепочкой steps, JPEG data: URL
// шириной width. Ничего не пишет.
func (s *EffectsService) Preview(project, shot string, steps []shoteffects.Step, frame, width int) (string, error) {
	return shoteffects.Preview(context.Background(), project, shot, steps, frame, width)
}

// Render — effects:render: задание «Эффект Mxx» — ролик с цепочкой steps поверх принятого видео,
// рецепт и ролик в assets/effects/Mxx/. Ошибки рецепта видны сразу, до запуска задания.
func (s *EffectsService) Render(project, shot string, steps []shoteffects.Step) (jobs.Info, error) {
	if s.manager == nil {
		return jobs.Info{}, errors.New("менеджер заданий не создан")
	}
	if _, err := shoteffects.Apply(project, shot, steps); err != nil {
		return jobs.Info{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := s.key(project, shot)
	if s.busyLocked(key) != "" {
		return jobs.Info{}, errors.New(textEffectBusy)
	}
	step := jobs.Step{
		Tool: "shot_effects", Label: textEffectJob(shot),
		Run: func(ctx context.Context, step *jobs.StepContext) error {
			_, err := shoteffects.Render(ctx, project, shot, steps, func(line string) { step.Log(line + "\n") })
			if ctx.Err() != nil {
				return &jobs.StepError{Code: -1, Message: jobs.StoppedMessage, Err: ctx.Err()}
			}
			return err
		},
	}
	info, err := s.manager.Start(jobs.Spec{Kind: jobs.KindTool, Title: textEffectJob(shot), Project: project, Steps: []jobs.Step{step}})
	if err != nil {
		return jobs.Info{}, err
	}
	s.running[key] = info.ID
	return info, nil
}

// Remove — effects:remove: эффект плана убирается, монтаж снова берёт принятое видео.
func (s *EffectsService) Remove(project, shot string) (EffectsView, error) {
	s.mu.Lock()
	busy := s.busyLocked(s.key(project, shot)) != ""
	s.mu.Unlock()
	if busy {
		return EffectsView{}, errors.New(textEffectBusy)
	}
	if err := shoteffects.Remove(project, shot); err != nil {
		return EffectsView{}, err
	}
	return s.View(project)
}
