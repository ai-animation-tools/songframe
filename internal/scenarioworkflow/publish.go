package scenarioworkflow

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/scenario"
	"songframe/internal/scenarioapply"
	"songframe/internal/sources"
	"songframe/internal/tools"
)

// Публикация сценарного предложения.
// Проход трактовки записывает только пару кастинга и трактовки (и описания в описи); проход
// сцен сначала собирает копию проекта во временной папке (staging), записывает туда новый
// реестр и прогоняет штатные проверки lint_registry, continuity_brief по каждому плану и фазе,
// update_scene_views и update_scene_views --check. Только если копия прошла все проверки и
// входы проекта не изменились, в проект публикуются реестр и производные виды копии — одной
// транзакцией журнала scenarioapply.Store (резервы, замены, откат при сбое).
//
// Инструменты — реализации internal/tools в процессе приложения, внешний интерпретатор не нужен;
// карточки копии рисует internal/animaticcards.

// Publication — ScenarioPublication: что публикуется и снимок входов, на котором агент готовил
// предложение.
type Publication struct {
	Project        string
	Pass           string
	Before, After  Documents
	ExpectedHashes *hashes
}

// copyExtensions — метаданные и изображения, которые нужны проверкам копии.
var copyExtensions = map[string]bool{".json": true, ".md": true, ".txt": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true,
	".gif": true, ".bmp": true, ".tif": true, ".tiff": true, ".avif": true, ".svg": true}

// skipDirectories — имена, которые staging не копирует.
var skipDirectories = map[string]bool{".git": true, ".local": true, "node_modules": true, "cache": true}

var kitManifest = regexp.MustCompile(`^assets/shots/M\d{2}(?:\.\d+)?/manifest\.json$`)

// Точки подмены для проверок сбоя: запуск инструмента в копии и момент перед публикацией.
var (
	runTool       = tools.Run
	beforePublish = func(string) error { return nil }
)

// extName — расширение имени с точкой: у имени, начинающегося с точки и без другой точки, расширения нет.
func extName(name string) string {
	index := strings.LastIndex(name, ".")
	if index <= 0 {
		return ""
	}
	return name[index:]
}

// fileDigest — SHA-256 байтов файла проекта без перехода по ссылкам; nil — файла нет.
func fileDigest(project, relative string) (*string, error) {
	data, err := scenarioapply.ReadFile(project, relative)
	if err != nil || data == nil {
		return nil, err
	}
	text := digestText(data)
	return &text, nil
}

// verifyHashes — каждый путь снимка с прежним содержимым. Для
// source/manifest.json достаточно совпадения отпечатка входов (обложка и время не важны).
func verifyHashes(project string, expected *hashes) error {
	for _, path := range expected.keys {
		want := expected.values[path]
		if path == "source/manifest.json" {
			if current, err := fileHash(project, path); err == nil && sameDigest(current, want) && current != nil {
				continue
			}
		}
		current, err := fileDigest(project, path)
		if err != nil {
			return err
		}
		if !sameDigest(current, want) {
			return errors.New(textStaleFile(path))
		}
	}
	return nil
}

// stageInputs — входы копии: метаданные и изображения source/, plan/, assets/ и
// ROADMAP.md, плюс принятые видео комплектов (их читает update_scene_views). Ссылки и
// необычные каталоги — отказ: копия не должна подменять рабочие данные. Пути отсортированы.
func stageInputs(project string) ([]string, error) {
	files := map[string]bool{}
	var visit func(relative string) error
	visit = func(relative string) error {
		directory := filepath.Join(project, filepath.FromSlash(relative))
		info, err := lstat(directory)
		if err != nil {
			return err
		}
		if info == nil {
			return nil
		}
		if !info.IsDir() {
			return errors.New(textStagingDirectoryRequired(relative))
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return dynvalue.FsError("scandir", directory, err)
		}
		for _, entry := range entries {
			if skipDirectories[entry.Name()] {
				continue
			}
			child := relative + "/" + entry.Name()
			switch {
			case entry.Type()&fs.ModeSymlink != 0:
				return errors.New(textStagingSymlink(child))
			case entry.IsDir():
				if err := visit(child); err != nil {
					return err
				}
			case entry.Type().IsRegular() && copyExtensions[strings.ToLower(extName(entry.Name()))]:
				files[child] = true
			}
		}
		return nil
	}
	for _, folder := range []string{"source", "plan", "assets"} {
		if err := visit(folder); err != nil {
			return nil, err
		}
	}
	roadmap, err := scenarioapply.CheckedPath(project, "ROADMAP.md")
	if err != nil {
		return nil, err
	}
	if info, err := lstat(roadmap); err != nil {
		return nil, err
	} else if info != nil {
		files["ROADMAP.md"] = true
	}
	for path := range files {
		if !kitManifest.MatchString(path) {
			continue
		}
		data, err := scenarioapply.ReadFile(project, path)
		if err != nil {
			return nil, err
		}
		value, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
		if err != nil {
			return nil, err
		}
		video, ok := dynvalue.GetPath(value, "accepted_edit", "video", "path").(string)
		if !ok || !scenarioapply.RelativePath(video) {
			return nil, errors.New(textAcceptedVideoPathRequired(path))
		}
		accepted := strings.TrimSuffix(path, "manifest.json") + video
		target, err := scenarioapply.CheckedPath(project, accepted)
		if err != nil {
			return nil, err
		}
		if info, err := lstat(target); err != nil {
			return nil, err
		} else if info == nil {
			return nil, errors.New(textAcceptedVideoMissing(accepted))
		}
		files[accepted] = true
	}
	result := make([]string, 0, len(files))
	for path := range files {
		result = append(result, path)
	}
	sort.Slice(result, func(i, j int) bool { return dynvalue.LessUTF16(result[i], result[j]) })
	return result, nil
}

// sameNames — одинаковые отсортированные списки путей.
func sameNames(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// jsonBytes — JSON с отступом в два пробела и переводом строки: формат записи документов сценария.
func jsonBytes(value any) []byte { return scenario.Encode(value) }

// sliceTail — последние limit кодовых единиц UTF-16 текста.
func sliceTail(text string, limit int) string {
	units := 0
	for index := len(text); index > 0; {
		r, size := lastRune(text[:index])
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > limit {
			return text[index:]
		}
		units += width
		index -= size
	}
	return text
}

func lastRune(text string) (rune, int) {
	for size := 1; size <= 4 && size <= len(text); size++ {
		if r := []rune(text[len(text)-size:]); len(r) == 1 {
			return r[0], size
		}
	}
	return rune(text[len(text)-1]), 1
}

// publisher — публикация через журнал Store каталога состояния.
type publisher struct{ store scenarioapply.Store }

// publish — публикация предложения прохода в проект: проход трактовки пишет пару документов,
// проход сцен — проверенные реестр и производные виды копии.
func (p publisher) publish(input Publication) error {
	project, err := filepath.Abs(input.Project)
	if err != nil {
		return err
	}
	if input.ExpectedHashes == nil || len(input.ExpectedHashes.keys) == 0 {
		return errors.New(textSnapshotMissing)
	}
	if err := verifyHashes(project, input.ExpectedHashes); err != nil {
		return err
	}
	// Новая карточка или README между запуском и применением отсутствовали в снимке, даже если
	// прежние файлы не менялись.
	if _, ok := input.ExpectedHashes.get("ROADMAP.md"); ok {
		outputs, err := scenarioOutputPaths(project)
		if err != nil {
			return err
		}
		for _, path := range outputs {
			if _, known := input.ExpectedHashes.get(path); !known {
				return errors.New(textStaleAddedFile(path))
			}
		}
	}
	if p.store.Pending(project) {
		return errors.New(textRecoveryPending)
	}
	if input.Pass == "treatment" {
		return p.publishPair(project, input)
	}
	return p.publishScenes(project, input)
}

// publishPair — первый проход: кастинг, трактовка и, если изменились, описания в описи.
func (p publisher) publishPair(project string, input Publication) error {
	castDocument, castOK := dynvalue.AsObject(input.After.Cast)
	treatment, treatmentOK := dynvalue.AsObject(input.After.Treatment)
	if !castOK || !treatmentOK {
		return errors.New(textApplyPairRequired)
	}
	timingBytes, err := scenarioapply.ReadFile(project, "plan/audio/timing.json")
	if err != nil {
		return err
	}
	var duration any
	if timingBytes != nil {
		value, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(timingBytes)))
		if err != nil {
			return err
		}
		duration = dynvalue.ToNumber(dynvalue.Get(value, "duration_decoded"))
	}
	problems, err := cast.Validate(input.After.Cast)
	if err != nil {
		return err
	}
	treatmentProblems, err := scenario.ValidateTreatment(treatment, duration)
	if err != nil {
		return err
	}
	if problems = append(problems, treatmentProblems...); len(problems) > 0 {
		return errors.New(strings.Join(problems, " "))
	}
	originalManifest, err := scenarioapply.ReadFile(project, "source/manifest.json")
	if err != nil {
		return err
	}
	manifest, err := sources.DescriptionManifest(project)
	if err != nil {
		return err
	}
	plan, err := cast.PlanDescriptions(castDocument, manifest, true)
	if err != nil {
		return err
	}
	candidates := []scenarioapply.Change{
		{Path: "plan/cast.json", Next: jsonBytes(plan.Cast)},
		{Path: "plan/treatment.json", Next: jsonBytes(treatment)},
	}
	if plan.Manifest != nil && dynvalue.Stringify(plan.Manifest) != dynvalue.Stringify(manifest) {
		candidates = append(candidates, scenarioapply.Change{Path: "source/manifest.json", Next: jsonBytes(plan.Manifest)})
	}
	// Карта references реестра сцен выводится из кастинга и публикуется вместе с ним.
	scenes, err := cast.ScenesWithReferences(project, plan.Cast)
	if err != nil {
		return err
	}
	if scenes != nil {
		candidates = append(candidates, scenarioapply.Change{Path: cast.ScenesPath, Next: scenes})
	}
	if err := verifyHashes(project, input.ExpectedHashes); err != nil {
		return err
	}
	currentManifest, err := scenarioapply.ReadFile(project, "source/manifest.json")
	if err != nil {
		return err
	}
	if (originalManifest == nil) != (currentManifest == nil) || !bytes.Equal(originalManifest, currentManifest) {
		return errors.New(textStaleProjectFiles)
	}
	if err := beforePublish(project); err != nil {
		return err
	}
	return p.commit(project, candidates)
}

// commit — отбор изменённых файлов (scenarioapply.Changes) и их публикация одной транзакцией журнала.
func (p publisher) commit(project string, candidates []scenarioapply.Change) error {
	changes, err := p.store.Changes(project, candidates)
	if err != nil {
		return err
	}
	return p.store.Publish(project, changes)
}

// snapshot — raw SHA-256 путей проекта (без особого правила описи).
func snapshot(project string, paths []string) (*hashes, error) {
	result := newHashes()
	for _, path := range paths {
		value, err := fileDigest(project, path)
		if err != nil {
			return nil, err
		}
		result.set(path, value)
	}
	return result, nil
}

// publishScenes — проход сцен и доработки: проверка нового реестра в копии и публикация его
// вместе с производными видами копии.
func (p publisher) publishScenes(project string, input Publication) error {
	if input.After.Scenes == nil {
		return errors.New(textProposedRegistryMissing)
	}
	problems, err := scenario.ValidateScenes(input.After.Scenes, input.After.Cast)
	if err != nil {
		return err
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, " "))
	}
	initial, err := cast.InitialStates(input.After.Cast)
	if err != nil {
		return err
	}
	if _, err := scenario.ResolveStates(input.After.Scenes, initial); err != nil {
		return err
	}
	initialFiles, err := stageInputs(project)
	if err != nil {
		return err
	}
	initialOutputs, err := scenarioOutputPaths(project)
	if err != nil {
		return err
	}
	union := append(append([]string(nil), initialFiles...), initialOutputs...)
	seen := map[string]bool{}
	unique := []string{}
	for _, path := range union {
		if !seen[path] {
			seen[path] = true
			unique = append(unique, path)
		}
	}
	current, err := snapshot(project, unique)
	if err != nil {
		return err
	}
	stage, err := os.MkdirTemp("", "songframe-scenario-apply-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	for _, relative := range initialFiles {
		data, err := scenarioapply.ReadFile(project, relative)
		if err != nil {
			return err
		}
		want, _ := current.get(relative)
		if data == nil || !sameDigest(want, ptr(digestText(data))) {
			return errors.New(textStaleStagingFile(relative))
		}
		target := filepath.Join(stage, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
	}
	scenesPath := filepath.Join(stage, "plan", "scenes.json")
	if err := os.MkdirAll(filepath.Dir(scenesPath), 0o777); err != nil {
		return err
	}
	if err := os.WriteFile(scenesPath, jsonBytes(input.After.Scenes), 0o600); err != nil {
		return err
	}
	run := func(name string, args ...string) error {
		result, err := runTool(stage, name, args)
		if err != nil {
			return err
		}
		if result.Code == nil || *result.Code != 0 {
			details := result.Stderr
			if details == "" {
				details = result.Stdout
			}
			if details == "" {
				details = textValidationExitCode(result.Code)
			}
			return errors.New(textValidationFailed(name, sliceTail(dynvalue.Trim(details), 1200)))
		}
		return nil
	}
	if err := run("lint_registry"); err != nil {
		return err
	}
	for _, scene := range arrayItems(dynvalue.Get(input.After.Scenes, "scenes")) {
		id := dynvalue.ToString(dynvalue.Get(scene, "id"))
		for _, phase := range []string{"before", "after"} {
			if err := run("continuity_brief", id, "--phase", phase, "--json"); err != nil {
				return err
			}
		}
	}
	if err := run("update_scene_views"); err != nil {
		return err
	}
	if err := run("update_scene_views", "--check"); err != nil {
		return err
	}
	if err := p.unchanged(project, input.ExpectedHashes, current, initialFiles, initialOutputs); err != nil {
		return err
	}
	candidates := []scenarioapply.Change{{Path: "plan/scenes.json", Next: jsonBytes(input.After.Scenes)}}
	stageOutputs, err := scenarioOutputPaths(stage)
	if err != nil {
		return err
	}
	added := map[string]bool{"plan/scenes.json": true}
	for _, relative := range append(append([]string(nil), initialOutputs...), stageOutputs...) {
		if added[relative] {
			continue
		}
		added[relative] = true
		data, err := scenarioapply.ReadFile(stage, relative)
		if err != nil {
			return err
		}
		candidates = append(candidates, scenarioapply.Change{Path: relative, Next: data})
	}
	// Последняя проверка снимка непосредственно перед резервами и заменами; источники назад не копируются.
	if err := verifyHashes(project, input.ExpectedHashes); err != nil {
		return err
	}
	if err := verifyHashes(project, current); err != nil {
		return err
	}
	if err := beforePublish(project); err != nil {
		return err
	}
	return p.commit(project, candidates)
}

// unchanged — после проверок копии входы и состав материалов проекта прежние.
func (p publisher) unchanged(project string, expected, current *hashes, initialFiles, initialOutputs []string) error {
	if err := verifyHashes(project, expected); err != nil {
		return err
	}
	if err := verifyHashes(project, current); err != nil {
		return err
	}
	files, err := stageInputs(project)
	if err != nil {
		return err
	}
	outputs, err := scenarioOutputPaths(project)
	if err != nil {
		return err
	}
	if !sameNames(initialFiles, files) || !sameNames(initialOutputs, outputs) {
		return errors.New(textStaleMaterials)
	}
	return nil
}

func ptr(text string) *string { return &text }
