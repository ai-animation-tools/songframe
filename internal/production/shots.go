// Package production переносит производственный вид планов. Сейчас (этап 43.2) здесь только
// срез viewProduction, который нужен оценке сохранения сценария (scenario.saveImpact): состояние
// плана (planned/progress/completed/stale/unknown) и признак «есть принятый комплект или пакет».
// Полный вид пакетов, их согласования и платные попытки переносит этап 45; он заменит readPackage
// этого файла полной версией с теми же правилами проблем пакета.
package production

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe-go/internal/acceptance"
	"songframe-go/internal/jscompat"
)

// Состояния плана ShotProductionState.
const (
	StatePlanned   = "planned"
	StateProgress  = "progress"
	StateCompleted = "completed"
	StateStale     = "stale"
	StateUnknown   = "unknown"
)

// ShotState — то, что оценка сохранения берёт из ShotProduction оригинала.
type ShotState struct {
	// State — состояние плана, как на странице «Производство».
	State string
	// Produced — есть принятый комплект (asset) или хотя бы один пакет плана.
	Produced bool
}

// originalName — скачанные оригиналы попытки в папке запроса.
var originalName = regexp.MustCompile(`^original(-\d+)?\.(mp4|png|jpg|webp)$`)

// readJSON — readJson модуля production: null при отсутствии и любой ошибке.
func readJSON(path string) any {
	value, ok := jscompat.ReadJSONFile(path)
	if !ok {
		return nil
	}
	return value
}

// joinArg — path.join(base, value): нестроковый аргумент — ERR_INVALID_ARG_TYPE.
func joinArg(base string, value any) (string, error) {
	path, err := jscompat.PathArg("path", value)
	if err != nil {
		return "", err
	}
	return filepath.Join(base, filepath.FromSlash(path)), nil
}

// within — `file.startsWith(resolve(root) + sep)`: путь материала внутри папки пакета или запроса.
func within(root, file string) bool {
	return strings.HasPrefix(filepath.Clean(file), filepath.Clean(root)+string(filepath.Separator))
}

// packageInfo — пакет плана: чей он и есть ли у него проблемы (readPackage → shot, problems).
type packageInfo struct {
	shot     string
	problems bool
}

// readPackage — срез readPackage оригинала: пакет без читаемого workflow.json или со строковым shot
// не считается пакетом (nil). Проблемы — те же условия, что у оригинала: нет/неверный замороженный
// запрос, материалы вне папки пакета, файл результата вне запроса или не обычный файл, пакет
// подготовлен по другой постановке плана. Исключения JS оригинала вне его try (stage не строка,
// keyframes не массив, нестроковые пути) возвращаются ошибкой: оригинал отклонял весь вызов.
// fingerprint — отпечаток текущей постановки плана (currentShotFingerprint) или "" при ошибке.
func readPackage(dir string, fingerprint func(shot string) string) (*packageInfo, error) {
	workflow := readJSON(filepath.Join(dir, "workflow.json"))
	shot, ok := jscompat.Get(workflow, "shot").(string)
	if !jscompat.Truthy(workflow) || !ok {
		return nil, nil
	}
	problems := false
	keyframes, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "keyframes"), &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "(workflow.keyframes ?? []).map is not a function"}
	}
	for _, frame := range keyframes {
		path, err := jscompat.Prop(frame, "path")
		if err != nil {
			return nil, err
		}
		if jscompat.Truthy(path) {
			if _, err := joinArg(dir, path); err != nil {
				return nil, err
			}
		}
	}
	if _, err := joinArg(dir, jscompat.Coalesce(jscompat.GetPath(workflow, "prompt", "path"), "video-prompt.txt")); err != nil {
		return nil, err
	}
	stage, ok := jscompat.Get(workflow, "stage").(string)
	if !ok {
		return nil, &jscompat.TypeError{Message: "workflow.stage.startsWith is not a function"}
	}
	imageRequest := strings.HasPrefix(stage, "image_")
	active := jscompat.Get(workflow, "request_dir")
	if imageRequest {
		active = jscompat.Get(workflow, "image_request_dir")
	}
	var requestDir string
	var downloads []string
	if jscompat.Truthy(active) {
		var err error
		if requestDir, err = joinArg(dir, active); err != nil {
			return nil, err
		}
		frozen := readJSON(filepath.Join(requestDir, "request.json"))
		attempt := readJSON(filepath.Join(requestDir, "attempt.json"))
		if jscompat.Truthy(frozen) {
			if provider, ok := jscompat.Get(frozen, "provider").(string); !ok || jscompat.Trim(provider) == "" {
				problems = true
			}
			kind := jscompat.Get(frozen, "kind")
			if imageRequest != jscompat.StrictEqual(kind, "image") {
				problems = true
			}
			if imageRequest {
				entries, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "image_requests"), &jscompat.Array{}))
				if !ok {
					return nil, &jscompat.TypeError{Message: "(workflow.image_requests ?? []).some is not a function"}
				}
				matched := false
				for _, entry := range entries {
					if jscompat.IsNullish(entry) {
						return nil, &jscompat.TypeError{Message: "Cannot read properties of null (reading 'request_dir')"}
					}
					if jscompat.StrictEqual(jscompat.Get(entry, "request_dir"), active) &&
						jscompat.StrictEqual(jscompat.Get(entry, "frame_id"), jscompat.Get(workflow, "image_frame_id")) &&
						jscompat.StrictEqual(jscompat.Get(entry, "request_sha256"), jscompat.Get(attempt, "request_sha256")) {
						matched = true
						break
					}
				}
				if !matched {
					problems = true
				}
			}
			prompt := jscompat.Get(frozen, "prompt")
			if _, isString := prompt.(string); !isString {
				prompt = jscompat.Coalesce(jscompat.Get(prompt, "path"), "prompt.txt")
			}
			if _, err := joinArg(requestDir, prompt); err != nil {
				return nil, err
			}
			inputs, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(frozen, "inputs"), &jscompat.Array{}))
			if !ok {
				return nil, &jscompat.TypeError{Message: "(frozen.inputs ?? []).map is not a function"}
			}
			for _, input := range inputs {
				path, err := jscompat.Prop(input, "path")
				if err != nil {
					return nil, err
				}
				if _, err := joinArg(requestDir, path); err != nil {
					return nil, err
				}
			}
			list, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(attempt, "downloads"), &jscompat.Array{}))
			if !ok {
				return nil, &jscompat.TypeError{Message: "(attempt?.downloads ?? []).map is not a function"}
			}
			for _, item := range list {
				path, err := jscompat.Prop(item, "path")
				if err != nil {
					return nil, err
				}
				if jscompat.Truthy(path) {
					file, err := joinArg(requestDir, path)
					if err != nil {
						return nil, err
					}
					downloads = append(downloads, file)
				}
			}
			if jscompat.Exists(requestDir) {
				entries, err := jscompat.ReadDir(requestDir)
				if err != nil {
					return nil, err
				}
				for _, entry := range entries {
					if originalName.MatchString(entry.Name()) {
						downloads = append(downloads, filepath.Join(requestDir, entry.Name()))
					}
				}
			}
			existing := downloads[:0]
			seen := map[string]bool{}
			for _, file := range downloads {
				if !seen[file] && jscompat.Exists(file) {
					existing = append(existing, file)
				}
				seen[file] = true
			}
			downloads = existing
		} else {
			problems = true
		}
	}
	// try { packageResultToken; packageToken } catch → проблема пакета.
	if len(downloads) > 0 && !resultFilesValid(requestDir, downloads) {
		problems = true
	} else if valid, err := materialsInside(dir, workflow); err != nil || !valid {
		problems = true
	}
	if stage != "accepted" {
		if current := fingerprint(shot); current != "" && !jscompat.StrictEqual(jscompat.Get(workflow, "scene_sha256"), current) {
			problems = true
		}
	}
	return &packageInfo{shot: shot, problems: problems}, nil
}

// resultFilesValid — условия packageResultToken: request.json, attempt.json и скачанные файлы лежат
// внутри папки запроса и являются обычными файлами (lstat, без ссылок).
func resultFilesValid(requestDir string, downloads []string) bool {
	paths := append([]string{filepath.Join(requestDir, "request.json"), filepath.Join(requestDir, "attempt.json")}, downloads...)
	for _, path := range paths {
		info, err := os.Lstat(path)
		if !within(requestDir, path) || err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

// materialsInside — условие packageToken: все материалы пакета (описание, промпт, опоры, замороженные
// запросы и их входы) лежат внутри папки пакета. TypeError на нестроковом пути — тоже ошибка
// внутри try оригинала, то есть проблема пакета.
func materialsInside(dir string, workflow any) (bool, error) {
	paths := []any{"workflow.json", "description.md", jscompat.Coalesce(jscompat.GetPath(workflow, "prompt", "path"), "video-prompt.txt")}
	keyframes, _ := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "keyframes"), &jscompat.Array{}))
	for _, frame := range keyframes {
		if path := jscompat.Get(frame, "path"); jscompat.Truthy(path) {
			paths = append(paths, path)
		}
	}
	requests := []any{jscompat.Get(workflow, "request_dir"), jscompat.Get(workflow, "image_request_dir")}
	entries, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "image_requests"), &jscompat.Array{}))
	if !ok {
		return false, &jscompat.TypeError{Message: "(workflow.image_requests ?? []).map is not a function"}
	}
	for _, entry := range entries {
		value, err := jscompat.Prop(entry, "request_dir")
		if err != nil {
			return false, err
		}
		requests = append(requests, value)
	}
	for _, requestDir := range requests {
		if !jscompat.Truthy(requestDir) {
			continue
		}
		base, err := jscompat.PathArg("path", requestDir)
		if err != nil {
			return false, err
		}
		paths = append(paths, filepath.Join(base, "request.json"))
		request := readJSON(filepath.Join(dir, base, "request.json"))
		if !jscompat.Truthy(request) {
			continue
		}
		prompt := jscompat.Get(request, "prompt")
		if _, isString := prompt.(string); !isString {
			prompt = jscompat.Coalesce(jscompat.Get(prompt, "path"), "prompt.txt")
		}
		path, err := jscompat.PathArg("path", prompt)
		if err != nil {
			return false, err
		}
		paths = append(paths, filepath.Join(base, path))
		inputs, err := jscompat.Iterate(jscompat.Coalesce(jscompat.Get(request, "inputs"), &jscompat.Array{}))
		if err != nil {
			return false, err
		}
		for _, input := range inputs {
			value, err := jscompat.Prop(input, "path")
			if err != nil {
				return false, err
			}
			path, err := jscompat.PathArg("path", value)
			if err != nil {
				return false, err
			}
			paths = append(paths, filepath.Join(base, path))
		}
	}
	for _, path := range paths {
		text, err := jscompat.PathArg("path", path)
		if err != nil {
			return false, err
		}
		// resolve(directory, path): абсолютный путь материала выходит за папку пакета.
		if !within(dir, jscompat.Resolve(dir, filepath.FromSlash(text))) {
			return false, nil
		}
	}
	return true, nil
}

// ShotStates — состояние каждого плана сохранённого реестра plan/scenes.json так же, как
// viewProduction(project).shots[*].state и наличие комплекта/пакетов. Без реестра — пусто.
// Ключ — String(id) плана. Ничего не пишет.
func ShotStates(project string) (map[string]ShotState, error) {
	result := map[string]ShotState{}
	scenes := readJSON(filepath.Join(project, "plan", "scenes.json"))
	if !jscompat.Truthy(scenes) {
		return result, nil
	}
	// currentShotFingerprint: отпечатки сохранённого реестра по кастингу проекта, один раз за вызов.
	var fingerprints *jscompat.Object
	computed := false
	fingerprint := func(shot string) string {
		if !computed {
			computed = true
			fingerprints, _ = acceptance.ProjectFingerprints(project, scenes)
		}
		if fingerprints == nil {
			return ""
		}
		value, _ := fingerprints.Value(shot).(string)
		return value
	}
	var packages []*packageInfo
	for _, base := range []string{"batches", "awaiting"} {
		folder := filepath.Join(project, "plan", base)
		if !jscompat.Exists(folder) {
			continue
		}
		entries, err := jscompat.ReadDir(folder)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			info, err := readPackage(filepath.Join(folder, name), fingerprint)
			if err != nil {
				return nil, err
			}
			if info != nil {
				packages = append(packages, info)
			}
		}
	}
	if _, ok := jscompat.AsArray(jscompat.Get(scenes, "sequences")); !ok {
		return nil, &jscompat.TypeError{Message: "scenes.sequences.map is not a function"}
	}
	accepted, err := acceptance.Compute(project, scenes)
	if err != nil {
		return nil, err
	}
	list, err := jscompat.Iterate(jscompat.Get(scenes, "scenes"))
	if err != nil {
		return nil, err
	}
	for _, scene := range list {
		rawID, err := jscompat.Prop(scene, "id")
		if err != nil {
			return nil, err
		}
		id, err := jscompat.PathArg("path", rawID)
		if err != nil {
			return nil, err
		}
		manifest := readJSON(filepath.Join(project, "assets", "shots", id, "manifest.json"))
		hasManifest := jscompat.Truthy(manifest)
		mine, troubled := 0, false
		for _, item := range packages {
			if item.shot == id {
				mine++
				troubled = troubled || item.problems
			}
		}
		state := StatePlanned
		if mine > 0 {
			state = StateProgress
		}
		if hasManifest {
			state = StateStale
			if value, ok := accepted.Accepted[id]; ok {
				state = value
			}
		} else if troubled {
			state = StateUnknown
		}
		result[jscompat.ToString(rawID)] = ShotState{State: state, Produced: hasManifest || mine > 0}
	}
	return result, nil
}
