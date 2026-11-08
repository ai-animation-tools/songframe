// Package scenesave сохраняет реестр планов с учётом производства: определяет,
// какие планы меняют отпечаток постановки при сохранении черновика, с какой формальной причиной
// и что с ними станет. Обычное сохранение (production) делает принятые комплекты затронутых планов
// устаревшими само — по несовпадению отпечатков. Режим keep («правка не меняет результат»)
// переносит новый отпечаток в plan/production-status.json и в workflow.json пакетов, подготовленных
// по прежней постановке.
//
// Пакет отделён от scenario, потому что ему нужны принятие (acceptance) и производственный вид
// (production), а те сами зависят от scenario: так нет цикла импортов.
package scenesave

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"unicode/utf16"

	"songframe-go/internal/cast"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/production"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/scenario"
)

// Режимы сохранения ScenesSaveMode.
const (
	ModeProduction = "production"
	ModeKeep       = "keep"
)

// Тексты scenarioTexts.main и productionTexts.main.acceptance (frontend/src/shared/texts).
const (
	textImpactNewShot      = "новый план в реестре"
	textImpactStaging      = "изменена постановка плана"
	textImpactBounds       = "сдвинуты границы плана"
	textImpactInitialState = "изменилось начальное состояние"
	textImpactGlobalRules  = "изменены общие правила или направление части"
	textInvalidSaveMode    = "Неизвестный режим сохранения реестра."
)

func textImpactInherited(source string) string {
	return "изменилось состояние, унаследованное от " + source
}
func textImpactDerived(source string) string {
	return "собирается из материала " + source
}
func textStatusCorrupt(path string) string {
	return path + " повреждён: исправьте файл, чтобы записать принятые отпечатки."
}

// statusPath — plan/production-status.json; в тексте ошибки путь с разделителем ОС, как join().
var statusPath = filepath.Join("plan", "production-status.json")

// ImpactShot — ScenarioImpactShot: план, чей отпечаток изменится, причина и его производство.
type ImpactShot struct {
	ID       string `json:"id"`
	Reason   string `json:"reason"`
	State    string `json:"state"`
	Produced bool   `json:"produced"`
}

// Impact — ScenarioSaveImpact, ответ scenario.saveImpact.
type Impact struct {
	Shots []ImpactShot `json:"shots"`
}

// affected — затронутый план и формальная причина.
type affected struct {
	id     string
	reason string
}

// readRegistry — сохранённый plan/scenes.json или nil (нет файла, не разбирается).
func readRegistry(project string) any {
	raw, err := os.ReadFile(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		return nil
	}
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(raw)))
	if err != nil {
		return nil
	}
	return value
}

// initialStates — начальное состояние сущностей кастинга проекта (`readCast(project) || null`).
func initialStates(project string) (*jscompat.Object, error) {
	read := cast.Read(project)
	var value any
	if jscompat.Truthy(read.Value) {
		value = read.Value
	}
	return cast.InitialStates(value)
}

// fingerprintsOf — отпечатки планов реестра: nil, если реестра нет или отпечатки
// не вычисляются (цикл состояний, неверные изменения и т. п.).
func fingerprintsOf(project string, scenes any) *jscompat.Object {
	if scenes == nil {
		return nil
	}
	initial, err := initialStates(project)
	if err != nil {
		return nil
	}
	fingerprints, err := scenario.SceneFingerprints(scenes, initial)
	if err != nil {
		return nil
	}
	return fingerprints
}

// sceneList — элементы scenes реестра, у которого уже вычислены отпечатки (массив гарантирован).
func sceneList(registry any) []any {
	list, _ := jscompat.AsArray(jscompat.Get(registry, "scenes"))
	return list
}

// findScene — `scenes.find((scene) => scene.id === id)`.
func findScene(registry any, id string) (any, bool) {
	for _, scene := range sceneList(registry) {
		if jscompat.StrictEqual(jscompat.Get(scene, "id"), id) {
			return scene, true
		}
	}
	return nil, false
}

// withoutBounds — план без start_frame и end_frame_exclusive для сравнения постановки.
func withoutBounds(scene any) string {
	rest := jscompat.Spread(scene)
	rest.Delete("start_frame")
	rest.Delete("end_frame_exclusive")
	return jscompat.Stringify(rest)
}

// stateJSON — компактный JSON вычисленного состояния плана id; второй результат — значение есть.
func stateJSON(registry any, initial *jscompat.Object, id string) (string, bool, error) {
	states, err := scenario.ResolveStates(registry, initial)
	if err != nil {
		return "", false, err
	}
	state, ok := states.Value(id).(scenario.ResolvedState)
	if !ok {
		return "", false, nil
	}
	return jscompat.Stringify(state.Object()), true, nil
}

// reasonOf — формальная причина изменения отпечатка плана: новый план, изменённая постановка,
// сдвиг границ, изменённое унаследованное или начальное состояние, иначе общие правила. Смысловые
// связи свободного текста не угадываются.
func reasonOf(project string, before, after any, id string) (string, error) {
	previous, found := findScene(before, id)
	next, _ := findScene(after, id)
	if !found {
		return textImpactNewShot, nil
	}
	if withoutBounds(previous) != withoutBounds(next) {
		return textImpactStaging, nil
	}
	if !jscompat.StrictEqual(jscompat.Get(previous, "start_frame"), jscompat.Get(next, "start_frame")) ||
		!jscompat.StrictEqual(jscompat.Get(previous, "end_frame_exclusive"), jscompat.Get(next, "end_frame_exclusive")) {
		return textImpactBounds, nil
	}
	initial, err := initialStates(project)
	if err != nil {
		return "", err
	}
	was, wasOK, err := stateJSON(before, initial, id)
	if err != nil {
		return "", err
	}
	now, nowOK, err := stateJSON(after, initial, id)
	if err != nil {
		return "", err
	}
	if was != now || wasOK != nowOK {
		from := jscompat.Get(next, "state_from")
		source := from
		if _, isString := from.(string); !isString {
			source = jscompat.Coalesce(jscompat.Get(from, "scene"), nil)
		}
		if jscompat.Truthy(source) {
			return textImpactInherited(jscompat.ToString(source)), nil
		}
		return textImpactInitialState, nil
	}
	return textImpactGlobalRules, nil
}

// affectedShots — планы, чей отпечаток различается у сохранённого реестра и черновика, плюс
// производные от них планы (derived_from.shot). Порядок — порядок планов черновика; повтор кода
// в черновике повторяется и в ответе. Без прежнего реестра или при
// невычислимых отпечатках — пусто.
func affectedShots(project string, before, after any) ([]affected, error) {
	previous := fingerprintsOf(project, before)
	next := fingerprintsOf(project, after)
	if before == nil || previous == nil || next == nil {
		return nil, nil
	}
	changed := map[string]string{}
	for _, scene := range sceneList(after) {
		id := jscompat.ToString(jscompat.Get(scene, "id"))
		if !jscompat.StrictEqual(previous.Value(id), next.Value(id)) {
			reason, err := reasonOf(project, before, after, id)
			if err != nil {
				return nil, err
			}
			changed[id] = reason
		}
	}
	for _, scene := range sceneList(after) {
		id := jscompat.ToString(jscompat.Get(scene, "id"))
		source, isString := jscompat.GetPath(scene, "derived_from", "shot").(string)
		if _, has := changed[source]; isString && source != "" && has {
			if _, already := changed[id]; !already {
				changed[id] = textImpactDerived(source)
			}
		}
	}
	result := []affected{}
	for _, scene := range sceneList(after) {
		id := jscompat.ToString(jscompat.Get(scene, "id"))
		if reason, ok := changed[id]; ok {
			result = append(result, affected{id: id, reason: reason})
		}
	}
	return result, nil
}

// SaveImpact — scenario.saveImpact (scenesSaveImpact): что затронет сохранение черновика.
// Состояние и наличие производства берутся из производственного вида сохранённого реестра — того
// же, что на страницах планов; план вне сохранённого реестра — planned без производства. Ничего не пишет.
func SaveImpact(project string, draft any) (Impact, error) {
	shots, err := affectedShots(project, readRegistry(project), draft)
	if err != nil {
		return Impact{}, err
	}
	result := Impact{Shots: []ImpactShot{}}
	if len(shots) == 0 {
		return result, nil
	}
	states, err := production.ShotStates(project)
	if err != nil {
		return Impact{}, err
	}
	for _, shot := range shots {
		item := ImpactShot{ID: shot.id, Reason: shot.reason, State: production.StatePlanned}
		if state, ok := states[shot.id]; ok {
			item.State, item.Produced = state.State, state.Produced
		}
		result.Shots = append(result.Shots, item)
	}
	return result, nil
}

// writableStatus — текущий plan/production-status.json для записи, nil без файла;
// повреждённый файл (не объект) — ошибка, чтобы keep не оставил полусохранение.
func writableStatus(project string) (*jscompat.Object, error) {
	path := filepath.Join(project, statusPath)
	if !jscompat.Exists(path) {
		return nil, nil
	}
	value, _ := jscompat.ReadJSONFile(path)
	if !jscompat.IsRecord(value) {
		return nil, errors.New(textStatusCorrupt(statusPath))
	}
	return value.(*jscompat.Object), nil
}

// acceptedFingerprints — отпечатки, по которым приняты комплекты (shots.*.scene_sha256).
func acceptedFingerprints(project string) map[string]string {
	result := map[string]string{}
	status, _ := jscompat.ReadJSONFile(filepath.Join(project, statusPath))
	shots, ok := jscompat.AsObject(jscompat.Get(status, "shots"))
	if !jscompat.IsRecord(status) || !ok {
		return result
	}
	for _, id := range shots.Keys() {
		entry := shots.Value(id)
		if sha, isString := jscompat.Get(entry, "scene_sha256").(string); isString && jscompat.IsRecord(entry) {
			result[id] = sha
		}
	}
	return result
}

// writeFile — замена файла проекта. Оригинал писал через временный файл и rename, то есть права
// становились 0666 с umask; здесь существующий файл сохраняет свои права, новый — 0666 с umask.
// Переменная — точка подмены в тестах сбоя.
var writeFile = func(path string, data []byte) error {
	perm := os.FileMode(0o666)
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	return projectfs.WriteFile(path, data, perm)
}

// shotNumber — Number(id.slice(1)) для порядка планов в production-status.json.
func shotNumber(id string) float64 {
	units := utf16.Encode([]rune(id))
	if len(units) == 0 {
		return 0
	}
	return jscompat.ToNumber(string(utf16.Decode(units[1:])))
}

// writeAcceptedFingerprints — атомарно записывает новые отпечатки принятых планов, сохраняя прочие
// поля файла и записей. Записи shots упорядочиваются по номеру плана (устойчиво; нечисловые
// номера сохраняют взаимный порядок).
func writeAcceptedFingerprints(project string, ids []string, updates map[string]string) error {
	if len(ids) == 0 {
		return nil
	}
	current, err := writableStatus(project)
	if err != nil {
		return err
	}
	status := current
	if status == nil {
		status = jscompat.NewObject()
		status.Set("schema_version", 1.0)
		status.Set("current_animatic", nil)
		status.Set("current_animatic_status", "none")
	}
	shots := jscompat.NewObject()
	if existing, ok := jscompat.AsObject(status.Value("shots")); ok {
		shots = jscompat.Spread(existing)
	}
	for _, id := range ids {
		entry := jscompat.NewObject()
		if previous, ok := jscompat.AsObject(shots.Value(id)); ok {
			entry = jscompat.Spread(previous)
		}
		entry.Set("scene_sha256", updates[id])
		shots.Set(id, entry)
	}
	keys := shots.Keys()
	sort.SliceStable(keys, func(i, j int) bool {
		difference := shotNumber(keys[i]) - shotNumber(keys[j])
		return !math.IsNaN(difference) && difference < 0
	})
	sorted := jscompat.NewObject()
	for _, key := range keys {
		sorted.Set(key, shots.Value(key))
	}
	status.Set("shots", sorted)
	return writeFile(filepath.Join(project, statusPath), scenario.Encode(status))
}

// jsSpace — класс \s регулярного выражения JS (RE2 понимает \s только как ASCII).
const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// restampPackage — в тексте workflow.json заменяется только первое
// значение "scene_sha256": "<from>", остальной файл (форматирование, порядок полей) не меняется.
// false — значения нет, файл не трогается.
func restampPackage(directory, from, to string) (bool, error) {
	path := filepath.Join(directory, "workflow.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return false, jscompat.FsError("open", path, err)
	}
	text := jscompat.DecodeUTF8(raw)
	pattern := regexp.MustCompile(`("scene_sha256"` + jsSpace + `*:` + jsSpace + `*)"` + regexp.QuoteMeta(from) + `"`)
	match := pattern.FindStringSubmatchIndex(text)
	if match == nil {
		return false, nil
	}
	replaced := text[:match[0]] + text[match[2]:match[3]] + `"` + to + `"` + text[match[1]:]
	return true, writeFile(path, []byte(replaced))
}

// restampPackages — пакеты plan/batches и plan/awaiting затронутых планов, не принятые и
// подготовленные по прежнему отпечатку, получают новый. Нечитаемый workflow.json пропускается.
func restampPackages(project string, shots map[string]bool, previous, next *jscompat.Object) error {
	for _, base := range []string{"batches", "awaiting"} {
		folder := filepath.Join(project, "plan", base)
		if !jscompat.Exists(folder) {
			continue
		}
		entries, err := jscompat.ReadDir(folder)
		if err != nil {
			return err
		}
		names := []string{}
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			workflow, ok := jscompat.ReadJSONFile(filepath.Join(folder, name, "workflow.json"))
			if !ok {
				continue
			}
			shot, _ := jscompat.Get(workflow, "shot").(string)
			from, hasFrom := previous.Value(shot).(string)
			if !shots[shot] || jscompat.StrictEqual(jscompat.Get(workflow, "stage"), "accepted") ||
				!hasFrom || !jscompat.StrictEqual(jscompat.Get(workflow, "scene_sha256"), from) {
				continue
			}
			if _, err := restampPackage(filepath.Join(folder, name), from, jscompat.ToString(next.Value(shot))); err != nil {
				return err
			}
		}
	}
	return nil
}

// SaveScenesWithMode — scenario.saveScenes с режимом. production: затронутые принятые планы
// становятся устаревшими сами, по несовпадению отпечатков. keep: планы, принятые и подготовленные
// по прежней постановке, получают новый отпечаток; ранее устаревшие остаются устаревшими, чтобы
// правка опечатки не отменяла прежнюю сюжетную правку. Файл принятия в режиме keep проверяется до
// записи реестра. Возвращает записанный реестр.
func SaveScenesWithMode(project string, data any, mode string) (*jscompat.Object, error) {
	if mode != ModeProduction && mode != ModeKeep {
		return nil, errors.New(textInvalidSaveMode)
	}
	if mode == ModeKeep {
		if _, err := writableStatus(project); err != nil {
			return nil, err
		}
	}
	before := readRegistry(project)
	previous := fingerprintsOf(project, before)
	saved, err := scenario.SaveScenes(project, data)
	if err != nil {
		return nil, err
	}
	if mode == ModeProduction || previous == nil {
		return saved, nil
	}
	next := fingerprintsOf(project, saved)
	if next == nil {
		return saved, nil
	}
	shots, err := affectedShots(project, before, saved)
	if err != nil {
		return nil, err
	}
	stored := acceptedFingerprints(project)
	set := map[string]bool{}
	ids := []string{}
	updates := map[string]string{}
	for _, shot := range shots {
		if set[shot.id] {
			continue
		}
		set[shot.id] = true
		was, _ := previous.Value(shot.id).(string)
		now, _ := next.Value(shot.id).(string)
		if stored[shot.id] != "" && stored[shot.id] == was && now != "" {
			ids = append(ids, shot.id)
			updates[shot.id] = now
		}
	}
	if err := writeAcceptedFingerprints(project, ids, updates); err != nil {
		return nil, err
	}
	if err := restampPackages(project, set, previous, next); err != nil {
		return nil, err
	}
	return saved, nil
}
