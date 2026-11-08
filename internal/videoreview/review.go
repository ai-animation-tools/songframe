// Package videoreview проверяет полученное видео агентом: кадры по PTS, сверка с утверждёнными
// опорами и отчёт с наблюдениями (videoReview.view/start/cancel).
//
// Проверка помогает человеку просмотреть оригинал попытки и никогда не принимает материал: решение
// о приёмке остаётся за production.Service.Accept. Сервис извлекает реальные кадры видео с PTS
// через FFmpeg (extract.go), готовит копии утверждённых опор в бюджете вложений выбранного CLI,
// собирает контекст постановки и запускает агента только на чтение с изображениями. Ответ агента
// принимается, лишь если каждое наблюдение ссылается на показанные кадры (ParseReport).
//
// Состояние хранится в <пакет>/video-review/latest.json и в подпапке выборки
// <пакет>/video-review/<id>/ с кадрами F001…, опорами R001… и manifest.json. Просмотр (View) не
// запускает ни агента, ни FFmpeg: он только сверяет сохранённый снимок с текущими материалами и
// фиксирует итог уже завершившегося задания агента.
package videoreview

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"songframe/internal/acceptance"
	"songframe/internal/agents"
	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/filedigest"
	"songframe/internal/scenario"
	"songframe/resources"
)

// prompt — инструкция агенту из встроенного скилла resources/skills (SkillVideoReview), как промпт
// сценария; её SHA-256 закреплён тестом TestPromptDigest.
var prompt = mustSkill(resources.SkillVideoReview)

// mustSkill читает встроенный скилл при старте: его отсутствие — ошибка сборки ресурсов, а не
// пользовательская ситуация.
func mustSkill(name string) string {
	text, err := resources.Skill(name)
	if err != nil {
		panic(err)
	}
	return text
}

// DefaultImageBudget — бюджет копий изображений проверки по умолчанию (16 МиБ, как у Codex).
const DefaultImageBudget = 16 * 1024 * 1024

// Agents — то, что проверке нужно от менеджера заданий агента (agents.Manager реализует).
type Agents interface {
	Start(input agents.StartInput) (agents.Job, error)
	Get(id string) (agents.Job, bool)
	List(project string) []agents.Job
	Cancel(id string) (agents.Job, error)
}

// ContinuityBrief — запуск `continuity_brief <shot> --phase <phase> --json` на проекте: stdout при
// коде 0, иначе ошибка, текст которой — stderr инструмента (пустой текст допустим, тогда
// пользователь увидит общее сообщение о неудачной подготовке). Отмена ctx прерывает запуск.
type ContinuityBrief func(ctx context.Context, project, shot, phase string) (string, error)

// Options связывают проверку с окружением приложения; в тестах всё подменяется.
type Options struct {
	Agents Agents
	// Tools — найденная пара FFmpeg/ffprobe; ok=false — причина «нужны FFmpeg и ffprobe».
	Tools func() (Tools, bool)
	// Extract — извлечение кадров и копий опор; nil — Extract этого пакета.
	Extract func(ctx context.Context, input ExtractInput) (Manifest, error)
	// Brief — состояние сущностей до и после плана; nil — подготовка завершается ошибкой.
	Brief ContinuityBrief
	// IsPackageBusy — у пакета идёт производственная операция (production.Service).
	IsPackageBusy func(project, directory string) bool
	// ImageBudgetBytes — бюджет изображений выбранного CLI; nil — DefaultImageBudget.
	ImageBudgetBytes func() int
}

// View — VideoReviewView контракта.
type View struct {
	Status          string      `json:"status"`
	Job             *agents.Job `json:"job"`
	Report          *Report     `json:"report"`
	Frames          []Frame     `json:"frames"`
	Stale           bool        `json:"stale"`
	CanStart        bool        `json:"canStart"`
	Reason          *string     `json:"reason"`
	Error           *string     `json:"error"`
	DurationSeconds *float64    `json:"durationSeconds"`
}

// preparation — идущая подготовка кадров пакета: отмена и признак завершения горутины.
type preparation struct {
	cancel context.CancelFunc
	ctx    context.Context
	done   chan struct{}
}

// Service владеет подготовками кадров и записью latest.json.
//
// Конкурентность: вызовы Wails идут из разных горутин, а подготовка — в своей. mu сериализует
// всё, что читает и пишет latest.json и карту preparing, поэтому повторный клик не извлекает
// второй комплект кадров, а отмена не пересекается с запуском агента: финальная проверка отмены
// и agents.Start выполняются под mu. FFmpeg и continuity_brief работают без блокировки.
type Service struct {
	options   Options
	mu        sync.Mutex
	preparing map[string]*preparation
	wg        sync.WaitGroup
}

// New создаёт сервис проверки.
func New(options Options) *Service {
	if options.Extract == nil {
		options.Extract = Extract
	}
	return &Service{options: options, preparing: map[string]*preparation{}}
}

var packageFolder = regexp.MustCompile(`^plan/(batches|awaiting)/[^/]+$`)

// directory — проверенные realpath проекта и папка пакета plan/batches|awaiting/<имя> с workflow.json.
func (s *Service) directory(project, packageDir string) (string, string, error) {
	if !dynvalue.IsAbs(project) {
		return "", "", errors.New(textInvalidPackage)
	}
	root, err := dynvalue.Realpath(project)
	if err != nil {
		return "", "", err
	}
	directory, err := productionPath(root, packageDir)
	if err != nil {
		return "", "", err
	}
	if !packageFolder.MatchString(slash(dynvalue.Relative(root, directory))) || !dynvalue.Exists(filepath.Join(directory, "workflow.json")) {
		return "", "", errors.New(textInvalidPackage)
	}
	return root, directory, nil
}

// reviewContext — проверенные материалы пакета, по которым готовится и сверяется проверка.
type reviewContext struct {
	project, directory string
	pkg                *packageView
	shot               string
	video              string
	// references — абсолютные пути утверждённых опор с файлом, в порядке workflow.json.
	references []string
	// approved — те же опоры: их ID, роль и время уходят агенту рядом с R001….
	approved   []keyframe
	staging    *dynvalue.Object
	sourceHash string
}

// readRegistry — разобранный plan/scenes.json, если он
// проходит общий контракт (версия, fps, коды и окна планов), иначе nil. Реестр и снимок берутся
// из одних байтов.
func readRegistry(project string) any {
	data, err := os.ReadFile(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		return nil
	}
	registry, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
	if err != nil || !dynvalue.IsRecord(registry) || !dynvalue.StrictEqual(dynvalue.Get(registry, "schema_version"), 1.0) ||
		!dynvalue.StrictEqual(dynvalue.Get(registry, "fps"), float64(scenario.FPS)) {
		return nil
	}
	scenes, ok := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	if !ok {
		return nil
	}
	ids := map[string]bool{}
	for _, scene := range scenes {
		id, isString := dynvalue.Get(scene, "id").(string)
		if !dynvalue.IsRecord(scene) || !isString || !sceneCode.MatchString(id) || ids[id] {
			return nil
		}
		start, finish := dynvalue.Get(scene, "start_frame"), dynvalue.Get(scene, "end_frame_exclusive")
		if !isFrame(start) || !isFrame(finish) || finish.(float64) <= start.(float64) {
			return nil
		}
		ids[id] = true
	}
	return registry
}

var sceneCode = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)

// isFrame — неотрицательное безопасное целое (граница плана в кадрах).
func isFrame(value any) bool {
	number, ok := value.(float64)
	return ok && dynvalue.IsSafeInteger(value) && number >= 0
}

// currentFingerprint — currentShotFingerprint: отпечаток текущей постановки плана по кастингу
// проекта или nil, если реестр не разбирается или плана нет.
func currentFingerprint(project, shot string) any {
	scenes, ok := dynvalue.ReadJSONFile(filepath.Join(project, "plan", "scenes.json"))
	if !ok {
		return nil
	}
	fingerprints, err := acceptance.ProjectFingerprints(project, scenes)
	if err != nil || fingerprints == nil {
		return nil
	}
	return dynvalue.Coalesce(fingerprints.Value(shot), nil)
}

// digest — cachedFileDigest: SHA-256 обычного файла или nil.
func digest(path string) any {
	if hash, ok := filedigest.File(path); ok {
		return hash
	}
	return nil
}

// sha — SHA-256 hex от компактной JSON-записи value (dynvalue.Stringify).
func sha(value any) string {
	sum := sha256.Sum256([]byte(dynvalue.Stringify(value)))
	return hex.EncodeToString(sum[:])
}

// source — источник проверки: пакет с полностью скачанным видео на этапе просмотра результата,
// 1–20 утверждённых опор, текущие отпечаток постановки и кастинг. sourceHash связывает отчёт с
// постановкой, контекстом агента и байтами видео и опор: их изменение делает отчёт устаревшим.
func (s *Service) source(project, directory string) (*reviewContext, error) {
	pkg, err := readPackage(directory)
	if err != nil {
		return nil, err
	}
	registry := readRegistry(project)
	var scene any = dynvalue.Undefined
	if registry != nil && pkg != nil {
		scenes, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
		for _, item := range scenes {
			if dynvalue.StrictEqual(dynvalue.Get(item, "id"), pkg.shot) {
				scene = item
				break
			}
		}
	}
	if pkg == nil || scene == dynvalue.Undefined || pkg.request == nil || dynvalue.StrictEqual(pkg.request.kind, "image") ||
		(pkg.stage != "downloaded" && pkg.stage != "edit_review" && pkg.stage != "accepted") ||
		!pkg.resultToken || len(pkg.request.downloads) != 1 {
		return nil, errors.New(textVideoRequired)
	}
	video, err := productionPath(project, pkg.request.downloads[0])
	if err != nil {
		return nil, err
	}
	result := &reviewContext{project: project, directory: directory, pkg: pkg, shot: pkg.shot, video: video}
	for _, frame := range pkg.keyframes {
		if frame.approved && frame.imagePath != "" {
			path, err := productionPath(project, frame.imagePath)
			if err != nil {
				return nil, err
			}
			result.references = append(result.references, path)
			result.approved = append(result.approved, frame)
		}
	}
	if len(result.references) == 0 || len(result.references) > 20 {
		return nil, errors.New(textReferencesRequired)
	}
	files := &dynvalue.Array{}
	complete := true
	for _, path := range append([]string{video}, result.references...) {
		file := dynvalue.NewObject()
		file.Set("path", slash(dynvalue.Relative(project, path)))
		hash := digest(path)
		complete = complete && hash != nil
		file.Set("sha256", hash)
		files.Items = append(files.Items, file)
	}
	fingerprint := currentFingerprint(project, pkg.shot)
	if !dynvalue.Truthy(fingerprint) || !complete {
		return nil, errors.New(textSourceChanged)
	}
	castValue := cast.Read(project).Value
	if !dynvalue.Truthy(castValue) {
		return nil, errors.New(textSourceChanged)
	}
	sequences, ok := dynvalue.AsArray(dynvalue.Get(registry, "sequences"))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "registry.sequences.find is not a function"}
	}
	var sequence any = dynvalue.Undefined
	for _, item := range sequences {
		if dynvalue.StrictEqual(dynvalue.Get(item, "id"), dynvalue.Get(scene, "sequence")) {
			sequence = item
			break
		}
	}
	staging := dynvalue.NewObject()
	staging.Set("scene", scene)
	staging.Set("sequence", sequence)
	start, _ := dynvalue.Get(scene, "start_frame").(float64)
	finish, _ := dynvalue.Get(scene, "end_frame_exclusive").(float64)
	staging.Set("windowSeconds", (finish-start)/float64(scenario.FPS))
	staging.Set("requestSeconds", dynvalue.Get(pkg.timing, "request_seconds"))
	staging.Set("visualDirection", dynvalue.Get(registry, "visual_direction"))
	staging.Set("cast", castValue)
	staging.Set("description", pkg.description)
	staging.Set("videoPrompt", dynvalue.Coalesce(dynvalue.Coalesce(pkg.request.promptText, pkg.promptText), ""))
	keyframes := &dynvalue.Array{}
	for _, frame := range pkg.keyframes {
		if frame.approved {
			keyframes.Items = append(keyframes.Items, keyframeContext(frame))
		}
	}
	staging.Set("keyframes", keyframes)
	result.staging = staging
	snapshot := dynvalue.NewObject()
	snapshot.Set("fingerprint", fingerprint)
	snapshot.Set("staging", staging)
	snapshot.Set("files", files)
	result.sourceHash = sha(snapshot)
	return result, nil
}

// keyframeContext — {id, role, timeSeconds} опоры для постановки агента.
func keyframeContext(frame keyframe) *dynvalue.Object {
	object := dynvalue.NewObject()
	object.Set("id", frame.id)
	object.Set("role", frame.role)
	object.Set("timeSeconds", frame.timeSeconds)
	return object
}

// preparingIn — идёт ли подготовка в каком-либо пакете проекта root. Вызывается под mu.
func (s *Service) preparingIn(root string) bool {
	for path := range s.preparing {
		if strings.HasPrefix(path, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func text(value string) *string { return &value }

// View — videoReview.view: состояние сохранённой проверки. Не запускает агента и FFmpeg; при
// необходимости фиксирует в latest.json итог, который уже наступил: прерванная подготовка
// (приложение закрылось), завершённое или потерянное задание агента. Готовый ответ агента
// принимается только после ParseReport.
func (s *Service) View(project, packageDir string) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	root, directory, err := s.directory(project, packageDir)
	if err != nil {
		return View{}, err
	}
	return s.view(root, directory)
}

// view — тело View под mu.
func (s *Service) view(root, directory string) (View, error) {
	material, sourceErr := s.source(root, directory)
	var reason *string
	if sourceErr != nil {
		reason = text(sourceErr.Error())
	}
	if reason == nil {
		if _, ok := s.tools(); !ok {
			reason = text(textToolsMissing)
		}
	}
	busy := s.preparingIn(root) || (s.options.IsPackageBusy != nil && s.options.IsPackageBusy(root, directory))
	for _, job := range s.options.Agents.List(root) {
		busy = busy || job.Status == "running"
	}
	idle := func(status string, message *string) View {
		view := View{Status: status, Frames: []Frame{}, Stale: status == StatusFailed, CanStart: reason == nil && !busy, Reason: reason, Error: message}
		if reason == nil && busy {
			view.Reason = text(textBusy)
		}
		return view
	}
	record, err := read(directory)
	if err != nil {
		return idle(StatusFailed, text(textInvalidReport)), nil
	}
	if record == nil {
		return idle(StatusIdle, nil), nil
	}
	var job *agents.Job
	if id := record.jobID(); id != "" {
		if found, ok := s.options.Agents.Get(id); ok {
			job = &found
		}
	}
	if record.status() == StatusPreparing && s.preparing[directory] == nil {
		record.finish(StatusFailed, textInterrupted)
		if err := save(root, directory, *record); err != nil {
			return View{}, err
		}
	}
	if record.status() == StatusRunning && (job == nil || job.Status != "running") {
		if job != nil && job.Status == "completed" {
			if report, err := ParseReport(job.Result, record.frames(), *record.duration()); err == nil {
				record.doc.Set("report", report)
				record.doc.Set("status", StatusCompleted)
			} else {
				record.finish(StatusFailed, textInvalidReport)
			}
		} else {
			status, message := StatusFailed, textInterrupted
			if job != nil && job.Status == "cancelled" {
				status = StatusCancelled
			}
			if job != nil && job.Message != "" {
				message = job.Message
			}
			record.finish(status, message)
		}
		if err := save(root, directory, *record); err != nil {
			return View{}, err
		}
	}
	stale := material == nil || material.sourceHash != record.sourceHash()
	for _, entry := range record.imageHashes() {
		path, err := productionPath(directory, entry.Key)
		stale = stale || err != nil || !dynvalue.StrictEqual(digest(path), entry.Value)
	}
	status := record.status()
	active := status == StatusRunning || status == StatusPreparing
	frames := []Frame{}
	for _, frame := range record.frames() {
		path, err := productionPath(directory, frame.Path)
		if err != nil {
			return View{}, err
		}
		frames = append(frames, Frame{ID: frame.ID, TimeSeconds: frame.TimeSeconds, Path: path})
	}
	view := View{
		Status: status, Job: job, Report: reportDTO(record.doc.Value("report")), Frames: frames, Stale: stale,
		CanStart: !active && reason == nil && !busy, Reason: reason, Error: record.errorText(), DurationSeconds: record.duration(),
	}
	if reason == nil && (active || busy) {
		view.Reason = text(textBusy)
	}
	return view, nil
}

// tools — пара FFmpeg/ffprobe окружения.
func (s *Service) tools() (Tools, bool) {
	if s.options.Tools == nil {
		return Tools{}, false
	}
	return s.options.Tools()
}

// randomUUID — crypto.randomUUID (версия 4): ID выборки и её папки.
func randomUUID() string {
	var data [16]byte
	_, _ = rand.Read(data[:])
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", data[0:4], data[4:6], data[6:8], data[8:10], data[10:16])
}

// newID — генератор ID выборки; тесты подменяют его ради стабильных путей.
var newID = randomUUID

// Start — videoReview.start: резервирует проверку записью preparing и запускает подготовку в
// фоне. Повторный запуск при идущей подготовке или задании проекта отклоняется причиной из View.
// Возвращает состояние сразу после резервирования; агент запускается, когда кадры готовы.
func (s *Service) Start(project, packageDir string) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	root, directory, err := s.directory(project, packageDir)
	if err != nil {
		return View{}, err
	}
	view, err := s.view(root, directory)
	if err != nil {
		return View{}, err
	}
	if !view.CanStart || s.preparingIn(root) {
		message := textBusy
		if view.Reason != nil && *view.Reason != "" {
			message = *view.Reason
		}
		return View{}, errors.New(message)
	}
	material, err := s.source(root, directory)
	if err != nil {
		return View{}, err
	}
	record := newStored(newID(), material.shot, material.sourceHash)
	if err := save(root, directory, record); err != nil {
		return View{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	pending := &preparation{cancel: cancel, ctx: ctx, done: make(chan struct{})}
	s.preparing[directory] = pending
	s.wg.Add(1)
	go s.run(material, record, pending)
	return s.view(root, directory)
}

// errCancelled — отмена подготовки пользователем или закрытием приложения.
var errCancelled = errors.New(textCancelled)

// run выполняет подготовку и фиксирует её итог в latest.json: ошибка — failed с причиной, отмена —
// cancelled. Запись итога и удаление из preparing идут под mu одним шагом; успешный запуск агента
// удаляет запись сам (prepare), здесь удаление повторное и безвредное.
func (s *Service) run(material *reviewContext, record stored, pending *preparation) {
	defer s.wg.Done()
	defer close(pending.done)
	err := s.prepare(material, record, pending.ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		if pending.ctx.Err() != nil {
			record.finish(StatusCancelled, textCancelled)
		} else {
			message := dynvalue.Trim(err.Error())
			if message == "" {
				message = textPreparationFailed
			}
			record.finish(StatusFailed, message)
		}
		if dynvalue.Exists(material.directory) {
			_ = save(material.project, material.directory, record)
		}
	}
	delete(s.preparing, material.directory)
}

// prepare — извлечение кадров, проверка выборки, состояния до и после плана,
// повторная сверка материалов и запуск агента с изображениями (сначала кадры F…, затем опоры R…).
// record меняется на месте (кадры, хеши копий, длительность): при отмене или ошибке сохраняется
// то, что успело заполниться.
func (s *Service) prepare(material *reviewContext, record stored, ctx context.Context) error {
	project, directory := material.project, material.directory
	out, err := productionPath(directory, filepath.Join(reviewDir, record.id()))
	if err != nil {
		return err
	}
	budget := DefaultImageBudget
	if s.options.ImageBudgetBytes != nil {
		budget = s.options.ImageBudgetBytes()
	}
	tools, _ := s.tools()
	manifest, err := s.options.Extract(ctx, ExtractInput{Tools: tools, Video: material.video, Out: out, References: material.references, BudgetBytes: budget})
	if ctx.Err() != nil {
		return errCancelled
	}
	if err != nil {
		return err
	}
	duration := manifest.DurationSeconds
	if manifest.SchemaVersion != 1 || !mathFinite(duration) || duration <= 0 || len(manifest.Frames) == 0 || len(manifest.Frames) > 32 ||
		len(manifest.References) != len(material.references) {
		return errors.New(textInvalidFrames)
	}
	hashes, _ := record.doc.Value("imageHashes").(*dynvalue.Object)
	images := []string{}
	image := func(path string) (string, error) {
		absolute, err := productionPath(out, path)
		if err != nil {
			return "", err
		}
		hash, ok := filedigest.File(absolute)
		if !ok {
			return "", errors.New(textInvalidFrames)
		}
		hashes.Set(slash(dynvalue.Relative(directory, absolute)), hash)
		images = append(images, absolute)
		return absolute, nil
	}
	frames := &dynvalue.Array{}
	contextFrames := &dynvalue.Array{}
	ids := map[string]bool{}
	previous := -1.0
	for _, frame := range manifest.Frames {
		if !frameID.MatchString(frame.ID) || ids[frame.ID] || !mathFinite(frame.TimeSeconds) || frame.TimeSeconds < 0 ||
			frame.TimeSeconds <= previous || frame.TimeSeconds >= duration {
			return errors.New(textInvalidFrames)
		}
		previous = frame.TimeSeconds
		ids[frame.ID] = true
		absolute, err := image(frame.Path)
		if err != nil {
			return err
		}
		item := dynvalue.NewObject()
		item.Set("id", frame.ID)
		item.Set("timeSeconds", frame.TimeSeconds)
		item.Set("path", slash(dynvalue.Relative(directory, absolute)))
		frames.Items = append(frames.Items, item)
		short := dynvalue.NewObject()
		short.Set("id", frame.ID)
		short.Set("timeSeconds", frame.TimeSeconds)
		contextFrames.Items = append(contextFrames.Items, short)
	}
	record.doc.Set("frames", frames)
	references := &dynvalue.Array{}
	for index, reference := range manifest.References {
		if reference.ID != fmt.Sprintf("R%03d", index+1) || reference.SourcePath != material.references[index] {
			return errors.New(textInvalidFrames)
		}
		if _, err := image(reference.Path); err != nil {
			return err
		}
		frame := material.approved[index]
		item := dynvalue.NewObject()
		item.Set("id", reference.ID)
		item.Set("keyframeId", frame.id)
		item.Set("role", frame.role)
		item.Set("timeSeconds", frame.timeSeconds)
		references.Items = append(references.Items, item)
	}
	record.doc.Set("durationSeconds", duration)
	briefs := dynvalue.NewObject()
	for _, phase := range []string{"before", "after"} {
		if s.options.Brief == nil {
			return errors.New(textPreparationFailed)
		}
		stdout, err := s.options.Brief(ctx, project, material.shot, phase)
		if ctx.Err() != nil {
			return errCancelled
		}
		if err != nil {
			return err
		}
		value, err := dynvalue.Parse([]byte(stdout))
		if err != nil {
			return errors.New(textPreparationFailed)
		}
		briefs.Set(phase, value)
	}
	if current, err := s.source(project, directory); err != nil {
		return err
	} else if current.sourceHash != record.sourceHash() {
		return errors.New(textSourceChanged)
	}
	payload := dynvalue.NewObject()
	payload.Set("staging", material.staging)
	payload.Set("briefs", briefs)
	payload.Set("durationSeconds", duration)
	payload.Set("frames", contextFrames)
	payload.Set("references", references)
	// Отмена и запуск агента сериализованы с Cancel: после отмены задание не создаётся.
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		return errCancelled
	}
	job, err := s.options.Agents.Start(agents.StartInput{Project: project, Task: textHeading, Prompt: prompt, Images: images, Context: dynvalue.Stringify(payload)})
	if err != nil {
		return err
	}
	record.doc.Set("jobId", job.ID)
	record.doc.Set("status", StatusRunning)
	if err := save(project, directory, record); err != nil {
		return err
	}
	// Подготовка закончена тем же шагом под mu, что и запись running: иначе View между ними видел бы
	// проверку уже запущенной, а пакет — ещё занятым подготовкой («Дождитесь завершения…»).
	delete(s.preparing, directory)
	return nil
}

// Cancel — videoReview.cancel: останавливает подготовку и задание агента и отмечает проверку
// остановленной. Повреждённый latest.json — ошибка.
func (s *Service) Cancel(project, packageDir string) (View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	root, directory, err := s.directory(project, packageDir)
	if err != nil {
		return View{}, err
	}
	record, err := read(directory)
	if err != nil {
		return View{}, err
	}
	if pending := s.preparing[directory]; pending != nil {
		pending.cancel()
	}
	if record != nil {
		if id := record.jobID(); id != "" {
			if job, ok := s.options.Agents.Get(id); ok && job.Status == "running" {
				if _, err := s.options.Agents.Cancel(id); err != nil {
					return View{}, err
				}
			}
		}
		if status := record.status(); status == StatusPreparing || status == StatusRunning {
			record.finish(StatusCancelled, textCancelled)
			if err := save(root, directory, *record); err != nil {
				return View{}, err
			}
		}
	}
	return s.view(root, directory)
}

// Shutdown отменяет все подготовки и ждёт их горутины (итог каждой записан как cancelled).
func (s *Service) Shutdown() {
	s.mu.Lock()
	for _, pending := range s.preparing {
		pending.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}
