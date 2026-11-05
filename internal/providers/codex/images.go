// Package codex — адаптер провайдера изображений Codex: опоры и обложки рисует программа-агент из
// реестра (internal/agents), отдельной программы провайдера нет. Перенос src/main/providers/codex
// оригинала.
//
//   - ImageExecutor — исполнитель опор (CodexImageProvider): возможности (диагностика агента и
//     каталог моделей), подготовка с SHA запроса, одноразовая отправка по согласованному SHA и
//     сбор кандидатов задания. Запуск и регистрацию кандидатов выполняет производство через
//     интерфейс Images (KeyframeImages оригинала).
//   - CoverRunner — исполнитель обложки и референса проекта (createCodexCoverRunner).
//
// Пакет не зависит от слоя internal/providers: слой подключает его своей таблицей
// агентов-исполнителей, а общий код знает о Codex только из реестра провайдеров медиа.
package codex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"regexp"
	"sync"
	"time"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediafile"
	"songframe-go/internal/projectfile"
	"songframe-go/internal/providers/agentexec"
)

var _ agentexec.Executor = (*ImageExecutor)(nil)

// ID — id провайдера в реестре; Kind — единственный вид медиа исполнителя.
const (
	ID   = "codex"
	Kind = "image"
)

// Тексты оригинала: mediaTexts (общие сообщения медиа) и диагностика каталога Codex адаптера.
const (
	textFramesRequired    = "Сначала подготовьте описания опор."
	textReferenceInvalid  = "Референс не является изображением."
	textPreparationUsed   = "Эта подготовка или подтверждение уже использованы. Для нового запуска подготовьте и подтвердите новый запрос."
	textRequestChanged    = "Запрос или референсы изменились после согласования."
	textModelsEmpty       = "Codex не вернул доступные модели агента."
	textModelsUnavailable = "Каталог моделей агента Codex сейчас недоступен. Повторите проверку возможностей."
)

// Images, ImagesRequest, Prepared, Reference и Permit — общий контракт исполнителя-агента.
type (
	Images        = agentexec.Images
	ImagesRequest = agentexec.ImagesRequest
	Prepared      = agentexec.Prepared
	Permit        = agentexec.Permit
)

// ImageOptions — зависимости исполнителя опор.
type ImageOptions struct {
	Images Images
	// Agent — программа-агент провайдера с моделью из настроек проекта ("" — выбор программы).
	Agent func(model string) (agents.Settings, error)
	// Check — диагностика программы-агента; Models — каталог моделей (nil — не читается).
	Check  func(ctx context.Context) (agents.CheckResult, error)
	Models func(ctx context.Context) ([]mediaapi.Model, error)
	// Now — часы checkedAt; nil — time.Now.
	Now func() time.Time
}

// ImageExecutor — исполнитель опор Codex. Подготовка и отправка отделены от восстановления
// существующего задания (CollectJob). Безопасен для параллельного вызова.
type ImageExecutor struct {
	options   ImageOptions
	mu        sync.Mutex
	submitted map[*Prepared]bool
	consumed  map[*Permit]bool
}

// NewImageExecutor создаёт исполнителя опор.
func NewImageExecutor(options ImageOptions) *ImageExecutor {
	return &ImageExecutor{options: options, submitted: map[*Prepared]bool{}, consumed: map[*Permit]bool{}}
}

// Provider — id провайдера, которого исполняет executor.
func (e *ImageExecutor) Provider() string { return ID }

// CheckedAt — время проверки в формате Date.toISOString.
func CheckedAt(now func() time.Time) string {
	if now == nil {
		now = time.Now
	}
	return now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// Capabilities — возможности провайдера: программа-агент доступна, если найдена и вход не
// отвергнут; неизвестный вход и отказы диагностики попадают в problems. Каталог моделей читается
// только у доступной программы. generationVerified всегда false: диагностика CLI не подтверждает
// работу встроенного генератора изображений.
func (e *ImageExecutor) Capabilities(ctx context.Context, _ string) mediaapi.Capabilities {
	available := false
	models := []mediaapi.Model{}
	problems := []string{}
	if diagnostic, err := e.options.Check(ctx); err != nil {
		problems = append(problems, err.Error())
	} else {
		available = diagnostic.Availability == agents.Available && diagnostic.Authorization != agents.Unauthenticated
		if !available || diagnostic.Authorization == agents.AuthUnknown {
			problems = append(problems, diagnostic.Message)
		}
	}
	if available && e.options.Models != nil {
		if list, err := e.options.Models(ctx); err != nil {
			problems = append(problems, textModelsUnavailable)
		} else {
			models = append(models, list...)
			if len(models) == 0 {
				problems = append(problems, textModelsEmpty)
			}
		}
	}
	return mediaapi.Capabilities{Provider: ID, Kind: Kind, Available: available, CheckedAt: CheckedAt(e.options.Now), Models: models, Problems: problems}
}

// ModelsFromCatalog — модели каталога Codex как объявления медиа: команда codex_exec без
// параметров, слотов и лимитов (readCodexModels оригинала).
func ModelsFromCatalog(rows []agents.CodexModel) []mediaapi.Model {
	models := make([]mediaapi.Model, len(rows))
	for index, row := range rows {
		models[index] = mediaapi.Model{ID: row.Model, Command: "codex_exec", Arguments: []byte("{}"), Slots: []byte("{}"), Limits: []byte("{}")}
	}
	return models
}

var frameID = regexp.MustCompile(`^K\d{2}$`)

// fileHash — SHA-256 файла (hex).
func fileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", jscompat.FsError("open", path, err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// inputValue — ImagesInput как значение JS для JSON.stringify: порядок ключей — порядок полей
// контракта, числа — запись Number оригинала.
func inputValue(input mediaapi.ImagesInput) *jscompat.Object {
	object := jscompat.NewObject()
	object.Set("project", input.Project)
	object.Set("shot", input.Shot)
	object.Set("packageDir", input.PackageDir)
	frames := make([]any, len(input.Frames))
	for index, frame := range input.Frames {
		item := jscompat.NewObject()
		item.Set("id", frame.ID)
		item.Set("role", frame.Role)
		item.Set("timeSeconds", frame.TimeSeconds)
		item.Set("prompt", frame.Prompt)
		paths := make([]any, len(frame.ReferencePaths))
		for position, path := range frame.ReferencePaths {
			paths[position] = path
		}
		item.Set("referencePaths", &jscompat.Array{Items: paths})
		frames[index] = item
	}
	object.Set("frames", &jscompat.Array{Items: frames})
	if input.Notes != nil {
		notes := make([]any, len(*input.Notes))
		for index, note := range *input.Notes {
			notes[index] = note
		}
		object.Set("notes", &jscompat.Array{Items: notes})
	}
	if input.ApprovedFrames != nil {
		approved := make([]any, len(*input.ApprovedFrames))
		for index, frame := range *input.ApprovedFrames {
			item := jscompat.NewObject()
			item.Set("id", frame.ID)
			item.Set("role", frame.Role)
			item.Set("path", frame.Path)
			approved[index] = item
		}
		object.Set("approvedFrames", &jscompat.Array{Items: approved})
	}
	return object
}

// clone — structuredClone входа: срезы не разделяются с вызывающим.
func clone(input mediaapi.ImagesInput) mediaapi.ImagesInput {
	frozen := input
	frozen.Frames = make([]mediaapi.FramePrompt, len(input.Frames))
	for index, frame := range input.Frames {
		frame.ReferencePaths = append([]string{}, frame.ReferencePaths...)
		frozen.Frames[index] = frame
	}
	if input.Notes != nil {
		notes := append([]string{}, *input.Notes...)
		frozen.Notes = &notes
	}
	if input.ApprovedFrames != nil {
		approved := append([]mediaapi.ApprovedFrame{}, *input.ApprovedFrames...)
		frozen.ApprovedFrames = &approved
	}
	return frozen
}

// Prepare замораживает запрос: проект по настоящему пути, опоры K01…K99 с непустым описанием,
// референсы — изображения внутри проекта (каждый один раз, в порядке первого упоминания).
// SHA — sha256(JSON.stringify({input, references})) оригинала.
func (e *ImageExecutor) Prepare(input mediaapi.ImagesInput) (*Prepared, error) {
	frozen := clone(input)
	project, err := jscompat.Realpath(input.Project)
	if err != nil {
		return nil, err
	}
	frozen.Project = project
	if len(frozen.Frames) == 0 {
		return nil, errors.New(textFramesRequired)
	}
	for _, frame := range frozen.Frames {
		if !frameID.MatchString(frame.ID) || jscompat.Trim(frame.Prompt) == "" {
			return nil, errors.New(textFramesRequired)
		}
	}
	seen := map[string]bool{}
	references := []agentexec.Reference{}
	for _, frame := range frozen.Frames {
		for _, path := range frame.ReferencePaths {
			if seen[path] {
				continue
			}
			seen[path] = true
			file, err := mediafile.LocalFile(frozen.Project, path)
			if err != nil {
				return nil, err
			}
			if !mediafile.IsImage(file) {
				return nil, errors.New(textReferenceInvalid)
			}
			digest, err := fileHash(file)
			if err != nil {
				return nil, err
			}
			references = append(references, agentexec.Reference{Path: file, SHA256: digest})
		}
	}
	items := make([]any, len(references))
	for index, reference := range references {
		item := jscompat.NewObject()
		item.Set("path", reference.Path)
		item.Set("sha256", reference.SHA256)
		items[index] = item
	}
	document := jscompat.NewObject()
	document.Set("input", inputValue(frozen))
	document.Set("references", &jscompat.Array{Items: items})
	sum := sha256.Sum256([]byte(jscompat.Stringify(document)))
	return &Prepared{Provider: ID, Kind: Kind, RequestSha: hex.EncodeToString(sum[:]), Input: frozen, References: references}, nil
}

// Submit запускает задание опор по согласованному SHA. Подготовка и подтверждение расходуются до
// запуска: ошибка Start не разрешает неявный повтор, а новые Prepared/Permit допускают отдельно
// согласованную генерацию тех же входов. Изменение входов после согласования — отказ.
func (e *ImageExecutor) Submit(prepared *Prepared, permit *Permit) (mediaapi.AgentExecutionRef, error) {
	e.mu.Lock()
	used := e.submitted[prepared] || e.consumed[permit]
	e.mu.Unlock()
	if used {
		return mediaapi.AgentExecutionRef{}, errors.New(textPreparationUsed)
	}
	if prepared.Provider != ID || prepared.Kind != Kind || permit.RequestSha != prepared.RequestSha {
		return mediaapi.AgentExecutionRef{}, errors.New(textRequestChanged)
	}
	again, err := e.Prepare(prepared.Input)
	if err != nil {
		return mediaapi.AgentExecutionRef{}, err
	}
	if again.RequestSha != prepared.RequestSha {
		return mediaapi.AgentExecutionRef{}, errors.New(textRequestChanged)
	}
	e.mu.Lock()
	if e.submitted[prepared] || e.consumed[permit] {
		e.mu.Unlock()
		return mediaapi.AgentExecutionRef{}, errors.New(textPreparationUsed)
	}
	e.submitted[prepared] = true
	e.consumed[permit] = true
	e.mu.Unlock()
	// Модель проекта относится только к этому провайдеру изображений; без неё выбор остаётся программе.
	model, err := projectImageModel(prepared.Input.Project)
	if err != nil {
		return mediaapi.AgentExecutionRef{}, err
	}
	config, err := e.options.Agent(model)
	if err != nil {
		return mediaapi.AgentExecutionRef{}, err
	}
	job, err := e.options.Images.Start(prepared.Input, ImagesRequest{Provider: ID, RequestSha: prepared.RequestSha, Agent: config})
	if err != nil {
		return mediaapi.AgentExecutionRef{}, err
	}
	return mediaapi.AgentExecutionRef{Provider: ID, Kind: Kind, RequestSha: prepared.RequestSha, AgentJobID: job.ID}, nil
}

// projectImageModel — generation.image.model проекта, если провайдер изображений проекта — этот
// же (sameMediaProvider: регистр и пробелы по краям несущественны); иначе "".
func projectImageModel(project string) (string, error) {
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return "", err
	}
	generation, err := jscompat.Parse(settings.Generation)
	if err != nil {
		return "", err
	}
	image := jscompat.Get(generation, "image")
	provider, _ := jscompat.Get(image, "provider").(string)
	if !SameProvider(provider, ID) {
		return "", nil
	}
	model, _ := jscompat.Get(image, "model").(string)
	return model, nil
}

// SameProvider — sameMediaProvider: непустые имена совпадают без учёта регистра и пробелов по краям.
func SameProvider(left, right string) bool {
	left, right = jscompat.Trim(left), jscompat.Trim(right)
	return left != "" && right != "" && lower(left) == lower(right)
}

// lower — String.prototype.toLowerCase для id провайдеров (латиница).
func lower(text string) string {
	runes := []rune(text)
	for index, char := range runes {
		if char >= 'A' && char <= 'Z' {
			runes[index] = char + 'a' - 'A'
		}
	}
	return string(runes)
}

// CollectJob — кандидаты завершённого задания опор, в том числе после перезапуска: номер по
// порядку, SHA-256 и размеры изображения. Сначала проверяется запись задания (RequestSha:
// версия, проект, формат SHA), затем кандидаты (Images.Collect).
func (e *ImageExecutor) CollectJob(job agents.Job) ([]mediaapi.Artifact, error) {
	if _, err := e.options.Images.RequestSha(job); err != nil {
		return nil, err
	}
	candidates, err := e.options.Images.Collect(job)
	if err != nil {
		return nil, err
	}
	artifacts := make([]mediaapi.Artifact, len(candidates))
	for index, candidate := range candidates {
		digest, err := fileHash(candidate.Path)
		if err != nil {
			return nil, err
		}
		width, height, _ := mediafile.Dimensions(candidate.Path)
		artifacts[index] = mediaapi.Artifact{Path: candidate.Path, Index: index + 1, FrameID: candidate.ID, Kind: Kind, SHA256: digest, Width: width, Height: height}
	}
	return artifacts, nil
}

// NewImages — исполнитель опор с настоящей программой-агентом: диагностика — проверка программы
// провайдера без модели, каталог — model/list этой программы (adapter.images оригинала).
func NewImages(deps agentexec.Deps) *ImageExecutor {
	agent := func() (agents.Settings, error) { return deps.Agent("") }
	return NewImageExecutor(ImageOptions{
		Images: deps.Images,
		Agent:  deps.Agent,
		Check: func(ctx context.Context) (agents.CheckResult, error) {
			config, err := agent()
			if err != nil {
				return agents.CheckResult{}, err
			}
			return agents.NewAdapter(config.Provider).Check(ctx, config)
		},
		Models: func(ctx context.Context) ([]mediaapi.Model, error) {
			config, err := agent()
			if err != nil {
				return nil, err
			}
			rows, err := agents.CodexImageModels(ctx, config, agents.CheckOptions{})
			if err != nil {
				return nil, err
			}
			return ModelsFromCatalog(rows), nil
		},
	})
}
