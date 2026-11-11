package production

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe/internal/acceptance"
	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
	"songframe/internal/projectfile"
	"songframe/internal/providers"
)

// FPS — частота кадров шкалы клипа; реестр сцен хранит свою и её же требует.
const FPS = 30

// Asset — принятые материалы плана в assets/shots/Mxx: пути только к существующим файлам.
type Asset struct {
	Dir      string  `json:"dir"`
	Video    *string `json:"video"`
	Original *string `json:"original"`
}

// ShotProduction — план реестра на странице «Производство»: состояние, подпись этапа, причина
// недоступности повтора, ожидание действия пользователя, принятый комплект и пакеты.
type ShotProduction struct {
	ID       string          `json:"id"`
	Title    json.RawMessage `json:"title"`
	Original json.RawMessage `json:"original,omitempty"`
	Start    float64         `json:"start"`
	End      float64         `json:"end"`
	Lipsync  json.RawMessage `json:"lipsync,omitempty"`
	// State — planned, progress, completed, stale или unknown.
	State       string  `json:"state"`
	StageLabel  string  `json:"stageLabel"`
	StaleReason *string `json:"staleReason"`
	// RegenerateProblem — известная причина недоступности повтора по сохранённому запросу.
	RegenerateProblem *string `json:"regenerateProblem"`
	// DerivedFrom — источник материала по актуальному derived_from сценария.
	DerivedFrom *string        `json:"derivedFrom"`
	Attention   *string        `json:"attention"`
	Asset       *Asset         `json:"asset"`
	Packages    []*PackageView `json:"packages"`
	// Proposal — непринятое предложение агента производства (добавляет сервис приложения из
	// прохода агента); отсутствует в виде самого пакета production.
	Proposal json.RawMessage `json:"proposal,omitempty"`
}

// Broken — BrokenPackage: папка пакета без читаемого workflow.json; приложение её не ведёт, но
// она мешает очереди и удаляется кнопкой.
type Broken struct {
	Dir      string  `json:"dir"`
	Relative string  `json:"relative"`
	Shot     *string `json:"shot"`
	Reason   string  `json:"reason"`
}

// Tools — наличие инструментов приложения: инструменты выполняются в процессе приложения, а
// клиенты платных провайдеров встроены, поэтому Providers отмечает каждого платного провайдера.
type Tools struct {
	Providers map[string]bool `json:"providers"`
}

// View — ProductionView: планы, повреждённые папки пакетов и проблемы.
type View struct {
	Shots    []*ShotProduction `json:"shots"`
	Broken   []Broken          `json:"broken"`
	Problems []string          `json:"problems"`
	Tools    Tools             `json:"tools"`
}

// shotFolder — ID плана в имени папки пакета (Mxx-…, Mxx_…, Mxx).
var shotFolder = regexp.MustCompile(`^(M\d{2}(?:\.\d+)?)(?:[-_]|$)`)

// tools — наличие инструментов не зависит от готовности сценария проекта.
func toolsAvailability() Tools {
	result := Tools{Providers: map[string]bool{}}
	for _, paid := range providers.PaidAdapters() {
		result.Providers[paid.ID] = true
	}
	return result
}

// existingAssetFile — утрата файла не отменяет приёмку, но путь для проигрывателя должен вести к
// существующему файлу комплекта.
func existingAssetFile(assetDir string, path any) (*string, error) {
	if !dynvalue.Truthy(path) {
		return nil, nil
	}
	full, err := joinArg(assetDir, path)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(full); err == nil && info.Mode().IsRegular() {
		return &full, nil
	}
	return nil, nil
}

// packages — все пакеты plan/batches и plan/awaiting (новые сверху) и повреждённые папки.
func listPackages(project string, fingerprint fingerprintFunc) ([]*PackageView, []Broken, error) {
	var packages []*PackageView
	broken := []Broken{}
	for _, base := range []string{"plan/batches", "plan/awaiting"} {
		folder := filepath.Join(project, filepath.FromSlash(base))
		if !dynvalue.Exists(folder) {
			continue
		}
		entries, err := dynvalue.ReadDir(folder)
		if err != nil {
			return nil, nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			dir := filepath.Join(folder, entry.Name())
			view, err := readPackage(project, dir, fingerprint)
			if err != nil {
				return nil, nil, err
			}
			if view != nil {
				packages = append(packages, view)
				continue
			}
			match := shotFolder.FindStringSubmatch(entry.Name())
			// Очередь состоит только из пакетов; в batches недописанной считается лишь папка
			// попытки плана без workflow.json (не проба стыков и не монтаж).
			packageLike := base == "plan/awaiting" ||
				(match != nil && !dynvalue.Exists(filepath.Join(dir, "montage.json")) && !dynvalue.Exists(filepath.Join(dir, "review.json")))
			if packageLike && !dynvalue.Exists(filepath.Join(dir, "workflow.json")) {
				item := Broken{Dir: dir, Relative: base + "/" + entry.Name(), Reason: textBrokenWorkflowMissing}
				if match != nil {
					item.Shot = &match[1]
				}
				broken = append(broken, item)
			}
		}
	}
	modified := make(map[*PackageView]int64, len(packages))
	for _, view := range packages {
		info, err := os.Stat(filepath.Join(view.Dir, "workflow.json"))
		if err != nil {
			return nil, nil, dynvalue.FsError("stat", filepath.Join(view.Dir, "workflow.json"), err)
		}
		modified[view] = info.ModTime().UnixNano()
	}
	sort.SliceStable(packages, func(i, j int) bool { return modified[packages[i]] > modified[packages[j]] })
	return packages, broken, nil
}

// attention — что ждёт от пользователя пакет: вопрос, замечание без доработки, отправка или
// просмотр результата; "" — ничего.
func attention(pkg *PackageView) string {
	name := filepath.Base(pkg.Dir)
	if pending := pkg.Pending(); pending != nil {
		return textAttentionQuestion(name, pending.Question)
	}
	if pkg.DecisionVerdict() == "revise" && pkg.Stage != "accepted" {
		return textAttentionRevision(name)
	}
	status := pkg.attemptStatus()
	switch {
	case (pkg.Stage == "request_choice" || pkg.Stage == "image_request_choice" || pkg.Stage == "ready") && status == "prepared":
		return textAttentionPrepared(name)
	case status == "submission_unknown" || status == "submitting":
		return textAttentionUnknownSubmission(name)
	case (pkg.Stage == "downloaded" || pkg.Stage == "edit_review") && status == "downloaded":
		return textAttentionResult(name)
	case pkg.Stage == "image_downloaded":
		return textAttentionImage(name)
	}
	return ""
}

// sameProvider — sameMediaProvider: непустые строки равны без учёта регистра и крайних пробелов.
func sameProvider(left, right string) bool {
	l, r := dynvalue.Trim(left), dynvalue.Trim(right)
	return l != "" && r != "" && strings.ToLower(l) == strings.ToLower(r)
}

// manualProvider — выбранный провайдер видео известен и не умеет липсинк: речевые планы с ним
// создаются вручную вне приложения (productionworkflow.Context.Manual).
func manualProvider(selected string) bool {
	info, ok := mediaproviders.Lookup(selected)
	return ok && info.LipSync == nil
}

// regenerateProblem — повтор выбирает источник как regenerate_shot --source auto: последний по
// времени request.json пакетов плана, иначе снимок принятого комплекта; провайдер источника
// должен совпадать с выбранным провайдером видео проекта. "" — повтор возможен. Инструменты не
// запускаются.
func regenerateProblem(project, shot string, packages []*PackageView, selected string) string {
	if selected == "" {
		return textRetryProviderRequired(shot)
	}
	compare := func(value any) string {
		provider, _ := value.(string)
		provider = dynvalue.Trim(provider)
		if provider == "" {
			return textRetryOriginalProviderMissing(shot)
		}
		if !sameProvider(provider, selected) {
			return textRetryProviderMismatch(shot, provider, selected)
		}
		return ""
	}
	type candidate struct {
		modified int64
		path     string
		provider any
	}
	var requests []candidate
	for _, pkg := range packages {
		workflow := readJSON(filepath.Join(pkg.Dir, "workflow.json"))
		requestDir, ok := dynvalue.Get(workflow, "request_dir").(string)
		if !ok || requestDir == "" {
			continue
		}
		// Как и инструмент, выбираем последний request.json; порядок workflow.json может отличаться.
		path := dynvalue.Resolve(pkg.Dir, requestDir, "request.json")
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		var provider any = dynvalue.Undefined
		if text, ok := dynvalue.Get(readJSON(path), "provider").(string); ok {
			provider = text
		}
		requests = append(requests, candidate{modified: info.ModTime().UnixNano(), path: path, provider: provider})
	}
	sort.SliceStable(requests, func(i, j int) bool {
		if requests[i].modified != requests[j].modified {
			return requests[i].modified < requests[j].modified
		}
		return dynvalue.LessUTF16(requests[i].path, requests[j].path)
	})
	if len(requests) > 0 {
		return compare(requests[len(requests)-1].provider)
	}
	snapshotPath := filepath.Join(project, "assets", "shots", shot, "generation-request.json")
	if !dynvalue.Exists(snapshotPath) {
		return textRetryRequestMissing(shot)
	}
	snapshot := readJSON(snapshotPath)
	if !dynvalue.Truthy(snapshot) || !(dynvalue.IsRecord(snapshot) || dynvalue.IsArray(snapshot)) {
		return textRetrySnapshotUnreadable(shot)
	}
	return compare(dynvalue.Get(snapshot, "provider"))
}

// optional — непустая строка как указатель, "" — nil.
func optional(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// selectedVideoProvider — generation.video.provider проекта, если выбор подтверждён
// provider_selected: true; иначе "".
func selectedVideoProvider(project string) (string, error) {
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return "", err
	}
	generation, _ := dynvalue.Parse(settings.Generation)
	video := dynvalue.Get(generation, "video")
	provider, ok := dynvalue.Get(video, "provider").(string)
	if !dynvalue.StrictEqual(dynvalue.Get(video, "provider_selected"), true) || !ok {
		return "", nil
	}
	return dynvalue.Trim(provider), nil
}

// ViewProduction — состояние планов по файлам проекта. Без реестра —
// пустой вид с просьбой создать сценарий. Ошибка отклоняет весь вызов (повреждённый
// workflow.json, нечитаемый plan/project.json при непустом реестре). Ничего не пишет.
func ViewProduction(project string) (View, error) {
	view := View{Shots: []*ShotProduction{}, Broken: []Broken{}, Problems: []string{}, Tools: toolsAvailability()}
	scenes := readJSON(filepath.Join(project, "plan", "scenes.json"))
	if !dynvalue.Truthy(scenes) {
		view.Problems = append(view.Problems, TextScenarioRequired)
		return view, nil
	}
	fingerprint := projectFingerprint(project)
	packages, broken, err := listPackages(project, fingerprint)
	if err != nil {
		return View{}, err
	}
	view.Broken = broken
	sequences, ok := dynvalue.AsArray(dynvalue.Get(scenes, "sequences"))
	if !ok {
		return View{}, &dynvalue.TypeError{Message: "scenes.sequences: ожидается список"}
	}
	titles := map[string]any{}
	for _, sequence := range sequences {
		if _, err := dynvalue.Prop(sequence, "id"); err != nil {
			return View{}, err
		}
		// Повтор ID заменяет прежнее название.
		titles[dynvalue.ToString(dynvalue.Get(sequence, "id"))] = dynvalue.Get(sequence, "title")
	}
	list, err := dynvalue.Iterate(dynvalue.Get(scenes, "scenes"))
	if err != nil {
		return View{}, err
	}
	selected := ""
	if len(list) > 0 {
		if selected, err = selectedVideoProvider(project); err != nil {
			return View{}, err
		}
	}
	fps := dynvalue.ToNumber(dynvalue.Get(scenes, "fps"))
	if fps == 0 || fps != fps {
		fps = FPS
	}
	accepted, err := acceptance.Compute(project, scenes)
	if err != nil {
		return View{}, err
	}
	if accepted.Problem != nil {
		view.Problems = append(view.Problems, *accepted.Problem)
	}
	known := map[string]bool{}
	for _, scene := range list {
		rawID, err := dynvalue.Prop(scene, "id")
		if err != nil {
			return View{}, err
		}
		id, err := dynvalue.PathArg("path", rawID)
		if err != nil {
			return View{}, err
		}
		known[id] = true
		shot, err := shotProduction(project, scene, id, packages, titles, fps, accepted, selected)
		if err != nil {
			return View{}, err
		}
		view.Shots = append(view.Shots, shot)
	}
	var orphans []string
	for _, pkg := range packages {
		if !known[pkg.Shot] {
			orphans = append(orphans, filepath.Base(pkg.Dir))
		}
	}
	if len(orphans) > 0 {
		view.Problems = append(view.Problems, textOrphanPackages(strings.Join(orphans, ", ")))
	}
	for _, item := range broken {
		view.Problems = append(view.Problems, textBrokenPackageBlocksQueue(item.Relative, item.Reason))
	}
	return view, nil
}

// shotProduction — ShotProduction одного плана реестра.
func shotProduction(project string, scene any, id string, packages []*PackageView, titles map[string]any, fps float64,
	accepted acceptance.Result, selected string) (*ShotProduction, error) {
	assetDir := filepath.Join(project, "assets", "shots", id)
	manifest := readJSON(filepath.Join(assetDir, "manifest.json"))
	hasManifest := dynvalue.Truthy(manifest)
	video, err := existingAssetFile(assetDir, dynvalue.GetPath(manifest, "accepted_edit", "video", "path"))
	if err != nil {
		return nil, err
	}
	mine := []*PackageView{}
	for _, pkg := range packages {
		if pkg.Shot == id {
			mine = append(mine, pkg)
		}
	}
	// completed обозначает художественную приёмку по текущей постановке; наличие готового файла
	// показывается отдельно.
	acceptedState := ""
	if hasManifest {
		acceptedState = acceptance.Stale
		if value, ok := accepted.Accepted[id]; ok {
			acceptedState = value
		}
	}
	state := acceptedState
	if state == "" {
		state = StatePlanned
		if len(mine) > 0 {
			state = StateProgress
		}
	}
	staleCode := accepted.Reasons[id]
	var staleReason *string
	if acceptedState == acceptance.Stale && staleCode != "" {
		reason, ok := staleReasons[staleCode]
		if !ok {
			reason = textStaleReasonUnknown
		}
		staleReason = &reason
	}
	var stageLabel string
	switch {
	case acceptedState == acceptance.Stale:
		if staleCode != "" && staleCode != acceptance.SceneChanged {
			stageLabel = *staleReason
		} else {
			stageLabel = textAcceptedOldScene
		}
	case hasManifest:
		if video != nil {
			stageLabel = textAcceptedVideoSaved
		} else {
			stageLabel = textAcceptedVideoMissing
		}
	case len(mine) > 0:
		stageLabel = mine[0].StageLabel
	default:
		stageLabel = textNotStarted
	}
	for _, pkg := range mine {
		if pending := pkg.Pending(); pending != nil {
			question := dynvalue.ToString(dynvalue.Get(dynvalue.Get(pkg.workflow, "pending_decision"), "question"))
			if hasManifest {
				stageLabel = textAcceptedDecisionPending(question)
			} else {
				stageLabel = textDecisionPending(question)
			}
			break
		}
	}
	for _, pkg := range mine {
		if len(pkg.Problems) > 0 && !hasManifest {
			state = StateUnknown
		}
	}
	var attentionText *string
	for _, pkg := range mine {
		if text := attention(pkg); text != "" {
			attentionText = &text
			break
		}
	}
	sequence := dynvalue.Get(scene, "sequence")
	title := dynvalue.Get(scene, "title")
	if dynvalue.IsNullish(title) {
		title = titles[dynvalue.ToString(sequence)]
		if dynvalue.IsNullish(title) {
			title = sequence
		}
	}
	shot := &ShotProduction{
		ID: id, Title: rawOrNull(title), Original: rawOptional(dynvalue.Get(scene, "original")),
		Start: dynvalue.ToNumber(dynvalue.Get(scene, "start_frame")) / fps, End: dynvalue.ToNumber(dynvalue.Get(scene, "end_frame_exclusive")) / fps,
		Lipsync: rawOptional(dynvalue.Get(scene, "lipsync")), State: state, StageLabel: stageLabel, StaleReason: staleReason,
		Attention: attentionText, Packages: mine,
	}
	// Производный план собирается из чужого материала: повтор генерации для него не нужен.
	if source := derivedshot.Source(scene); source != "" {
		shot.DerivedFrom = &source
		shot.RegenerateProblem = optional(derivedshot.Reason(source))
	} else if dynvalue.StrictEqual(dynvalue.Get(scene, "lipsync"), true) && manualProvider(selected) {
		// Речевой план у провайдера без липсинка делается вручную вне приложения: сохранённый запрос
		// сервису повторять нельзя, нужна новая попытка с пакетом ручной генерации.
		shot.RegenerateProblem = optional(textRetryManual(id))
	} else {
		shot.RegenerateProblem = optional(regenerateProblem(project, id, mine, selected))
	}
	if hasManifest {
		original, err := existingAssetFile(assetDir, dynvalue.GetPath(manifest, "generation", "original", "path"))
		if err != nil {
			return nil, err
		}
		shot.Asset = &Asset{Dir: assetDir, Video: video, Original: original}
	}
	return shot, nil
}
