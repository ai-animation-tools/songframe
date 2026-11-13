package productionworkflow

import (
	"errors"
	"path/filepath"
	"strings"

	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaproviders"
)

// Способ генерации видео попытки: «Провайдер проекта» — запрос и платная отправка
// приложением; «Вручную вне приложения» — пакет ручной генерации из утверждённых опор и
// видеопромпта, видео пользователь создаёт сам и загружает (как у речевого плана без липсинка).
// Выбор хранится в workflow.json попытки ключом generation_method и делается до утверждения
// видеопромпта: промпт пишется под выбранный способ (предел провайдера, обозначения входов).
// Утверждённый промпт выбору не мешает, пока запрос не подготовлен: свой промпт утверждается
// сразу при сохранении, и способ должен оставаться доступным после него. На провайдера
// переводится только промпт в пределах его длины.

// SetGenerationMethod записывает способ генерации попытки packageDir: "manual" или "provider".
// Доступно, пока запрос не подготовлен и попытка не отправлена;
// открытый вопрос о видеопромпте не мешает (промпт сверх предела провайдера вручную утвердить
// можно). Речевой план у провайдера без липсинка всегда делается вручную.
func (w *Workflow) SetGenerationMethod(project, shot, packageDir, method string) (View, error) {
	if method != "manual" && method != "provider" {
		return View{}, errors.New(textStartParametersInvalid)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	view, err := w.view(project, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	if view.PackageDir == nil {
		return View{}, errors.New(textPackageUnavailable)
	}
	c, err := ReadContext(view.Project, shot, *view.PackageDir)
	if err != nil {
		return View{}, err
	}
	if reason, err := methodReason(c, view, method); err != nil || reason != "" {
		if err == nil {
			err = errors.New(reason)
		}
		return View{}, err
	}
	workflow, err := packageDocument(c.PackageDir, textWorkflowMissing)
	if err != nil {
		return View{}, err
	}
	if method == "manual" {
		workflow.Set("generation_method", "manual")
	} else {
		workflow.Delete("generation_method")
	}
	if err := writeProjectJSON(filepath.Join(c.PackageDir, "workflow.json"), workflow); err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, c.PackageDir)
}

// methodReason — почему способ генерации попытки сейчас сменить на method нельзя; "" — можно.
func methodReason(c *Context, view View, method string) (string, error) {
	pending := c.workflowValue("pending_decision")
	stage, _ := c.workflowValue("stage").(string)
	switch {
	case c.DerivedFrom != "":
		return derivedshot.Reason(c.DerivedFrom), nil
	case c.SingleFrame:
		return textMethodSingleFrame, nil
	case mediaproviders.ManualVideo(c.Settings.Value("provider"), false):
		return textMethodProjectManual, nil
	case view.Busy:
		return textOperationBusy, nil
	case proposalOpen(view.Proposal):
		return textResolveProposalFirst, nil
	case c.Paid:
		return textSentAttemptNeedsRetry, nil
	case strings.HasPrefix(stage, "image_"):
		return textResolveImageFirst, nil
	case dynvalue.Truthy(pending) && dynvalue.Get(pending, "stage") != "prompt_review":
		return textResolvePackageQuestionFirst, nil
	case dynvalue.Truthy(c.workflowValue("request_dir")):
		return textMethodRequestReady, nil
	}
	approved, err := c.PromptApproved()
	if err != nil || !approved || method != "provider" {
		return "", err
	}
	// Утверждённый промпт уходит провайдеру как есть: длиннее его предела он не пройдёт.
	// Ручная попытка предела не знает (PromptLimit 0), поэтому предел берётся у провайдера проекта.
	if limit := mediaadapters.PromptLimit(c.Settings.Value("provider")); limit > 0 {
		if chars := int(dynvalue.ToNumber(dynvalue.Get(c.workflowValue("prompt"), "chars"))); chars > limit {
			return textMethodPromptOverLimit(chars, limit), nil
		}
	}
	return "", nil
}

// proposalOpen — у вида есть предложение, ещё не применённое: выбор способа ждёт его решения.
func proposalOpen(raw []byte) bool {
	value, _ := dynvalue.Parse(raw)
	return dynvalue.Truthy(value) && dynvalue.Get(value, "status") != "applied"
}
