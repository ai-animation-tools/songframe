package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"songframe/internal/dynvalue"
	"songframe/internal/effects"
	"songframe/internal/jobs"
	"songframe/internal/montage"
	"songframe/internal/production"
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
// схема параметров, параметр наклона, который можно считать из ветра ("" — эффект от ветра не
// зависит), параметры-моменты плана (поля в секундах) и параметры источника и луча, которые
// ставятся мышью на кадре (nil — источника нет).
type EffectKind struct {
	ID        string              `json:"id"`
	Title     string              `json:"title"`
	Hint      string              `json:"hint"`
	Params    []effects.ParamSpec `json:"params"`
	WindAngle string              `json:"windAngle"`
	PlanTime  []string            `json:"planTime"`
	Beam      *effects.Beam       `json:"beam"`
}

// EffectLine — строка песни на шкале времени плана: секунды от начала плана (может начинаться до
// него или кончаться после).
type EffectLine struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// EffectShot — принятый план страницы с идущим заданием рендера ("" — задания нет),
// изображением карточки — первой опорой принятого комплекта, как на «Производстве» ("" — опор
// нет), — и строками песни в окне плана для шкалы моментов эффекта; LyricProblem — почему строк
// нет (разметки нет, трек сменился).
type EffectShot struct {
	shoteffects.Shot
	JobID        string       `json:"jobId"`
	Frame        string       `json:"frame"`
	Lines        []EffectLine `json:"lines"`
	LyricProblem *string      `json:"lyricProblem"`
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
		planTime := append([]string{}, kind.PlanTime...)
		view.Kinds = append(view.Kinds, EffectKind{ID: kind.ID, Title: kind.Title, Hint: kind.Hint, Params: kind.Params, WindAngle: kind.WindAngle, PlanTime: planTime, Beam: kind.Beam})
	}
	lyrics := map[int64]lyricsAt{}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, shot := range shots {
		item := EffectShot{Shot: shot, JobID: s.busyLocked(s.key(project, shot.State.Shot)), Frame: acceptedFrame(project, shot.State.Shot), Lines: []EffectLine{}}
		if fps := shot.State.FPS; fps > 0 && shot.Problem == "" {
			found, ok := lyrics[fps]
			if !ok {
				found.lines, found.problem, err = montage.Lyrics(project, float64(fps))
				if err != nil {
					return EffectsView{}, err
				}
				lyrics[fps] = found
			}
			item.Lines, item.LyricProblem = planLines(found.lines, shot.Start, shot.End, float64(fps)), found.problem
		}
		view.Shots = append(view.Shots, item)
	}
	return view, nil
}

// lyricsAt — строки песни на кадровой оси одной частоты и причина, если строк нет.
type lyricsAt struct {
	lines   []montage.LyricLine
	problem *string
}

// planLines — строки песни, пересекающие окно плана [start, end) секунд песни, в секундах от
// начала плана.
func planLines(lines []montage.LyricLine, start, end, fps float64) []EffectLine {
	result := []EffectLine{}
	for _, line := range lines {
		from, to := line.StartFrame/fps, line.EndFrame/fps
		if to <= start || from >= end {
			continue
		}
		result = append(result, EffectLine{Text: line.Text, Start: from - start, End: to - start})
	}
	return result
}

// acceptedFrame — абсолютный путь первой опоры принятого комплекта плана для карточки списка;
// "" — у комплекта нет изображений-входов (своё видео, производный план) или файла нет. Карточка
// показывает изображение, а не видео: десятки видео в сетке держали бы по декодеру на каждое.
func acceptedFrame(project, shot string) string {
	dir := filepath.Join(project, "assets", "shots", shot)
	manifest, found := dynvalue.ReadJSONFile(filepath.Join(dir, "manifest.json"))
	if !found {
		return ""
	}
	path, ok := dynvalue.Get(production.FirstFrameInput(manifest), "path").(string)
	if !ok || !filepath.IsLocal(filepath.FromSlash(path)) {
		return ""
	}
	full := filepath.Join(dir, filepath.FromSlash(path))
	if info, err := os.Stat(full); err != nil || !info.Mode().IsRegular() {
		return ""
	}
	return full
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
