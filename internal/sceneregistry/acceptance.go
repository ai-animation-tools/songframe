package sceneregistry

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"songframe-go/internal/filedigest"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/pycompat"
)

// Принятие плана привязано к постановке: отпечаток хранится в plan/production-status.json →
// shots.Mxx.scene_sha256. То же правило повторяет главный процесс (internal/acceptance).

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

// EmptyProductionStatus — EMPTY_PRODUCTION_STATUS: содержимое нового файла принятия, совпадающее с
// шаблоном проекта. Возвращается новая копия.
func EmptyProductionStatus() *pycompat.Dict {
	status := pycompat.NewDict()
	status.Set("schema_version", pycompat.NewInt(1))
	status.Set("current_animatic", nil)
	status.Set("current_animatic_status", "none")
	status.Set("shots", pycompat.NewDict())
	return status
}

// ReadProductionStatus — read_production_status(root): объект plan/production-status.json;
// отсутствующий файл — nil, ошибка чтения или разбора — ValueError «Не удалось прочитать …: <текст
// исключения Python>», не-объект — ValueError.
func ReadProductionStatus(root string) (*pycompat.Dict, error) {
	value, err := pycompat.LoadJSONFile(filepath.Join(root, filepath.FromSlash(ProductionStatus)))
	if err != nil {
		if pycompat.IsNotFound(err) {
			return nil, nil
		}
		if pycompat.IsAny(err, pycompat.OSError, pycompat.ValueError) {
			return nil, valueError("Не удалось прочитать %s: %s", ProductionStatus, err.Error())
		}
		return nil, err
	}
	status, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, valueError("%s должен быть объектом.", ProductionStatus)
	}
	return status, nil
}

// AcceptedFingerprints — accepted_fingerprints(status): отпечатки постановки, по которым приняты
// комплекты, {Mxx: sha} в порядке файла; nil-статус или пустой объект без shots — пусто. Неверная
// запись — ValueError.
func AcceptedFingerprints(status *pycompat.Dict) (*pycompat.Dict, error) {
	var shotsField any = pycompat.NewDict()
	if status.Len() > 0 {
		shotsField, _ = pycompat.DictGet(status, "shots", pycompat.NewDict())
	}
	shots, ok := shotsField.(*pycompat.Dict)
	if !ok {
		return nil, valueError(`%s: shots должен быть объектом {"Mxx": {"scene_sha256": "..."}}.`, ProductionStatus)
	}
	result := pycompat.NewDict()
	for _, sid := range shots.Keys() {
		var digest any
		if entry, ok := shots.Value(sid).(*pycompat.Dict); ok {
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

// WithAcceptedFingerprints — with_accepted_fingerprints(status, updates, clear): копия статуса с
// новыми отпечатками принятых планов (updates: код → hex). Прочие поля и записи других планов
// сохраняются; clearSourceReviews удаляет прежнюю сверку source_review (новая приёмка приносит
// свою квитанцию generation). Записи shots упорядочиваются по монтажному номеру, как у записи
// главного процесса. nil-статус — EmptyProductionStatus.
func WithAcceptedFingerprints(status *pycompat.Dict, updates *pycompat.Dict, clearSourceReviews bool) (*pycompat.Dict, error) {
	result := EmptyProductionStatus()
	if status != nil {
		result = pycompat.DeepCopy(status).(*pycompat.Dict)
	}
	if _, err := AcceptedFingerprints(result); err != nil {
		return nil, err
	}
	existing, _ := pycompat.DictGet(result, "shots", pycompat.NewDict())
	shots := existing.(*pycompat.Dict).Clone()
	for _, sid := range updates.Keys() {
		digest := updates.Value(sid)
		text, isString := digest.(string)
		if !ShotID.MatchString(sid) || !isString || !SHA256.MatchString(text) {
			return nil, valueError("%s: неверный отпечаток постановки %s.", sid, pycompat.Repr(digest))
		}
		entry := pycompat.NewDict()
		if previous, ok := shots.Value(sid).(*pycompat.Dict); ok {
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
		number, err := pycompat.FloatFromString(string(pycompat.Runes(key)[1:]))
		if err != nil {
			return nil, err
		}
		numbers[key] = number
	}
	sort.SliceStable(keys, func(i, j int) bool { return numbers[keys[i]] < numbers[keys[j]] })
	ordered := pycompat.NewDict()
	for _, key := range keys {
		ordered.Set(key, shots.Value(key))
	}
	result.Set("shots", ordered)
	return result, nil
}

// WriteAcceptedFingerprints — write_accepted_fingerprints(root, updates, clear): атомарная запись
// plan/production-status.json с новыми отпечатками (WithAcceptedFingerprints). Отличие от
// оригинала: запись проходит шлюз projectfs.CheckWrite, как вся запись Go-версии в проект.
func WriteAcceptedFingerprints(root string, updates *pycompat.Dict, clearSourceReviews bool) error {
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
	return pycompat.WriteJSONAtomic(filepath.Join(root, filepath.FromSlash(ProductionStatus)), next)
}

// resolvePath — Path.resolve(): абсолютный путь с разыменованными ссылками; ok=false, если путь
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

// isRelativeTo — Path.is_relative_to(directory) для разрешённых путей.
func isRelativeTo(path, directory string) bool {
	return path == directory || strings.HasPrefix(path, strings.TrimSuffix(directory, string(filepath.Separator))+string(filepath.Separator))
}

// SourceVideoSnapshot — source_video_snapshot(root, shot, allowDerived): фактический SHA-256
// выбранного монтажного ролика комплекта assets/shots/<shot>, если он совпадает с записанным в
// manifest.json accepted_edit.video.sha256; иначе ok=false. Производный комплект (derived_video)
// допускается только при allowDerived. Любая ошибка чтения или формы — ok=false, как в оригинале.
func SourceVideoSnapshot(root, shot string, allowDerived bool) (string, bool) {
	directory, ok := resolvePath(filepath.Join(root, "assets", "shots", shot))
	if !ok {
		return "", false
	}
	value, err := pycompat.LoadJSONFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return "", false
	}
	manifest, ok := value.(*pycompat.Dict)
	if !ok || !pycompat.Equal(manifest.Value("schema_version"), pycompat.NewInt(1)) || !pycompat.Equal(manifest.Value("shot"), shot) ||
		pycompat.Equal(manifest.Value("kind"), "derived_video") && !allowDerived {
		return "", false
	}
	edit, err := pycompat.GetItem(manifest, "accepted_edit")
	if err != nil {
		return "", false
	}
	videoValue, err := pycompat.GetItem(edit, "video")
	if err != nil {
		return "", false
	}
	video, ok := videoValue.(*pycompat.Dict)
	if !ok || !video.Has("path") || !video.Has("sha256") {
		return "", false
	}
	name, nameOK := video.Value("path").(string)
	digest, digestOK := video.Value("sha256").(string)
	rootValue, _ := pycompat.DictGet(video, "root", "asset")
	if !nameOK || name == "" || filepath.IsAbs(name) || !pycompat.Equal(rootValue, "asset") || !digestOK || !SHA256.MatchString(digest) {
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
	Kits             *pycompat.Dict
	Accepted         *pycompat.Dict
	Initial          *pycompat.Dict
	SourceSnapshot   Snapshot
	SourceReviews    *pycompat.Dict
	AcceptedSnapshot Snapshot
}

// Acceptance — итог shot_acceptance: состояние (completed/stale) планов с комплектом и причины
// устаревания; оба словаря упорядочены, как в оригинале (причины — по порядку назначения).
type Acceptance struct {
	States  *pycompat.Dict
	Reasons *pycompat.Dict
}

// reviewFields — ключи действующей сверки source_review.
var reviewFields = []string{"source_shot", "source_scene_sha256", "source_accepted_video_sha256", "accepted_video_sha256"}

// validReview — запись source_review ровно с полями reviewFields, кодом плана и hex-отпечатками.
func validReview(value any) bool {
	review, ok := value.(*pycompat.Dict)
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

// ShotAcceptance — shot_acceptance(data, kits, accepted, …): свежесть комплектов по собственной
// постановке и сохранённому снимку источника. Комплект принят, если отпечаток плана совпадает с
// принятым; производный план дополнительно сверяет связь derived_from с квитанцией generation и
// снимок выбранного ролика источника; действующая сверка source_review приоритетнее исторической
// квитанции. Реестр проверяется Validate (ошибка — исключение оригинала).
func ShotAcceptance(data any, input AcceptanceInput) (Acceptance, error) {
	current, err := SceneFingerprints(data, input.Initial)
	if err != nil {
		return Acceptance{}, err
	}
	states, reasons := pycompat.NewDict(), pycompat.NewDict()
	for _, sid := range current.Keys() {
		if input.Kits.Has(sid) {
			if pycompat.Equal(input.Accepted.Value(sid), current.Value(sid)) {
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
	scenes := pycompat.NewDict()
	list, _ := pycompat.Iter(data.(*pycompat.Dict).Value("scenes"))
	for _, item := range list {
		scene := item.(*pycompat.Dict)
		scenes.Set(scene.Value("id").(string), scene)
	}
	reviews := input.SourceReviews
	for _, item := range list {
		scene := item.(*pycompat.Dict)
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
func derivedReason(scene *pycompat.Dict, sid string, input AcceptanceInput, scenes, states, current, reviews *pycompat.Dict) string {
	var source string
	if link, ok := scene.Value("derived_from").(*pycompat.Dict); ok {
		source, _ = link.Value("shot").(string)
	}
	manifest, _ := input.Kits.Value(sid).(*pycompat.Dict)
	storedDerived := manifest != nil && pycompat.Equal(manifest.Value("kind"), "derived_video")
	if source == "" && !storedDerived {
		return ""
	}
	generation, _ := manifest.Value("generation").(*pycompat.Dict)
	if source == "" || !storedDerived || generation == nil || !pycompat.Equal(generation.Value("source_shot"), source) {
		return DerivedLinkChanged
	}
	sourceScene, _ := scenes.Value(source).(*pycompat.Dict)
	snapshot, snapshotOK := "", false
	if input.SourceSnapshot != nil {
		snapshot, snapshotOK = input.SourceSnapshot(source)
	}
	if sourceScene == nil || pycompat.Truthy(sourceScene.Value("derived_from")) || states.Value(source) != Completed || !snapshotOK {
		return SourceUnavailable
	}
	if reviews.Has(sid) {
		// Явная повторная сверка текущего монтажа не переписывает историческое происхождение
		// generation; подтверждение действительно только для этих байтов и этой постановки источника.
		review := reviews.Value(sid)
		if !validReview(review) {
			return SourceReceiptMissing
		}
		record := review.(*pycompat.Dict)
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

// ProjectShotAcceptance — project_shot_acceptance(root, data): свежесть комплектов по файлам
// проекта (манифесты assets/shots, plan/production-status.json, кастинг, выбранные ролики) без
// записи и изменения исторических снимков. data nil — Load(root).
func ProjectShotAcceptance(root string, data *pycompat.Dict) (Acceptance, error) {
	if data == nil {
		loaded, err := Load(root)
		if err != nil {
			return Acceptance{}, err
		}
		data = loaded
	}
	scenes, err := pycompat.Iter(data.Value("scenes"))
	if err != nil {
		return Acceptance{}, err
	}
	kits := pycompat.NewDict()
	for _, item := range scenes {
		idValue, err := pycompat.GetItem(item, "id")
		if err != nil {
			return Acceptance{}, err
		}
		id, ok := idValue.(string)
		if !ok {
			return Acceptance{}, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(idValue))
		}
		path := filepath.Join(root, "assets", "shots", id, "manifest.json")
		if pycompat.IsFile(path) {
			manifest, err := pycompat.LoadJSONFile(path)
			if err != nil && !pycompat.IsAny(err, pycompat.OSError, pycompat.ValueError) {
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
	reviews := pycompat.NewDict()
	if status.Len() > 0 {
		shots, _ := pycompat.DictGet(status, "shots", pycompat.NewDict())
		for _, sid := range shots.(*pycompat.Dict).Keys() {
			entry := shots.(*pycompat.Dict).Value(sid).(*pycompat.Dict)
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
