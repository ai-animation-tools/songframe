// Package animatic проверяет сборку аниматика plan/animatic/latest: собрана ли она, свежа ли по
// реестру сцен и фактическим входам и принята ли именно она в plan/production-status.json.
//
// Один разбор (inspect) даёт и вид страницы «Аниматик», и признаки built/fresh/approved статуса
// проекта; порядок проверок и ошибки (например, нестроковый путь в манифесте) зафиксированы
// эталоном testdata/golden/animatic-view, потому что такая ошибка прерывает и страницу, и
// computeStatus. Чтение не меняет файлов; хеши входов берутся из кэша filedigest. Запись —
// только SetStatus в plan/production-status.json; задание сборки — Service.Build.
package animatic

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/filedigest"
)

// fps — кадровая сетка приложения.
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
	return "MP4 сборки не найден: " + dynvalue.ToString(dynvalue.Coalesce(filename, "имя не записано")) + ". Соберите аниматик заново."
}
func inputHashMissing(name string) string {
	return "Нет сохранённого хеша входа " + name + ": пересоберите аниматик для проверки свежести."
}
func inputChanged(name string) string {
	return "Вход аниматика изменён или отсутствует: " + name + ". Нужна пересборка."
}
func shotInputMissing(shot any) string {
	return dynvalue.ToString(shot) + ": в манифесте нет входного файла; нужна пересборка."
}
func acceptedEditChanged(shot any) string {
	return dynvalue.ToString(shot) + ": выбранный принятый монтаж изменился после сборки; нужна пересборка."
}
func acceptedEditAdded(shot any) string {
	return dynvalue.ToString(shot) + ": вместо карточки появился принятый монтаж; нужна пересборка."
}
func keyframesChanged(shot any) string {
	return dynvalue.ToString(shot) + ": выбор принятых опор изменился после сборки; нужна пересборка."
}
func keyframeSourcesMissing(shot any) string {
	return dynvalue.ToString(shot) + ": нет сведений об исходных опорах старой сборки; пересоберите аниматик."
}
func referencePathMissing(shot, id any) string {
	return dynvalue.ToString(shot) + ": нет пути референса " + dynvalue.ToString(id) + "; нужна пересборка."
}

// State — признаки сборки для статуса проекта и страницы аниматика.
type State struct {
	// Built — манифест сборки читается и содержит массив shots.
	Built bool
	// Fresh — сборка соответствует текущим байтам scenes.json, MP4 на месте и все входы совпадают.
	Fresh bool
	// Approved — принята именно эта свежая сборка (approval.current).
	Approved bool
	// ApprovalStatus — approved, review или none из current_animatic_status.
	ApprovalStatus string
	// CardsFresh — квитанция карточек построена по текущему реестру.
	CardsFresh bool
	// Problems — проблемы сборки в порядке проверок, зафиксированном эталоном.
	Problems []string
}

// readJSON читает JSON-файл; при любой ошибке возвращает nil.
func readJSON(path string) any {
	value, _ := dynvalue.ReadJSONFile(path)
	return value
}

// Inspect возвращает признаки и проблемы сборки для статуса проекта. Это тот же разбор, что и
// ViewAnimatic (inspect в view.go); ошибка означает повреждённые данные сборки или реестра.
func Inspect(project string) (State, error) {
	_, state, err := inspect(project)
	return state, err
}

// projectPath — путь входа внутри проекта или "" для абсолютного и выходящего за проект.
func projectPath(project string, name any) (string, error) {
	text, err := dynvalue.PathArg("paths[1]", name)
	if err != nil {
		return "", err
	}
	path := dynvalue.Resolve(project, text)
	local := dynvalue.Relative(project, path)
	if dynvalue.IsAbs(text) || local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) {
		return "", nil
	}
	return path, nil
}

// digestOf — кэшированный SHA-256 файла (filedigest.File) как значение JSON: строка или null.
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
func inputProblems(project string, manifest *dynvalue.Object) ([]string, error) {
	var problems []string
	sources := dynvalue.Coalesce(manifest.Value("source_hashes"), dynvalue.NewObject())
	check := func(name, digest any) error {
		path, err := projectPath(project, name)
		if err != nil {
			return err
		}
		text, isString := digest.(string)
		label := dynvalue.ToString(name)
		if !isString || !sha256Pattern.MatchString(text) {
			problems = append(problems, inputHashMissing(label))
		} else if path == "" || !dynvalue.StrictEqual(digestOf(path), text) {
			problems = append(problems, inputChanged(label))
		}
		return nil
	}
	in := func(key any) (bool, error) { return dynvalue.HasProperty(sources, key) }
	currentProject := readJSON(filepath.Join(project, "plan", "project.json"))
	if !manifest.Has("project_inputs") {
		problems = append(problems, projectInputsMissing)
	} else if !projectInputsMatch(manifest.Value("project_inputs"), currentProject) {
		problems = append(problems, projectInputsChanged)
	}
	entries, err := dynvalue.Entries(sources)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if err := check(entry.Key, entry.Value); err != nil {
			return nil, err
		}
	}
	audio := manifest.Value("source_audio")
	name := dynvalue.Coalesce(audio, "source/track.mp3")
	found, err := in(name)
	if err != nil {
		return nil, err
	}
	if !found {
		var digest any = dynvalue.Undefined
		if dynvalue.StrictEqual(name, audio) {
			digest = manifest.Value("source_audio_sha256")
		}
		if err := check(name, digest); err != nil {
			return nil, err
		}
	}
	receipt := readJSON(filepath.Join(project, "plan", "animatic", "cards", "manifest.json"))
	registry := readJSON(filepath.Join(project, "plan", "scenes.json"))
	shots, _ := dynvalue.AsArray(manifest.Value("shots"))
	for _, shot := range shots {
		shotID := dynvalue.Get(shot, "id")
		path := dynvalue.Get(shot, "path")
		if !dynvalue.Truthy(path) {
			problems = append(problems, shotInputMissing(shotID))
			continue
		}
		if found, err := in(path); err != nil {
			return nil, err
		} else if !found {
			if err := check(path, dynvalue.Get(shot, "sha256")); err != nil {
				return nil, err
			}
		}
		last := dynvalue.Get(shot, "path_last")
		if dynvalue.Truthy(last) {
			if found, err := in(last); err != nil {
				return nil, err
			} else if !found {
				if err := check(last, dynvalue.Get(shot, "sha256_last")); err != nil {
					return nil, err
				}
			}
		}
		id, err := dynvalue.PathArg("path", shotID)
		if err != nil {
			return nil, err
		}
		assetPath := filepath.Join(project, "assets", "shots", id, "manifest.json")
		asset := readJSON(assetPath)
		if dynvalue.StrictEqual(dynvalue.Get(shot, "media"), "video") {
			edit := dynvalue.Get(asset, "accepted_edit")
			var selected any = nil
			if videoPath := dynvalue.GetPath(edit, "video", "path"); dynvalue.Truthy(videoPath) {
				text, err := dynvalue.PathArg("paths[1]", videoPath)
				if err != nil {
					return nil, err
				}
				selected = toSlash(dynvalue.Relative(project, dynvalue.Resolve(filepath.Dir(assetPath), text)))
			}
			expected := dynvalue.Coalesce(dynvalue.GetKey(sources, path), dynvalue.Get(shot, "sha256"))
			if !dynvalue.StrictEqual(dynvalue.Get(asset, "shot"), shotID) || !dynvalue.StrictEqual(selected, path) ||
				!dynvalue.StrictEqual(dynvalue.GetPath(edit, "video", "sha256"), expected) ||
				!dynvalue.StrictEqual(dynvalue.Get(edit, "fps"), fps) || !dynvalue.StrictEqual(dynvalue.Get(edit, "frames"), dynvalue.Get(shot, "frames")) {
				problems = append(problems, acceptedEditChanged(shotID))
			}
			continue
		}
		if dynvalue.Exists(assetPath) {
			problems = append(problems, acceptedEditAdded(shotID))
			continue
		}
		selectedFrames, err := selectFrames(project, id)
		if err != nil {
			return nil, err
		}
		entry := dynvalue.GetKey(dynvalue.Get(receipt, "cards"), shotID)
		receiptMatches := dynvalue.StrictEqual(dynvalue.Get(receipt, "registry_sha256"), manifest.Value("scene_registry_sha256")) &&
			dynvalue.StrictEqual(dynvalue.Get(entry, "sha256"), dynvalue.Coalesce(dynvalue.GetKey(sources, path), dynvalue.Get(shot, "sha256"))) &&
			(!dynvalue.Truthy(last) || dynvalue.StrictEqual(dynvalue.GetPath(entry, "last", "sha256"),
				dynvalue.Coalesce(dynvalue.GetKey(sources, last), dynvalue.Get(shot, "sha256_last"))))
		var fromReceipt any = dynvalue.Undefined
		if receiptMatches {
			fromReceipt = dynvalue.Get(entry, "keyframes")
		}
		recorded := dynvalue.Coalesce(dynvalue.Coalesce(dynvalue.Get(shot, "keyframes"), fromReceipt), nil)
		left, err := normalizeFrames(selectedFrames)
		if err != nil {
			return nil, err
		}
		right, err := normalizeFrames(recorded)
		if err != nil {
			return nil, err
		}
		if dynvalue.Stringify(left) != dynvalue.Stringify(right) {
			problems = append(problems, keyframesChanged(shotID))
		}
		if dynvalue.StrictEqual(dynvalue.Get(shot, "media"), "keyframes") && !dynvalue.Truthy(recorded) {
			problems = append(problems, keyframeSourcesMissing(shotID))
		}
		frames, _ := dynvalue.AsArray(recorded)
		for _, frame := range frames {
			framePath := dynvalue.Get(frame, "path")
			found, err := in(framePath)
			if err != nil {
				return nil, err
			}
			if !found {
				if err := check(framePath, dynvalue.Get(frame, "sha256")); err != nil {
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
				name := dynvalue.Get(dynvalue.GetKey(dynvalue.Get(registry, "references"), id), "path")
				if !dynvalue.Truthy(name) {
					problems = append(problems, referencePathMissing(shotID, id))
					continue
				}
				found, err := in(name)
				if err != nil {
					return nil, err
				}
				if !found {
					var digest any = dynvalue.Undefined
					if receiptMatches {
						digest = dynvalue.GetKey(dynvalue.Get(receipt, "reference_hashes"), name)
					}
					if err := check(name, digest); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	if videoFile := manifest.Value("video_file"); dynvalue.Truthy(videoFile) {
		if err := check("plan/animatic/latest/"+dynvalue.ToString(videoFile), manifest.Value("video_sha256")); err != nil {
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
	list := dynvalue.Coalesce(dynvalue.Coalesce(dynvalue.Get(shot, "references"), dynvalue.Get(shot, "refs")), &dynvalue.Array{})
	items, err := dynvalue.Iterate(list)
	if err != nil {
		return nil, err
	}
	items = append(append([]any(nil), items...), dynvalue.GetPath(shot, "card", "primary_reference"))
	seen := map[any]bool{}
	var result []any
	for _, id := range items {
		if !dynvalue.Truthy(id) || dynvalue.StrictEqual(id, "—") || seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, id)
	}
	return result, nil
}

// normalizeFrames — сравнимый вид списка опор: поля id, role, time_seconds, path, sha256 в этом
// порядке; null остаётся null. Не-массив и пустой элемент списка — TypeError.
func normalizeFrames(frames any) (any, error) {
	if dynvalue.IsNullish(frames) {
		return nil, nil
	}
	items, ok := dynvalue.AsArray(frames)
	if !ok {
		return nil, &dynvalue.TypeError{Message: "frames: ожидается список"}
	}
	result := &dynvalue.Array{Items: make([]any, len(items))}
	for index, frame := range items {
		if dynvalue.IsNullish(frame) {
			if frame == nil {
				return nil, &dynvalue.TypeError{Message: "нет поля 'id': значение null"}
			}
			return nil, &dynvalue.TypeError{Message: "нет поля 'id': значение отсутствует"}
		}
		object := dynvalue.NewObject()
		for _, key := range []string{"id", "role", "time_seconds", "path", "sha256"} {
			object.Set(key, dynvalue.Get(frame, key))
		}
		result.Items[index] = object
	}
	return result, nil
}

// selectFrames выбирает опоры плана так же, как approved_keyframes в update_scene_views: первая
// подходящая очередь plan/awaiting/<план>, затем рабочие пакеты plan/batches в порядке имён.
// Подходит workflow этого плана, не принятый, со всеми утверждёнными и существующими опорами.
func selectFrames(project, shot string) (any, error) {
	batches := filepath.Join(project, "plan", "batches")
	candidates := []string{filepath.Join(project, "plan", "awaiting", shot, "workflow.json")}
	if dynvalue.Exists(batches) {
		entries, err := dynvalue.ReadDir(batches)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.SliceStable(names, func(i, j int) bool { return dynvalue.LessUTF16(names[i], names[j]) })
		for _, name := range names {
			candidates = append(candidates, filepath.Join(batches, name, "workflow.json"))
		}
	}
	for _, path := range candidates {
		workflow := readJSON(path)
		keyframes, isArray := dynvalue.AsArray(dynvalue.Get(workflow, "keyframes"))
		if !dynvalue.StrictEqual(dynvalue.Get(workflow, "shot"), shot) || dynvalue.StrictEqual(dynvalue.Get(workflow, "stage"), "accepted") ||
			!isArray || len(keyframes) == 0 {
			continue
		}
		approved := true
		for _, frame := range keyframes {
			if _, err := dynvalue.Prop(frame, "approved"); err != nil {
				return nil, err
			}
			if !dynvalue.Truthy(dynvalue.Get(frame, "approved")) || !dynvalue.Truthy(dynvalue.Get(frame, "path")) {
				approved = false
				break
			}
			text, err := dynvalue.PathArg("paths[1]", dynvalue.Get(frame, "path"))
			if err != nil {
				return nil, err
			}
			if digestOf(dynvalue.Resolve(filepath.Dir(path), text)) == nil {
				approved = false
				break
			}
		}
		if !approved {
			continue
		}
		result := &dynvalue.Array{}
		for _, frame := range keyframes {
			full := dynvalue.Resolve(filepath.Dir(path), dynvalue.Get(frame, "path").(string))
			object := dynvalue.NewObject()
			object.Set("id", dynvalue.Get(frame, "id"))
			object.Set("role", dynvalue.Get(frame, "role"))
			object.Set("time_seconds", dynvalue.Get(frame, "time_seconds"))
			object.Set("path", toSlash(dynvalue.Relative(project, full)))
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
	name, nameOK := dynvalue.Get(project, "name").(string)
	video, videoOK := dynvalue.Get(project, "animatic_video").(string)
	object, ok := dynvalue.AsObject(snapshot)
	if !dynvalue.IsRecord(project) || !nameOK || !videoOK || !ok || object.Len() != 2 {
		return false
	}
	return dynvalue.StrictEqual(object.Value("name"), name) && dynvalue.StrictEqual(object.Value("animatic_video"), video)
}
