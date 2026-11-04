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

	"songframe-go/internal/cast"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/scenario"
	"songframe-go/internal/sourceinputs"
	"songframe-go/internal/timing"
)

// Входы сценарного прохода (inputs оригинала): опись исходников, разметка и документы проекта
// с проверками готовности и SHA-256 всех файлов, от которых зависит предложение. Снимок хешей
// запоминается при запуске агента и сверяется перед применением: любое изменение входа делает
// предложение устаревшим.

// hashes — путь файла проекта → SHA-256 (nil — файла нет). Порядок ключей — порядок добавления
// путей, как у объекта оригинала: он сохраняется в локальной записи.
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

// matches — matches оригинала: одинаковые наборы путей и хешей (порядок не важен).
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
func (h *hashes) object() *jscompat.Object {
	result := jscompat.NewObject()
	for _, key := range h.keys {
		if value := h.values[key]; value != nil {
			result.Set(key, *value)
		} else {
			result.Set(key, nil)
		}
	}
	return result
}

// hashesFrom — снимок из проверенной локальной записи (checkHashes).
func hashesFrom(value any) *hashes {
	result := newHashes()
	record, _ := jscompat.AsObject(value)
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

// fileHash — hash оригинала: для source/manifest.json — отпечаток входов, для остальных путей —
// SHA-256 байтов; nil — файла нет (или он не читается: existsSync оригинала тоже давал «нет»
// только для отсутствующего пути, а ошибку чтения — исключением).
func fileHash(project, relative string) (*string, error) {
	data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(relative)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, jscompat.FsError("open", filepath.Join(project, filepath.FromSlash(relative)), err)
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

// readJSON — json(project, path) оригинала: null для отсутствующего файла, иначе JSON.parse текста
// UTF-8. Ошибка разбора — текст разборщика jscompat (оригинал показывал SyntaxError V8).
func readJSON(project, relative string) (any, error) {
	path := filepath.Join(project, filepath.FromSlash(relative))
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, jscompat.FsError("open", path, err)
	}
	return jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
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

// fixedViews — FIXED_VIEWS: производные виды с постоянными путями.
var fixedViews = []string{
	"ROADMAP.md",
	"plan/edit-list.md",
	"plan/storyboard.md",
	"plan/context/characters.md",
	"plan/audio/timing.md",
	"assets/shots/manifest.json",
	"plan/animatic/cards/manifest.json",
}

// scenarioOutputPaths — scenarioOutputPaths оригинала: известные производные виды проекта, включая
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
			return nil, jscompat.FsError("scandir", cards, err)
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
			return nil, jscompat.FsError("scandir", shots, err)
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
	// [...outputs].sort(): сравнение строк JS по кодовым единицам UTF-16.
	sort.Slice(result, func(i, j int) bool { return jscompat.LessUTF16(result[i], result[j]) })
	return result, nil
}

// inputs — входы проекта для вида и действий сценарного прохода.
type inputs struct {
	project   string
	documents Documents
	manifest  *jscompat.Object
	timing    *jscompat.Object
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

// sourcePath — sourcePath оригинала: путь из описи или кастинга внутри source/ с прямыми слешами.
func sourcePath(project string, value any) (string, error) {
	path, ok := value.(string)
	if !ok || path == "" || jscompat.IsAbs(path) {
		return "", errors.New(textSourcePathUnreadable)
	}
	base := filepath.Join(project, "source")
	local := jscompat.Relative(base, jscompat.Resolve(base, path))
	if strings.HasPrefix(local, "..") || jscompat.IsAbs(local) {
		return "", errors.New(textSourceOutsideProject)
	}
	return "source/" + strings.ReplaceAll(local, "\\", "/"), nil
}

// orderedSet — множество путей в порядке добавления (Set оригинала).
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

// readInputs — inputs(path) оригинала. Ошибка — только исключение до сбора проблем (нет папки
// проекта, повреждённая папка карточек); остальное — проблемы вида.
func readInputs(path string) (*inputs, error) {
	project, err := jscompat.Realpath(path)
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
		for _, entity := range arrayItems(jscompat.Get(result.documents.Cast, "entities")) {
			for _, image := range arrayItems(jscompat.Get(entity, "images")) {
				relative, err := sourcePath(project, image)
				if err == nil {
					paths.add(relative)
					if !jscompat.Exists(filepath.Join(project, filepath.FromSlash(relative))) {
						err = errors.New(textCastImageMissing(jscompat.ToString(jscompat.Get(entity, "name")), relative))
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
		sceneProblems, err := scenario.ValidateScenes(result.documents.Scenes, result.documents.Cast)
		if err != nil {
			return nil, err
		}
		result.documentProblems = append(result.documentProblems, sceneProblems...)
		result.scenesValid = len(sceneProblems) == 0
		if result.scenesValid && result.documents.Cast != nil && result.duration != nil {
			if err := checkReadyScenes(result.documents.Scenes, result.documents.Cast, *result.duration); err != nil {
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

// readSources — блок try оригинала: маркер проекта, опись с SHA трёх исходников и референсов,
// разметка версии 2 и её согласованность с текстом и треком. Первая ошибка прерывает проверку.
func readSources(result *inputs, paths *orderedSet) error {
	project := result.project
	if !jscompat.Exists(filepath.Join(project, "plan", "project.json")) {
		return errors.New(textProjectSettingsUnreadable)
	}
	raw, err := readJSON(project, "source/manifest.json")
	if err != nil {
		return err
	}
	manifest, ok := jscompat.AsObject(raw)
	if !ok || !jscompat.StrictEqual(manifest.Value("schema_version"), 1.0) || !jscompat.IsArray(manifest.Value("references")) {
		return errors.New(textSourcesMissing)
	}
	for _, key := range []string{"track", "lyrics", "idea"} {
		source, ok := jscompat.AsObject(manifest.Value(key))
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
			return errors.New(textSourceFileChanged(relative))
		}
	}
	for _, item := range arrayItems(manifest.Value("references")) {
		reference, ok := jscompat.AsObject(item)
		valid := ok && jscompat.IsArray(reference.Value("files"))
		for _, key := range []string{"id", "kind", "name", "short_name", "description"} {
			valid = valid && isString(reference.Value(key))
		}
		if !valid {
			return errors.New(textSourceReferenceInvalid)
		}
		for _, file := range arrayItems(reference.Value("files")) {
			record, ok := jscompat.AsObject(file)
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
				return errors.New(textSourceImageChanged(relative))
			}
		}
	}
	result.manifest = manifest
	rawTiming, err := readJSON(project, "plan/audio/timing.json")
	if err != nil {
		return err
	}
	timingDocument, ok := jscompat.AsObject(rawTiming)
	if !ok || !validTiming(timingDocument) {
		return errors.New(textScenarioTimingRequired)
	}
	result.timing = timingDocument
	duration := timingDocument.Value("duration_decoded").(float64)
	result.duration = &duration
	text, err := os.ReadFile(filepath.Join(project, "source", "text.md"))
	if err != nil {
		return jscompat.FsError("open", filepath.Join(project, "source", "text.md"), err)
	}
	lyrics := timing.ParseLyricsLines(jscompat.DecodeUTF8(text))
	problems, err := timing.Validate(timingDocument, lyrics, &duration)
	if err != nil {
		return err
	}
	if !jscompat.StrictEqual(timingDocument.Value("sha256"), jscompat.GetPath(manifest, "track", "sha256")) {
		problems = append(problems, textTimingTrackMismatch)
	}
	covered := map[float64]bool{}
	unverified := false
	for _, line := range arrayItems(timingDocument.Value("lines")) {
		if jscompat.Get(line, "verified") != true {
			unverified = true
		}
		covered[jscompat.Get(line, "source_line").(float64)] = true
	}
	if unverified {
		problems = append(problems, textTimingUnverified)
	}
	for _, line := range lyrics {
		if !line.Header && jscompat.Trim(line.Text) != "" && !covered[float64(line.Number)] {
			problems = append(problems, textTimingIncomplete)
			break
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, " "))
	}
	return nil
}

// validTiming — проверка формы разметки оригинала: версия 2, непустые строки с целыми id и
// source_line, числовыми границами и флагом verified, части с конечными границами и
// положительная конечная duration_decoded.
func validTiming(document *jscompat.Object) bool {
	lines, linesOK := jscompat.AsArray(document.Value("lines"))
	sections, sectionsOK := jscompat.AsArray(document.Value("sections"))
	duration, durationOK := document.Value("duration_decoded").(float64)
	if !jscompat.StrictEqual(document.Value("version"), 2.0) || !linesOK || len(lines) == 0 || !sectionsOK || !durationOK ||
		!jscompat.IsFinite(duration) || duration <= 0 {
		return false
	}
	for _, item := range lines {
		line, ok := jscompat.AsObject(item)
		_, startOK := jscompat.Get(item, "start").(float64)
		_, endOK := jscompat.Get(item, "end").(float64)
		_, verifiedOK := jscompat.Get(item, "verified").(bool)
		if !ok || !jscompat.IsInteger(line.Value("id")) || !jscompat.IsInteger(line.Value("source_line")) || !startOK || !endOK || !verifiedOK {
			return false
		}
	}
	for _, item := range sections {
		part, ok := jscompat.AsObject(item)
		start, startOK := jscompat.Get(item, "start").(float64)
		end, endOK := jscompat.Get(item, "end").(float64)
		if !ok || !isString(part.Value("name")) || !startOK || !jscompat.IsFinite(start) || !endOK || !jscompat.IsFinite(end) {
			return false
		}
	}
	return true
}

// readDocuments — разбор plan/cast.json, plan/treatment.json и plan/scenes.json. Проблема
// документа — «<имя>.json: <текст>», документ тогда считается отсутствующим.
//
// Отличие от 634fd94: трактовка читается черновиком (структурная нормализация), как её сохраняет
// редактор с этапа 43; проблемы validateTreatment добавляются тем же текстом «treatment.json: …»,
// но черновик остаётся в документах. Так проход трактовки агентом начинается с черновика
// пользователя, а ручное утверждение пары и проход сцен по-прежнему требуют трактовки без проблем
// (pairValid). Оригинал отбрасывал такой черновик целиком.
func readDocuments(result *inputs) {
	for _, key := range []string{"cast", "treatment", "scenes"} {
		raw, err := readJSON(result.project, "plan/"+key+".json")
		if err == nil && raw != nil {
			switch key {
			case "cast":
				var normalized *jscompat.Object
				normalized, err = cast.Normalize(raw, cast.LoadDefaults())
				if err == nil {
					var manifest any
					if result.manifest != nil {
						manifest = result.manifest
					}
					result.documents.Cast, err = cast.ProjectDescriptions(normalized, manifest)
				}
			case "treatment":
				var draft *jscompat.Object
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
