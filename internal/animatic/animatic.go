// Package animatic проверяет сборку аниматика plan/animatic/latest: собрана ли она, свежа ли по
// реестру сцен и фактическим входам и принята ли именно она в plan/production-status.json.
//
// Это viewAnimatic, animaticInputProblems и setAnimaticStatus оригинала (src/main/animatic.ts,
// animatic-freshness.ts). Один разбор (inspect) даёт и вид страницы «Аниматик», и признаки
// built/fresh/approved статуса проекта; порядок проверок и исключения (например, нестроковый путь
// в манифесте) повторены полностью, потому что исключение оригинала прерывает и страницу, и
// computeStatus. Чтение не меняет файлов; хеши входов берутся из кэша filedigest. Запись —
// только SetStatus в plan/production-status.json; задание сборки — Service.Build.
package animatic

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe-go/internal/filedigest"
	"songframe-go/internal/jscompat"
)

// fps — кадровая сетка приложения (shared/video.ts).
const fps = 30.0

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Тексты animaticTexts.main и commonTexts.scenario: сейчас входят только в Problems и нужны
// будущей странице аниматика.
const (
	scenarioRequired     = "Сначала нужен сценарий. Создайте его на странице «Сценарий»."
	registryChanged      = "Реестр сцен изменился после сборки: аниматик устарел, нужна пересборка."
	manifestCorrupt      = "plan/animatic/latest/manifest.json повреждён."
	projectInputsMissing = "В манифесте аниматика отсутствует обязательное поле project_inputs; пересоберите аниматик."
	projectInputsChanged = "Значимые поля plan/project.json изменены или snapshot project_inputs повреждён; нужна пересборка аниматика."
)

func videoMissing(filename any) string {
	return "MP4 сборки не найден: " + jscompat.ToString(jscompat.Coalesce(filename, "имя не записано")) + ". Соберите аниматик заново."
}
func inputHashMissing(name string) string {
	return "Нет сохранённого хеша входа " + name + ": пересоберите аниматик для проверки свежести."
}
func inputChanged(name string) string {
	return "Вход аниматика изменён или отсутствует: " + name + ". Нужна пересборка."
}
func shotInputMissing(shot any) string {
	return jscompat.ToString(shot) + ": в манифесте нет входного файла; нужна пересборка."
}
func acceptedEditChanged(shot any) string {
	return jscompat.ToString(shot) + ": выбранный принятый монтаж изменился после сборки; нужна пересборка."
}
func acceptedEditAdded(shot any) string {
	return jscompat.ToString(shot) + ": вместо карточки появился принятый монтаж; нужна пересборка."
}
func keyframesChanged(shot any) string {
	return jscompat.ToString(shot) + ": выбор принятых опор изменился после сборки; нужна пересборка."
}
func keyframeSourcesMissing(shot any) string {
	return jscompat.ToString(shot) + ": нет сведений об исходных опорах старой сборки; пересоберите аниматик."
}
func referencePathMissing(shot, id any) string {
	return jscompat.ToString(shot) + ": нет пути референса " + jscompat.ToString(id) + "; нужна пересборка."
}

// State — признаки сборки для статуса проекта и страницы аниматика.
type State struct {
	// Built — манифест сборки читается и содержит массив shots (built !== null оригинала).
	Built bool
	// Fresh — сборка соответствует текущим байтам scenes.json, MP4 на месте и все входы совпадают.
	Fresh bool
	// Approved — принята именно эта свежая сборка (approval.current).
	Approved bool
	// ApprovalStatus — approved, review или none из current_animatic_status.
	ApprovalStatus string
	// CardsFresh — квитанция карточек построена по текущему реестру.
	CardsFresh bool
	// Problems — проблемы сборки в порядке оригинала.
	Problems []string
}

// readJSON — readJson оригинала: null при любой ошибке.
func readJSON(path string) any {
	value, _ := jscompat.ReadJSONFile(path)
	return value
}

// Inspect — viewAnimatic(project) в части признаков и проблем для статуса проекта. Это тот же
// разбор, что и ViewAnimatic (inspect в view.go). Ошибка — исключение оригинала.
func Inspect(project string) (State, error) {
	_, state, err := inspect(project)
	return state, err
}

// projectPath — путь входа внутри проекта или "" для абсолютного и выходящего за проект.
func projectPath(project string, name any) (string, error) {
	text, err := jscompat.PathArg("paths[1]", name)
	if err != nil {
		return "", err
	}
	path := jscompat.Resolve(project, text)
	local := jscompat.Relative(project, path)
	if jscompat.IsAbs(text) || local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) {
		return "", nil
	}
	return path, nil
}

// digestOf — cachedFileDigest как значение JS: строка или null.
func digestOf(path string) any {
	if digest, ok := filedigest.File(path); ok {
		return digest
	}
	return nil
}

// toSlash — `.split(sep).join('/')`.
func toSlash(path string) string {
	return strings.ReplaceAll(path, string(filepath.Separator), "/")
}

// inputProblems — animaticInputProblems: сверка source_hashes, project_inputs, принятых монтажей,
// выбранных опор и референсов карточек. Результат без повторов, в порядке первого появления.
func inputProblems(project string, manifest *jscompat.Object) ([]string, error) {
	var problems []string
	sources := jscompat.Coalesce(manifest.Value("source_hashes"), jscompat.NewObject())
	check := func(name, digest any) error {
		path, err := projectPath(project, name)
		if err != nil {
			return err
		}
		text, isString := digest.(string)
		label := jscompat.ToString(name)
		if !isString || !sha256Pattern.MatchString(text) {
			problems = append(problems, inputHashMissing(label))
		} else if path == "" || !jscompat.StrictEqual(digestOf(path), text) {
			problems = append(problems, inputChanged(label))
		}
		return nil
	}
	in := func(key any) (bool, error) { return jscompat.HasProperty(sources, key) }
	currentProject := readJSON(filepath.Join(project, "plan", "project.json"))
	if !manifest.Has("project_inputs") {
		problems = append(problems, projectInputsMissing)
	} else if !projectInputsMatch(manifest.Value("project_inputs"), currentProject) {
		problems = append(problems, projectInputsChanged)
	}
	entries, err := jscompat.Entries(sources)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if err := check(entry.Key, entry.Value); err != nil {
			return nil, err
		}
	}
	audio := manifest.Value("source_audio")
	name := jscompat.Coalesce(audio, "source/track.mp3")
	found, err := in(name)
	if err != nil {
		return nil, err
	}
	if !found {
		var digest any = jscompat.Undefined
		if jscompat.StrictEqual(name, audio) {
			digest = manifest.Value("source_audio_sha256")
		}
		if err := check(name, digest); err != nil {
			return nil, err
		}
	}
	receipt := readJSON(filepath.Join(project, "plan", "animatic", "cards", "manifest.json"))
	registry := readJSON(filepath.Join(project, "plan", "scenes.json"))
	shots, _ := jscompat.AsArray(manifest.Value("shots"))
	for _, shot := range shots {
		shotID := jscompat.Get(shot, "id")
		path := jscompat.Get(shot, "path")
		if !jscompat.Truthy(path) {
			problems = append(problems, shotInputMissing(shotID))
			continue
		}
		if found, err := in(path); err != nil {
			return nil, err
		} else if !found {
			if err := check(path, jscompat.Get(shot, "sha256")); err != nil {
				return nil, err
			}
		}
		last := jscompat.Get(shot, "path_last")
		if jscompat.Truthy(last) {
			if found, err := in(last); err != nil {
				return nil, err
			} else if !found {
				if err := check(last, jscompat.Get(shot, "sha256_last")); err != nil {
					return nil, err
				}
			}
		}
		id, err := jscompat.PathArg("path", shotID)
		if err != nil {
			return nil, err
		}
		assetPath := filepath.Join(project, "assets", "shots", id, "manifest.json")
		asset := readJSON(assetPath)
		if jscompat.StrictEqual(jscompat.Get(shot, "media"), "video") {
			edit := jscompat.Get(asset, "accepted_edit")
			var selected any = nil
			if videoPath := jscompat.GetPath(edit, "video", "path"); jscompat.Truthy(videoPath) {
				text, err := jscompat.PathArg("paths[1]", videoPath)
				if err != nil {
					return nil, err
				}
				selected = toSlash(jscompat.Relative(project, jscompat.Resolve(filepath.Dir(assetPath), text)))
			}
			expected := jscompat.Coalesce(jscompat.GetKey(sources, path), jscompat.Get(shot, "sha256"))
			if !jscompat.StrictEqual(jscompat.Get(asset, "shot"), shotID) || !jscompat.StrictEqual(selected, path) ||
				!jscompat.StrictEqual(jscompat.GetPath(edit, "video", "sha256"), expected) ||
				!jscompat.StrictEqual(jscompat.Get(edit, "fps"), fps) || !jscompat.StrictEqual(jscompat.Get(edit, "frames"), jscompat.Get(shot, "frames")) {
				problems = append(problems, acceptedEditChanged(shotID))
			}
			continue
		}
		if jscompat.Exists(assetPath) {
			problems = append(problems, acceptedEditAdded(shotID))
			continue
		}
		selectedFrames, err := selectFrames(project, id)
		if err != nil {
			return nil, err
		}
		entry := jscompat.GetKey(jscompat.Get(receipt, "cards"), shotID)
		receiptMatches := jscompat.StrictEqual(jscompat.Get(receipt, "registry_sha256"), manifest.Value("scene_registry_sha256")) &&
			jscompat.StrictEqual(jscompat.Get(entry, "sha256"), jscompat.Coalesce(jscompat.GetKey(sources, path), jscompat.Get(shot, "sha256"))) &&
			(!jscompat.Truthy(last) || jscompat.StrictEqual(jscompat.GetPath(entry, "last", "sha256"),
				jscompat.Coalesce(jscompat.GetKey(sources, last), jscompat.Get(shot, "sha256_last"))))
		var fromReceipt any = jscompat.Undefined
		if receiptMatches {
			fromReceipt = jscompat.Get(entry, "keyframes")
		}
		recorded := jscompat.Coalesce(jscompat.Coalesce(jscompat.Get(shot, "keyframes"), fromReceipt), nil)
		left, err := normalizeFrames(selectedFrames)
		if err != nil {
			return nil, err
		}
		right, err := normalizeFrames(recorded)
		if err != nil {
			return nil, err
		}
		if jscompat.Stringify(left) != jscompat.Stringify(right) {
			problems = append(problems, keyframesChanged(shotID))
		}
		if jscompat.StrictEqual(jscompat.Get(shot, "media"), "keyframes") && !jscompat.Truthy(recorded) {
			problems = append(problems, keyframeSourcesMissing(shotID))
		}
		frames, _ := jscompat.AsArray(recorded)
		for _, frame := range frames {
			framePath := jscompat.Get(frame, "path")
			found, err := in(framePath)
			if err != nil {
				return nil, err
			}
			if !found {
				if err := check(framePath, jscompat.Get(frame, "sha256")); err != nil {
					return nil, err
				}
			}
		}
		if recorded == nil {
			references, err := shotReferences(shot)
			if err != nil {
				return nil, err
			}
			for _, id := range references {
				name := jscompat.Get(jscompat.GetKey(jscompat.Get(registry, "references"), id), "path")
				if !jscompat.Truthy(name) {
					problems = append(problems, referencePathMissing(shotID, id))
					continue
				}
				found, err := in(name)
				if err != nil {
					return nil, err
				}
				if !found {
					var digest any = jscompat.Undefined
					if receiptMatches {
						digest = jscompat.GetKey(jscompat.Get(receipt, "reference_hashes"), name)
					}
					if err := check(name, digest); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	if videoFile := manifest.Value("video_file"); jscompat.Truthy(videoFile) {
		if err := check("plan/animatic/latest/"+jscompat.ToString(videoFile), manifest.Value("video_sha256")); err != nil {
			return nil, err
		}
	}
	seen := map[string]bool{}
	unique := []string{}
	for _, problem := range problems {
		if !seen[problem] {
			seen[problem] = true
			unique = append(unique, problem)
		}
	}
	return unique, nil
}

// shotReferences — уникальные референсы карточки: references (или refs) и primary_reference без «—».
func shotReferences(shot any) ([]any, error) {
	list := jscompat.Coalesce(jscompat.Coalesce(jscompat.Get(shot, "references"), jscompat.Get(shot, "refs")), &jscompat.Array{})
	items, err := jscompat.Iterate(list)
	if err != nil {
		return nil, err
	}
	items = append(append([]any(nil), items...), jscompat.GetPath(shot, "card", "primary_reference"))
	seen := map[any]bool{}
	var result []any
	for _, id := range items {
		if !jscompat.Truthy(id) || jscompat.StrictEqual(id, "—") || seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, id)
	}
	return result, nil
}

// normalizeFrames — сравнимый вид списка опор: поля id, role, time_seconds, path, sha256 в этом
// порядке; null остаётся null. Не-массив — TypeError вызова .map.
func normalizeFrames(frames any) (any, error) {
	if jscompat.IsNullish(frames) {
		return nil, nil
	}
	items, ok := jscompat.AsArray(frames)
	if !ok {
		return nil, &jscompat.TypeError{Message: "frames?.map is not a function"}
	}
	result := &jscompat.Array{Items: make([]any, len(items))}
	for index, frame := range items {
		if jscompat.IsNullish(frame) {
			return nil, &jscompat.TypeError{Message: "Cannot destructure property 'id' of '" + jscompat.ToString(frame) + "' as it is " + jscompat.ToString(frame) + "."}
		}
		object := jscompat.NewObject()
		for _, key := range []string{"id", "role", "time_seconds", "path", "sha256"} {
			object.Set(key, jscompat.Get(frame, key))
		}
		result.Items[index] = object
	}
	return result, nil
}

// selectFrames — selectedFrames оригинала (= approved_keyframes в update_scene_views): первая
// подходящая очередь plan/awaiting/<план>, затем рабочие пакеты plan/batches в порядке имён.
// Подходит workflow этого плана, не принятый, со всеми утверждёнными и существующими опорами.
func selectFrames(project, shot string) (any, error) {
	batches := filepath.Join(project, "plan", "batches")
	candidates := []string{filepath.Join(project, "plan", "awaiting", shot, "workflow.json")}
	if jscompat.Exists(batches) {
		entries, err := jscompat.ReadDir(batches)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.SliceStable(names, func(i, j int) bool { return jscompat.LessUTF16(names[i], names[j]) })
		for _, name := range names {
			candidates = append(candidates, filepath.Join(batches, name, "workflow.json"))
		}
	}
	for _, path := range candidates {
		workflow := readJSON(path)
		keyframes, isArray := jscompat.AsArray(jscompat.Get(workflow, "keyframes"))
		if !jscompat.StrictEqual(jscompat.Get(workflow, "shot"), shot) || jscompat.StrictEqual(jscompat.Get(workflow, "stage"), "accepted") ||
			!isArray || len(keyframes) == 0 {
			continue
		}
		approved := true
		for _, frame := range keyframes {
			if _, err := jscompat.Prop(frame, "approved"); err != nil {
				return nil, err
			}
			if !jscompat.Truthy(jscompat.Get(frame, "approved")) || !jscompat.Truthy(jscompat.Get(frame, "path")) {
				approved = false
				break
			}
			text, err := jscompat.PathArg("paths[1]", jscompat.Get(frame, "path"))
			if err != nil {
				return nil, err
			}
			if digestOf(jscompat.Resolve(filepath.Dir(path), text)) == nil {
				approved = false
				break
			}
		}
		if !approved {
			continue
		}
		result := &jscompat.Array{}
		for _, frame := range keyframes {
			full := jscompat.Resolve(filepath.Dir(path), jscompat.Get(frame, "path").(string))
			object := jscompat.NewObject()
			object.Set("id", jscompat.Get(frame, "id"))
			object.Set("role", jscompat.Get(frame, "role"))
			object.Set("time_seconds", jscompat.Get(frame, "time_seconds"))
			object.Set("path", toSlash(jscompat.Relative(project, full)))
			object.Set("sha256", digestOf(full))
			result.Items = append(result.Items, object)
		}
		return result, nil
	}
	return nil, nil
}

// projectInputsMatch — animaticProjectInputsMatch: снимок project_inputs содержит ровно строковые
// name и animatic_video текущего plan/project.json.
func projectInputsMatch(snapshot, project any) bool {
	name, nameOK := jscompat.Get(project, "name").(string)
	video, videoOK := jscompat.Get(project, "animatic_video").(string)
	object, ok := jscompat.AsObject(snapshot)
	if !jscompat.IsRecord(project) || !nameOK || !videoOK || !ok || object.Len() != 2 {
		return false
	}
	return jscompat.StrictEqual(object.Value("name"), name) && jscompat.StrictEqual(object.Value("animatic_video"), video)
}
