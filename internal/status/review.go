package status

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe-go/internal/filedigest"
	"songframe-go/internal/jscompat"
)

// Тексты applicationTexts и scenarioTexts.main, участвующие в проверке актуальности сценария.
const (
	scenarioReviewRequired = "Кастинг, трактовка или исходники изменились: проверьте и утвердите актуальный сценарий на странице «Сценарий»."
	cardsDirectoryRequired = "plan/animatic/cards: нужна обычная папка."
	shotsDirectoryRequired = "assets/shots: нужна обычная папка."
)

func scenarioReviewFailed(reason string) string {
	return "Не удалось проверить актуальность сценария: " + reason
}

// reviewProblem — проверка актуальности сценария без записи согласования: только исключения сбора
// входов, которые ScenarioWorkflow.view оригинала выполняет до чтения записи (см. reviewInputs).
// Её используют Compute (открытие и переименование проекта) и тесты. Полная проверка с записью
// согласования принадлежит сценарному проходу: projects.status передаёт её в ComputeWith
// (app.ConnectScenarioReview).
func reviewProblem(path string) string {
	if err := reviewInputs(path); err != nil {
		return scenarioReviewFailed(err.Error())
	}
	return ""
}

// fixedInputs — постоянные входы сценария в порядке Set оригинала.
var fixedInputs = []string{
	"plan/project.json",
	"plan/production-status.json",
	"source/manifest.json",
	"source/track.mp3",
	"source/text.md",
	"source/description.md",
	"plan/audio/timing.json",
	"plan/cast.json",
	"plan/treatment.json",
	"plan/scenes.json",
}

// fixedViews — производные представления сценария (FIXED_VIEWS scenario-apply).
var fixedViews = []string{
	"ROADMAP.md",
	"plan/edit-list.md",
	"plan/storyboard.md",
	"plan/context/characters.md",
	"plan/audio/timing.md",
	"assets/shots/manifest.json",
	"plan/animatic/cards/manifest.json",
}

var shotDirectory = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)

// reviewInputs воспроизводит части ScenarioWorkflow.inputs, которые выполняются вне try и потому
// превращают reviewProblem в scenarioReviewFailed: realpath проекта, перечень выходов сценария и
// хеширование всех входов (каталог или недоступный файл на месте входа). Проблемы документов,
// которые оригинал собирает внутри try, на результат статуса при пустой записи не влияют.
//
// Не воспроизведено: пути изображений из нормализованного кастинга (normalizeCast) тоже входят в
// хешируемый набор; каталог на их месте в оригинале дал бы ту же ошибку.
func reviewInputs(path string) error {
	project, err := jscompat.Realpath(path)
	if err != nil {
		return err
	}
	outputs, err := scenarioOutputPaths(project)
	if err != nil {
		return err
	}
	paths := newPathSet()
	for _, item := range fixedInputs {
		paths.add(item)
	}
	for _, item := range outputs {
		paths.add(item)
	}
	for _, item := range manifestSourcePaths(project) {
		paths.add(item)
	}
	for _, item := range paths.items {
		if err := hashCheck(project, item); err != nil {
			return err
		}
	}
	return nil
}

// pathSet — Set строк с порядком вставки.
type pathSet struct {
	items []string
	seen  map[string]bool
}

func newPathSet() *pathSet { return &pathSet{seen: map[string]bool{}} }

func (s *pathSet) add(path string) {
	if !s.seen[path] {
		s.seen[path] = true
		s.items = append(s.items, path)
	}
}

// fileStat — lstat, где отсутствие пути не ошибка, а прочие отказы (ENOTDIR, EACCES) — ошибка.
func fileStat(path string) (fs.FileInfo, error) {
	info, err := os.Lstat(path)
	if err == nil {
		return info, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return nil, jscompat.FsError("lstat", path, err)
}

// scenarioOutputPaths — выходы сценария: фиксированные представления, карточки *.png и README
// комплектов. Каталоги карточек и комплектов должны быть обычными папками, не ссылками.
func scenarioOutputPaths(project string) ([]string, error) {
	outputs := newPathSet()
	for _, item := range fixedViews {
		outputs.add(item)
	}
	cards := filepath.Join(project, "plan", "animatic", "cards")
	info, err := fileStat(cards)
	if err != nil {
		return nil, err
	}
	if info != nil {
		if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
			return nil, errors.New(cardsDirectoryRequired)
		}
		entries, err := jscompat.ReadDir(cards)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".png") {
				outputs.add("plan/animatic/cards/" + entry.Name())
			}
		}
	}
	shots := filepath.Join(project, "assets", "shots")
	info, err = fileStat(shots)
	if err != nil {
		return nil, err
	}
	if info != nil {
		if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
			return nil, errors.New(shotsDirectoryRequired)
		}
		entries, err := jscompat.ReadDir(shots)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !shotDirectory.MatchString(entry.Name()) {
				continue
			}
			readme, err := fileStat(filepath.Join(shots, entry.Name(), "README.md"))
			if err != nil {
				return nil, err
			}
			if readme != nil {
				outputs.add("assets/shots/" + entry.Name() + "/README.md")
			}
		}
	}
	items := append([]string(nil), outputs.items...)
	sort.SliceStable(items, func(i, j int) bool { return jscompat.LessUTF16(items[i], items[j]) })
	return items, nil
}

// manifestSourcePaths — пути source/…, которые оригинал добавляет в набор входов, проверяя опись
// исходников внутри try: трек, текст, идея и файлы референсов по порядку до первого отказа
// (неверная запись, путь вне source/, несовпавший или нечитаемый хеш). Путь добавляется до
// сверки его хеша, поэтому и нечитаемый файл попадает в набор.
func manifestSourcePaths(project string) []string {
	var paths []string
	if !jscompat.Exists(filepath.Join(project, "plan", "project.json")) {
		return nil
	}
	manifestFile := filepath.Join(project, "source", "manifest.json")
	if !jscompat.Exists(manifestFile) {
		return nil
	}
	raw, ok := jscompat.ReadJSONFile(manifestFile)
	if !ok {
		return nil
	}
	references, isArray := jscompat.AsArray(jscompat.Get(raw, "references"))
	if !jscompat.IsRecord(raw) || !jscompat.StrictEqual(jscompat.Get(raw, "schema_version"), 1.0) || !isArray {
		return nil
	}
	// accept добавляет путь и сообщает, продолжает ли оригинал проверку после сверки хеша.
	accept := func(entry any) bool {
		sha, isString := jscompat.Get(entry, "sha256").(string)
		if !jscompat.IsRecord(entry) || !isString {
			return false
		}
		path, ok := sourcePath(project, jscompat.Get(entry, "path"))
		if !ok {
			return false
		}
		paths = append(paths, path)
		digest, err := hashValue(project, path)
		return err == nil && digest == any(sha)
	}
	for _, key := range []string{"track", "lyrics", "idea"} {
		if !accept(jscompat.Get(raw, key)) {
			return paths
		}
	}
	for _, reference := range references {
		files, isArray := jscompat.AsArray(jscompat.Get(reference, "files"))
		if !jscompat.IsRecord(reference) || !isArray {
			return paths
		}
		for _, key := range []string{"id", "kind", "name", "short_name", "description"} {
			if jscompat.TypeOf(jscompat.Get(reference, key)) != "string" {
				return paths
			}
		}
		for _, file := range files {
			if !accept(file) {
				return paths
			}
		}
	}
	return paths
}

// sourcePath — путь исходника относительно source/ в виде «source/<путь>» или отказ.
func sourcePath(project string, value any) (string, bool) {
	path, ok := value.(string)
	if !ok || path == "" || jscompat.IsAbs(path) {
		return "", false
	}
	base := filepath.Join(project, "source")
	local := jscompat.Relative(base, jscompat.Resolve(project, "source", path))
	if strings.HasPrefix(local, "..") || jscompat.IsAbs(local) {
		return "", false
	}
	return "source/" + strings.ReplaceAll(local, `\`, "/"), true
}

// hashValue — hash() сценарного процесса: SHA-256 содержимого либо null для отсутствующего файла.
// Для source/manifest.json оригинал хеширует канонический набор входов, но здесь значение
// сравнивается только с хешами файлов исходников, поэтому достаточно отказа чтения.
func hashValue(project, path string) (any, error) {
	full := filepath.Join(project, filepath.FromSlash(path))
	if !jscompat.Exists(full) {
		return nil, nil
	}
	if err := jscompat.ReadFileCheck(full); err != nil {
		return nil, err
	}
	if path == "source/manifest.json" {
		return "", nil
	}
	if digest, ok := filedigest.File(full); ok {
		return digest, nil
	}
	return nil, jscompat.FsError("read", "", errors.New("read failed"))
}

// hashCheck — отказ hash() вне try: каталог или недоступный файл на месте входа.
func hashCheck(project, path string) error {
	full := filepath.Join(project, filepath.FromSlash(path))
	if !jscompat.Exists(full) {
		return nil
	}
	return jscompat.ReadFileCheck(full)
}
