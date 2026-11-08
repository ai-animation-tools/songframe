package montage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/timing"
)

// Scene — MontageScene: план реестра с окном на абсолютной кадровой оси песни.
type Scene struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	StartFrame float64 `json:"startFrame"`
	EndFrame   float64 `json:"endFrame"`
}

// Source — MontageSource: видео или карточка сцены, которые можно положить на дорожку. Path —
// от корня проекта; Frames — известная длина в кадрах 30 к/с или null.
type Source struct {
	ID       string   `json:"id"`
	Scene    string   `json:"scene"`
	Title    string   `json:"title"`
	Label    string   `json:"label"`
	Path     string   `json:"path"`
	Kind     string   `json:"kind"`
	Frames   *float64 `json:"frames"`
	Original bool     `json:"original"`
	// Attempt — скачанный результат рабочего пакета, ещё не принятый в assets (поле есть только
	// у таких источников).
	Attempt bool `json:"attempt,omitempty"`
}

// Saved — MontageSaved: сохранённый черновик plan/montage/<uuid>.json.
type Saved struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	UpdatedAt string `json:"updatedAt"`
}

// LyricLine — MontageLyricLine: строка песни на кадровой оси трека. ID — id строки разметки как
// есть (число в принятом формате; тип не проверяется).
type LyricLine struct {
	ID         json.RawMessage `json:"id"`
	Text       string          `json:"text"`
	StartFrame float64         `json:"startFrame"`
	EndFrame   float64         `json:"endFrame"`
}

// View — MontageView: всё, что нужно странице монтажа. ManifestSha256 — объект «сцена → SHA-256
// манифеста» в порядке сцен реестра, поэтому отдаётся сырым JSON.
type View struct {
	ScenarioStatus string          `json:"scenarioStatus"`
	TrackPath      *string         `json:"trackPath"`
	TrackSha256    *string         `json:"trackSha256"`
	Duration       *float64        `json:"duration"`
	LyricLines     []LyricLine     `json:"lyricLines"`
	LyricProblem   *string         `json:"lyricProblem"`
	Scenes         []Scene         `json:"scenes"`
	Sources        []Source        `json:"sources"`
	ScenesSha256   string          `json:"scenesSha256"`
	ManifestSha256 json.RawMessage `json:"manifestSha256"`
	Saved          []Saved         `json:"saved"`
	Problems       []string        `json:"problems"`

	// manifests — те же снимки для проверок Apply.
	manifests map[string]string
}

// registry — чтение реестра сцен: статус, реестр и SHA-256 тех же байтов (повторное чтение могло
// бы захватить другую версию).
type registry struct {
	status string
	value  *jscompat.Object
	scenes []*jscompat.Object
	sha256 string
}

// readRegistry — чтение реестра сцен проекта: общий контракт реестра (версия 1, fps 30, коды и
// кадровые окна планов). Отсутствующий файл — missing, ошибка чтения и неверная структура — invalid.
func readRegistry(project string) registry {
	raw, err := os.ReadFile(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return registry{status: "missing"}
		}
		return registry{status: "invalid"}
	}
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(raw)))
	object, ok := jscompat.AsObject(value)
	if err != nil || !ok || !jscompat.StrictEqual(object.Value("schema_version"), 1.0) || !jscompat.StrictEqual(object.Value("fps"), float64(fps)) {
		return registry{status: "invalid"}
	}
	items, ok := jscompat.AsArray(object.Value("scenes"))
	if !ok {
		return registry{status: "invalid"}
	}
	ids := map[string]bool{}
	scenes := []*jscompat.Object{}
	for _, item := range items {
		scene, ok := jscompat.AsObject(item)
		if !ok {
			return registry{status: "invalid"}
		}
		id, isString := scene.Value("id").(string)
		if !isString || !shotPattern.MatchString(id) || ids[id] {
			return registry{status: "invalid"}
		}
		start, end := scene.Value("start_frame"), scene.Value("end_frame_exclusive")
		if !isFrame(start) || !isFrame(end) || end.(float64) <= start.(float64) {
			return registry{status: "invalid"}
		}
		ids[id] = true
		scenes = append(scenes, scene)
	}
	sum := sha256.Sum256(raw)
	status := "empty"
	if len(scenes) > 0 {
		status = "ready"
	}
	return registry{status: status, value: object, scenes: scenes, sha256: hex.EncodeToString(sum[:])}
}

// originalFrames — длина оригинала видео (original_media) в кадрах 30 к/с по duration,
// иначе по nb_frames и r_frame_rate ffprobe; неизвестная — nil.
func originalFrames(value any) *float64 {
	media, ok := jscompat.AsObject(value)
	if !ok {
		return nil
	}
	if duration := jscompat.ToNumber(media.Value("duration")); jscompat.IsFinite(duration) && duration > 0 {
		frames := secondsToFrames(duration)
		return &frames
	}
	rate := []float64{}
	if text, ok := media.Value("r_frame_rate").(string); ok {
		for _, part := range strings.Split(text, "/") {
			rate = append(rate, jscompat.ToNumber(part))
		}
	}
	speed := jscompat.ToNumber(jscompat.Undefined)
	if len(rate) == 1 {
		speed = rate[0]
	} else if len(rate) == 2 && rate[1] > 0 {
		speed = rate[0] / rate[1]
	}
	count := jscompat.ToNumber(media.Value("nb_frames"))
	if jscompat.IsFinite(speed) && speed > 0 && jscompat.IsFinite(count) && count > 0 {
		frames := secondsToFrames(count / speed)
		return &frames
	}
	return nil
}

// attemptVideo и originalVideo — имена видео попытки: скачанные *.mp4 и original(-N).mp4.
var (
	attemptVideo  = regexp.MustCompile(`(?i)\.mp4$`)
	originalVideo = regexp.MustCompile(`(?i)^original(?:-\d+)?\.mp4$`)
)

// ViewProject собирает каталог монтажа. Читает только небольшие JSON и метаданные
// файлов: инструменты и FFmpeg не запускаются, байты видеороликов не перечитываются (полные платные
// оригиналы не хешируются). Сценарий без готового реестра останавливает каталог до музыки и
// материалов; ошибки отдельных комплектов, пакетов и черновиков становятся problems. Ошибка —
// только сбой чтения самого проекта (например, каталог пакетов оказался файлом).
func ViewProject(project string) (*View, error) {
	view := &View{
		ScenarioStatus: "missing", LyricLines: []LyricLine{}, Scenes: []Scene{}, Sources: []Source{},
		ManifestSha256: json.RawMessage("{}"), Saved: []Saved{}, Problems: []string{}, manifests: map[string]string{},
	}
	scenario := readRegistry(project)
	view.ScenarioStatus = scenario.status
	switch {
	case scenario.status == "missing":
		view.Problems = append(view.Problems, textScenarioRequired)
		return view, nil
	case scenario.status == "empty":
		view.Problems = append(view.Problems, textEmptyScenario)
		return view, nil
	case scenario.status == "invalid" || scenario.value == nil:
		view.Problems = append(view.Problems, textInvalidScenario)
		return view, nil
	}
	// new Map(sequences.map((s) => [s.id, s.title])): более поздний id заменяет значение.
	sequences := map[string]any{}
	if items, ok := jscompat.AsArray(scenario.value.Value("sequences")); ok {
		for _, item := range items {
			if sequence, ok := jscompat.AsObject(item); ok {
				if key, ok := mapKey(sequence.Value("id")); ok {
					sequences[key] = sequence.Value("title")
				}
			}
		}
	}
	view.ScenesSha256 = scenario.sha256
	for _, scene := range scenario.scenes {
		id := scene.Value("id").(string)
		title := scene.Value("title")
		if jscompat.IsNullish(title) {
			title = jscompat.Undefined
			if key, ok := mapKey(scene.Value("sequence")); ok {
				if value, found := sequences[key]; found {
					title = value
				}
			}
		}
		title = jscompat.Coalesce(jscompat.Coalesce(title, scene.Value("original")), id)
		view.Scenes = append(view.Scenes, Scene{
			ID: id, Title: jscompat.ToString(title),
			StartFrame: scene.Value("start_frame").(float64), EndFrame: scene.Value("end_frame_exclusive").(float64),
		})
	}
	if err := viewLyrics(project, view); err != nil {
		return nil, err
	}
	manifests := jscompat.NewObject()
	addSource := func(scene, title, label, dir string, descriptor any, frames *float64, original, attempt bool) {
		object, ok := jscompat.AsObject(descriptor)
		if !ok {
			return
		}
		name, ok := object.Value("path").(string)
		if !ok {
			return
		}
		base := dir
		if jscompat.StrictEqual(object.Value("root"), "source") {
			base = filepath.Join(project, "source")
		}
		path := portable(project, join(base, name))
		if _, err := projectPath(project, path, true); err != nil {
			view.Problems = append(view.Problems, scene+": "+err.Error())
			return
		}
		for _, source := range view.Sources {
			if source.Scene == scene && source.Path == path {
				return
			}
		}
		view.Sources = append(view.Sources, Source{
			ID: scene + ":" + path, Scene: scene, Title: title, Label: label, Path: path, Kind: "video",
			Frames: frames, Original: original, Attempt: attempt,
		})
	}
	for _, scene := range view.Scenes {
		dir := filepath.Join(project, "assets", "shots", scene.ID)
		manifestPath := filepath.Join(dir, "manifest.json")
		if !jscompat.Exists(manifestPath) {
			continue
		}
		// Ошибка отдельного комплекта не меняет доступность самого сценария.
		err := func() error {
			digest, err := fileHash(manifestPath)
			if err != nil {
				return err
			}
			manifests.Set(scene.ID, digest)
			view.manifests[scene.ID] = digest
			manifest, err := readObject(manifestPath, labelSceneMaterials)
			if err != nil {
				return err
			}
			generation, edit := section(manifest, "generation"), section(manifest, "accepted_edit")
			addSource(scene.ID, scene.Title, textOriginal, dir, generation.Value("original"), originalFrames(generation.Value("original_media")), true, false)
			var frames *float64
			if value, ok := number(edit.Value("frames")); ok && isFrame(value) && value > 0 {
				frames = &value
			}
			addSource(scene.ID, scene.Title, textAccepted, dir, edit.Value("video"), frames, false, false)
			return nil
		}()
		if err != nil {
			view.Problems = append(view.Problems, scene.ID+": "+err.Error())
		}
	}
	view.ManifestSha256 = jscompat.Raw(manifests)

	// Не читаем пакет целиком: его токены решений хешируют полные платные оригиналы.
	for _, base := range []string{"plan/batches", "plan/awaiting"} {
		folder := filepath.Join(project, filepath.FromSlash(base))
		if !jscompat.Exists(folder) {
			continue
		}
		entries, err := jscompat.ReadDir(folder)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			dir := filepath.Join(folder, entry.Name())
			if !jscompat.Exists(filepath.Join(dir, "workflow.json")) {
				continue
			}
			if err := attemptSources(project, view, entry.Name(), dir, addSource); err != nil {
				view.Problems = append(view.Problems, entry.Name()+": "+err.Error())
			}
		}
	}
	for _, scene := range view.Scenes {
		found := false
		for _, source := range view.Sources {
			found = found || source.Scene == scene.ID
		}
		if found {
			continue
		}
		path := "plan/animatic/cards/" + scene.ID + ".png"
		if jscompat.Exists(filepath.Join(project, filepath.FromSlash(path))) {
			view.Sources = append(view.Sources, Source{
				ID: scene.ID + ":" + path, Scene: scene.ID, Title: scene.Title, Label: textSceneCard, Path: path, Kind: "card",
			})
		} else {
			view.Problems = append(view.Problems, textSceneMediaMissing(scene.ID, path))
		}
	}
	folder := filepath.Join(project, "plan", "montage")
	if jscompat.Exists(folder) {
		entries, err := jscompat.ReadDir(folder)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			file := entry.Name()
			if !strings.HasSuffix(file, ".json") || !uuidPattern.MatchString(strings.TrimSuffix(file, ".json")) {
				continue
			}
			id := strings.TrimSuffix(file, ".json")
			draft, err := Load(project, id)
			if err == nil {
				var info os.FileInfo
				if info, err = os.Stat(filepath.Join(folder, file)); err == nil {
					view.Saved = append(view.Saved, Saved{ID: id, Name: jscompat.Get(draft, "name").(string), UpdatedAt: isoTime(info)})
					continue
				}
				err = jscompat.FsError("stat", filepath.Join(folder, file), err)
			}
			view.Problems = append(view.Problems, textDraftReadFailed(file, err.Error()))
		}
		sort.SliceStable(view.Saved, func(a, b int) bool { return view.Saved[a].UpdatedAt > view.Saved[b].UpdatedAt })
	}
	return view, nil
}

// mapKey — ключ Map по SameValueZero для примитивов; объекты и массивы из разных мест JSON
// никогда не совпадают (ok=false).
func mapKey(value any) (string, bool) {
	switch item := value.(type) {
	case string:
		return "s" + item, true
	case float64:
		return "n" + jscompat.NumberToString(item), true
	case bool:
		return "b" + jscompat.ToString(item), true
	case nil:
		return "null", true
	}
	if value == jscompat.Undefined {
		return "undefined", true
	}
	return "", false
}

// section — `object(manifest.key) ? manifest.key : {}`.
func section(manifest *jscompat.Object, key string) *jscompat.Object {
	if object, ok := jscompat.AsObject(manifest.Value(key)); ok {
		return object
	}
	return jscompat.NewObject()
}

// attemptSources — видео одной папки рабочего пакета или очереди: скачанные MP4 из attempt.json и
// файлы original(-N).mp4 папки запроса. Пакет изображения пропускается. Ошибка чтения workflow,
// запроса или попытки возвращается и становится проблемой с именем папки.
func attemptSources(project string, view *View, name, dir string, addSource func(string, string, string, string, any, *float64, bool, bool)) error {
	workflow, err := readObject(filepath.Join(dir, "workflow.json"), labelWorkflow)
	if err != nil {
		return err
	}
	var scene *Scene
	for index := range view.Scenes {
		if jscompat.StrictEqual(view.Scenes[index].ID, workflow.Value("shot")) {
			scene = &view.Scenes[index]
			break
		}
	}
	requestName, ok := workflow.Value("request_dir").(string)
	if scene == nil || !ok {
		return nil
	}
	requestDir, err := projectPath(project, portable(project, join(dir, requestName)), false)
	if err != nil {
		return err
	}
	request, err := readObject(filepath.Join(requestDir, "request.json"), labelRequest)
	if err != nil {
		return err
	}
	if jscompat.StrictEqual(request.Value("kind"), "image") {
		return nil
	}
	attempt := jscompat.NewObject()
	if attemptPath := filepath.Join(requestDir, "attempt.json"); jscompat.Exists(attemptPath) {
		if attempt, err = readObject(attemptPath, labelAttempt); err != nil {
			return err
		}
	}
	downloads := []string{}
	if items, ok := jscompat.AsArray(attempt.Value("downloads")); ok {
		for _, item := range items {
			if object, ok := jscompat.AsObject(item); ok {
				if path, ok := object.Value("path").(string); ok && attemptVideo.MatchString(path) {
					downloads = append(downloads, path)
				}
			}
		}
	}
	entries, err := os.ReadDir(requestDir)
	if err != nil {
		return jscompat.FsError("scandir", requestDir, err)
	}
	for _, entry := range entries {
		if originalVideo.MatchString(entry.Name()) {
			downloads = append(downloads, entry.Name())
		}
	}
	seen := map[string]bool{}
	for _, file := range downloads {
		if seen[file] {
			continue
		}
		seen[file] = true
		descriptor := jscompat.NewObject()
		descriptor.Set("path", file)
		addSource(scene.ID, scene.Title, textAttemptSource(name), requestDir, descriptor, nil, true, true)
	}
	return nil
}

// viewLyrics заполняет музыку и строки песни: трек и проблемы viewTiming, затем строки разметки,
// которые соответствуют тексту, на кадровой оси 30 к/с, либо причину недоступности строк.
func viewLyrics(project string, view *View) error {
	timingView, err := timing.ViewProject(project)
	if err != nil {
		return err
	}
	if timingView.TrackPath != nil {
		path := portable(project, *timingView.TrackPath)
		view.TrackPath = &path
	}
	view.TrackSha256 = timingView.TrackSha256
	view.Duration = timingView.Duration
	view.Problems = append(view.Problems, timingView.Problems...)
	saved, err := jscompat.Parse(timingView.Timing)
	if err != nil {
		return err
	}
	problem := func(text string) { view.LyricProblem = &text }
	sha, track := jscompat.Get(saved, "sha256"), timingView.TrackSha256
	switch {
	case !jscompat.Truthy(saved):
		problem(textLyricTimingMissing)
	case jscompat.Truthy(sha) && track != nil && *track != "" && !jscompat.StrictEqual(sha, *track):
		problem(textLyricTrackChanged)
	default:
		numbers := map[float64]bool{}
		texts := map[float64]string{}
		for _, line := range timingView.Lyrics {
			texts[float64(line.Number)] = line.Text
			if line.Text != "" && !line.Header {
				numbers[float64(line.Number)] = true
			}
		}
		lines, _ := jscompat.AsArray(jscompat.Get(saved, "lines"))
		selected := []any{}
		invalid := false
		for _, line := range lines {
			source, ok := number(jscompat.Get(line, "source_line"))
			if ok && numbers[source] {
				selected = append(selected, line)
			} else {
				invalid = true
			}
		}
		for _, line := range selected {
			start, startOK := number(jscompat.Get(line, "start"))
			end, endOK := number(jscompat.Get(line, "end"))
			if !startOK || !endOK || !jscompat.IsFinite(start) || !jscompat.IsFinite(end) || start < 0 || end <= start {
				invalid = true
			}
		}
		if invalid {
			problem(textLyricTimingInvalid)
			break
		}
		// Строки и склейки используют одну сетку 30 к/с и абсолютную ось исходного трека.
		for _, line := range selected {
			source, _ := number(jscompat.Get(line, "source_line"))
			start, _ := number(jscompat.Get(line, "start"))
			end, _ := number(jscompat.Get(line, "end"))
			view.LyricLines = append(view.LyricLines, LyricLine{
				ID: jscompat.Raw(jscompat.Get(line, "id")), Text: texts[source],
				StartFrame: secondsToFrames(start), EndFrame: secondsToFrames(end),
			})
		}
		if len(view.LyricLines) == 0 {
			problem(textLyricTimingEmpty)
		}
	}
	return nil
}
