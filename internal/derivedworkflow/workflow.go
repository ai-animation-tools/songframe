// Package derivedworkflow обслуживает страницу производного плана. View собирает контекст плана
// (источник, кадры, рецепт, последняя
// проба и её свежесть), Save хранит настройки формы, Build и Accept запускают задания инструмента
// derive_shot (internal/deriveshot), RecoverApplications откатывает прерванную приёмку.
//
// Файлы проекта читаются деревом dynvalue: черновик и рецепт сохраняются с порядком ключей и формой
// чисел, а записанный JSON совпадает с эталоном testdata/golden/derived-workflow байт в байт.
// Сам пакет платных запросов не делает и данные комплектов не меняет: это работа инструмента.
package derivedworkflow

import (
	"encoding/json"
	"errors"
	"math"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/acceptance"
	"songframe/internal/dynvalue"
	"songframe/internal/filedigest"
	"songframe/internal/jobs"
	"songframe/internal/mediacmd"
	"songframe/internal/montage"
	"songframe/internal/projectfile"
	"songframe/internal/projectfs"
)

var (
	shotPattern = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)
	idPattern   = regexp.MustCompile(`^[a-f0-9-]{36}$`)
	shaPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// Jobs — используемая часть менеджера заданий (jobs.Manager); тесты подменяют её записью запусков.
type Jobs interface {
	Start(spec jobs.Spec) (jobs.Info, error)
	List() []jobs.Info
	Get(id string) (jobs.Info, bool)
}

// mediaReady сообщает, запускаются ли FFmpeg и ffprobe. Программы находит менеджер компонентов
// (mediacmd.Programs) или системный PATH; значение не кэшируется, потому что компонент можно
// поставить, не закрывая страницу.
var mediaReady = func() bool {
	for _, program := range []string{mediacmd.FFmpeg(), mediacmd.FFprobe()} {
		if _, err := exec.LookPath(program); err != nil {
			return false
		}
	}
	return true
}

// Preview — DerivedShotPreview: последняя проба плана и её свежесть.
type Preview struct {
	ID            string          `json:"id"`
	VideoPath     string          `json:"videoPath"`
	CandidatePath string          `json:"candidatePath"`
	ResultToken   string          `json:"resultToken"`
	Recipe        json.RawMessage `json:"recipe"`
	Frames        float64         `json:"frames"`
	Fresh         bool            `json:"fresh"`
	Problem       *string         `json:"problem"`
	Accepted      bool            `json:"accepted"`
}

// View — DerivedShotView: всё, что показывает страница производного плана. Recipe — сохранённый
// проверенный рецепт формы либо nil; Job — текущее или последнее задание инструмента.
type View struct {
	Project      string           `json:"project"`
	Shot         string           `json:"shot"`
	Title        string           `json:"title"`
	Action       string           `json:"action"`
	SourceShot   *string          `json:"sourceShot"`
	SourceTitle  string           `json:"sourceTitle"`
	SourcePath   *string          `json:"sourcePath"`
	SourceFrames float64          `json:"sourceFrames"`
	TargetFrames float64          `json:"targetFrames"`
	Recipe       *json.RawMessage `json:"recipe"`
	Preview      *Preview         `json:"preview"`
	Job          *jobs.Info       `json:"job"`
	Problem      *string          `json:"problem"`
	ToolsProblem *string          `json:"toolsProblem"`
	HasAsset     bool             `json:"hasAsset"`
}

// Workflow — операции страницы производного плана. Состояния не хранит: всё читается из проекта
// и менеджера.
type Workflow struct{ jobs Jobs }

// New связывает страницу производного плана с менеджером заданий.
func New(manager Jobs) *Workflow { return &Workflow{jobs: manager} }

// encode — байты локального JSON: отступ в два пробела и перевод строки в конце.
func encode(value any) []byte { return []byte(dynvalue.StringifyIndent(value, "  ") + "\n") }

// read — документ montage.ReadJournal с заменой любой ошибки на nil.
func read(path string) any {
	value, err := montage.ReadJournal(path)
	if err != nil {
		return nil
	}
	return value
}

// optional — указатель на непустой текст отказа.
func optional(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// finite — число DTO: NaN (кадры без чисел в реестре) не сериализуется в JSON и заменяется нулём,
// который страница и проверка рецепта трактуют так же, как NaN.
func finite(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}

// artifact — файл результата внутри папки с тем же SHA-256. Отказ — ok
// false: показанный ранее файл не заменяется другим, нужна новая сборка.
func artifact(directory string, value any) (string, bool) {
	name, nameOK := dynvalue.Get(value, "path").(string)
	digest, digestOK := dynvalue.Get(value, "sha256").(string)
	if !dynvalue.IsRecord(value) || !nameOK || name == "" || dynvalue.IsAbs(name) || !digestOK || !shaPattern.MatchString(digest) {
		return "", false
	}
	path, err := dynvalue.Realpath(dynvalue.Resolve(directory, name))
	if err != nil {
		return "", false
	}
	local := dynvalue.Relative(directory, path)
	if local == "" || local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) || dynvalue.IsAbs(local) {
		return "", false
	}
	if actual, ok := filedigest.File(path); !ok || actual != digest {
		return "", false
	}
	return path, true
}

// audioSource — снимок трека {path, sha256}; даже без файла хранит
// объявленный путь, потому что появление файла меняет услышанную пользователем пробу. ok false —
// путь вне source/ или вне проекта.
func audioSource(project string, value any) (name string, sha any, ok bool) {
	name, isText := value.(string)
	if !isText || !strings.HasPrefix(name, "source/") || strings.Contains(name, `\`) {
		return "", nil, false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return "", nil, false
		}
	}
	path := dynvalue.Resolve(project, name)
	existing := path
	for !dynvalue.Exists(existing) && filepath.Dir(existing) != existing {
		existing = filepath.Dir(existing)
	}
	canonical, err := dynvalue.Realpath(existing)
	if err != nil {
		return "", nil, false
	}
	local := dynvalue.Relative(project, canonical)
	if local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) || dynvalue.IsAbs(local) {
		return "", nil, false
	}
	if existing == path {
		if digest, found := filedigest.File(path); found {
			return name, digest, true
		}
	}
	return name, nil, true
}

// acceptedResult — принятие принадлежит проекту, журнал
// задания может исчезнуть. Выбранный комплект должен быть derived_video с тем же клипом, а
// committed-журнал с этим токеном — описывать именно текущий манифест.
func acceptedResult(project, shot string, receipt any) bool {
	directory, err := dynvalue.Realpath(filepath.Join(project, "assets", "shots", shot))
	if err != nil {
		return false
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	manifest := read(manifestPath)
	if !dynvalue.StrictEqual(dynvalue.Get(manifest, "schema_version"), 1.0) || !dynvalue.StrictEqual(dynvalue.Get(manifest, "shot"), shot) ||
		!dynvalue.StrictEqual(dynvalue.Get(manifest, "kind"), "derived_video") || !dynvalue.IsRecord(dynvalue.Get(manifest, "accepted_edit")) {
		return false
	}
	video := dynvalue.GetPath(manifest, "accepted_edit", "video")
	root := dynvalue.Get(video, "root")
	if !dynvalue.IsRecord(video) || (root != dynvalue.Undefined && !dynvalue.StrictEqual(root, "asset")) ||
		!dynvalue.StrictEqual(dynvalue.Get(video, "sha256"), dynvalue.GetPath(receipt, "video", "sha256")) {
		return false
	}
	if _, ok := artifact(directory, video); !ok {
		return false
	}
	manifestDigest, ok := filedigest.File(manifestPath)
	if !ok {
		return false
	}
	history := filepath.Join(project, "plan", "derived-history")
	entries, err := dynvalue.ReadDir(history)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if !entry.IsDir() || !journalName.MatchString(entry.Name()) {
			continue
		}
		journal := read(filepath.Join(history, entry.Name(), "journal.json"))
		kit := dynvalue.Get(journal, "directory")
		if dynvalue.StrictEqual(dynvalue.Get(journal, "schema_version"), 1.0) &&
			dynvalue.StrictEqual(dynvalue.Get(journal, "id"), entry.Name()) &&
			dynvalue.StrictEqual(dynvalue.Get(journal, "shot"), shot) &&
			dynvalue.StrictEqual(dynvalue.Get(journal, "state"), "committed") &&
			dynvalue.StrictEqual(dynvalue.Get(journal, "result_token"), dynvalue.Get(receipt, "result_token")) &&
			dynvalue.IsRecord(kit) && dynvalue.StrictEqual(dynvalue.Get(kit, "path"), "assets/shots/"+shot) &&
			dynvalue.IsRecord(dynvalue.Get(kit, "after_files")) &&
			dynvalue.StrictEqual(dynvalue.GetPath(kit, "after_files", "manifest.json"), manifestDigest) {
			return true
		}
	}
	return false
}

// checkProject — канонический путь существующего проекта и проверка кода
// плана.
func checkProject(project, shot string) (string, error) {
	if !dynvalue.IsAbs(project) || !shotPattern.MatchString(shot) {
		return "", errors.New(textProjectInvalid)
	}
	canonical, err := dynvalue.Realpath(project)
	if err != nil {
		return "", err
	}
	if !dynvalue.Exists(filepath.Join(canonical, "plan", "project.json")) {
		return "", errors.New(textProjectInvalid)
	}
	return canonical, nil
}

// directory — plan/derived/<план> в проекте.
func directory(project, shot string) string { return filepath.Join(project, "plan", "derived", shot) }

// latestRun — latest.json: последняя запущенная операция плана.
type latestRun struct{ id, jobID string }

// latest — запись с проверенными полями либо nil.
func latest(project, shot string) *latestRun {
	value := read(filepath.Join(directory(project, shot), "latest.json"))
	id, idOK := dynvalue.Get(value, "id").(string)
	job, jobOK := dynvalue.Get(value, "jobId").(string)
	operation := dynvalue.Get(value, "operation")
	if value == nil || !idOK || !idPattern.MatchString(id) || !jobOK || !(dynvalue.StrictEqual(operation, "build") || dynvalue.StrictEqual(operation, "accept")) {
		return nil
	}
	return &latestRun{id: id, jobID: job}
}

// active — выполняющееся задание derive_shot этого проекта: пока оно идёт, другие операции запрещены.
func (w *Workflow) active(project string) *jobs.Info {
	for _, job := range w.jobs.List() {
		if job.Status != jobs.StatusRunning || job.Project == nil || *job.Project != project {
			continue
		}
		for _, step := range job.Steps {
			if step.Tool == "derive_shot" {
				found := job
				return &found
			}
		}
	}
	return nil
}

// findByID — первый элемент массива, чей id строго равен (dynvalue.StrictEqual) значению id.
func findByID(list []any, id any) any {
	for _, item := range list {
		if dynvalue.StrictEqual(dynvalue.Get(item, "id"), id) {
			return item
		}
	}
	return dynvalue.Undefined
}

// sequenceTitle — название последовательности sequence из реестра. Реестр без массива sequences не ломает
// страницу: название просто не находится.
func sequenceTitle(registry, sequence any) any {
	list, _ := dynvalue.AsArray(dynvalue.Get(registry, "sequences"))
	return dynvalue.Get(findByID(list, sequence), "title")
}

// displayText — первое заданное (не null) значение строкой для подписи DTO, иначе "".
func displayText(values ...any) string {
	for _, value := range values {
		if !dynvalue.IsNullish(value) {
			return dynvalue.ToString(value)
		}
	}
	return ""
}

// recipeRaw — рецепт значением поля DTO.
func recipeRaw(value any) *json.RawMessage {
	if value == nil {
		return nil
	}
	raw := dynvalue.Raw(value)
	return &raw
}

// sourceState — вычисленные для View сведения об источнике и отпечатках.
type sourceState struct {
	shot     any
	snapshot *acceptance.Snapshot
	scores   acceptance.Result
}

// viewPreview — проба из latest.json или nil: повреждённый или подменённый файл не показывается.
// problem — отказ страницы: при нём проба не бывает свежей.
func viewPreview(canonical, shot string, run *latestRun, registry, recipe any, problem string, target float64, source sourceState) *Preview {
	folder := filepath.Join(directory(canonical, shot), run.id)
	receipt := read(filepath.Join(folder, "preview.json"))
	build := read(filepath.Join(folder, "build.json"))
	token, tokenOK := dynvalue.Get(receipt, "result_token").(string)
	if !dynvalue.StrictEqual(dynvalue.Get(receipt, "schema_version"), 1.0) || !dynvalue.StrictEqual(dynvalue.Get(receipt, "shot"), shot) ||
		!tokenOK || !shaPattern.MatchString(token) {
		return nil
	}
	videoPath, ok := artifact(folder, dynvalue.Get(receipt, "preview"))
	if !ok {
		return nil
	}
	candidatePath, ok := artifact(folder, dynvalue.Get(receipt, "video"))
	if !ok {
		return nil
	}
	saved, err := CheckedRecipe(dynvalue.Get(receipt, "recipe"))
	if err != nil {
		return nil
	}
	fresh, invalid := previewFresh(canonical, shot, receipt, build, registry, recipe, saved, problem, target, source)
	if invalid {
		return nil
	}
	return &Preview{
		ID: run.id, VideoPath: videoPath, CandidatePath: candidatePath, ResultToken: token, Recipe: dynvalue.Raw(saved),
		Frames: finite(dynvalue.ToNumber(dynvalue.Get(receipt, "target_frames"))), Fresh: fresh, Problem: staleProblem(fresh),
		Accepted: acceptedResult(canonical, shot, receipt),
	}
}

// staleProblem — текст устаревшей пробы.
func staleProblem(fresh bool) *string {
	if fresh {
		return nil
	}
	return optional(textPreviewStale)
}

// fingerprint — отпечаток плана shot из оценки приёмки: отсутствие — dynvalue.Undefined.
func fingerprint(scores acceptance.Result, shot string) any {
	if value, ok := scores.Fingerprints[shot]; ok {
		return value
	}
	return dynvalue.Undefined
}

// previewFresh — условие свежести пробы; порядок проверок зафиксирован эталоном. invalid —
// манифест источника исчез между проверками: проба не показывается.
func previewFresh(canonical, shot string, receipt, build, registry, recipe, saved any, problem string, target float64, source sourceState) (fresh, invalid bool) {
	sourceName, _ := source.shot.(string)
	field := func(key string) any { return dynvalue.Get(receipt, key) }
	var sourceVideo any = dynvalue.Undefined
	if source.snapshot != nil {
		sourceVideo = source.snapshot.AcceptedVideoSha256
	}
	if problem != "" || !dynvalue.StrictEqual(field("source_shot"), source.shot) ||
		dynvalue.ToNumber(field("target_frames")) != target ||
		!dynvalue.StrictEqual(field("target_scene_sha256"), fingerprint(source.scores, shot)) ||
		!dynvalue.StrictEqual(field("source_scene_sha256"), fingerprint(source.scores, sourceName)) ||
		!dynvalue.StrictEqual(field("source_accepted_video_sha256"), sourceVideo) {
		return false, false
	}
	manifest, ok := dynvalue.Get(build, "source_manifest_sha256").(string)
	if !ok || !shaPattern.MatchString(manifest) {
		return false, false
	}
	actual, found := filedigest.File(filepath.Join(canonical, "assets", "shots", sourceName, "manifest.json"))
	if !found {
		return false, true
	}
	name, sha, audioOK := audioSource(canonical, dynvalue.GetPath(registry, "audio", "path"))
	audio := field("audio_source")
	var wanted any = sha
	return manifest == actual && audioOK && dynvalue.IsRecord(audio) && dynvalue.StrictEqual(dynvalue.Get(audio, "path"), name) &&
		dynvalue.StrictEqual(dynvalue.Get(audio, "sha256"), wanted) && dynvalue.DeepStrictEqual(recipe, saved), false
}

// View — контекст страницы без записи в проект. Отказы источника возвращаются
// полем Problem, потому что страница показывает их рядом с сохранённой формой.
func (w *Workflow) View(project, shot string) (*View, error) {
	canonical, err := checkProject(project, shot)
	if err != nil {
		return nil, err
	}
	registry := read(filepath.Join(canonical, "plan", "scenes.json"))
	scenes, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	target := findByID(scenes, shot)
	if !dynvalue.Truthy(target) {
		return nil, errors.New(textSceneMissing)
	}
	sourceShot := dynvalue.Coalesce(dynvalue.GetPath(target, "derived_from", "shot"), nil)
	source := findByID(scenes, sourceShot)
	targetFrames := dynvalue.ToNumber(dynvalue.Get(target, "end_frame_exclusive")) - dynvalue.ToNumber(dynvalue.Get(target, "start_frame"))
	scores, err := acceptance.Compute(canonical, registry)
	if err != nil {
		return nil, err
	}
	sourceName, _ := sourceShot.(string)
	var snapshot *acceptance.Snapshot
	var manifest any
	if shotPattern.MatchString(sourceName) {
		snapshot = acceptance.ReadSourceVideo(canonical, sourceName)
		manifest = read(filepath.Join(canonical, "assets", "shots", sourceName, "manifest.json"))
	}
	edit := dynvalue.Get(manifest, "accepted_edit")
	sourceFrames := 0.0
	if frames := dynvalue.Get(edit, "frames"); dynvalue.IsRecord(edit) && dynvalue.TypeOf(frames) == "number" &&
		dynvalue.StrictEqual(dynvalue.Get(edit, "fps"), projectfile.FPS(canonical)) && dynvalue.IsSafeInteger(frames) {
		sourceFrames = dynvalue.ToNumber(frames)
	}
	state, accepted := scores.Accepted[sourceName]
	problem := ""
	switch {
	case !dynvalue.Truthy(sourceShot):
		problem = textNotDerived
	case !dynvalue.Truthy(source) || dynvalue.StrictEqual(sourceShot, shot) || dynvalue.Truthy(dynvalue.Get(source, "derived_from")):
		problem = textInvalidSource
	case dynvalue.Truthy(dynvalue.Get(target, "lipsync")):
		problem = textLipsyncUnsupported
	case snapshot == nil || sourceFrames == 0 || !accepted:
		problem = textSourceUnavailable
	case state != "completed":
		problem = textSourceStale
	}
	toolsProblem := ""
	if !mediaReady() {
		toolsProblem = textToolsUnavailable
	}
	var recipe any
	draft := read(filepath.Join(directory(canonical, shot), "draft.json"))
	if dynvalue.StrictEqual(dynvalue.Get(draft, "schema_version"), 1.0) && dynvalue.StrictEqual(dynvalue.Get(draft, "shot"), shot) {
		if checked, err := CheckedRecipe(dynvalue.Get(draft, "recipe")); err == nil {
			recipe = checked // Повреждённые настройки можно заменить явным сохранением формы.
		}
	}
	run := latest(canonical, shot)
	job := w.active(canonical)
	if job == nil && run != nil {
		if info, ok := w.jobs.Get(run.jobID); ok {
			job = &info
		}
	}
	var preview *Preview
	if run != nil {
		preview = viewPreview(canonical, shot, run, registry, recipe, problem, targetFrames, sourceState{shot: sourceShot, snapshot: snapshot, scores: scores})
	}
	var sourcePath *string
	if snapshot != nil {
		sourcePath = &snapshot.VideoPath
	}
	var dtoSource *string
	if text, ok := sourceShot.(string); ok {
		dtoSource = &text
	}
	return &View{
		Project:      canonical,
		Shot:         shot,
		Title:        displayText(dynvalue.Get(target, "title"), sequenceTitle(registry, dynvalue.Get(target, "sequence")), shot),
		Action:       displayText(dynvalue.Get(target, "action")),
		SourceShot:   dtoSource,
		SourceTitle:  displayText(dynvalue.Get(source, "title"), sequenceTitle(registry, dynvalue.Get(source, "sequence")), sourceShot),
		SourcePath:   sourcePath,
		SourceFrames: sourceFrames,
		TargetFrames: finite(targetFrames),
		Recipe:       recipeRaw(recipe),
		Preview:      preview,
		Job:          job,
		Problem:      optional(problem),
		ToolsProblem: optional(toolsProblem),
		HasAsset:     dynvalue.Exists(filepath.Join(canonical, "assets", "shots", shot, "manifest.json")),
	}, nil
}

// Save — настройки формы в plan/derived/<план>/draft.json.
func (w *Workflow) Save(project, shot string, value any) (*View, error) {
	view, err := w.View(project, shot)
	if err != nil {
		return nil, err
	}
	if view.SourceShot == nil || *view.SourceShot == "" {
		return nil, errors.New(textNotDerived)
	}
	if w.active(view.Project) != nil {
		return nil, errors.New(textBusy)
	}
	recipe, err := CheckedRecipe(value)
	if err != nil {
		return nil, err
	}
	if err := projectfs.CheckWrite(view.Project); err != nil {
		return nil, err
	}
	draft := dynvalue.NewObject()
	draft.Set("schema_version", 1.0)
	draft.Set("shot", shot)
	draft.Set("source_shot", *view.SourceShot)
	draft.Set("recipe", recipe)
	if err := projectfs.WriteFile(filepath.Join(directory(view.Project, shot), "draft.json"), encode(draft), 0); err != nil {
		return nil, err
	}
	return w.View(view.Project, shot)
}

// blocked — общий отказ Build и Accept: идёт операция либо есть проблема источника или инструментов.
func (w *Workflow) blocked(view *View) error {
	if w.active(view.Project) != nil {
		return errors.New(textBusy)
	}
	if view.Problem != nil {
		return errors.New(*view.Problem)
	}
	if view.ToolsProblem != nil {
		return errors.New(*view.ToolsProblem)
	}
	return nil
}

// remember — запись latest.json после старта задания. Намеренно мимо шлюза записи: запущенная
// приёмка могла уже завести журнал publishing, и шлюз ложно отказал бы при живой публикации.
func remember(project, shot, id, jobID, operation string) error {
	value := dynvalue.NewObject()
	value.Set("id", id)
	value.Set("jobId", jobID)
	value.Set("operation", operation)
	return projectfs.WriteFile(filepath.Join(directory(project, shot), "latest.json"), encode(value), 0)
}

// Build — сохраняет настройки и рецепт новой пробы и запускает
// задание сборки. Рецепт пишется отдельным файлом: инструмент читает именно зафиксированные байты.
func (w *Workflow) Build(project, shot string, value any) (*View, error) {
	view, err := w.View(project, shot)
	if err != nil {
		return nil, err
	}
	if err := w.blocked(view); err != nil {
		return nil, err
	}
	recipe, err := CheckedRecipe(value)
	if err != nil {
		return nil, err
	}
	if problem := RecipeProblem(recipe, view.TargetFrames, view.SourceFrames); problem != "" {
		return nil, errors.New(problem)
	}
	if _, err := w.Save(view.Project, shot, recipe); err != nil {
		return nil, err
	}
	id := montage.RandomUUID()
	base := "plan/derived/" + shot
	recipePath := base + "/recipes/" + id + ".json"
	if err := projectfs.WriteFile(filepath.Join(view.Project, filepath.FromSlash(recipePath)), encode(recipe), 0); err != nil {
		return nil, err
	}
	job, err := w.jobs.Start(jobs.Spec{
		Kind: jobs.KindTool, Title: textBuildTitle(shot), Project: view.Project,
		Steps: []jobs.Step{montage.ToolStep(view.Project, "derive_shot", textBuildStep,
			[]string{"build", "--shot", shot, "--recipe", recipePath, "--work-dir", base + "/" + id, "--json"})},
	})
	if err != nil {
		return nil, err
	}
	if err := remember(view.Project, shot, id, job.ID, "build"); err != nil {
		return nil, err
	}
	return w.View(view.Project, shot)
}

// Accept — запускает приёмку показанной свежей пробы.
func (w *Workflow) Accept(project, shot, id, token string, replace bool) (*View, error) {
	view, err := w.View(project, shot)
	if err != nil {
		return nil, err
	}
	if err := w.blocked(view); err != nil {
		return nil, err
	}
	preview := view.Preview
	if preview == nil || preview.ID != id || preview.ResultToken != token {
		return nil, errors.New(textPreviewMissing)
	}
	if !preview.Fresh {
		return nil, errors.New(textPreviewStale)
	}
	if view.HasAsset && !replace && !preview.Accepted {
		return nil, errors.New(textReplacementRequired)
	}
	args := []string{"accept", "--work-dir", "plan/derived/" + shot + "/" + id, "--confirm", token}
	if replace {
		args = append(args, "--replace")
	}
	job, err := w.jobs.Start(jobs.Spec{
		Kind: jobs.KindTool, Title: textAcceptTitle(shot), Project: view.Project,
		Steps: []jobs.Step{montage.ToolStep(view.Project, "derive_shot", textAcceptStep, append(args, "--json"))},
	})
	if err != nil {
		return nil, err
	}
	if err := remember(view.Project, shot, id, job.ID, "accept"); err != nil {
		return nil, err
	}
	return w.View(view.Project, shot)
}
