package scenarioworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/filedigest"
	"songframe/internal/scenario"
	"songframe/internal/sourceinputs"
	"songframe/internal/timing"
)

// Входы сценарного прохода: опись исходников, разметка и документы проекта
// с проверками готовности и SHA-256 всех файлов, от которых зависит предложение. Снимок хешей
// запоминается при запуске агента и сверяется перед применением: любое изменение входа делает
// предложение устаревшим.

// hashes — путь файла проекта → SHA-256 (nil — файла нет). Порядок ключей — порядок добавления
// путей: он сохраняется в записи прохода и зафиксирован эталонами.
type hashes struct {
	keys   []string
	values map[string]*string
}

func newHashes() *hashes { return &hashes{values: map[string]*string{}} }

// set добавляет или заменяет хеш пути.
func (h *hashes) set(path string, value *string) {
	if _, ok := h.values[path]; !ok {
		h.keys = append(h.keys, path)
	}
	h.values[path] = value
}

// get — хеш пути и признак его наличия в снимке.
func (h *hashes) get(path string) (*string, bool) {
	value, ok := h.values[path]
	return value, ok
}

// matches — одинаковые наборы путей и хешей (порядок не важен).
func (h *hashes) matches(other *hashes) bool {
	if other == nil || len(h.keys) != len(other.keys) {
		return false
	}
	for _, key := range h.keys {
		value, ok := other.values[key]
		if !ok || !sameDigest(h.values[key], value) {
			return false
		}
	}
	return true
}

// object — снимок как объект JSON (null для отсутствующего файла).
func (h *hashes) object() *dynvalue.Object {
	result := dynvalue.NewObject()
	for _, key := range h.keys {
		if value := h.values[key]; value != nil {
			result.Set(key, *value)
		} else {
			result.Set(key, nil)
		}
	}
	return result
}

// changedCategories — виды входов утверждения, чьи хеши в current отличаются хотя бы от одного
// снимка: "sources" (любой файл source/*, включая добавленные и удалённые), "timing", "cast",
// "treatment" в этом порядке.
func changedCategories(current *hashes, snapshots ...*hashes) []string {
	found := map[string]bool{}
	mark := func(path string) {
		switch {
		case strings.HasPrefix(path, "source/"):
			found["sources"] = true
		case path == "plan/audio/timing.json":
			found["timing"] = true
		case path == "plan/cast.json":
			found["cast"] = true
		case path == "plan/treatment.json":
			found["treatment"] = true
		}
	}
	for _, snapshot := range snapshots {
		for _, key := range current.keys {
			if value, ok := snapshot.get(key); !ok || !sameDigest(current.values[key], value) {
				mark(key)
			}
		}
		for _, key := range snapshot.keys {
			if _, ok := current.get(key); !ok {
				mark(key)
			}
		}
	}
	return orderedCategories(found)
}

// inputCategories — виды входов утверждения в порядке показа.
var inputCategories = []string{"sources", "timing", "cast", "treatment"}

// orderedCategories — отмеченные виды в порядке inputCategories; неизвестные отбрасываются.
func orderedCategories(found map[string]bool) []string {
	result := []string{}
	for _, category := range inputCategories {
		if found[category] {
			result = append(result, category)
		}
	}
	return result
}

// mergeCategories — объединение списков видов входов в порядке inputCategories.
func mergeCategories(lists ...[]string) []string {
	found := map[string]bool{}
	for _, list := range lists {
		for _, category := range list {
			found[category] = true
		}
	}
	return orderedCategories(found)
}

// hashesFrom — снимок из проверенной записи прохода (checkHashes).
func hashesFrom(value any) *hashes {
	result := newHashes()
	record, _ := dynvalue.AsObject(value)
	if record == nil {
		return result
	}
	for _, key := range record.Keys() {
		if text, ok := record.Value(key).(string); ok {
			result.set(key, &text)
		} else {
			result.set(key, nil)
		}
	}
	return result
}

func sameDigest(left, right *string) bool {
	if left == nil || right == nil {
		return left == right
	}
	return *left == *right
}

// digestText — SHA-256 байтов в шестнадцатеричной записи.
func digestText(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// fileHash — для source/manifest.json — отпечаток входов, для остальных путей — SHA-256 байтов;
// nil — файла нет. Ошибка чтения существующего файла возвращается ошибкой, а не «нет файла».
func fileHash(project, relative string) (*string, error) {
	data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(relative)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, dynvalue.FsError("open", filepath.Join(project, filepath.FromSlash(relative)), err)
	}
	var text string
	if relative == "source/manifest.json" {
		text = sourceinputs.DigestBytes(data)
	} else {
		text = digestText(data)
	}
	return &text, nil
}

// snapshotMatches — все пути снимка имеют прежние хеши.
func snapshotMatches(project string, expected *hashes) (bool, error) {
	for _, key := range expected.keys {
		current, err := fileHash(project, key)
		if err != nil {
			return false, err
		}
		if !sameDigest(current, expected.values[key]) {
			return false, nil
		}
	}
	return true, nil
}

// readJSON — документ проекта: null для отсутствующего файла, иначе разбор текста UTF-8 в дерево
// dynvalue. Ошибка разбора — текст разборщика dynvalue.
func readJSON(project, relative string) (any, error) {
	path := filepath.Join(project, filepath.FromSlash(relative))
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, dynvalue.FsError("open", path, err)
	}
	return dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
}

var (
	shotFolder = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)
)

// lstat — lstat без ошибки для отсутствующего пути.
func lstat(path string) (fs.FileInfo, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return info, err
}

// fixedViews — производные виды с постоянными путями.
var fixedViews = []string{
	"ROADMAP.md",
	"plan/edit-list.md",
	"plan/storyboard.md",
	"plan/context/characters.md",
	"plan/audio/timing.md",
	"assets/shots/manifest.json",
	"plan/animatic/cards/manifest.json",
}

// scenarioOutputPaths — известные производные виды проекта, включая
// отсутствующие фиксированные, существующие PNG карточек и README комплектов. Входят в снимок
// предложения до запуска агента, чтобы появление нового производного файла делало его устаревшим.
func scenarioOutputPaths(project string) ([]string, error) {
	outputs := map[string]bool{}
	for _, path := range fixedViews {
		outputs[path] = true
	}
	cards := filepath.Join(project, "plan", "animatic", "cards")
	info, err := lstat(cards)
	if err != nil {
		return nil, err
	}
	if info != nil {
		if !info.IsDir() {
			return nil, errors.New(textCardsDirectoryRequired)
		}
		entries, err := os.ReadDir(cards)
		if err != nil {
			return nil, dynvalue.FsError("scandir", cards, err)
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".png") {
				outputs["plan/animatic/cards/"+entry.Name()] = true
			}
		}
	}
	shots := filepath.Join(project, "assets", "shots")
	info, err = lstat(shots)
	if err != nil {
		return nil, err
	}
	if info != nil {
		if !info.IsDir() {
			return nil, errors.New(textShotsDirectoryRequired)
		}
		entries, err := os.ReadDir(shots)
		if err != nil {
			return nil, dynvalue.FsError("scandir", shots, err)
		}
		for _, entry := range entries {
			if shotFolder.MatchString(entry.Name()) {
				if readme, _ := lstat(filepath.Join(shots, entry.Name(), "README.md")); readme != nil {
					outputs["assets/shots/"+entry.Name()+"/README.md"] = true
				}
			}
		}
	}
	result := make([]string, 0, len(outputs))
	for path := range outputs {
		result = append(result, path)
	}
	// Сортировка путей по кодовым единицам UTF-16.
	sort.Slice(result, func(i, j int) bool { return dynvalue.LessUTF16(result[i], result[j]) })
	return result, nil
}

// inputs — входы проекта для вида и действий сценарного прохода.
type inputs struct {
	project   string
	documents Documents
	manifest  *dynvalue.Object
	timing    *dynvalue.Object
	// duration — duration_decoded разметки; nil, если разметка не прошла проверку.
	duration *float64
	hashes   *hashes
	// approval — часть снимка, на которую опирается утверждение пары: исходники, разметка,
	// кастинг и трактовка.
	approval *hashes
	// problems — препятствия запуску прохода трактовки (исходники, разметка); documentProblems —
	// проблемы документов сценария.
	problems, documentProblems []string
	pairValid, scenesValid     bool
	scenesReady                bool
	// treatmentDraft — трактовка прочитана черновиком с проблемами validateTreatment.
	treatmentDraft bool
}

// sourcePath — путь из описи или кастинга внутри source/ с прямыми слешами.
func sourcePath(project string, value any) (string, error) {
	path, ok := value.(string)
	if !ok || path == "" || dynvalue.IsAbs(path) {
		return "", errors.New(textSourcePathUnreadable)
	}
	base := filepath.Join(project, "source")
	local := dynvalue.Relative(base, dynvalue.Resolve(base, path))
	if strings.HasPrefix(local, "..") || dynvalue.IsAbs(local) {
		return "", errors.New(textSourceOutsideProject)
	}
	return "source/" + strings.ReplaceAll(local, "\\", "/"), nil
}

// orderedSet — множество путей в порядке добавления: порядок попадает в снимок хешей.
type orderedSet struct {
	items []string
	seen  map[string]bool
}

func (s *orderedSet) add(path string) {
	if s.seen == nil {
		s.seen = map[string]bool{}
	}
	if !s.seen[path] {
		s.seen[path] = true
		s.items = append(s.items, path)
	}
}

// readInputs — входы прохода для проекта. Ошибка — только исключение до сбора проблем (нет папки
// проекта, повреждённая папка карточек); остальное — проблемы вида.
func readInputs(path string) (*inputs, error) {
	project, err := dynvalue.Realpath(path)
	if err != nil {
		return nil, err
	}
	result := &inputs{project: project, problems: []string{}, documentProblems: []string{}}
	paths := &orderedSet{}
	for _, item := range []string{"plan/project.json", "plan/production-status.json", "source/manifest.json", "source/track.mp3", "source/text.md",
		"source/description.md", "plan/audio/timing.json", "plan/cast.json", "plan/treatment.json", "plan/scenes.json"} {
		paths.add(item)
	}
	outputs, err := scenarioOutputPaths(project)
	if err != nil {
		return nil, err
	}
	for _, item := range outputs {
		paths.add(item)
	}
	if err := readSources(result, paths); err != nil {
		result.problems = append(result.problems, err.Error())
	}
	readDocuments(result)
	castImagesValid := true
	if result.documents.Cast != nil {
		for _, entity := range arrayItems(dynvalue.Get(result.documents.Cast, "entities")) {
			for _, image := range arrayItems(dynvalue.Get(entity, "images")) {
				relative, err := sourcePath(project, image)
				if err == nil {
					paths.add(relative)
					if !dynvalue.Exists(filepath.Join(project, filepath.FromSlash(relative))) {
						err = errors.New(textCastImageMissing(dynvalue.ToString(dynvalue.Get(entity, "name")), relative))
					}
				}
				if err != nil {
					castImagesValid = false
					result.documentProblems = append(result.documentProblems, err.Error())
				}
			}
		}
	}
	if result.documents.Cast != nil && result.documents.Treatment != nil && castImagesValid && !result.treatmentDraft {
		if err := checkTreatmentCast(result.documents.Cast, result.documents.Treatment); err != nil {
			result.documentProblems = append(result.documentProblems, err.Error())
		} else {
			result.pairValid = true
		}
	}
	if result.documents.Scenes != nil {
		sceneProblems, err := scenario.ValidateScenes(result.documents.Scenes, result.documents.Cast, scenario.ExpectedFPS(project, result.documents.Scenes))
		if err != nil {
			return nil, err
		}
		result.documentProblems = append(result.documentProblems, sceneProblems...)
		result.scenesValid = len(sceneProblems) == 0
		if result.scenesValid && result.documents.Cast != nil && result.duration != nil {
			if err := checkReadyScenes(result.documents.Scenes, result.documents.Cast, *result.duration, scenario.ExpectedFPS(project, result.documents.Scenes)); err != nil {
				result.documentProblems = append(result.documentProblems, strings.Split(err.Error(), "\n")...)
			} else {
				result.scenesReady = true
			}
		}
	}
	result.hashes = newHashes()
	result.approval = newHashes()
	for _, item := range paths.items {
		value, err := fileHash(project, item)
		if err != nil {
			return nil, err
		}
		result.hashes.set(item, value)
		if strings.HasPrefix(item, "source/") || item == "plan/audio/timing.json" || item == "plan/cast.json" || item == "plan/treatment.json" {
			result.approval.set(item, value)
		}
	}
	return result, nil
}

// sourceChanged — ошибка несовпадения SHA-256 файла исходников: указатель Git LFS вместо
// содержимого (клип склонирован без git lfs pull) получает отдельный понятный текст, остальное —
// текст changed вызывающего.
func sourceChanged(project, relative string, changed func(string) string) error {
	if text, ok := filedigest.LFSPointerProblem(filepath.Join(project, filepath.FromSlash(relative)), relative); ok {
		return errors.New(text)
	}
	return errors.New(changed(relative))
}

// readSources — проверка исходников: маркер проекта, опись с SHA трёх исходников и референсов,
// разметка версии 2 и её согласованность с текстом и треком. Первая ошибка прерывает проверку.
func readSources(result *inputs, paths *orderedSet) error {
	project := result.project
	if !dynvalue.Exists(filepath.Join(project, "plan", "project.json")) {
		return errors.New(textProjectSettingsUnreadable)
	}
	raw, err := readJSON(project, "source/manifest.json")
	if err != nil {
		return err
	}
	manifest, ok := dynvalue.AsObject(raw)
	if !ok || !dynvalue.StrictEqual(manifest.Value("schema_version"), 1.0) || !dynvalue.IsArray(manifest.Value("references")) {
		return errors.New(textSourcesMissing)
	}
	for _, key := range []string{"track", "lyrics", "idea"} {
		source, ok := dynvalue.AsObject(manifest.Value(key))
		if !ok || !isString(source.Value("sha256")) {
			return errors.New(textScenarioSourcesRequired)
		}
		relative, err := sourcePath(project, source.Value("path"))
		if err != nil {
			return err
		}
		paths.add(relative)
		current, err := fileHash(project, relative)
		if err != nil {
			return err
		}
		if current == nil || *current != source.Value("sha256").(string) {
			return sourceChanged(project, relative, textSourceFileChanged)
		}
	}
	for _, item := range arrayItems(manifest.Value("references")) {
		reference, ok := dynvalue.AsObject(item)
		valid := ok && dynvalue.IsArray(reference.Value("files"))
		for _, key := range []string{"id", "kind", "name", "short_name", "description"} {
			valid = valid && isString(reference.Value(key))
		}
		if !valid {
			return errors.New(textSourceReferenceInvalid)
		}
		for _, file := range arrayItems(reference.Value("files")) {
			record, ok := dynvalue.AsObject(file)
			if !ok || !isString(record.Value("sha256")) {
				return errors.New(textSourceImageInvalid)
			}
			relative, err := sourcePath(project, record.Value("path"))
			if err != nil {
				return err
			}
			paths.add(relative)
			current, err := fileHash(project, relative)
			if err != nil {
				return err
			}
			if current == nil || *current != record.Value("sha256").(string) {
				return sourceChanged(project, relative, textSourceImageChanged)
			}
		}
	}
	result.manifest = manifest
	rawTiming, err := readJSON(project, "plan/audio/timing.json")
	if err != nil {
		return err
	}
	timingDocument, ok := dynvalue.AsObject(rawTiming)
	if !ok || !validTiming(timingDocument) {
		return errors.New(textScenarioTimingRequired)
	}
	result.timing = timingDocument
	duration := timingDocument.Value("duration_decoded").(float64)
	result.duration = &duration
	text, err := os.ReadFile(filepath.Join(project, "source", "text.md"))
	if err != nil {
		return dynvalue.FsError("open", filepath.Join(project, "source", "text.md"), err)
	}
	lyrics := timing.ParseLyricsLines(dynvalue.DecodeUTF8(text))
	problems, err := timing.Validate(timingDocument, lyrics, &duration)
	if err != nil {
		return err
	}
	if !dynvalue.StrictEqual(timingDocument.Value("sha256"), dynvalue.GetPath(manifest, "track", "sha256")) {
		problems = append(problems, textTimingTrackMismatch)
	}
	covered := map[float64]bool{}
	unverified := false
	for _, line := range arrayItems(timingDocument.Value("lines")) {
		if dynvalue.Get(line, "verified") != true {
			unverified = true
		}
		covered[dynvalue.Get(line, "source_line").(float64)] = true
	}
	if unverified {
		problems = append(problems, textTimingUnverified)
	}
	for _, line := range lyrics {
		if !line.Header && dynvalue.Trim(line.Text) != "" && !covered[float64(line.Number)] {
			problems = append(problems, textTimingIncomplete)
			break
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, " "))
	}
	return nil
}

// validTiming — проверка формы разметки: версия 2, непустые строки с целыми id и
// source_line, числовыми границами и флагом verified, части с конечными границами и
// положительная конечная duration_decoded.
func validTiming(document *dynvalue.Object) bool {
	lines, linesOK := dynvalue.AsArray(document.Value("lines"))
	sections, sectionsOK := dynvalue.AsArray(document.Value("sections"))
	duration, durationOK := document.Value("duration_decoded").(float64)
	if !dynvalue.StrictEqual(document.Value("version"), 2.0) || !linesOK || len(lines) == 0 || !sectionsOK || !durationOK ||
		!dynvalue.IsFinite(duration) || duration <= 0 {
		return false
	}
	for _, item := range lines {
		line, ok := dynvalue.AsObject(item)
		_, startOK := dynvalue.Get(item, "start").(float64)
		_, endOK := dynvalue.Get(item, "end").(float64)
		_, verifiedOK := dynvalue.Get(item, "verified").(bool)
		if !ok || !dynvalue.IsInteger(line.Value("id")) || !dynvalue.IsInteger(line.Value("source_line")) || !startOK || !endOK || !verifiedOK {
			return false
		}
	}
	for _, item := range sections {
		part, ok := dynvalue.AsObject(item)
		start, startOK := dynvalue.Get(item, "start").(float64)
		end, endOK := dynvalue.Get(item, "end").(float64)
		if !ok || !isString(part.Value("name")) || !startOK || !dynvalue.IsFinite(start) || !endOK || !dynvalue.IsFinite(end) {
			return false
		}
	}
	return true
}

// readDocuments — разбор plan/cast.json, plan/treatment.json и plan/scenes.json. Проблема
// документа — «<имя>.json: <текст>», документ тогда считается отсутствующим.
//
// Трактовка читается черновиком (структурная нормализация), как её сохраняет редактор; проблемы
// scenario.ValidateTreatment добавляются текстом «treatment.json: …», но черновик остаётся в
// документах. Так проход трактовки агентом начинается с черновика пользователя, а ручное
// утверждение пары и проход сцен требуют трактовки без проблем (pairValid).
func readDocuments(result *inputs) {
	for _, key := range []string{"cast", "treatment", "scenes"} {
		raw, err := readJSON(result.project, "plan/"+key+".json")
		if err == nil && raw != nil {
			switch key {
			case "cast":
				var normalized *dynvalue.Object
				normalized, err = cast.Normalize(raw, cast.LoadDefaults())
				if err == nil {
					var manifest any
					if result.manifest != nil {
						manifest = result.manifest
					}
					result.documents.Cast, err = cast.ProjectDescriptions(normalized, manifest)
				}
			case "treatment":
				var draft *dynvalue.Object
				draft, err = scenario.NormalizeTreatmentDraft(raw)
				if err == nil {
					result.documents.Treatment = draft
					var problems []string
					problems, err = scenario.ValidateTreatment(draft, durationValue(result.duration))
					if err == nil && len(problems) > 0 {
						err = errors.New(strings.Join(problems, " "))
					}
					result.treatmentDraft = err != nil
				}
			case "scenes":
				err = checkScenesShape(raw)
				if err == nil {
					result.documents.Scenes = raw
				}
			}
		}
		if err != nil {
			result.documentProblems = append(result.documentProblems, key+".json: "+err.Error())
		}
	}
}

// durationValue — длительность для validateTreatment: число или null.
func durationValue(duration *float64) any {
	if duration == nil {
		return nil
	}
	return *duration
}
