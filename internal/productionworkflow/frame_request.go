package productionworkflow

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediafile"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/providers"
	"songframe-go/internal/providers/agentexec"
)

// MediaLayer — часть слоя провайдеров медиа (providers.Layer), через которую производство создаёт
// опоры: исполнитель провайдера-агента проекта, исполнитель программы-агента выполненного задания
// (даже если настройки проекта уже сменились) и общий платный адаптер провайдера для изображений.
type MediaLayer interface {
	ProjectAgentImages(imageProvider any) (agentexec.Executor, error)
	JobAgentImages(job agents.Job) (agentexec.Executor, error)
	PaidMedia(provider, kind string) (*providers.PaidMedia, bool)
}

// imageAliases — rules.aliases.image?.[name] ?? [name]: все написания параметра изображения.
func imageAliases(rules mediaapi.RequestRules, name string) []string {
	for _, alias := range rules.Aliases[mediaproviders.Image] {
		if alias.Name == name {
			return alias.Names
		}
	}
	return []string{name}
}

// hasAny — хотя бы одно из имён есть в объекте (name in object).
func hasAny(object *jscompat.Object, names []string) bool {
	for _, name := range names {
		if object.Has(name) {
			return true
		}
	}
	return false
}

// sameMediaProvider сравнивает ID провайдеров: непустые строки совпадают без учёта регистра и
// крайних пробелов.
func sameMediaProvider(left any, right string) bool {
	text, ok := left.(string)
	if !ok {
		return false
	}
	normalized, _ := mediaproviders.Normalize(text)
	other, _ := mediaproviders.Normalize(right)
	return normalized != "" && normalized == other
}

// frameImageRequest — черновик
// платного запроса одной опоры input.Frames[0] в новой папке пакета image-<опора>-<N>. Параметры —
// options изображений проекта; разрешение, пропорции и число результатов — из настроек или
// значений провайдера по умолчанию (явный параметр provider-а сохраняется, конфликт выявит общий
// валидатор). Серия изображений для одной опоры запрещена, объявленная моделью серия выключается.
// Референсы — изображения внутри проекта в именованных слотах. Модель выбирает общий селектор до
// показа платного подтверждения; settings — generation.image проекта как есть.
func frameImageRequest(paid providers.Paid, input mediaapi.ImagesInput, settings any, caps mediaapi.Capabilities, validate func(string) bool) (providers.PaidInput, error) {
	info, _ := mediaproviders.Lookup(paid.ID)
	rules := paid.Rules
	if !jscompat.Truthy(settings) || !sameMediaProvider(jscompat.Get(settings, "provider"), paid.ID) {
		return providers.PaidInput{}, errors.New(textImageProviderMismatch(info.Title))
	}
	if len(input.Frames) != 1 {
		return providers.PaidInput{}, errors.New(textOneFrameRequired)
	}
	frame := input.Frames[0]
	parameters := jscompat.NewObject()
	if options, ok := jscompat.Get(settings, "options").(*jscompat.Object); ok {
		parameters = options.Clone()
	}
	for _, rule := range rules.Enforced {
		value := parameters.Value(rule.Name)
		for _, rejected := range rule.Rejected {
			if jscompat.StrictEqual(value, rejected) {
				return providers.PaidInput{}, errors.New(rule.Message)
			}
		}
	}
	defaults := map[string]any{"resolution": jscompat.Undefined, "aspect_ratio": jscompat.Undefined}
	if info.DefaultImageResolution != "" {
		defaults["resolution"] = info.DefaultImageResolution
	}
	if info.DefaultImageAspectRatio != "" {
		defaults["aspect_ratio"] = info.DefaultImageAspectRatio
	}
	for _, key := range []string{"resolution", "aspect_ratio"} {
		setting := jscompat.Get(settings, key)
		value := setting
		if jscompat.IsNullish(value) {
			value = defaults[key]
		}
		if !jscompat.Truthy(value) {
			continue
		}
		// Явный provider-параметр сохраняем; конфликт двух значений выявит общий валидатор.
		if !hasAny(parameters, imageAliases(rules, key)) || setting != jscompat.Undefined {
			parameters.Set(key, value)
		}
	}
	series := rules.Image.Series
	if series != nil {
		for _, name := range series.Names {
			if value := parameters.Value(name); value == true || value == "true" {
				return providers.PaidInput{}, errors.New(textSeriesUnsupported(series.Names[0]))
			}
		}
	}
	inputs := make([]providers.PaidInputItem, len(frame.ReferencePaths))
	for index, path := range frame.ReferencePaths {
		full, err := ProductionPath(input.Project, path)
		if err != nil {
			return providers.PaidInput{}, err
		}
		if !mediafile.IsImage(full) || !validate(full) {
			return providers.PaidInput{}, errors.New(textReferenceUnavailable(path))
		}
		inputs[index] = providers.PaidInputItem{Flag: "input", Slot: rules.Image.ReferenceSlot(index), Path: full, Role: "reference"}
	}
	number := 1
	for jscompat.Exists(filepath.Join(input.PackageDir, "image-"+frame.ID+"-"+strconv.Itoa(number))) {
		number++
	}
	model, _ := jscompat.Get(settings, "model").(string)
	model = jscompat.Trim(model)
	outputs := info.DefaultImageOutputs
	if value, ok := jscompat.Get(settings, "outputs").(float64); ok {
		outputs = int(value)
	} else if outputs == 0 {
		outputs = 1
	}
	request := providers.PaidInput{
		Project: input.Project, WorkDir: filepath.Join(input.PackageDir, "image-"+frame.ID+"-"+strconv.Itoa(number)), Shot: input.Shot,
		Kind: mediaproviders.Image, Command: rules.Image.Command(len(frame.ReferencePaths)), Model: model, PreferredModel: &model,
		Prompt: frame.Prompt, Parameters: parameters, Outputs: outputs, FrameID: frame.ID, Inputs: inputs,
	}
	return providers.SelectPaidRequest(paid, request, caps, func(item mediaapi.Model) *jscompat.Object {
		candidate := parameters.Clone()
		// Неявный обычный режим добавляем только при наличии объявления; пользовательские options не удаляем.
		if series != nil && !hasAny(candidate, series.Names) {
			arguments, _ := jscompat.Parse(item.Arguments)
			if declared, ok := arguments.(*jscompat.Object); ok {
				for _, name := range series.Names {
					if declared.Has(name) {
						candidate.Set(name, series.Off)
						break
					}
				}
			}
		}
		return candidate
	})
}

// prepareImageRequest — платный провайдер изображений проекта готовит неизменяемый запрос одной
// опоры в папке пакета (media_request prepare через
// общий платный адаптер), затем shot_workflow set-image-request записывает в workflow.json пакета
// вопрос согласования. Отправка остаётся за общим quote/submit «Производства» и подтверждением
// пользователя по показанному SHA и цене. Доступ к провайдеру проверяет сервис до вызова.
func (w *Workflow) prepareImageRequest(ctx context.Context, input mediaapi.ImagesInput) error {
	generation, err := projectGeneration(input.Project)
	if err != nil {
		return err
	}
	settings := jscompat.Get(generation, "image")
	id, _ := mediaproviders.Normalize(jscompat.Get(settings, "provider"))
	var media *providers.PaidMedia
	found := false
	if w.options.Media != nil {
		media, found = w.options.Media.PaidMedia(id, mediaproviders.Image)
	}
	if !found {
		titles := []string{}
		for _, provider := range mediaproviders.IDs() {
			if info, _ := mediaproviders.Lookup(provider); info.Paid && mediaproviders.Supports(provider, mediaproviders.Image) {
				titles = append(titles, info.Title)
			}
		}
		return errors.New(textChoosePaidImageProvider(titles))
	}
	caps := media.Capabilities(ctx, input.Project)
	request, err := frameImageRequest(media.Paid, input, settings, caps, w.options.ValidateImage)
	if err != nil {
		return err
	}
	if _, err := media.Prepare(ctx, request, caps); err != nil {
		return err
	}
	name := filepath.Base(request.WorkDir)
	result, err := w.options.Run(ctx, input.Project, "shot_workflow", []string{"set-image-request", "--dir", input.PackageDir, "--frame", request.FrameID, "--request-dir", name})
	if err != nil {
		return err
	}
	if result.Code == nil || *result.Code != 0 {
		details := result.Stderr
		if details == "" {
			details = result.Stdout
		}
		if details = jscompat.Trim(details); details == "" {
			details = textImageConsentFailed
		}
		return errors.New(details)
	}
	return nil
}

// generateImages — исполнитель провайдера-агента проекта фиксирует запрос опор (SHA), сразу
// отправляет его по этому SHA (отдельной цены у агента нет;
// согласием служит нажатие кнопки) и возвращает задание менеджера агентов.
func (w *Workflow) generateImages(project string, input mediaapi.ImagesInput) (agents.Job, error) {
	generation, err := projectGeneration(project)
	if err != nil {
		return agents.Job{}, err
	}
	executor, err := w.options.Media.ProjectAgentImages(jscompat.Get(jscompat.Get(generation, "image"), "provider"))
	if err != nil {
		return agents.Job{}, err
	}
	prepared, err := executor.Prepare(input)
	if err != nil {
		return agents.Job{}, err
	}
	execution, err := executor.Submit(prepared, &agentexec.Permit{RequestSha: prepared.RequestSha})
	if err != nil {
		return agents.Job{}, err
	}
	if execution.Provider != executor.Provider() {
		return agents.Job{}, errors.New(textImageJobKindInvalid)
	}
	job, ok := w.options.Agents.Get(execution.AgentJobID)
	if !ok {
		return agents.Job{}, errors.New(textImageJobMissing)
	}
	return job, nil
}

// collectImages — кандидаты задания опор собирает исполнитель
// провайдера, чья программа-агент выполнила задание.
func (w *Workflow) collectImages(job agents.Job) ([]FrameCandidate, error) {
	if w.options.Media == nil {
		return nil, errors.New(textImageExecutorMissing)
	}
	executor, err := w.options.Media.JobAgentImages(job)
	if err != nil {
		return nil, err
	}
	artifacts, err := executor.CollectJob(job)
	if err != nil {
		return nil, err
	}
	candidates := make([]FrameCandidate, len(artifacts))
	for index, artifact := range artifacts {
		candidates[index] = FrameCandidate{ID: artifact.FrameID, Path: artifact.Path}
	}
	return candidates, nil
}
