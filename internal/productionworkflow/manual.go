package productionworkflow

import (
	"context"
	"errors"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/requestsnapshot"
	"songframe/internal/speech"
)

// manualReason — почему пакет ручной генерации нельзя собрать; "" — можно. Пакет собирается из
// утверждённых опор и видеопромпта, у речевого плана — и из подготовленного среза речи, один раз
// на пакет: новый — только после доработки промпта или новой попытки.
func manualReason(c *Context, derived, common string, imagePhase bool) (string, error) {
	if !c.Manual {
		return "", nil
	}
	switch {
	case derived != "":
		return derived, nil
	case c.PackageDir == "":
		return textAcceptedDescriptionFrames, nil
	case c.SceneChanged:
		return textSceneChangedReason, nil
	case common != "":
		return common, nil
	case c.Paid:
		return textSentAttemptNeedsRetry, nil
	case len(c.Problems) > 0:
		return c.Problems[0], nil
	case imagePhase:
		return textResolveImageFirst, nil
	case dynvalue.Truthy(c.workflowValue("request_dir")):
		return textManualPackageReady, nil
	}
	prompt, err := c.PromptApproved()
	if err != nil {
		return "", err
	}
	if !prompt {
		return textManualPromptRequired, nil
	}
	if c.Speech == nil && c.Scene.Value("lipsync") == true {
		return textManualSpeechRequired, nil
	}
	return "", nil
}

// BuildManual собирает пакет ручной генерации плана без агента: в новой папке request-NN пакета —
// утверждённые опоры по порядку, у речевого плана срез речи, и утверждённый видеопромпт с SHA
// (requestsnapshot.PrepareManual),
// затем этап request_choice с этой папкой. Отправки сервису у такой попытки нет: видео загружает
// пользователь (production.Service.AttachManual).
func (w *Workflow) BuildManual(ctx context.Context, project, shot, packageDir string) (View, error) {
	w.mu.Lock()
	view, err := w.view(project, shot, packageDir)
	if err != nil {
		w.mu.Unlock()
		return View{}, err
	}
	if !view.CanBuildManual {
		w.mu.Unlock()
		reason := textManualUnavailable
		if view.Reasons.Manual != nil {
			reason = *view.Reasons.Manual
		}
		return View{}, errors.New(reason)
	}
	c, err := ReadContext(view.Project, shot, *view.PackageDir)
	if err != nil {
		w.mu.Unlock()
		return View{}, err
	}
	planKey := key(c.Project, shot)
	w.busy[planKey] = true
	w.mu.Unlock()
	err = w.buildManual(ctx, c)
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.busy, planKey)
	if err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, c.PackageDir)
}

// buildManual — запись пакета ручной генерации для проверенного контекста c (без мьютекса).
func (w *Workflow) buildManual(ctx context.Context, c *Context) error {
	frames := keyframes(c.Workflow)
	if c.SingleFrame && len(frames) != 1 {
		return errors.New(textManualSingleFrame)
	}
	// Входы — опоры в порядке плана (слот image: форма сайта принимает изображения), затем звук.
	inputs := []requestsnapshot.ManualInput{}
	for _, frame := range frames {
		path, err := packageFile(c, dynvalue.Get(frame, "path"))
		if err != nil {
			return err
		}
		inputs = append(inputs, requestsnapshot.ManualInput{Path: path, Slot: "image", Role: textManualFrameRole(dynvalue.ToString(dynvalue.Get(frame, "id")))})
	}
	if c.Scene.Value("lipsync") == true {
		prepared := speech.ReadPackage(c.PackageDir)
		if prepared == nil {
			return errors.New(textManualSpeechRequired)
		}
		inputs = append(inputs, requestsnapshot.ManualInput{Path: prepared.Path, Slot: "audio", Role: textManualSpeechRole})
	}
	promptPath, err := packageFile(c, dynvalue.Get(c.workflowValue("prompt"), "path"))
	if err != nil {
		return err
	}
	prompt, err := readText(promptPath)
	if err != nil {
		return err
	}
	seconds := int64(dynvalue.ToNumber(dynvalue.Get(c.workflowValue("timing"), "request_seconds")))
	number := 1
	for dynvalue.Exists(filepath.Join(c.PackageDir, "request-"+twoDigits(number))) {
		number++
	}
	requestName := "request-" + twoDigits(number)
	provider := dynvalue.ToString(c.Settings.Value("provider"))
	if _, err := requestsnapshot.PrepareManual(filepath.Join(c.PackageDir, requestName), requestsnapshot.ManualSpec{
		Shot: c.Shot, Provider: provider, Seconds: seconds, Prompt: prompt, Inputs: inputs,
	}); err != nil {
		return err
	}
	return w.run(ctx, c.Project, "shot_workflow", "set-stage", "--dir", c.PackageDir, "request_choice", "--request-dir", requestName)
}
