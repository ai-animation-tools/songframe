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

	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
	"songframe/internal/production"
	"songframe/internal/scenario"
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
	if dynvalue.Exists(path) {
		return &path
	}
	return nil
}

// descriptorPath — путь дескриптора комплекта: без root или с root asset от папки сцены, с root
// source от папки source.
func descriptorPath(project, assetDir string, item any) *string {
	path, ok := dynvalue.Get(item, "path").(string)
	if !ok || path == "" {
		return nil
	}
	base := assetDir
	if dynvalue.StrictEqual(dynvalue.Get(item, "root"), "source") {
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
	return dynvalue.DecodeUTF8(data), true
}

// orText — значение строкой (dynvalue.ToString), а при null или отсутствии — fallback.
func orText(value any, fallback string) string {
	if dynvalue.IsNullish(value) {
		return fallback
	}
	return dynvalue.ToString(value)
}

// raw — значение в JSON (отсутствующее, dynvalue.Undefined, — null).
func raw(value any) json.RawMessage {
	if value == dynvalue.Undefined {
		return json.RawMessage("null")
	}
	return dynvalue.Raw(value)
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
	manifest, ok := dynvalue.ReadJSONFile(filepath.Join(dir, "manifest.json"))
	if !ok || dynvalue.IsNullish(manifest) {
		return nil
	}
	generation := dynvalue.Coalesce(dynvalue.Get(manifest, "generation"), dynvalue.NewObject())
	edit := dynvalue.Coalesce(dynvalue.Get(manifest, "accepted_edit"), dynvalue.NewObject())
	var request any
	if path := descriptorPath(project, dir, dynvalue.Get(generation, "request")); path != nil {
		if value, ok := dynvalue.ReadJSONFile(*path); ok {
			request = value
		}
	}
	inputs := []Input{}
	list, _ := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(generation, "inputs"), []any{}))
	for _, item := range list {
		path := descriptorPath(project, dir, item)
		if path == nil || !image.MatchString(*path) {
			continue
		}
		role := dynvalue.Coalesce(dynvalue.Get(item, "role"), dynvalue.Coalesce(dynvalue.Get(item, "slot"), ""))
		inputs = append(inputs, Input{Path: *path, Role: dynvalue.ToString(role)})
	}
	var originalMedia *string
	if media := dynvalue.Get(generation, "original_media"); dynvalue.Truthy(media) {
		text := textOriginalMedia(orText(dynvalue.Get(media, "width"), "?"), orText(dynvalue.Get(media, "height"), "?"),
			orText(dynvalue.Get(media, "r_frame_rate"), "?"), orText(dynvalue.Get(media, "nb_frames"), "?"),
			dynvalue.ToFixed(dynvalue.ToNumber(dynvalue.Coalesce(dynvalue.Get(media, "duration"), 0.0)), 2))
		originalMedia = &text
	}
	frames := dynvalue.Coalesce(dynvalue.Get(edit, "frames"), 0.0)
	speed := dynvalue.Get(edit, "speed")
	speedValue := dynvalue.Get(speed, "ratio")
	if dynvalue.IsNullish(speedValue) {
		if factor := dynvalue.Get(speed, "factor"); dynvalue.Truthy(factor) {
			speedValue = dynvalue.ToString(factor)
		} else {
			speedValue = "1"
		}
	}
	duration := dynvalue.Get(edit, "duration_seconds")
	if dynvalue.IsNullish(duration) {
		duration = dynvalue.ToNumber(frames) / fps
	}
	asset := &Asset{
		Dir: dir, Video: descriptorPath(project, dir, dynvalue.Get(edit, "video")),
		Original: descriptorPath(project, dir, dynvalue.Get(generation, "original")), OriginalMedia: originalMedia,
		Edit: Edit{
			Frames: dynvalue.ToNumber(frames), Duration: dynvalue.ToNumber(duration),
			SourceInterval: raw(dynvalue.Coalesce(dynvalue.Get(edit, "source_interval_seconds"), nil)),
			StillAt:        raw(dynvalue.Coalesce(dynvalue.Get(edit, "still_source_time_seconds"), nil)),
			Speed:          raw(speedValue),
			HoldFirst:      dynvalue.ToNumber(dynvalue.Coalesce(dynvalue.Get(edit, "hold_first_seconds"), 0.0)),
			HoldLast:       dynvalue.ToNumber(dynvalue.Coalesce(dynvalue.Get(edit, "hold_last_seconds"), 0.0)),
			Note:           raw(dynvalue.Coalesce(dynvalue.Get(edit, "processing_note"), "")),
		},
		Prompt: readText(descriptorPath(project, dir, dynvalue.Get(generation, "prompt"))),
		Inputs: inputs, Lipsync: dynvalue.Truthy(dynvalue.Get(generation, "lipsync")),
		Audio: descriptorPath(project, dir, dynvalue.Get(generation, "audio")),
	}
	if dynvalue.Truthy(request) {
		asset.Request = &AssetRequest{
			Provider:   raw(dynvalue.Coalesce(dynvalue.Get(request, "provider"), videoTitles())),
			Model:      raw(dynvalue.Coalesce(dynvalue.Get(request, "model"), "")),
			Parameters: raw(dynvalue.Coalesce(dynvalue.Get(request, "parameters"), dynvalue.NewObject())),
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
	scenes, ok := dynvalue.ReadJSONFile(filepath.Join(project, "plan", "scenes.json"))
	if !ok || dynvalue.IsNullish(scenes) {
		return View{Shots: []Shot{}, Problems: []string{production.TextScenarioRequired}}, nil
	}
	// Частота кадров принадлежит реестру сцен (schema требует 30), приложение её не выбирает.
	fps := dynvalue.ToNumber(dynvalue.Get(scenes, "fps"))
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
	sequences, err := dynvalue.Iterate(dynvalue.Get(scenes, "sequences"))
	if err != nil {
		return View{}, err
	}
	titles := map[string]any{}
	for _, sequence := range sequences {
		titles[dynvalue.ToString(dynvalue.Get(sequence, "id"))] = dynvalue.Get(sequence, "title")
	}
	animatic, _ := dynvalue.ReadJSONFile(filepath.Join(project, "plan", "animatic", "latest", "manifest.json"))
	animaticMedia := map[string]any{}
	if list, ok := dynvalue.AsArray(dynvalue.Get(animatic, "shots")); ok {
		for _, item := range list {
			animaticMedia[dynvalue.ToString(dynvalue.Get(item, "id"))] = dynvalue.Coalesce(dynvalue.Get(item, "media"), "card")
		}
	}
	problems := append([]string{}, view.Problems...)
	list, err := dynvalue.Iterate(dynvalue.Get(scenes, "scenes"))
	if err != nil {
		return View{}, err
	}
	shots := []Shot{}
	for _, scene := range list {
		sid := dynvalue.ToString(dynvalue.Get(scene, "id"))
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
				if note, err := dynvalue.Parse(frame.Note); err == nil && len(frame.Note) > 0 && dynvalue.Truthy(note) {
					label += " · " + dynvalue.ToString(note)
				}
				keyframes = append(keyframes, Keyframe{ImagePath: *frame.ImagePath, Label: label, Approved: frame.Approved})
			}
		}
		references := []Reference{}
		refs, _ := dynvalue.AsArray(dynvalue.Get(scene, "references"))
		for _, item := range refs {
			id := dynvalue.ToString(item)
			ref := dynvalue.Get(dynvalue.Get(scenes, "references"), id)
			var imagePath *string
			if path, ok := dynvalue.Get(ref, "path").(string); ok && path != "" {
				imagePath = existing(filepath.Join(project, path))
			}
			name := dynvalue.Coalesce(dynvalue.Get(ref, "short_name"), dynvalue.Coalesce(dynvalue.Get(ref, "name"), id))
			references = append(references, Reference{ID: id, Name: dynvalue.ToString(name), ImagePath: imagePath})
		}
		sequence := dynvalue.Get(scene, "sequence")
		sequenceTitle, known := titles[dynvalue.ToString(sequence)]
		if !known || dynvalue.IsNullish(sequenceTitle) {
			sequenceTitle = sequence
		}
		start := dynvalue.ToNumber(dynvalue.Get(scene, "start_frame"))
		end := dynvalue.ToNumber(dynvalue.Get(scene, "end_frame_exclusive"))
		shot := Shot{
			DerivedFrom: raw(dynvalue.Coalesce(dynvalue.Get(dynvalue.Get(scene, "derived_from"), "shot"), nil)),
			ID:          sid, Title: raw(dynvalue.Coalesce(dynvalue.Get(scene, "title"), sequenceTitle)),
			SequenceTitle: raw(sequenceTitle), Original: raw(dynvalue.Get(scene, "original")),
			Start: start / fps, End: end / fps, Frames: end - start,
			Camera: raw(dynvalue.Get(scene, "camera")), Action: raw(dynvalue.Get(scene, "action")),
			Continuity: raw(dynvalue.Get(scene, "continuity")), Notes: raw(dynvalue.Coalesce(dynvalue.Get(scene, "notes"), "")),
			Lipsync: raw(dynvalue.Get(scene, "lipsync")), References: references,
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
