package productionworkflow

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strconv"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
	"songframe/internal/providers/agentexec"
)

// MediaLayer — часть слоя провайдеров медиа (providers.Layer), через которую производство создаёт
// опоры: исполнитель провайдера-агента проекта, исполнитель программы-агента выполненного задания
// (даже если настройки проекта уже сменились) и общий платный адаптер провайдера для изображений.
type MediaLayer interface {
	ProjectAgentImages(imageProvider any) (agentexec.Executor, error)
	JobAgentImages(job agents.Job) (agentexec.Executor, error)
	PaidMedia(provider, kind string) (*providers.PaidMedia, bool)
}

// imageAliases — все написания параметра изображения name из псевдонимов правил провайдера;
// без записи о параметре — только само name.
func imageAliases(rules mediaapi.RequestRules, name string) []string {
	for _, alias := range rules.Aliases[mediaproviders.Image] {
		if alias.Name == name {
			return alias.Names
		}
	}
	return []string{name}
}

// hasAny — хотя бы одно из имён есть в объекте (name in object).
func hasAny(object *dynvalue.Object, names []string) bool {
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
// Референсы — изображения внутри проекта в именованных слотах. За референсами описания идут
// утверждённые опоры пакета (input.ApprovedFrames): промпт называет их слоты, чтобы модель сохранила
// внешность, одежду, свет и расстановку. Если модель не принимает столько входов, опоры
// отбрасываются с последней — до запроса без них, как прежде. Модель выбирает общий селектор до
// показа платного подтверждения; settings — generation.image проекта как есть.
func frameImageRequest(paid providers.Paid, input mediaapi.ImagesInput, settings any, caps mediaapi.Capabilities, validate func(string) bool) (providers.PaidInput, error) {
	info, _ := mediaproviders.Lookup(paid.ID)
	rules := paid.Rules
	if !dynvalue.Truthy(settings) || !sameMediaProvider(dynvalue.Get(settings, "provider"), paid.ID) {
		return providers.PaidInput{}, errors.New(textImageProviderMismatch(info.Title))
	}
	if len(input.Frames) != 1 {
		return providers.PaidInput{}, errors.New(textOneFrameRequired)
	}
	frame := input.Frames[0]
	parameters := dynvalue.NewObject()
	if options, ok := dynvalue.Get(settings, "options").(*dynvalue.Object); ok {
		parameters = options.Clone()
	}
	for _, rule := range rules.Enforced {
		value := parameters.Value(rule.Name)
		for _, rejected := range rule.Rejected {
			if dynvalue.StrictEqual(value, rejected) {
				return providers.PaidInput{}, errors.New(rule.Message)
			}
		}
	}
	defaults := map[string]any{"resolution": dynvalue.Undefined, "aspect_ratio": dynvalue.Undefined}
	if info.DefaultImageResolution != "" {
		defaults["resolution"] = info.DefaultImageResolution
	}
	if info.DefaultImageAspectRatio != "" {
		defaults["aspect_ratio"] = info.DefaultImageAspectRatio
	}
	for _, key := range []string{"resolution", "aspect_ratio"} {
		setting := dynvalue.Get(settings, key)
		value := setting
		if dynvalue.IsNullish(value) {
			value = defaults[key]
		}
		if !dynvalue.Truthy(value) {
			continue
		}
		// Явный provider-параметр сохраняем; конфликт двух значений выявит общий валидатор.
		if !hasAny(parameters, imageAliases(rules, key)) || setting != dynvalue.Undefined {
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
	references := make([]string, 0, len(frame.ReferencePaths))
	for _, path := range frame.ReferencePaths {
		full, err := ProductionPath(input.Project, path)
		if err != nil {
			return providers.PaidInput{}, err
		}
		if !mediafile.IsImage(full) || !validate(full) {
			return providers.PaidInput{}, errors.New(textReferenceUnavailable(path))
		}
		references = append(references, full)
	}
	approved := []string{}
	if input.ApprovedFrames != nil {
		for _, item := range *input.ApprovedFrames {
			if !mediafile.IsImage(item.Path) || !validate(item.Path) {
				return providers.PaidInput{}, errors.New(textReferenceUnavailable(item.ID))
			}
			approved = append(approved, item.Path)
		}
	}
	number := 1
	for dynvalue.Exists(filepath.Join(input.PackageDir, "image-"+frame.ID+"-"+strconv.Itoa(number))) {
		number++
	}
	model, _ := dynvalue.Get(settings, "model").(string)
	model = dynvalue.Trim(model)
	outputs := info.DefaultImageOutputs
	if value, ok := dynvalue.Get(settings, "outputs").(float64); ok {
		outputs = int(value)
	} else if outputs == 0 {
		outputs = 1
	}
	// candidate — запрос с первыми count утверждёнными опорами после референсов описания.
	candidate := func(count int) providers.PaidInput {
		paths := append(slices.Clone(references), approved[:count]...)
		inputs := make([]providers.PaidInputItem, len(paths))
		slots := []string{}
		for index, path := range paths {
			slot := rules.Image.ReferenceSlot(index)
			inputs[index] = providers.PaidInputItem{Flag: "input", Slot: slot, Path: path, Role: "reference"}
			if index >= len(references) {
				slots = append(slots, slot)
			}
		}
		prompt := frame.Prompt
		if len(slots) > 0 {
			prompt += framesApprovedLabel(slots)
		}
		return providers.PaidInput{
			Project: input.Project, WorkDir: filepath.Join(input.PackageDir, "image-"+frame.ID+"-"+strconv.Itoa(number)), Shot: input.Shot,
			Kind: mediaproviders.Image, Command: rules.Image.Command(len(paths)), Model: model, PreferredModel: &model,
			Prompt: prompt, Parameters: parameters, Outputs: outputs, FrameID: frame.ID, Inputs: inputs,
		}
	}
	// Отказ из-за числа входов не должен лишать опору запроса: опоры отбрасываются с последней, а
	// ошибка запроса без них — прежняя ошибка селектора.
	for count := len(approved); count > 0; count-- {
		if request, err := selectFrameRequest(paid, candidate(count), caps, parameters, series); err == nil {
			return request, nil
		}
	}
	return selectFrameRequest(paid, candidate(0), caps, parameters, series)
}

// selectFrameRequest — общий селектор модели для черновика опоры; объявленная моделью серия
// изображений выключается, если её не задали явно.
func selectFrameRequest(paid providers.Paid, request providers.PaidInput, caps mediaapi.Capabilities, parameters *dynvalue.Object, series *mediaapi.ImageSeries) (providers.PaidInput, error) {
	return providers.SelectPaidRequest(paid, request, caps, func(item mediaapi.Model) *dynvalue.Object {
		candidate := parameters.Clone()
		// Неявный обычный режим добавляем только при наличии объявления; пользовательские options не удаляем.
		if series != nil && !hasAny(candidate, series.Names) {
			arguments, _ := dynvalue.Parse(item.Arguments)
			if declared, ok := arguments.(*dynvalue.Object); ok {
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
	settings := dynvalue.Get(generation, "image")
	id, _ := mediaproviders.Normalize(dynvalue.Get(settings, "provider"))
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
		if details = dynvalue.Trim(details); details == "" {
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
	executor, err := w.options.Media.ProjectAgentImages(dynvalue.Get(dynvalue.Get(generation, "image"), "provider"))
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
// провайдера, чья программа-агент выполнила задание; вместе с ними — ID этого провайдера изображений.
func (w *Workflow) collectImages(job agents.Job) ([]FrameCandidate, string, error) {
	if w.options.Media == nil {
		return nil, "", errors.New(textImageExecutorMissing)
	}
	executor, err := w.options.Media.JobAgentImages(job)
	if err != nil {
		return nil, "", err
	}
	artifacts, err := executor.CollectJob(job)
	if err != nil {
		return nil, "", err
	}
	candidates := make([]FrameCandidate, len(artifacts))
	for index, artifact := range artifacts {
		candidates[index] = FrameCandidate{ID: artifact.FrameID, Path: artifact.Path}
	}
	return candidates, executor.Provider(), nil
}
