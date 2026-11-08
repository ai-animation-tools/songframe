package sceneregistry

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"songframe/internal/filedigest"
	"songframe/internal/projectfs"
	"songframe/internal/toolrt"
)

// Принятие плана привязано к постановке: отпечаток хранится в plan/production-status.json →
// shots.Mxx.scene_sha256. То же правило для страниц приложения применяет internal/acceptance.

// Состояния принятых комплектов и причины устаревания (значения shot_acceptance).
const (
	Completed            = "completed"
	Stale                = "stale"
	SceneChanged         = "scene_changed"
	DerivedLinkChanged   = "derived_link_changed"
	SourceUnavailable    = "source_unavailable"
	SourceReceiptMissing = "source_receipt_missing"
	SourceChanged        = "source_changed"
)

// EmptyProductionStatus — содержимое нового файла принятия, совпадающее с
// шаблоном проекта. Возвращается новая копия.
func EmptyProductionStatus() *toolrt.Dict {
	status := toolrt.NewDict()
	status.Set("schema_version", toolrt.NewInt(1))
	status.Set("current_animatic", nil)
	status.Set("current_animatic_status", "none")
	status.Set("shots", toolrt.NewDict())
	return status
}

// ReadProductionStatus — объект plan/production-status.json;
// отсутствующий файл — nil, ошибка чтения или разбора — ValueError «Не удалось прочитать …: <текст
// исключения>», не-объект — ValueError.
func ReadProductionStatus(root string) (*toolrt.Dict, error) {
	value, err := toolrt.LoadJSONFile(filepath.Join(root, filepath.FromSlash(ProductionStatus)))
	if err != nil {
		if toolrt.IsNotFound(err) {
			return nil, nil
		}
		if toolrt.IsAny(err, toolrt.OSError, toolrt.ValueError) {
			return nil, valueError("Не удалось прочитать %s: %s", ProductionStatus, err.Error())
		}
		return nil, err
	}
	status, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, valueError("%s должен быть объектом.", ProductionStatus)
	}
	return status, nil
}

// AcceptedFingerprints — отпечатки постановки, по которым приняты
// комплекты, {Mxx: sha} в порядке файла; nil-статус или пустой объект без shots — пусто. Неверная
// запись — ValueError.
func AcceptedFingerprints(status *toolrt.Dict) (*toolrt.Dict, error) {
	var shotsField any = toolrt.NewDict()
	if status.Len() > 0 {
		shotsField, _ = toolrt.DictGet(status, "shots", toolrt.NewDict())
	}
	shots, ok := shotsField.(*toolrt.Dict)
	if !ok {
		return nil, valueError(`%s: shots должен быть объектом {"Mxx": {"scene_sha256": "..."}}.`, ProductionStatus)
	}
	result := toolrt.NewDict()
	for _, sid := range shots.Keys() {
		var digest any
		if entry, ok := shots.Value(sid).(*toolrt.Dict); ok {
			digest = entry.Value("scene_sha256")
		}
		text, isString := digest.(string)
		if !ShotID.MatchString(sid) || !isString || !SHA256.MatchString(text) {
			return nil, valueError("%s: shots.%s должен содержать scene_sha256 из 64 hex-символов.", ProductionStatus, sid)
		}
		result.Set(sid, text)
	}
	return result, nil
}

// WithAcceptedFingerprints — копия статуса с
// новыми отпечатками принятых планов (updates: код → hex). Прочие поля и записи других планов
// сохраняются; clearSourceReviews удаляет прежнюю сверку source_review (новая приёмка приносит
// свою квитанцию generation). Записи shots упорядочиваются по монтажному номеру, как при записи
// статуса из приложения (internal/acceptance). nil-статус — EmptyProductionStatus.
func WithAcceptedFingerprints(status *toolrt.Dict, updates *toolrt.Dict, clearSourceReviews bool) (*toolrt.Dict, error) {
	result := EmptyProductionStatus()
	if status != nil {
		result = toolrt.DeepCopy(status).(*toolrt.Dict)
	}
	if _, err := AcceptedFingerprints(result); err != nil {
		return nil, err
	}
	existing, _ := toolrt.DictGet(result, "shots", toolrt.NewDict())
	shots := existing.(*toolrt.Dict).Clone()
	for _, sid := range updates.Keys() {
		digest := updates.Value(sid)
		text, isString := digest.(string)
		if !ShotID.MatchString(sid) || !isString || !SHA256.MatchString(text) {
			return nil, valueError("%s: неверный отпечаток постановки %s.", sid, toolrt.Repr(digest))
		}
		entry := toolrt.NewDict()
		if previous, ok := shots.Value(sid).(*toolrt.Dict); ok {
			entry = previous.Clone()
		}
		entry.Set("scene_sha256", text)
		if clearSourceReviews {
			entry.Delete("source_review")
		}
		shots.Set(sid, entry)
	}
	keys := shots.Keys()
	numbers := make(map[string]float64, len(keys))
	for _, key := range keys {
		number, err := toolrt.FloatFromString(string(toolrt.Runes(key)[1:]))
		if err != nil {
			return nil, err
		}
		numbers[key] = number
	}
	sort.SliceStable(keys, func(i, j int) bool { return numbers[keys[i]] < numbers[keys[j]] })
	ordered := toolrt.NewDict()
	for _, key := range keys {
		ordered.Set(key, shots.Value(key))
	}
	result.Set("shots", ordered)
	return result, nil
}

// WriteAcceptedFingerprints — атомарная запись
// plan/production-status.json с новыми отпечатками (WithAcceptedFingerprints). Запись проходит
// шлюз projectfs.CheckWrite, как любая запись приложения в проект.
func WriteAcceptedFingerprints(root string, updates *toolrt.Dict, clearSourceReviews bool) error {
	status, err := ReadProductionStatus(root)
	if err != nil {
		return err
	}
	next, err := WithAcceptedFingerprints(status, updates, clearSourceReviews)
	if err != nil {
		return err
	}
	if err := projectfs.CheckWrite(root); err != nil {
		return err
	}
	return toolrt.WriteJSONAtomic(filepath.Join(root, filepath.FromSlash(ProductionStatus)), next)
}

// resolvePath — абсолютный путь с разыменованными ссылками; ok=false, если путь
// не существует (тогда снимок источника всё равно недоступен).
func resolvePath(path string) (string, bool) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", false
	}
	return resolved, true
}

// isRelativeTo — path совпадает с directory или лежит внутри неё (оба пути уже разрешены).
func isRelativeTo(path, directory string) bool {
	return path == directory || strings.HasPrefix(path, strings.TrimSuffix(directory, string(filepath.Separator))+string(filepath.Separator))
}

// SourceVideoSnapshot — фактический SHA-256
// выбранного монтажного ролика комплекта assets/shots/<shot>, если он совпадает с записанным в
// manifest.json accepted_edit.video.sha256; иначе ok=false. Производный комплект (derived_video)
// допускается только при allowDerived. Любая ошибка чтения или формы — ok=false.
func SourceVideoSnapshot(root, shot string, allowDerived bool) (string, bool) {
	directory, ok := resolvePath(filepath.Join(root, "assets", "shots", shot))
	if !ok {
		return "", false
	}
	value, err := toolrt.LoadJSONFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return "", false
	}
	manifest, ok := value.(*toolrt.Dict)
	if !ok || !toolrt.Equal(manifest.Value("schema_version"), toolrt.NewInt(1)) || !toolrt.Equal(manifest.Value("shot"), shot) ||
		toolrt.Equal(manifest.Value("kind"), "derived_video") && !allowDerived {
		return "", false
	}
	edit, err := toolrt.GetItem(manifest, "accepted_edit")
	if err != nil {
		return "", false
	}
	videoValue, err := toolrt.GetItem(edit, "video")
	if err != nil {
		return "", false
	}
	video, ok := videoValue.(*toolrt.Dict)
	if !ok || !video.Has("path") || !video.Has("sha256") {
		return "", false
	}
	name, nameOK := video.Value("path").(string)
	digest, digestOK := video.Value("sha256").(string)
	rootValue, _ := toolrt.DictGet(video, "root", "asset")
	if !nameOK || name == "" || filepath.IsAbs(name) || !toolrt.Equal(rootValue, "asset") || !digestOK || !SHA256.MatchString(digest) {
		return "", false
	}
	path, ok := resolvePath(filepath.Join(directory, name))
	if !ok || !isRelativeTo(path, directory) {
		return "", false
	}
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	actual, ok := filedigest.File(path)
	if !ok || actual != digest {
		return "", false
	}
	return actual, true
}

// Snapshot — функция снимка ролика плана (SHA или ok=false); nil — снимка нет.
type Snapshot func(shot string) (string, bool)

// AcceptanceInput — аргументы shot_acceptance. Kits — прочитанные манифесты комплектов (ключ есть,
// если manifest.json существует; значение nil — файл не разобран); Accepted — AcceptedFingerprints;
// Initial — начальное состояние кастинга; SourceSnapshot — SHA выбранного видео источника;
// SourceReviews — записи shots.Mxx.source_review; AcceptedSnapshot — SHA собственного ролика плана.
type AcceptanceInput struct {
	Kits             *toolrt.Dict
	Accepted         *toolrt.Dict
	Initial          *toolrt.Dict
	SourceSnapshot   Snapshot
	SourceReviews    *toolrt.Dict
	AcceptedSnapshot Snapshot
}

// Acceptance — итог ShotAcceptance: состояние (completed/stale) планов с комплектом и причины
// устаревания; порядок обоих словарей зафиксирован эталоном (причины — по порядку назначения).
type Acceptance struct {
	States  *toolrt.Dict
	Reasons *toolrt.Dict
}

// reviewFields — ключи действующей сверки source_review.
var reviewFields = []string{"source_shot", "source_scene_sha256", "source_accepted_video_sha256", "accepted_video_sha256"}

// validReview — запись source_review ровно с полями reviewFields, кодом плана и hex-отпечатками.
func validReview(value any) bool {
	review, ok := value.(*toolrt.Dict)
	if !ok || review.Len() != len(reviewFields) {
		return false
	}
	for _, key := range reviewFields {
		text, isString := review.Value(key).(string)
		if !review.Has(key) || !isString {
			return false
		}
		if key == "source_shot" && !ShotID.MatchString(text) || key != "source_shot" && !SHA256.MatchString(text) {
			return false
		}
	}
	return true
}

// ShotAcceptance — свежесть комплектов по собственной
// постановке и сохранённому снимку источника. Комплект принят, если отпечаток плана совпадает с
// принятым; производный план дополнительно сверяет связь derived_from с квитанцией generation и
// снимок выбранного ролика источника; действующая сверка source_review приоритетнее исторической
// квитанции. Реестр проверяется Validate (ошибка — её исключение).
func ShotAcceptance(data any, input AcceptanceInput) (Acceptance, error) {
	current, err := SceneFingerprints(data, input.Initial)
	if err != nil {
		return Acceptance{}, err
	}
	states, reasons := toolrt.NewDict(), toolrt.NewDict()
	for _, sid := range current.Keys() {
		if input.Kits.Has(sid) {
			if toolrt.Equal(input.Accepted.Value(sid), current.Value(sid)) {
				states.Set(sid, Completed)
			} else {
				states.Set(sid, Stale)
			}
		}
	}
	for _, sid := range states.Keys() {
		if states.Value(sid) == Stale {
			reasons.Set(sid, SceneChanged)
		}
	}
	scenes := toolrt.NewDict()
	list, _ := toolrt.Iter(data.(*toolrt.Dict).Value("scenes"))
	for _, item := range list {
		scene := item.(*toolrt.Dict)
		scenes.Set(scene.Value("id").(string), scene)
	}
	reviews := input.SourceReviews
	for _, item := range list {
		scene := item.(*toolrt.Dict)
		sid := scene.Value("id").(string)
		if states.Value(sid) != Completed {
			continue
		}
		reason := derivedReason(scene, sid, input, scenes, states, current, reviews)
		if reason != "" {
			states.Set(sid, Stale)
			reasons.Set(sid, reason)
		}
	}
	return Acceptance{States: states, Reasons: reasons}, nil
}

// derivedReason — причина устаревания принятого производного плана или пустая строка.
func derivedReason(scene *toolrt.Dict, sid string, input AcceptanceInput, scenes, states, current, reviews *toolrt.Dict) string {
	var source string
	if link, ok := scene.Value("derived_from").(*toolrt.Dict); ok {
		source, _ = link.Value("shot").(string)
	}
	manifest, _ := input.Kits.Value(sid).(*toolrt.Dict)
	storedDerived := manifest != nil && toolrt.Equal(manifest.Value("kind"), "derived_video")
	if source == "" && !storedDerived {
		return ""
	}
	generation, _ := manifest.Value("generation").(*toolrt.Dict)
	if source == "" || !storedDerived || generation == nil || !toolrt.Equal(generation.Value("source_shot"), source) {
		return DerivedLinkChanged
	}
	sourceScene, _ := scenes.Value(source).(*toolrt.Dict)
	snapshot, snapshotOK := "", false
	if input.SourceSnapshot != nil {
		snapshot, snapshotOK = input.SourceSnapshot(source)
	}
	if sourceScene == nil || toolrt.Truthy(sourceScene.Value("derived_from")) || states.Value(source) != Completed || !snapshotOK {
		return SourceUnavailable
	}
	if reviews.Has(sid) {
		// Явная повторная сверка текущего монтажа не переписывает историческое происхождение
		// generation; подтверждение действительно только для этих байтов и этой постановки источника.
		review := reviews.Value(sid)
		if !validReview(review) {
			return SourceReceiptMissing
		}
		record := review.(*toolrt.Dict)
		if record.Value("source_shot") != source {
			return DerivedLinkChanged
		}
		if input.AcceptedSnapshot == nil {
			return SourceReceiptMissing
		}
		if own, ok := input.AcceptedSnapshot(sid); !ok || own != record.Value("accepted_video_sha256") {
			return SourceReceiptMissing
		}
		if record.Value("source_scene_sha256") != current.Value(source) || record.Value("source_accepted_video_sha256") != snapshot {
			return SourceChanged
		}
		return ""
	}
	sceneSHA, sceneOK := generation.Value("source_scene_sha256").(string)
	videoSHA, videoOK := generation.Value("source_accepted_video_sha256").(string)
	if !sceneOK || !videoOK {
		return SourceReceiptMissing
	}
	if sceneSHA != current.Value(source) || videoSHA != snapshot {
		return SourceChanged
	}
	return ""
}

// ProjectShotAcceptance — свежесть комплектов по файлам
// проекта (манифесты assets/shots, plan/production-status.json, кастинг, выбранные ролики) без
// записи и изменения исторических снимков. data nil — Load(root).
func ProjectShotAcceptance(root string, data *toolrt.Dict) (Acceptance, error) {
	if data == nil {
		loaded, err := Load(root)
		if err != nil {
			return Acceptance{}, err
		}
		data = loaded
	}
	scenes, err := toolrt.Iter(data.Value("scenes"))
	if err != nil {
		return Acceptance{}, err
	}
	kits := toolrt.NewDict()
	for _, item := range scenes {
		idValue, err := toolrt.GetItem(item, "id")
		if err != nil {
			return Acceptance{}, err
		}
		id, ok := idValue.(string)
		if !ok {
			return Acceptance{}, toolrt.Raise(toolrt.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", toolrt.TypeName(idValue))
		}
		path := filepath.Join(root, "assets", "shots", id, "manifest.json")
		if toolrt.IsFile(path) {
			manifest, err := toolrt.LoadJSONFile(path)
			if err != nil && !toolrt.IsAny(err, toolrt.OSError, toolrt.ValueError) {
				return Acceptance{}, err
			}
			kits.Set(id, manifest)
		}
	}
	status, err := ReadProductionStatus(root)
	if err != nil {
		return Acceptance{}, err
	}
	accepted, err := AcceptedFingerprints(status)
	if err != nil {
		return Acceptance{}, err
	}
	reviews := toolrt.NewDict()
	if status.Len() > 0 {
		shots, _ := toolrt.DictGet(status, "shots", toolrt.NewDict())
		for _, sid := range shots.(*toolrt.Dict).Keys() {
			entry := shots.(*toolrt.Dict).Value(sid).(*toolrt.Dict)
			if review, ok := entry.Get("source_review"); ok {
				reviews.Set(sid, review)
			}
		}
	}
	initial, err := InitialStatesFor(root)
	if err != nil {
		return Acceptance{}, err
	}
	return ShotAcceptance(data, AcceptanceInput{
		Kits:             kits,
		Accepted:         accepted,
		Initial:          initial,
		SourceSnapshot:   func(shot string) (string, bool) { return SourceVideoSnapshot(root, shot, false) },
		SourceReviews:    reviews,
		AcceptedSnapshot: func(shot string) (string, bool) { return SourceVideoSnapshot(root, shot, true) },
	})
}
