package productionworkflow

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"songframe/internal/agents"
	"songframe/internal/derivedshot"
	"songframe/internal/mediaproviders"
	"songframe/internal/requestsnapshot"
	"songframe/internal/shotworkflow"
)

// ownVideoRequest — папка пакета своего видео внутри новой попытки.
const ownVideoRequest = "request-01"

// CreateOwnVideo создаёт попытку своего видео плана: новая папка Mxx-attempt-NN (shot_workflow
// init даёт окно и отпечаток постановки), пакет ручной генерации без промпта и входов с провайдером
// способа «вручную вне приложения» и этап request_choice. Видео в неё загружает production
// AttachManual, после чего попытка идёт к результату и приёмке, как ручная генерация. Описание, опоры
// и видеопромпт не нужны: это выбор пользователя, который сделал видео сам. Производный план, занятый
// план, неприменённое предложение и неутверждённый сценарий отклоняются; неполные настройки видео
// проекта не мешают — сервис здесь не участвует. Возвращает папку попытки; при ошибке после init
// недособранная попытка удаляется.
func (w *Workflow) CreateOwnVideo(ctx context.Context, project, shot string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, err := ReadContext(project, shot, "")
	if err != nil {
		return "", err
	}
	switch {
	case c.DerivedFrom != "":
		return "", errors.New(derivedshot.Reason(c.DerivedFrom))
	case w.busy[key(c.Project, shot)] || slices.ContainsFunc(w.options.Agents.List(c.Project), func(job agents.Job) bool { return job.Status == "running" }):
		return "", errors.New(textOperationBusy)
	case w.store.Read(c.Project, shot).active():
		return "", errors.New(textResolveProposalFirstError)
	case !w.options.IsScenarioApproved(c.Project):
		return "", errors.New(textApproveScenarioFirst)
	}
	if index := slices.IndexFunc(c.Problems, func(problem string) bool { return !strings.HasPrefix(problem, textVideoSettingsIncomplete) }); index >= 0 {
		return "", errors.New(c.Problems[index])
	}
	provider := mediaproviders.ManualID()
	if provider == "" {
		return "", errors.New(textOwnVideoUnavailable)
	}
	directory := nextPackage(c.Project, shot)
	if err := w.run(ctx, c.Project, "shot_workflow", "init", shot, "--dir", directory, "--mode", "shot"); err != nil {
		return "", err
	}
	if _, err := requestsnapshot.PrepareManual(filepath.Join(directory, ownVideoRequest), requestsnapshot.ManualSpec{
		Shot: shot, Provider: provider, OwnVideo: true,
	}); err != nil {
		_ = os.RemoveAll(directory)
		return "", err
	}
	if err := shotworkflow.StartOwnVideo(directory, ownVideoRequest); err != nil {
		_ = os.RemoveAll(directory)
		return "", err
	}
	return directory, nil
}
