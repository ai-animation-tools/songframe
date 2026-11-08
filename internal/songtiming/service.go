package songtiming

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"songframe/internal/components"
	"songframe/internal/jobs"
	"songframe/internal/timing"
)

// Тексты songTimingTexts (frontend/src/shared/texts/song-timing.ts).
const (
	textTimingDownload  = "Загрузка модели уточнения границ"
	textTimingMissing   = "Для разметки по вокалу установите модель уточнения границ и явно выберите готовый вокал."
	textTimingVocals    = "Сначала выделить вокал"
	textJobTitle        = "Разметка трека"
	textTimingCancelled = "Разметка остановлена пользователем."
	textNoJob           = "Задание разметки не найдено. Закройте окно и обновите страницу."
	textTimingBusy      = "Разметка этого трека уже выполняется."
	textTimingSource    = "Сначала сохраните MP3 и текст песни на странице «Исходники»."
)

// SongModelID — модель комплекта уточнения границ в JobInfo.modelDownload (SONG_MODEL_ID).
const SongModelID = "song-timing-v1"

// Операции менеджера компонентов, которые нужны заданиям.
const (
	operationSeparate = "prepare-vocals"
	operationAlign    = "ctc-existing-vocals"
)

// Наборы компонентов операций: выделению — FFmpeg, ORT и Voc FT; выравниванию — FFmpeg/ffprobe,
// ORT и CTC-модель со словарём. Порядок — порядок загрузки.
var (
	separationComponents = []string{"ffmpeg", "ort-cpu", "voc-ft"}
	alignmentComponents  = []string{"ffmpeg", "ort-cpu", "ctc-ru", "ctc-vocab"}
)

// stepTimeout — лимит шага выделения и разметки.
const stepTimeout = 90 * time.Minute

// Components — часть менеджера компонентов, нужная разметке (в тестах — заглушка).
type Components interface {
	State() components.Snapshot
	Check(ctx context.Context, operations []string, force bool) (components.Snapshot, error)
	Download(ctx context.Context, ids []string) (components.InstallSnapshot, error)
	Installation() components.InstallSnapshot
	CancelInstall()
	Catalog() []components.InstallPackage
}

// SongModelSetup — комплект уточнения границ (SongModelSetup frontend): каталог управляемых
// компонентов, готовность и объём недостающей загрузки.
type SongModelSetup struct {
	Directory  string `json:"directory"`
	Installed  bool   `json:"installed"`
	TotalBytes int64  `json:"totalBytes"`
}

// GenerateOptions — TimingGenerateOptions. Reset — разметить заново без переноса подтверждённых
// строк. Vocals остаётся в контракте, но выбора не даёт: разметка всегда идёт по выбранному
// готовому вокалу.
type GenerateOptions struct {
	Vocals bool `json:"vocals,omitempty"`
	Reset  bool `json:"reset,omitempty"`
}

// Service — локальная разметка трека: задания выделения вокала, выравнивания и загрузки
// компонентов в общем менеджере заданий. Поле running отличает свои задания для Cancel и
// хранит причину отмены. mu сериализует проверку «уже выполняется» с запуском задания:
// двойной клик не создаёт второе задание проекта.
type Service struct {
	jobs       *jobs.Manager
	components Components
	// recheck запрашивает фоновую проверку компонентов после загрузки, чтобы окна увидели итог.
	recheck func()
	profile string
	store   *Store

	mu      sync.Mutex
	running map[string]string
}

// New создаёт сервис. profile — каталог состояния приложения (кэш вокала и emissions).
func New(manager *jobs.Manager, parts Components, profile string, recheck func()) *Service {
	if recheck == nil {
		recheck = func() {}
	}
	return &Service{jobs: manager, components: parts, recheck: recheck, profile: profile, store: NewStore(profile), running: map[string]string{}}
}

// managedDirectory — каталог управляемых компонентов: выбор пользователя или <профиль>/components.
func (s *Service) managedDirectory() string {
	if directory := s.components.State().Selection.ManagedDirectory; directory != "" {
		return directory
	}
	return filepath.Join(s.profile, "components")
}

// needsDownload — компонент отсутствует или его файлы неисправны: помочь может только загрузка.
func needsDownload(status string) bool {
	switch status {
	case "missing", "incompatible", "error", "cancelled":
		return true
	}
	return false
}

// missing — компоненты набора, которые нужно скачать.
func (s *Service) missing(ids []string) []string {
	states := map[string]string{}
	for _, state := range s.components.State().Components {
		states[state.ID] = state.Status
	}
	var result []string
	for _, id := range ids {
		if needsDownload(states[id]) {
			result = append(result, id)
		}
	}
	return result
}

// setup — готовность набора и размер загрузки: сумма недостающих пакетов, а у готового
// набора — полный размер (подсказка о занимаемом месте).
func (s *Service) setup(ids []string) (bool, int64) {
	missing := s.missing(ids)
	sizes := map[string]int64{}
	for _, item := range s.components.Catalog() {
		sizes[item.Component] = item.Bytes
	}
	counted := missing
	if len(missing) == 0 {
		counted = ids
	}
	var total int64
	for _, id := range counted {
		total += sizes[id]
	}
	return len(missing) == 0, total
}

// SongModelSetup — songModelSetup: комплект CTC-выравнивания.
func (s *Service) SongModelSetup() SongModelSetup {
	installed, total := s.setup(alignmentComponents)
	return SongModelSetup{Directory: s.managedDirectory(), Installed: installed, TotalBytes: total}
}

// vocalModels — состояние новых моделей выделения (только Voc FT).
func (s *Service) vocalModels() []VocalModelStatus {
	installed, total := s.setup(separationComponents)
	model := knownModels[0]
	return []VocalModelStatus{{ID: model.ID, Label: model.Label, Installed: installed, TotalBytes: total}}
}

// VocalsView — vocalsView: готовые варианты вокала трека проекта без записи в проект.
func (s *Service) VocalsView(project string) VocalPreparationView {
	return s.store.View(project, s.vocalModels())
}

// SelectVocal — selectVocal: явный выбор варианта для разметки.
func (s *Service) SelectVocal(project, id string) (VocalPreparationView, error) {
	if err := s.store.Select(project, id); err != nil {
		return VocalPreparationView{}, err
	}
	return s.VocalsView(project), nil
}

// DeleteVocal перемещает вариант вокала в корзину ОС; занятый заданием вокал не удаляется.
func (s *Service) DeleteVocal(project, id string, discard func(string) error) (VocalPreparationView, error) {
	if err := s.store.Delete(project, id, s.projectBusy(project), discard); err != nil {
		return VocalPreparationView{}, err
	}
	return s.VocalsView(project), nil
}

// projectBusy — у проекта выполняется выделение вокала или разметка.
func (s *Service) projectBusy(project string) bool {
	for _, job := range s.jobs.List() {
		if job.Status != jobs.StatusRunning || job.Project == nil || *job.Project != project {
			continue
		}
		for _, step := range job.Steps {
			if step.Tool == "align_lyrics" || step.Tool == "separate_vocals" {
				return true
			}
		}
	}
	return false
}

// DownloadVocalModel — downloadVocalModel: загрузка недостающих компонентов выделения вокала.
func (s *Service) DownloadVocalModel(model string) (jobs.Info, error) {
	if model != knownModels[0].ID {
		return jobs.Info{}, errors.New(textModelUnknown)
	}
	return s.download(model, textVocalDownload(knownModels[0].Label), separationComponents, textVocalCancelled)
}

// DownloadSongModels — downloadSongModels: загрузка недостающих компонентов уточнения границ.
func (s *Service) DownloadSongModels() (jobs.Info, error) {
	return s.download(SongModelID, textTimingDownload, alignmentComponents, textTimingCancelled)
}

// download запускает (или возвращает уже идущую) загрузку набора через менеджер компонентов.
// Загрузка устанавливает закреплённые пакеты в управляемый каталог и подключает их; отмена
// задания отменяет установку, опубликованные целиком пакеты остаются.
func (s *Service) download(model, title string, ids []string, cancelled string) (jobs.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, job := range s.jobs.List() {
		if job.Status == jobs.StatusRunning && job.ModelDownload != nil && job.ModelDownload.Model == model {
			return job, nil
		}
	}
	directory := s.managedDirectory()
	run := func(ctx context.Context, step *jobs.StepContext) error {
		defer s.recheck()
		missing := s.missing(ids)
		if len(missing) == 0 {
			step.Log("Компоненты уже установлены.\n")
			return nil
		}
		step.Log("Загружаем: " + strings.Join(missing, ", ") + "\n")
		stop := context.AfterFunc(ctx, s.components.CancelInstall)
		defer stop()
		done := make(chan struct{})
		var logging sync.WaitGroup
		logging.Add(1)
		// Последние строки журнала установки попадают в журнал задания до его завершения.
		defer logging.Wait()
		defer close(done)
		// Журнал прошлой установки не повторяется: отсчёт берётся до начала новой.
		written := len(s.components.Installation().Log)
		go func() {
			defer logging.Done()
			s.logInstallation(step, done, written)
		}()
		for {
			_, err := s.components.Download(ctx, missing)
			if errors.Is(err, components.ErrBusy) && ctx.Err() == nil {
				// Менеджер занят проверкой или другой установкой: ждём его, а не отказываем.
				select {
				case <-ctx.Done():
				case <-time.After(time.Second):
				}
				continue
			}
			if err != nil {
				return err
			}
			if left := s.missing(ids); len(left) > 0 {
				return fmt.Errorf("после загрузки не найдены компоненты: %s", strings.Join(left, ", "))
			}
			return nil
		}
	}
	info, err := s.jobs.Start(jobs.Spec{
		Kind:          jobs.KindModelDownload,
		Title:         title,
		Steps:         []jobs.Step{{Tool: "download_song_models", Args: []string{"--component", model, "--output", directory}, Run: run}},
		ModelDownload: &jobs.ModelDownload{Model: model, Directory: directory},
	})
	if err == nil {
		s.running[info.ID] = cancelled
	}
	return info, err
}

// logInstallation переносит изменения журнала установки компонентов в журнал задания.
func (s *Service) logInstallation(step *jobs.StepContext, done <-chan struct{}, written int) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	flush := func() {
		log := s.components.Installation().Log
		if written > len(log) {
			written = 0
		}
		for _, entry := range log[written:] {
			step.Log(entry.Message + "\n")
		}
		written = len(log)
	}
	for {
		select {
		case <-done:
			flush()
			return
		case <-ticker.C:
			flush()
		}
	}
}

// Cancel — cancel: остановка своего задания с причиной, которую увидит пользователь.
func (s *Service) Cancel(id string) (jobs.Info, error) {
	s.mu.Lock()
	reason, ok := s.running[id]
	s.mu.Unlock()
	if !ok {
		return jobs.Info{}, errors.New(textNoJob)
	}
	info, found := s.jobs.Get(id)
	if !found {
		return jobs.Info{}, errors.New(textNoJob)
	}
	if info.Status == jobs.StatusRunning {
		info, _ = s.jobs.Cancel(id, reason)
	}
	return info, nil
}

// threads — потоки ORT: max(1, min(8, число CPU)).
func threads() int { return max(1, min(8, runtime.NumCPU())) }

// ready проверяет операцию менеджером компонентов (ожидая занятый менеджер) и возвращает
// пути готовых компонентов: ключ — "<компонент>/<роль>".
func (s *Service) ready(ctx context.Context, operation string) (map[string]string, error) {
	for {
		_, err := s.components.Check(ctx, []string{operation}, false)
		if errors.Is(err, components.ErrBusy) && ctx.Err() == nil {
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
			continue
		}
		break
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	state := s.components.State()
	for _, op := range state.Operations {
		if op.ID == operation && op.Status != "ready" {
			return nil, fmt.Errorf("Компоненты не готовы: %s", op.Reason)
		}
	}
	paths := map[string]string{}
	for _, component := range state.Components {
		for role, path := range component.Paths {
			paths[component.ID+"/"+role] = path
		}
	}
	return paths, nil
}

// SeparateVocals — separateVocals: новое выделение вокала Voc FT в отдельный каталог кэша.
func (s *Service) SeparateVocals(project, model string) (jobs.Info, error) {
	if model != knownModels[0].ID {
		return jobs.Info{}, errors.New(textModelUnknown)
	}
	label := knownModels[0].Label
	_, digest, err := sourceTrack(project, true)
	if err != nil {
		return jobs.Info{}, err
	}
	if s.store.isDeleting(digest) {
		return jobs.Info{}, errors.New(textDeletePending)
	}
	if installed, _ := s.setup(separationComponents); !installed {
		return jobs.Info{}, errors.New(textModelMissing)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.projectBusy(project) {
		return jobs.Info{}, errors.New(textVocalBusy)
	}
	output, err := s.store.outputPath(digest)
	if err != nil {
		return jobs.Info{}, err
	}
	run := func(ctx context.Context, step *jobs.StepContext) error {
		return s.separate(ctx, step, project, digest, output)
	}
	info, err := s.jobs.Start(jobs.Spec{
		Kind:    jobs.KindTool,
		Title:   textSeparation(label),
		Project: project,
		Steps:   []jobs.Step{{Tool: "separate_vocals", Label: textSeparation(label), Args: []string{"--model", model, "--output", output}, Timeout: stepTimeout, Run: run}},
	})
	if err == nil {
		s.running[info.ID] = textVocalCancelled
	}
	return info, err
}

// Start — start: разметка по выбранному готовому вокалу. Исходный текст проверяется до
// создания задания; выбранный WAV удерживается до завершения задания, включая остановку.
func (s *Service) Start(project string, options GenerateOptions) (jobs.Info, error) {
	view, err := timing.ViewProject(project)
	if err != nil {
		return jobs.Info{}, err
	}
	hasLine := false
	for _, line := range view.Lyrics {
		hasLine = hasLine || (!line.Header && line.Text != "")
	}
	if view.TrackPath == nil || !hasLine {
		return jobs.Info{}, errors.New(textTimingSource)
	}
	text, err := os.ReadFile(filepath.Join(project, "source", "text.md"))
	if err != nil {
		return jobs.Info{}, errors.New(textTimingSource)
	}
	if problems := timing.AnalyzeLyrics(string(text)).Problems; len(problems) > 0 {
		return jobs.Info{}, errors.New(strings.Join(problems, " "))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.projectBusy(project) {
		return jobs.Info{}, errors.New(textTimingBusy)
	}
	if installed, _ := s.setup(alignmentComponents); !installed {
		return jobs.Info{}, errors.New(textTimingMissing)
	}
	resultPath, vocal, sourceSHA, err := s.store.Selected(project)
	if err != nil {
		return jobs.Info{}, err
	}
	release := s.store.Hold(resultPath)
	var watched sync.Mutex
	jobID := ""
	var stop func()
	stop = s.jobs.OnFinished(func(info jobs.Info, _ string) {
		watched.Lock()
		match := info.ID == jobID
		watched.Unlock()
		if match {
			release()
			stop()
		}
	})
	args := []string{"--vocal-result", resultPath}
	if options.Reset {
		args = append(args, "--reset")
	}
	request := alignRequest{project: project, resultPath: resultPath, vocal: vocal, sourceSHA: sourceSHA, reset: options.Reset}
	info, err := s.jobs.Start(jobs.Spec{
		Kind:    jobs.KindTool,
		Title:   textJobTitle,
		Project: project,
		Steps: []jobs.Step{{Tool: "align_lyrics", Label: textTimingVocals, Args: args, Timeout: stepTimeout, Run: func(ctx context.Context, step *jobs.StepContext) error {
			return s.align(ctx, step, request)
		}}},
	})
	if err != nil {
		stop()
		release()
		return jobs.Info{}, err
	}
	watched.Lock()
	jobID = info.ID
	watched.Unlock()
	// Задание могло завершиться до того, как подписчик узнал его ID.
	if current, ok := s.jobs.Get(info.ID); !ok || current.Status != jobs.StatusRunning {
		stop()
		release()
	}
	s.running[info.ID] = textTimingCancelled
	return info, nil
}
