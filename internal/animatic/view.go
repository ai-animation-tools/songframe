package animatic

import (
	"errors"
	"math"
	"os"
	"path/filepath"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
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
	// videoSha — manifest.video_sha256 ?? null как есть: SetStatus проверяет его истинность и
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
	// BuiltAt — время изменения манифеста, toISOString() (UTC, миллисекунды).
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

// text — строковое поле DTO из значения манифеста. Оригинал передавал значение как есть, и
// повреждённый манифест мог дать в renderer число или undefined; контракт Go строгий, поэтому
// nullish даёт «», остальные значения — String(value).
func text(value any) string {
	if jscompat.IsNullish(value) {
		return ""
	}
	return jscompat.ToString(value)
}

// textPointer — строковое поле string | null контракта.
func textPointer(value any) *string {
	if jscompat.IsNullish(value) {
		return nil
	}
	result := jscompat.ToString(value)
	return &result
}

// number — Number(value ?? 0). JSON Wails не переносит NaN и бесконечности, поэтому для
// повреждённого значения отдаётся 0.
func number(value any) float64 {
	result := jscompat.ToNumber(jscompat.Coalesce(value, 0.0))
	if math.IsNaN(result) || math.IsInf(result, 0) {
		return 0
	}
	return result
}

// readStatus читает production-status.json или возвращает значения по умолчанию.
func readStatus(project string) any {
	status := readJSON(filepath.Join(project, filepath.FromSlash(statusFile)))
	if status == nil {
		defaults := jscompat.NewObject()
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
	view.CardsFresh = jscompat.Truthy(cards) && hasRegistry && jscompat.StrictEqual(jscompat.Get(cards, "registry_sha256"), registry)
	if !hasRegistry {
		view.Problems = append(view.Problems, scenarioRequired)
	}
	var videoSha any = nil
	fresh := false
	if shots, ok := jscompat.AsArray(jscompat.Get(manifest, "shots")); ok && jscompat.Truthy(manifest) {
		videoFile := jscompat.Get(manifest, "video_file")
		var videoPath *string
		if jscompat.Truthy(videoFile) {
			name, err := jscompat.PathArg("path", videoFile)
			if err != nil {
				return View{}, State{}, err
			}
			path := filepath.Join(project, "plan", "animatic", "latest", name)
			if jscompat.Exists(path) {
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
		inputs, err := inputProblems(project, manifest.(*jscompat.Object))
		if err != nil {
			return View{}, State{}, err
		}
		view.Problems = append(view.Problems, inputs...)
		info, err := os.Stat(manifestPath)
		if err != nil {
			return View{}, State{}, jscompat.FsError("stat", manifestPath, err)
		}
		sceneRegistry := jscompat.Get(manifest, "scene_registry_sha256")
		fresh = hasRegistry && jscompat.StrictEqual(sceneRegistry, registry) && videoPath != nil && len(inputs) == 0
		videoSha = jscompat.Coalesce(jscompat.Get(manifest, "video_sha256"), nil)
		built := &Built{
			VideoPath: videoPath, ManifestPath: manifestPath, VideoSha256: textPointer(videoSha),
			Duration: number(jscompat.Get(manifest, "video_duration")), TotalFrames: number(jscompat.Get(manifest, "total_frames")),
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
		if !hasRegistry || !jscompat.StrictEqual(sceneRegistry, registry) {
			view.Problems = append(view.Problems, registryChanged)
		}
	} else if jscompat.Exists(manifestPath) {
		view.Problems = append(view.Problems, manifestCorrupt)
	}
	current := jscompat.Get(status, "current_animatic_status")
	switch {
	case jscompat.StrictEqual(current, "approved"):
		view.Approval.Status = "approved"
	case jscompat.StrictEqual(current, "review"):
		view.Approval.Status = "review"
	default:
		view.Approval.Status = "none"
	}
	approvedSha := jscompat.Coalesce(jscompat.GetPath(status, "approved_animatic", "video_sha256"), nil)
	view.Approval.ApprovedSha256 = textPointer(approvedSha)
	// Принята именно свежая сборка: прежнее согласование остаётся в истории после изменения входов.
	view.Approval.Current = view.Approval.Status == "approved" && fresh && jscompat.Truthy(videoSha) && jscompat.StrictEqual(approvedSha, videoSha)
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
		id, err := jscompat.Prop(item, "id")
		if err != nil {
			return nil, err
		}
		media := jscompat.Get(item, "media")
		shot := Shot{
			ID: text(id), Title: text(jscompat.Coalesce(jscompat.Get(item, "title"), id)),
			Original: text(jscompat.Get(item, "original")), Sequence: text(jscompat.Get(item, "sequence")),
			SequenceTitle: text(jscompat.Get(item, "sequence_title")),
			Start:         number(jscompat.Get(item, "start")), End: number(jscompat.Get(item, "end")),
			Frames: number(jscompat.Get(item, "frames")), Action: text(jscompat.Get(item, "action")),
			Camera: text(jscompat.Get(item, "camera")), Lipsync: jscompat.Truthy(jscompat.Get(item, "lipsync")),
			Media: text(jscompat.Coalesce(media, "card")),
		}
		if path := jscompat.Get(item, "path"); !jscompat.StrictEqual(media, "video") && jscompat.Truthy(path) {
			name, err := jscompat.PathArg("path", path)
			if err != nil {
				return nil, err
			}
			card := filepath.Join(project, name)
			shot.CardPath = &card
		}
		if last := jscompat.Get(item, "path_last"); jscompat.StrictEqual(media, "keyframes") && jscompat.Truthy(last) {
			name, err := jscompat.PathArg("path", last)
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
	if view.Built == nil || view.Built.VideoPath == nil || !jscompat.Truthy(view.videoSha) {
		return View{}, errors.New(textBuildRequired)
	}
	if status == "approved" && !view.Built.Fresh {
		return View{}, errors.New(textFreshBuildRequired)
	}
	data := readStatus(project)
	manifest := readJSON(filepath.Join(project, filepath.FromSlash(manifestFile)))
	next := jscompat.Spread(data)
	next.Set("current_animatic", manifestFile)
	next.Set("current_animatic_status", status)
	if status == "approved" {
		approved := jscompat.NewObject()
		approved.Set("manifest", manifestFile)
		approved.Set("video", "plan/animatic/latest/"+jscompat.ToString(jscompat.Coalesce(jscompat.Get(manifest, "video_file"), "")))
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
	if err := projectfs.WriteFile(path, []byte(jscompat.StringifyIndent(next, "  ")+"\n"), perm); err != nil {
		return View{}, err
	}
	return ViewAnimatic(project)
}
