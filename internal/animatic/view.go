package animatic

import (
	"errors"
	"math"
	"os"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
)

// Тексты ошибок принятия аниматика.
const (
	textBuildRequired      = "Нет собранного аниматика: сначала соберите его."
	textFreshBuildRequired = "Аниматик собран по устаревшему реестру или входам: пересоберите перед принятием."
)

// Пути статуса производства и манифеста сборки: относительные, через «/» для записи в
// production-status.
const (
	statusFile   = "plan/production-status.json"
	manifestFile = "plan/animatic/latest/manifest.json"
)

// View — AnimaticView контракта (frontend/src/shared/types.ts): сборка latest, её планы для
// плеера, принятие, свежесть карточек и проблемы. BlockedReason заполняет сервис приложения,
// когда сценарий нужно утвердить заново.
type View struct {
	Built         *Built   `json:"built"`
	Shots         []Shot   `json:"shots"`
	Approval      Approval `json:"approval"`
	CardsFresh    bool     `json:"cardsFresh"`
	Problems      []string `json:"problems"`
	BlockedReason *string  `json:"blockedReason,omitempty"`
	// videoSha — manifest.video_sha256 как есть (отсутствие — null): SetStatus проверяет его истинность и
	// записывает без преобразования (в DTO уходит строковый VideoSha256).
	videoSha any
}

// Built — сведения о собранном аниматике. Пути абсолютные (текущий сеанс, не формат хранения).
type Built struct {
	VideoPath    *string `json:"videoPath"`
	ManifestPath string  `json:"manifestPath"`
	VideoSha256  *string `json:"videoSha256"`
	Duration     float64 `json:"duration"`
	TotalFrames  float64 `json:"totalFrames"`
	// BuiltAt — время изменения манифеста в ISO 8601 (UTC, миллисекунды, суффикс Z).
	BuiltAt string `json:"builtAt"`
	// Fresh — сборка сделана по текущему plan/scenes.json и фактическим входам.
	Fresh  bool   `json:"fresh"`
	Counts Counts `json:"counts"`
}

// Counts — число планов по виду входа.
type Counts struct {
	Video     int `json:"video"`
	Cards     int `json:"cards"`
	Keyframes int `json:"keyframes"`
}

// Shot — AnimaticShot: план собранного аниматика (глава плеера) с путями карточек.
type Shot struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	Original      string  `json:"original"`
	Sequence      string  `json:"sequence"`
	SequenceTitle string  `json:"sequenceTitle"`
	Start         float64 `json:"start"`
	End           float64 `json:"end"`
	Frames        float64 `json:"frames"`
	Action        string  `json:"action"`
	Camera        string  `json:"camera"`
	Lipsync       bool    `json:"lipsync"`
	Media         string  `json:"media"`
	// CardPath — абсолютный путь карточки для планов без клипа.
	CardPath     *string `json:"cardPath"`
	LastCardPath *string `json:"lastCardPath"`
}

// Approval — AnimaticApproval: решение пользователя и принята ли именно текущая сборка.
type Approval struct {
	Status         string  `json:"status"`
	ApprovedSha256 *string `json:"approvedSha256"`
	Current        bool    `json:"current"`
}

// text — строковое поле DTO из значения манифеста. Контракт строгий: повреждённый манифест не
// должен передать в renderer число или отсутствующее значение, поэтому null и отсутствие дают
// «», остальные значения — их строковый вид dynvalue.ToString.
func text(value any) string {
	if dynvalue.IsNullish(value) {
		return ""
	}
	return dynvalue.ToString(value)
}

// textPointer — строковое поле string | null контракта.
func textPointer(value any) *string {
	if dynvalue.IsNullish(value) {
		return nil
	}
	result := dynvalue.ToString(value)
	return &result
}

// number — числовое значение поля (dynvalue.ToNumber, отсутствие и null — 0). JSON Wails не
// переносит NaN и бесконечности, поэтому для повреждённого значения отдаётся 0.
func number(value any) float64 {
	result := dynvalue.ToNumber(dynvalue.Coalesce(value, 0.0))
	if math.IsNaN(result) || math.IsInf(result, 0) {
		return 0
	}
	return result
}

// readStatus читает production-status.json или возвращает значения по умолчанию.
func readStatus(project string) any {
	status := readJSON(filepath.Join(project, filepath.FromSlash(statusFile)))
	if status == nil {
		defaults := dynvalue.NewObject()
		defaults.Set("schema_version", 1.0)
		defaults.Set("current_animatic", nil)
		defaults.Set("current_animatic_status", "none")
		status = defaults
	}
	return status
}

// ViewAnimatic читает latest, проверяет свежесть по реестру и фактическим входам
// (inputProblems), собирает список планов для плеера и состояние принятия. Ничего не пишет;
// ошибка — повреждённый манифест (например, план null или нестроковый путь карточки).
func ViewAnimatic(project string) (View, error) {
	result, _, err := inspect(project)
	return result, err
}

// inspect — общая часть View и Inspect: вид для страницы и признаки для статуса проекта.
func inspect(project string) (View, State, error) {
	view := View{Shots: []Shot{}, Problems: []string{}}
	state := State{}
	manifestPath := filepath.Join(project, "plan", "animatic", "latest", "manifest.json")
	manifest := readJSON(manifestPath)
	registry, hasRegistry := digestText(filepath.Join(project, "plan", "scenes.json"))
	status := readStatus(project)
	cards := readJSON(filepath.Join(project, "plan", "animatic", "cards", "manifest.json"))
	view.CardsFresh = dynvalue.Truthy(cards) && hasRegistry && dynvalue.StrictEqual(dynvalue.Get(cards, "registry_sha256"), registry)
	if !hasRegistry {
		view.Problems = append(view.Problems, scenarioRequired)
	}
	var videoSha any = nil
	fresh := false
	if shots, ok := dynvalue.AsArray(dynvalue.Get(manifest, "shots")); ok && dynvalue.Truthy(manifest) {
		videoFile := dynvalue.Get(manifest, "video_file")
		var videoPath *string
		if dynvalue.Truthy(videoFile) {
			name, err := dynvalue.PathArg("path", videoFile)
			if err != nil {
				return View{}, State{}, err
			}
			path := filepath.Join(project, "plan", "animatic", "latest", name)
			if dynvalue.Exists(path) {
				videoPath = &path
			}
		}
		if videoPath == nil {
			view.Problems = append(view.Problems, videoMissing(videoFile))
		}
		list, err := shotList(project, shots)
		if err != nil {
			return View{}, State{}, err
		}
		view.Shots = list
		inputs, err := inputProblems(project, manifest.(*dynvalue.Object))
		if err != nil {
			return View{}, State{}, err
		}
		view.Problems = append(view.Problems, inputs...)
		info, err := os.Stat(manifestPath)
		if err != nil {
			return View{}, State{}, dynvalue.FsError("stat", manifestPath, err)
		}
		sceneRegistry := dynvalue.Get(manifest, "scene_registry_sha256")
		fresh = hasRegistry && dynvalue.StrictEqual(sceneRegistry, registry) && videoPath != nil && len(inputs) == 0
		videoSha = dynvalue.Coalesce(dynvalue.Get(manifest, "video_sha256"), nil)
		built := &Built{
			VideoPath: videoPath, ManifestPath: manifestPath, VideoSha256: textPointer(videoSha),
			Duration: number(dynvalue.Get(manifest, "video_duration")), TotalFrames: number(dynvalue.Get(manifest, "total_frames")),
			BuiltAt: info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z"), Fresh: fresh,
		}
		for _, shot := range list {
			switch shot.Media {
			case "video":
				built.Counts.Video++
			case "card":
				built.Counts.Cards++
			case "keyframes":
				built.Counts.Keyframes++
			}
		}
		view.Built = built
		view.videoSha = videoSha
		state.Built = true
		if !hasRegistry || !dynvalue.StrictEqual(sceneRegistry, registry) {
			view.Problems = append(view.Problems, registryChanged)
		}
	} else if dynvalue.Exists(manifestPath) {
		view.Problems = append(view.Problems, manifestCorrupt)
	}
	current := dynvalue.Get(status, "current_animatic_status")
	switch {
	case dynvalue.StrictEqual(current, "approved"):
		view.Approval.Status = "approved"
	case dynvalue.StrictEqual(current, "review"):
		view.Approval.Status = "review"
	default:
		view.Approval.Status = "none"
	}
	approvedSha := dynvalue.Coalesce(dynvalue.GetPath(status, "approved_animatic", "video_sha256"), nil)
	view.Approval.ApprovedSha256 = textPointer(approvedSha)
	// Принята именно свежая сборка: прежнее согласование остаётся в истории после изменения входов.
	view.Approval.Current = view.Approval.Status == "approved" && fresh && dynvalue.Truthy(videoSha) && dynvalue.StrictEqual(approvedSha, videoSha)
	state.Fresh = fresh
	state.Approved = view.Approval.Current
	state.ApprovalStatus = view.Approval.Status
	state.CardsFresh = view.CardsFresh
	state.Problems = view.Problems
	return view, state, nil
}

// digestText — cachedFileDigest реестра как (строка, есть ли файл).
func digestText(path string) (string, bool) {
	digest := digestOf(path)
	text, ok := digest.(string)
	return text, ok
}

// shotList — планы манифеста для плеера: значения по умолчанию, числа через Number и
// абсолютные пути карточек. Ошибки — обращение к id у null и нестроковый путь карточки.
func shotList(project string, shots []any) ([]Shot, error) {
	result := make([]Shot, 0, len(shots))
	for _, item := range shots {
		id, err := dynvalue.Prop(item, "id")
		if err != nil {
			return nil, err
		}
		media := dynvalue.Get(item, "media")
		shot := Shot{
			ID: text(id), Title: text(dynvalue.Coalesce(dynvalue.Get(item, "title"), id)),
			Original: text(dynvalue.Get(item, "original")), Sequence: text(dynvalue.Get(item, "sequence")),
			SequenceTitle: text(dynvalue.Get(item, "sequence_title")),
			Start:         number(dynvalue.Get(item, "start")), End: number(dynvalue.Get(item, "end")),
			Frames: number(dynvalue.Get(item, "frames")), Action: text(dynvalue.Get(item, "action")),
			Camera: text(dynvalue.Get(item, "camera")), Lipsync: dynvalue.Truthy(dynvalue.Get(item, "lipsync")),
			Media: text(dynvalue.Coalesce(media, "card")),
		}
		if path := dynvalue.Get(item, "path"); !dynvalue.StrictEqual(media, "video") && dynvalue.Truthy(path) {
			name, err := dynvalue.PathArg("path", path)
			if err != nil {
				return nil, err
			}
			card := filepath.Join(project, name)
			shot.CardPath = &card
		}
		if last := dynvalue.Get(item, "path_last"); dynvalue.StrictEqual(media, "keyframes") && dynvalue.Truthy(last) {
			name, err := dynvalue.PathArg("path", last)
			if err != nil {
				return nil, err
			}
			card := filepath.Join(project, name)
			shot.LastCardPath = &card
		}
		result = append(result, shot)
	}
	return result, nil
}

// SetStatus принимает текущую сборку (approved) или возвращает её на просмотр (иное значение,
// в контракте — review). Принять можно только собранную и свежую сборку; прочие поля
// production-status.json сохраняются в прежнем порядке ключей, approved_animatic пишется при
// принятии и удаляется при возврате. Запись атомарна и проходит шлюз записи проекта.
// Возвращает вид после записи.
func SetStatus(project, status string) (View, error) {
	view, err := ViewAnimatic(project)
	if err != nil {
		return View{}, err
	}
	if view.Built == nil || view.Built.VideoPath == nil || !dynvalue.Truthy(view.videoSha) {
		return View{}, errors.New(textBuildRequired)
	}
	if status == "approved" && !view.Built.Fresh {
		return View{}, errors.New(textFreshBuildRequired)
	}
	data := readStatus(project)
	manifest := readJSON(filepath.Join(project, filepath.FromSlash(manifestFile)))
	next := dynvalue.Spread(data)
	next.Set("current_animatic", manifestFile)
	next.Set("current_animatic_status", status)
	if status == "approved" {
		approved := dynvalue.NewObject()
		approved.Set("manifest", manifestFile)
		approved.Set("video", "plan/animatic/latest/"+dynvalue.ToString(dynvalue.Coalesce(dynvalue.Get(manifest, "video_file"), "")))
		approved.Set("video_sha256", view.videoSha)
		next.Set("approved_animatic", approved)
	} else {
		next.Delete("approved_animatic")
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return View{}, err
	}
	path := filepath.Join(project, filepath.FromSlash(statusFile))
	perm := os.FileMode(0o666)
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	if err := projectfs.WriteFile(path, []byte(dynvalue.StringifyIndent(next, "  ")+"\n"), perm); err != nil {
		return View{}, err
	}
	return ViewAnimatic(project)
}
