// Package derivedworkflow обслуживает страницу производного плана. View собирает контекст плана
// (источник, кадры, рецепт, последняя
// проба и её свежесть), Save хранит настройки формы, Build и Accept запускают задания инструмента
// derive_shot (internal/deriveshot), RecoverApplications откатывает прерванную приёмку.
//
// Файлы проекта читаются деревом jscompat: черновик и рецепт сохраняются с порядком ключей и формой
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

	"songframe-go/internal/acceptance"
	"songframe-go/internal/filedigest"
	"songframe-go/internal/jobs"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/montage"
	"songframe-go/internal/projectfs"
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

// encode — текст writeLocalJson.
func encode(value any) []byte { return []byte(jscompat.StringifyIndent(value, "  ") + "\n") }

// read — read<T>: readLocalJson с заменой любой ошибки на nil.
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

// artifact — artifact(directory, value): файл результата внутри папки с тем же SHA-256. Отказ — ok
// false: показанный ранее файл не заменяется другим, нужна новая сборка.
func artifact(directory string, value any) (string, bool) {
	name, nameOK := jscompat.Get(value, "path").(string)
	digest, digestOK := jscompat.Get(value, "sha256").(string)
	if !jscompat.IsRecord(value) || !nameOK || name == "" || jscompat.IsAbs(name) || !digestOK || !shaPattern.MatchString(digest) {
		return "", false
	}
	path, err := jscompat.Realpath(jscompat.Resolve(directory, name))
	if err != nil {
		return "", false
	}
	local := jscompat.Relative(directory, path)
	if local == "" || local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) || jscompat.IsAbs(local) {
		return "", false
	}
	if actual, ok := filedigest.File(path); !ok || actual != digest {
		return "", false
	}
	return path, true
}

// audioSource — audioSource(project, value): снимок трека {path, sha256}; даже без файла хранит
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
	path := jscompat.Resolve(project, name)
	existing := path
	for !jscompat.Exists(existing) && filepath.Dir(existing) != existing {
		existing = filepath.Dir(existing)
	}
	canonical, err := jscompat.Realpath(existing)
	if err != nil {
		return "", nil, false
	}
	local := jscompat.Relative(project, canonical)
	if local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) || jscompat.IsAbs(local) {
		return "", nil, false
	}
	if existing == path {
		if digest, found := filedigest.File(path); found {
			return name, digest, true
		}
	}
	return name, nil, true
}

// acceptedResult — acceptedResult(project, shot, receipt): принятие принадлежит проекту, журнал
// задания может исчезнуть. Выбранный комплект должен быть derived_video с тем же клипом, а
// committed-журнал с этим токеном — описывать именно текущий манифест.
func acceptedResult(project, shot string, receipt any) bool {
	directory, err := jscompat.Realpath(filepath.Join(project, "assets", "shots", shot))
	if err != nil {
		return false
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	manifest := read(manifestPath)
	if !jscompat.StrictEqual(jscompat.Get(manifest, "schema_version"), 1.0) || !jscompat.StrictEqual(jscompat.Get(manifest, "shot"), shot) ||
		!jscompat.StrictEqual(jscompat.Get(manifest, "kind"), "derived_video") || !jscompat.IsRecord(jscompat.Get(manifest, "accepted_edit")) {
		return false
	}
	video := jscompat.GetPath(manifest, "accepted_edit", "video")
	root := jscompat.Get(video, "root")
	if !jscompat.IsRecord(video) || (root != jscompat.Undefined && !jscompat.StrictEqual(root, "asset")) ||
		!jscompat.StrictEqual(jscompat.Get(video, "sha256"), jscompat.GetPath(receipt, "video", "sha256")) {
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
	entries, err := jscompat.ReadDir(history)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if !entry.IsDir() || !journalName.MatchString(entry.Name()) {
			continue
		}
		journal := read(filepath.Join(history, entry.Name(), "journal.json"))
		kit := jscompat.Get(journal, "directory")
		if jscompat.StrictEqual(jscompat.Get(journal, "schema_version"), 1.0) &&
			jscompat.StrictEqual(jscompat.Get(journal, "id"), entry.Name()) &&
			jscompat.StrictEqual(jscompat.Get(journal, "shot"), shot) &&
			jscompat.StrictEqual(jscompat.Get(journal, "state"), "committed") &&
			jscompat.StrictEqual(jscompat.Get(journal, "result_token"), jscompat.Get(receipt, "result_token")) &&
			jscompat.IsRecord(kit) && jscompat.StrictEqual(jscompat.Get(kit, "path"), "assets/shots/"+shot) &&
			jscompat.IsRecord(jscompat.Get(kit, "after_files")) &&
			jscompat.StrictEqual(jscompat.GetPath(kit, "after_files", "manifest.json"), manifestDigest) {
			return true
		}
	}
	return false
}

// checkProject — project(project, shot): канонический путь существующего проекта и проверка кода
// плана.
func checkProject(project, shot string) (string, error) {
	if !jscompat.IsAbs(project) || !shotPattern.MatchString(shot) {
		return "", errors.New(textProjectInvalid)
	}
	canonical, err := jscompat.Realpath(project)
	if err != nil {
		return "", err
	}
	if !jscompat.Exists(filepath.Join(canonical, "plan", "project.json")) {
		return "", errors.New(textProjectInvalid)
	}
	return canonical, nil
}

// directory — plan/derived/<план> в проекте.
func directory(project, shot string) string { return filepath.Join(project, "plan", "derived", shot) }

// latestRun — latest.json: последняя запущенная операция плана.
type latestRun struct{ id, jobID string }

// latest — latest(project, shot): запись с проверенными полями либо nil.
func latest(project, shot string) *latestRun {
	value := read(filepath.Join(directory(project, shot), "latest.json"))
	id, idOK := jscompat.Get(value, "id").(string)
	job, jobOK := jscompat.Get(value, "jobId").(string)
	operation := jscompat.Get(value, "operation")
	if value == nil || !idOK || !idPattern.MatchString(id) || !jobOK || !(jscompat.StrictEqual(operation, "build") || jscompat.StrictEqual(operation, "accept")) {
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

// findByID — первый элемент массива со значением id (Array.find по строгому равенству).
func findByID(list []any, id any) any {
	for _, item := range list {
		if jscompat.StrictEqual(jscompat.Get(item, "id"), id) {
			return item
		}
	}
	return jscompat.Undefined
}

// sequenceTitle — registry.sequences.find(…)?.title. Реестр без массива sequences не ломает
// страницу: название просто не находится.
func sequenceTitle(registry, sequence any) any {
	list, _ := jscompat.AsArray(jscompat.Get(registry, "sequences"))
	return jscompat.Get(findByID(list, sequence), "title")
}

// displayText — цепочка `a ?? b ?? c` подписи DTO.
func displayText(values ...any) string {
	for _, value := range values {
		if !jscompat.IsNullish(value) {
			return jscompat.ToString(value)
		}
	}
	return ""
}

// recipeRaw — рецепт значением поля DTO.
func recipeRaw(value any) *json.RawMessage {
	if value == nil {
		return nil
	}
	raw := jscompat.Raw(value)
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
	token, tokenOK := jscompat.Get(receipt, "result_token").(string)
	if !jscompat.StrictEqual(jscompat.Get(receipt, "schema_version"), 1.0) || !jscompat.StrictEqual(jscompat.Get(receipt, "shot"), shot) ||
		!tokenOK || !shaPattern.MatchString(token) {
		return nil
	}
	videoPath, ok := artifact(folder, jscompat.Get(receipt, "preview"))
	if !ok {
		return nil
	}
	candidatePath, ok := artifact(folder, jscompat.Get(receipt, "video"))
	if !ok {
		return nil
	}
	saved, err := CheckedRecipe(jscompat.Get(receipt, "recipe"))
	if err != nil {
		return nil
	}
	fresh, invalid := previewFresh(canonical, shot, receipt, build, registry, recipe, saved, problem, target, source)
	if invalid {
		return nil
	}
	return &Preview{
		ID: run.id, VideoPath: videoPath, CandidatePath: candidatePath, ResultToken: token, Recipe: jscompat.Raw(saved),
		Frames: finite(jscompat.ToNumber(jscompat.Get(receipt, "target_frames"))), Fresh: fresh, Problem: staleProblem(fresh),
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

// fingerprint — acceptance.fingerprints?.[shot]: отсутствие — undefined.
func fingerprint(scores acceptance.Result, shot string) any {
	if value, ok := scores.Fingerprints[shot]; ok {
		return value
	}
	return jscompat.Undefined
}

// previewFresh — условие свежести пробы; порядок проверок зафиксирован эталоном. invalid —
// манифест источника исчез между проверками: проба не показывается.
func previewFresh(canonical, shot string, receipt, build, registry, recipe, saved any, problem string, target float64, source sourceState) (fresh, invalid bool) {
	sourceName, _ := source.shot.(string)
	field := func(key string) any { return jscompat.Get(receipt, key) }
	var sourceVideo any = jscompat.Undefined
	if source.snapshot != nil {
		sourceVideo = source.snapshot.AcceptedVideoSha256
	}
	if problem != "" || !jscompat.StrictEqual(field("source_shot"), source.shot) ||
		jscompat.ToNumber(field("target_frames")) != target ||
		!jscompat.StrictEqual(field("target_scene_sha256"), fingerprint(source.scores, shot)) ||
		!jscompat.StrictEqual(field("source_scene_sha256"), fingerprint(source.scores, sourceName)) ||
		!jscompat.StrictEqual(field("source_accepted_video_sha256"), sourceVideo) {
		return false, false
	}
	manifest, ok := jscompat.Get(build, "source_manifest_sha256").(string)
	if !ok || !shaPattern.MatchString(manifest) {
		return false, false
	}
	actual, found := filedigest.File(filepath.Join(canonical, "assets", "shots", sourceName, "manifest.json"))
	if !found {
		return false, true
	}
	name, sha, audioOK := audioSource(canonical, jscompat.GetPath(registry, "audio", "path"))
	audio := field("audio_source")
	var wanted any = sha
	return manifest == actual && audioOK && jscompat.IsRecord(audio) && jscompat.StrictEqual(jscompat.Get(audio, "path"), name) &&
		jscompat.StrictEqual(jscompat.Get(audio, "sha256"), wanted) && jscompat.DeepStrictEqual(recipe, saved), false
}

// View — view(project, shot): контекст страницы без записи в проект. Отказы источника возвращаются
// полем Problem, потому что страница показывает их рядом с сохранённой формой.
func (w *Workflow) View(project, shot string) (*View, error) {
	canonical, err := checkProject(project, shot)
	if err != nil {
		return nil, err
	}
	registry := read(filepath.Join(canonical, "plan", "scenes.json"))
	scenes, _ := jscompat.AsArray(jscompat.Get(registry, "scenes"))
	target := findByID(scenes, shot)
	if !jscompat.Truthy(target) {
		return nil, errors.New(textSceneMissing)
	}
	sourceShot := jscompat.Coalesce(jscompat.GetPath(target, "derived_from", "shot"), nil)
	source := findByID(scenes, sourceShot)
	targetFrames := jscompat.ToNumber(jscompat.Get(target, "end_frame_exclusive")) - jscompat.ToNumber(jscompat.Get(target, "start_frame"))
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
	edit := jscompat.Get(manifest, "accepted_edit")
	sourceFrames := 0.0
	if frames := jscompat.Get(edit, "frames"); jscompat.IsRecord(edit) && jscompat.TypeOf(frames) == "number" &&
		jscompat.StrictEqual(jscompat.Get(edit, "fps"), 30.0) && jscompat.IsSafeInteger(frames) {
		sourceFrames = jscompat.ToNumber(frames)
	}
	state, accepted := scores.Accepted[sourceName]
	problem := ""
	switch {
	case !jscompat.Truthy(sourceShot):
		problem = textNotDerived
	case !jscompat.Truthy(source) || jscompat.StrictEqual(sourceShot, shot) || jscompat.Truthy(jscompat.Get(source, "derived_from")):
		problem = textInvalidSource
	case jscompat.Truthy(jscompat.Get(target, "lipsync")):
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
	if jscompat.StrictEqual(jscompat.Get(draft, "schema_version"), 1.0) && jscompat.StrictEqual(jscompat.Get(draft, "shot"), shot) {
		if checked, err := CheckedRecipe(jscompat.Get(draft, "recipe")); err == nil {
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
		Title:        displayText(jscompat.Get(target, "title"), sequenceTitle(registry, jscompat.Get(target, "sequence")), shot),
		Action:       displayText(jscompat.Get(target, "action")),
		SourceShot:   dtoSource,
		SourceTitle:  displayText(jscompat.Get(source, "title"), sequenceTitle(registry, jscompat.Get(source, "sequence")), sourceShot),
		SourcePath:   sourcePath,
		SourceFrames: sourceFrames,
		TargetFrames: finite(targetFrames),
		Recipe:       recipeRaw(recipe),
		Preview:      preview,
		Job:          job,
		Problem:      optional(problem),
		ToolsProblem: optional(toolsProblem),
		HasAsset:     jscompat.Exists(filepath.Join(canonical, "assets", "shots", shot, "manifest.json")),
	}, nil
}

// Save — save(project, shot, recipe): настройки формы в plan/derived/<план>/draft.json.
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
	draft := jscompat.NewObject()
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
	value := jscompat.NewObject()
	value.Set("id", id)
	value.Set("jobId", jobID)
	value.Set("operation", operation)
	return projectfs.WriteFile(filepath.Join(directory(project, shot), "latest.json"), encode(value), 0)
}

// Build — build(project, shot, recipe): сохраняет настройки и рецепт новой пробы и запускает
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

// Accept — accept(project, shot, id, token, replace): запускает приёмку показанной свежей пробы.
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
