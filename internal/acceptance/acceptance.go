// Package acceptance определяет, какие комплекты assets/shots/Mxx приняты по текущей постановке.
//
// Комплект принят, если отпечаток постановки плана совпадает с plan/production-status.json →
// shots.Mxx.scene_sha256. Производный план (derived_from) дополнительно сверяет снимок выбранного
// ролика источника: действующее подтверждение source_review приоритетнее исторической квитанции
// generation. Правило общее для статуса проекта и будущих страниц планов; пакет только читает
// файлы и ничего не записывает. Хеши роликов считаются через кэш filedigest в памяти процесса.
package acceptance

import (
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/cast"
	"songframe-go/internal/filedigest"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/scenario"
)

// Состояние принятого комплекта.
const (
	Completed = "completed"
	Stale     = "stale"
)

// Причины устаревания; подпись выбирает потребитель.
const (
	SceneChanged         = "scene_changed"
	SourceChanged        = "source_changed"
	SourceUnavailable    = "source_unavailable"
	SourceReceiptMissing = "source_receipt_missing"
	DerivedLinkChanged   = "derived_link_changed"
)

// ProductionStatus — путь файла принятия внутри проекта.
const ProductionStatus = "plan/production-status.json"

// sha256Pattern — формат хеша в квитанциях.
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Result — итог shotAcceptance. Поля сериализуются как expected-acceptance.json эталонов.
type Result struct {
	// Fingerprints — отпечатки текущей постановки по String(id) плана; nil, если состояние
	// реестра не вычисляется (тогда все комплекты устарели по scene_changed).
	Fingerprints map[string]string `json:"fingerprints"`
	// Accepted — только планы с комплектом: completed или stale.
	Accepted map[string]string `json:"accepted"`
	// Reasons — причина устаревания для stale-планов.
	Reasons map[string]string `json:"reasons"`
	// Problem — ошибка вычисления отпечатков для показа пользователю или nil.
	Problem *string `json:"problem"`
}

// sceneComparisonFailed — productionTexts.main.acceptance.sceneComparisonFailed.
func sceneComparisonFailed(reason string) string {
	return "Постановку планов не удалось сверить с принятыми комплектами: " + reason
}

// readJSON читает JSON-файл; при любой ошибке чтения или разбора — undefined, чтобы
// повреждённый файл принятия считался отсутствующим.
func readJSON(path string) any {
	value, ok := jscompat.ReadJSONFile(path)
	if !ok {
		return jscompat.Undefined
	}
	return value
}

// acceptedEntries — shots из файла принятия или пустой объект.
func acceptedEntries(project string) *jscompat.Object {
	status := readJSON(filepath.Join(project, filepath.FromSlash(ProductionStatus)))
	if shots, ok := jscompat.AsObject(jscompat.Get(status, "shots")); ok && jscompat.IsRecord(status) {
		return shots
	}
	return jscompat.NewObject()
}

// ProjectFingerprints — отпечатки по кастингу проекта: initial_state сущностей входит в
// унаследованное состояние плана. Повреждённый кастинг даёт пустое начальное состояние.
func ProjectFingerprints(project string, scenes any) (*jscompat.Object, error) {
	read := cast.Read(project)
	var value any
	if jscompat.Truthy(read.Value) {
		value = read.Value
	}
	initial, err := cast.InitialStates(value)
	if err != nil {
		return nil, err
	}
	return scenario.SceneFingerprints(scenes, initial)
}

// Compute — shotAcceptance(project, scenes): scenes — разобранный реестр (объект с непустым
// массивом scenes). Ошибка означает непригодный реестр (план без строкового id и т. п.), при
// котором расчёт статуса проекта тоже завершается ошибкой.
func Compute(project string, scenes any) (Result, error) {
	result := Result{Accepted: map[string]string{}, Reasons: map[string]string{}}
	fingerprints, err := ProjectFingerprints(project, scenes)
	if err != nil {
		problem := sceneComparisonFailed(err.Error())
		result.Problem = &problem
		fingerprints = nil
	}
	entries := acceptedEntries(project)
	stored := map[string]string{}
	for _, id := range entries.Keys() {
		if sha, ok := jscompat.Get(entries.Value(id), "scene_sha256").(string); ok && jscompat.IsRecord(entries.Value(id)) {
			stored[id] = sha
		}
	}
	accepted := map[string]string{}
	reasons := map[string]string{}
	manifests := map[string]any{}
	stale := func(shot, reason string) {
		accepted[shot] = Stale
		reasons[shot] = reason
	}
	list, err := jscompat.Iterate(jscompat.Get(scenes, "scenes"))
	if err != nil {
		return Result{}, err
	}
	for _, scene := range list {
		rawID, err := jscompat.Prop(scene, "id")
		if err != nil {
			return Result{}, err
		}
		id, err := jscompat.PathArg("path", rawID)
		if err != nil {
			return Result{}, err
		}
		path := filepath.Join(project, "assets", "shots", id, "manifest.json")
		if !jscompat.Exists(path) {
			continue
		}
		manifests[id] = readJSON(path)
		current, has := stored[id]
		if fingerprints != nil && has && fingerprints.Value(id) == any(current) {
			accepted[id] = Completed
		} else {
			stale(id, SceneChanged)
		}
	}
	// Все собственные отпечатки уже вычислены: источник может стоять позже на монтажной шкале.
	for _, scene := range list {
		id := jscompat.Get(scene, "id").(string)
		if accepted[id] != Completed {
			continue
		}
		entry := entries.Value(id)
		source := jscompat.GetPath(scene, "derived_from", "shot")
		manifest := manifests[id]
		storedDerived := jscompat.IsRecord(manifest) && jscompat.StrictEqual(jscompat.Get(manifest, "kind"), "derived_video")
		if !jscompat.Truthy(source) && !storedDerived {
			continue
		}
		generation, hasGeneration := jscompat.AsObject(jscompat.Get(manifest, "generation"))
		if !jscompat.IsRecord(manifest) {
			hasGeneration = false
		}
		if !jscompat.Truthy(source) || !storedDerived || !hasGeneration || !jscompat.StrictEqual(generation.Value("source_shot"), source) {
			stale(id, DerivedLinkChanged)
			continue
		}
		var sourceScene any
		for _, item := range list {
			if jscompat.StrictEqual(jscompat.Get(item, "id"), source) {
				sourceScene = item
				break
			}
		}
		sourceName, sourceIsString := source.(string)
		var snapshot *Snapshot
		if sourceIsString {
			snapshot = ReadSourceVideo(project, sourceName)
		}
		sourceFingerprint := jscompat.Undefined
		if fingerprints != nil {
			sourceFingerprint = fingerprints.Value(jscompat.ToString(source))
		}
		reviewEntry, entryIsRecord := jscompat.AsObject(entry)
		switch {
		case sourceScene == nil || jscompat.Truthy(jscompat.Get(sourceScene, "derived_from")) ||
			accepted[jscompat.ToString(source)] != Completed || !sourceIsString || snapshot == nil:
			stale(id, SourceUnavailable)
		case entryIsRecord && reviewEntry.Has("source_review"):
			review := reviewEntry.Value("source_review")
			valid := validReview(review)
			var own *Snapshot
			if valid {
				own = ReadAcceptedVideo(project, id)
			}
			switch {
			case valid && !jscompat.StrictEqual(jscompat.Get(review, "source_shot"), source):
				stale(id, DerivedLinkChanged)
			case !valid || own == nil || !jscompat.StrictEqual(own.AcceptedVideoSha256, jscompat.Get(review, "accepted_video_sha256")):
				stale(id, SourceReceiptMissing)
			case !jscompat.StrictEqual(jscompat.Get(review, "source_scene_sha256"), sourceFingerprint) ||
				!jscompat.StrictEqual(jscompat.Get(review, "source_accepted_video_sha256"), snapshot.AcceptedVideoSha256):
				stale(id, SourceChanged)
			}
		case jscompat.TypeOf(generation.Value("source_scene_sha256")) != "string" ||
			jscompat.TypeOf(generation.Value("source_accepted_video_sha256")) != "string":
			stale(id, SourceReceiptMissing)
		case !jscompat.StrictEqual(generation.Value("source_scene_sha256"), sourceFingerprint) ||
			!jscompat.StrictEqual(generation.Value("source_accepted_video_sha256"), snapshot.AcceptedVideoSha256):
			stale(id, SourceChanged)
		}
	}
	if fingerprints != nil {
		result.Fingerprints = map[string]string{}
		for _, key := range fingerprints.Keys() {
			result.Fingerprints[key] = fingerprints.Value(key).(string)
		}
	}
	result.Accepted, result.Reasons = accepted, reasons
	return result, nil
}

// validReview — подтверждение source_review ровно с четырьмя полями: непустым source_shot и
// тремя SHA-256.
func validReview(review any) bool {
	object, ok := jscompat.AsObject(review)
	if !ok || object.Len() != 4 {
		return false
	}
	fields := map[string]bool{"source_shot": true, "source_scene_sha256": true, "source_accepted_video_sha256": true, "accepted_video_sha256": true}
	for _, key := range object.Keys() {
		if !fields[key] {
			return false
		}
	}
	shot, ok := object.Value("source_shot").(string)
	if !ok || jscompat.Trim(shot) == "" {
		return false
	}
	for _, key := range []string{"source_scene_sha256", "source_accepted_video_sha256", "accepted_video_sha256"} {
		if text, ok := object.Value(key).(string); !ok || !sha256Pattern.MatchString(text) {
			return false
		}
	}
	return true
}

// Snapshot — фактический выбранный принятый ролик плана.
type Snapshot struct {
	// AcceptedVideoSha256 — хеш байтов ролика; совпадает с записанным в манифесте комплекта.
	AcceptedVideoSha256 string
	// VideoPath — реальный путь ролика после разрешения ссылок.
	VideoPath string
}

// ReadAcceptedVideo — снимок ролика плана, который сам может быть производным.
func ReadAcceptedVideo(project, shot string) *Snapshot { return readVideo(project, shot, true) }

// ReadSourceVideo — снимок ролика источника: источник производного плана не может быть производным.
func ReadSourceVideo(project, shot string) *Snapshot { return readVideo(project, shot, false) }

// readVideo проверяет манифест комплекта и сам файл ролика: путь внутри комплекта, обычный файл,
// хеш байтов равен записанному. Любой отказ — nil: непроверяемый ролик не считается принятым.
func readVideo(project, shot string, allowDerived bool) *Snapshot {
	directory, err := jscompat.Realpath(filepath.Join(project, "assets", "shots", shot))
	if err != nil {
		return nil
	}
	manifest, ok := jscompat.ReadJSONFile(filepath.Join(directory, "manifest.json"))
	if !ok {
		return nil
	}
	object, isRecord := jscompat.AsObject(manifest)
	if !isRecord || !jscompat.StrictEqual(object.Value("schema_version"), 1.0) || !jscompat.StrictEqual(object.Value("shot"), shot) ||
		(!allowDerived && jscompat.StrictEqual(object.Value("kind"), "derived_video")) || !jscompat.IsRecord(object.Value("accepted_edit")) {
		return nil
	}
	video, isRecord := jscompat.AsObject(jscompat.Get(object.Value("accepted_edit"), "video"))
	if !isRecord {
		return nil
	}
	path, isString := video.Value("path").(string)
	root := video.Value("root")
	sha, shaIsString := video.Value("sha256").(string)
	if !isString || path == "" || jscompat.IsAbs(path) || (root != jscompat.Undefined && !jscompat.StrictEqual(root, "asset")) ||
		!shaIsString || !sha256Pattern.MatchString(sha) {
		return nil
	}
	videoPath, err := jscompat.Realpath(jscompat.Resolve(directory, path))
	if err != nil {
		return nil
	}
	local := jscompat.Relative(directory, videoPath)
	if local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) || jscompat.IsAbs(local) {
		return nil
	}
	digest, ok := filedigest.File(videoPath)
	if !ok || digest != sha {
		return nil
	}
	return &Snapshot{AcceptedVideoSha256: digest, VideoPath: videoPath}
}
