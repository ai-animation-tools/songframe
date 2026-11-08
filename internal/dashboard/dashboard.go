// Package dashboard собирает дашборд сцен: по каждому плану реестра
// собирается всё, что о нём известно в проекте, в одну карточку: постановка и строка песни,
// положение на шкале, комплект в assets (оригинал против принятого монтажа, рецепт, промпт,
// входы), пакеты с опорами (production.ViewProduction), карточка аниматика, состояние героев до и
// после (scenario.ProjectBrief). Ничего не пишет: только чтение файлов проекта.
package dashboard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/production"
	"songframe-go/internal/scenario"
)

// image — расширения изображений-входов запроса.
var image = regexp.MustCompile(`(?i)\.(png|jpe?g|webp)$`)

// Тексты scenesTexts.main и productionTexts.main.package (frontend/src/shared/texts).
const (
	textRequestInput = "вход запроса"
	textNotStarted   = "постановка есть, работа не начата"
)

func textStateFailed(shot, reason string) string {
	return shot + ": состояние не вычислено: " + reason
}

func textOriginalMedia(width, height, rate, frames, duration string) string {
	return width + "×" + height + ", " + rate + " FPS, кадров: " + frames + ", " + duration + " с"
}

// Reference — референс постановки плана.
type Reference struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	ImagePath *string `json:"imagePath"`
}

// Edit — принятый монтаж комплекта.
type Edit struct {
	Frames         float64         `json:"frames"`
	Duration       float64         `json:"duration"`
	SourceInterval json.RawMessage `json:"sourceInterval"`
	StillAt        json.RawMessage `json:"stillAt"`
	Speed          json.RawMessage `json:"speed"`
	HoldFirst      float64         `json:"holdFirst"`
	HoldLast       float64         `json:"holdLast"`
	Note           json.RawMessage `json:"note"`
}

// AssetRequest — снимок запроса принятого комплекта.
type AssetRequest struct {
	Provider   json.RawMessage `json:"provider"`
	Model      json.RawMessage `json:"model"`
	Parameters json.RawMessage `json:"parameters"`
}

// Input — изображение-вход принятого запроса.
type Input struct {
	Path string `json:"path"`
	Role string `json:"role"`
}

// Asset — комплект assets/shots/<id>.
type Asset struct {
	Dir           string        `json:"dir"`
	Video         *string       `json:"video"`
	Original      *string       `json:"original"`
	OriginalMedia *string       `json:"originalMedia"`
	Edit          Edit          `json:"edit"`
	Prompt        *string       `json:"prompt"`
	Request       *AssetRequest `json:"request"`
	Inputs        []Input       `json:"inputs"`
	Lipsync       bool          `json:"lipsync"`
	Audio         *string       `json:"audio"`
}

// PackageRequest — запрос последнего пакета.
type PackageRequest struct {
	Model      json.RawMessage `json:"model"`
	Parameters json.RawMessage `json:"parameters"`
	Downloads  []string        `json:"downloads"`
}

// Package — последний пакет плана.
type Package struct {
	Dir        string          `json:"dir"`
	StageLabel string          `json:"stageLabel"`
	Prompt     *string         `json:"prompt"`
	Request    *PackageRequest `json:"request"`
	Preview    []string        `json:"preview"`
}

// Keyframe — опора карточки.
type Keyframe struct {
	ImagePath string `json:"imagePath"`
	Label     string `json:"label"`
	Approved  bool   `json:"approved"`
}

// Phase — состояние героев до или после плана со строками врезки непрерывности.
type Phase struct {
	State     json.RawMessage `json:"state"`
	Lines     []string        `json:"lines"`
	Checklist []string        `json:"checklist"`
}

// Shot — DashboardShot контракта.
type Shot struct {
	DerivedFrom   json.RawMessage `json:"derivedFrom"`
	ID            string          `json:"id"`
	Title         json.RawMessage `json:"title"`
	SequenceTitle json.RawMessage `json:"sequenceTitle"`
	Original      json.RawMessage `json:"original"`
	Start         float64         `json:"start"`
	End           float64         `json:"end"`
	Frames        float64         `json:"frames"`
	Camera        json.RawMessage `json:"camera"`
	Action        json.RawMessage `json:"action"`
	Continuity    json.RawMessage `json:"continuity"`
	Notes         json.RawMessage `json:"notes"`
	Lipsync       json.RawMessage `json:"lipsync"`
	References    []Reference     `json:"references"`
	State         string          `json:"state"`
	StageLabel    string          `json:"stageLabel"`
	Asset         *Asset          `json:"asset"`
	Package       *Package        `json:"package"`
	PackagesCount int             `json:"packagesCount"`
	Thumbnail     *string         `json:"thumbnail"`
	Keyframes     []Keyframe      `json:"keyframes"`
	CardPath      *string         `json:"cardPath"`
	AnimaticMedia json.RawMessage `json:"animaticMedia"`
	Before        *Phase          `json:"before"`
	After         *Phase          `json:"after"`
}

// Summary — сводка готовности.
type Summary struct {
	Total            int     `json:"total"`
	Completed        int     `json:"completed"`
	Stale            int     `json:"stale"`
	Progress         int     `json:"progress"`
	Planned          int     `json:"planned"`
	Duration         float64 `json:"duration"`
	CompletedSeconds float64 `json:"completedSeconds"`
}

// View — DashboardView контракта.
type View struct {
	Shots    []Shot   `json:"shots"`
	Summary  Summary  `json:"summary"`
	Problems []string `json:"problems"`
}

// existing — путь, если файл существует.
func existing(path string) *string {
	if jscompat.Exists(path) {
		return &path
	}
	return nil
}

// descriptorPath — путь дескриптора комплекта: без root или с root asset от папки сцены, с root
// source от папки source.
func descriptorPath(project, assetDir string, item any) *string {
	path, ok := jscompat.Get(item, "path").(string)
	if !ok || path == "" {
		return nil
	}
	base := assetDir
	if jscompat.StrictEqual(jscompat.Get(item, "root"), "source") {
		base = filepath.Join(project, "source")
	}
	return existing(filepath.Join(base, path))
}

// readText — содержимое текстового файла либо nil.
func readText(path *string) *string {
	if path == nil {
		return nil
	}
	data, ok := readFile(*path)
	if !ok {
		return nil
	}
	return &data
}

func readFile(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return jscompat.DecodeUTF8(data), true
}

// orText — `value ?? fallback` как строка шаблона JS.
func orText(value any, fallback string) string {
	if jscompat.IsNullish(value) {
		return fallback
	}
	return jscompat.ToString(value)
}

// raw — значение в JSON (undefined — null).
func raw(value any) json.RawMessage {
	if value == jscompat.Undefined {
		return json.RawMessage("null")
	}
	return jscompat.Raw(value)
}

// videoTitles — mediaProviderTitles('video'): названия провайдеров видео через « или ».
func videoTitles() string {
	titles := []string{}
	for _, id := range mediaproviders.IDs() {
		if mediaproviders.Supports(id, mediaproviders.Video) {
			info, _ := mediaproviders.Lookup(id)
			titles = append(titles, info.Title)
		}
	}
	return strings.Join(titles, " или ")
}

// readAsset — комплект плана: оригинал против принятого монтажа, рецепт, промпт, входы.
func readAsset(project, sid string, fps float64) *Asset {
	dir := filepath.Join(project, "assets", "shots", sid)
	manifest, ok := jscompat.ReadJSONFile(filepath.Join(dir, "manifest.json"))
	if !ok || jscompat.IsNullish(manifest) {
		return nil
	}
	generation := jscompat.Coalesce(jscompat.Get(manifest, "generation"), jscompat.NewObject())
	edit := jscompat.Coalesce(jscompat.Get(manifest, "accepted_edit"), jscompat.NewObject())
	var request any
	if path := descriptorPath(project, dir, jscompat.Get(generation, "request")); path != nil {
		if value, ok := jscompat.ReadJSONFile(*path); ok {
			request = value
		}
	}
	inputs := []Input{}
	list, _ := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(generation, "inputs"), []any{}))
	for _, item := range list {
		path := descriptorPath(project, dir, item)
		if path == nil || !image.MatchString(*path) {
			continue
		}
		role := jscompat.Coalesce(jscompat.Get(item, "role"), jscompat.Coalesce(jscompat.Get(item, "slot"), ""))
		inputs = append(inputs, Input{Path: *path, Role: jscompat.ToString(role)})
	}
	var originalMedia *string
	if media := jscompat.Get(generation, "original_media"); jscompat.Truthy(media) {
		text := textOriginalMedia(orText(jscompat.Get(media, "width"), "?"), orText(jscompat.Get(media, "height"), "?"),
			orText(jscompat.Get(media, "r_frame_rate"), "?"), orText(jscompat.Get(media, "nb_frames"), "?"),
			jscompat.ToFixed(jscompat.ToNumber(jscompat.Coalesce(jscompat.Get(media, "duration"), 0.0)), 2))
		originalMedia = &text
	}
	frames := jscompat.Coalesce(jscompat.Get(edit, "frames"), 0.0)
	speed := jscompat.Get(edit, "speed")
	speedValue := jscompat.Get(speed, "ratio")
	if jscompat.IsNullish(speedValue) {
		if factor := jscompat.Get(speed, "factor"); jscompat.Truthy(factor) {
			speedValue = jscompat.ToString(factor)
		} else {
			speedValue = "1"
		}
	}
	duration := jscompat.Get(edit, "duration_seconds")
	if jscompat.IsNullish(duration) {
		duration = jscompat.ToNumber(frames) / fps
	}
	asset := &Asset{
		Dir: dir, Video: descriptorPath(project, dir, jscompat.Get(edit, "video")),
		Original: descriptorPath(project, dir, jscompat.Get(generation, "original")), OriginalMedia: originalMedia,
		Edit: Edit{
			Frames: jscompat.ToNumber(frames), Duration: jscompat.ToNumber(duration),
			SourceInterval: raw(jscompat.Coalesce(jscompat.Get(edit, "source_interval_seconds"), nil)),
			StillAt:        raw(jscompat.Coalesce(jscompat.Get(edit, "still_source_time_seconds"), nil)),
			Speed:          raw(speedValue),
			HoldFirst:      jscompat.ToNumber(jscompat.Coalesce(jscompat.Get(edit, "hold_first_seconds"), 0.0)),
			HoldLast:       jscompat.ToNumber(jscompat.Coalesce(jscompat.Get(edit, "hold_last_seconds"), 0.0)),
			Note:           raw(jscompat.Coalesce(jscompat.Get(edit, "processing_note"), "")),
		},
		Prompt: readText(descriptorPath(project, dir, jscompat.Get(generation, "prompt"))),
		Inputs: inputs, Lipsync: jscompat.Truthy(jscompat.Get(generation, "lipsync")),
		Audio: descriptorPath(project, dir, jscompat.Get(generation, "audio")),
	}
	if jscompat.Truthy(request) {
		asset.Request = &AssetRequest{
			Provider:   raw(jscompat.Coalesce(jscompat.Get(request, "provider"), videoTitles())),
			Model:      raw(jscompat.Coalesce(jscompat.Get(request, "model"), "")),
			Parameters: raw(jscompat.Coalesce(jscompat.Get(request, "parameters"), jscompat.NewObject())),
		}
	}
	return asset
}

// brief — строки врезки непрерывности: имя сущности и подписи свойств из словаря.
func brief(project string, scenes any, sid, phase string, problems *[]string) *Phase {
	result, err := scenario.ProjectBrief(project, scenes, sid, phase)
	if err != nil {
		*problems = append(*problems, textStateFailed(sid, err.Error()))
		return nil
	}
	body := strings.Split(result.Text, "\n")
	if len(body) > 2 {
		body = body[2:]
	} else {
		body = []string{}
	}
	for index, line := range body {
		if line == "" {
			body = body[:index]
			break
		}
	}
	checklist := result.Checklist
	if checklist == nil {
		checklist = []string{}
	}
	return &Phase{State: result.State, Lines: body, Checklist: checklist}
}

// ViewDashboard — карточки планов, сводка и проблемы чтения.
func ViewDashboard(project string) (View, error) {
	scenes, ok := jscompat.ReadJSONFile(filepath.Join(project, "plan", "scenes.json"))
	if !ok || jscompat.IsNullish(scenes) {
		return View{Shots: []Shot{}, Problems: []string{production.TextScenarioRequired}}, nil
	}
	// Частота кадров принадлежит реестру сцен (schema требует 30), приложение её не выбирает.
	fps := jscompat.ToNumber(jscompat.Get(scenes, "fps"))
	if fps == 0 || fps != fps {
		fps = production.FPS
	}
	view, err := production.ViewProduction(project)
	if err != nil {
		return View{}, err
	}
	byID := map[string]*production.ShotProduction{}
	for _, shot := range view.Shots {
		byID[shot.ID] = shot
	}
	sequences, err := jscompat.Iterate(jscompat.Get(scenes, "sequences"))
	if err != nil {
		return View{}, err
	}
	titles := map[string]any{}
	for _, sequence := range sequences {
		titles[jscompat.ToString(jscompat.Get(sequence, "id"))] = jscompat.Get(sequence, "title")
	}
	animatic, _ := jscompat.ReadJSONFile(filepath.Join(project, "plan", "animatic", "latest", "manifest.json"))
	animaticMedia := map[string]any{}
	if list, ok := jscompat.AsArray(jscompat.Get(animatic, "shots")); ok {
		for _, item := range list {
			animaticMedia[jscompat.ToString(jscompat.Get(item, "id"))] = jscompat.Coalesce(jscompat.Get(item, "media"), "card")
		}
	}
	problems := append([]string{}, view.Problems...)
	list, err := jscompat.Iterate(jscompat.Get(scenes, "scenes"))
	if err != nil {
		return View{}, err
	}
	shots := []Shot{}
	for _, scene := range list {
		sid := jscompat.ToString(jscompat.Get(scene, "id"))
		prod := byID[sid]
		asset := readAsset(project, sid, fps)
		packages := []*production.PackageView{}
		if prod != nil {
			packages = prod.Packages
		}
		var latest *production.PackageView
		if len(packages) > 0 {
			latest = packages[0]
		}
		card := filepath.Join(project, "plan", "animatic", "cards", sid+".png")
		keyframes := []Keyframe{}
		if asset != nil && len(asset.Inputs) > 0 {
			for _, input := range asset.Inputs {
				label := input.Role
				if label == "" {
					label = textRequestInput
				}
				keyframes = append(keyframes, Keyframe{ImagePath: input.Path, Label: label, Approved: true})
			}
		} else if latest != nil {
			for _, frame := range latest.Keyframes {
				if frame.ImagePath == nil || *frame.ImagePath == "" {
					continue
				}
				label := frame.ID + " · " + frame.Role
				if note, err := jscompat.Parse(frame.Note); err == nil && len(frame.Note) > 0 && jscompat.Truthy(note) {
					label += " · " + jscompat.ToString(note)
				}
				keyframes = append(keyframes, Keyframe{ImagePath: *frame.ImagePath, Label: label, Approved: frame.Approved})
			}
		}
		references := []Reference{}
		refs, _ := jscompat.AsArray(jscompat.Get(scene, "references"))
		for _, item := range refs {
			id := jscompat.ToString(item)
			ref := jscompat.Get(jscompat.Get(scenes, "references"), id)
			var imagePath *string
			if path, ok := jscompat.Get(ref, "path").(string); ok && path != "" {
				imagePath = existing(filepath.Join(project, path))
			}
			name := jscompat.Coalesce(jscompat.Get(ref, "short_name"), jscompat.Coalesce(jscompat.Get(ref, "name"), id))
			references = append(references, Reference{ID: id, Name: jscompat.ToString(name), ImagePath: imagePath})
		}
		sequence := jscompat.Get(scene, "sequence")
		sequenceTitle, known := titles[jscompat.ToString(sequence)]
		if !known || jscompat.IsNullish(sequenceTitle) {
			sequenceTitle = sequence
		}
		start := jscompat.ToNumber(jscompat.Get(scene, "start_frame"))
		end := jscompat.ToNumber(jscompat.Get(scene, "end_frame_exclusive"))
		shot := Shot{
			DerivedFrom: raw(jscompat.Coalesce(jscompat.Get(jscompat.Get(scene, "derived_from"), "shot"), nil)),
			ID:          sid, Title: raw(jscompat.Coalesce(jscompat.Get(scene, "title"), sequenceTitle)),
			SequenceTitle: raw(sequenceTitle), Original: raw(jscompat.Get(scene, "original")),
			Start: start / fps, End: end / fps, Frames: end - start,
			Camera: raw(jscompat.Get(scene, "camera")), Action: raw(jscompat.Get(scene, "action")),
			Continuity: raw(jscompat.Get(scene, "continuity")), Notes: raw(jscompat.Coalesce(jscompat.Get(scene, "notes"), "")),
			Lipsync: raw(jscompat.Get(scene, "lipsync")), References: references,
			State: production.StatePlanned, StageLabel: textNotStarted, Asset: asset, PackagesCount: len(packages),
			Keyframes: keyframes, CardPath: existing(card), AnimaticMedia: json.RawMessage("null"),
		}
		if prod != nil {
			shot.State, shot.StageLabel = prod.State, prod.StageLabel
		}
		if latest != nil {
			pkg := &Package{Dir: latest.Dir, StageLabel: latest.StageLabel, Preview: latest.Preview}
			if latest.Prompt != nil {
				text := latest.Prompt.Text
				pkg.Prompt = &text
			}
			if latest.Request != nil {
				pkg.Request = &PackageRequest{Model: rawOrNull(latest.Request.Model), Parameters: rawOrNull(latest.Request.Parameters), Downloads: latest.Request.Downloads}
			}
			if pkg.Preview == nil {
				pkg.Preview = []string{}
			}
			shot.Package = pkg
		}
		if len(keyframes) > 0 {
			thumbnail := keyframes[0].ImagePath
			shot.Thumbnail = &thumbnail
		} else {
			shot.Thumbnail = existing(card)
		}
		if media, ok := animaticMedia[sid]; ok {
			shot.AnimaticMedia = raw(media)
		}
		shot.Before = brief(project, scenes, sid, "before", &problems)
		shot.After = brief(project, scenes, sid, "after", &problems)
		shots = append(shots, shot)
	}
	summary := Summary{Total: len(shots)}
	if len(shots) > 0 {
		summary.Duration = shots[len(shots)-1].End
	}
	for _, shot := range shots {
		switch shot.State {
		case production.StateCompleted:
			summary.Completed++
			summary.CompletedSeconds += shot.End - shot.Start
		case production.StateStale:
			summary.Stale++
		case production.StateProgress, production.StateUnknown:
			summary.Progress++
		case production.StatePlanned:
			summary.Planned++
		}
	}
	return View{Shots: shots, Summary: summary, Problems: problems}, nil
}

// rawOrNull — пустое значение JSON как null.
func rawOrNull(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("null")
	}
	return value
}
