package production

import (
	"encoding/json"
	"regexp"

	"songframe/internal/dynvalue"
)

// AssetEdit — рецепт принятого участка из manifest.json комплекта (accepted_edit): частота кадров,
// длина в кадрах и секундах, участок или стоп-кадр оригинала, скорость и удержания. Поля stillAt, sourceInterval,
// speed и note передаются как записаны (JSON), интерфейс сам собирает из них подпись под видео.
type AssetEdit struct {
	// Fps — частота кадров принятого участка (accepted_edit.fps), при её отсутствии — сетка проекта.
	Fps            float64         `json:"fps"`
	Frames         float64         `json:"frames"`
	Duration       float64         `json:"duration"`
	SourceInterval json.RawMessage `json:"sourceInterval"`
	StillAt        json.RawMessage `json:"stillAt"`
	Speed          json.RawMessage `json:"speed"`
	// SpeedParts — части скорости участка (accepted_edit.speed.parts); пусто — одна скорость Speed.
	SpeedParts []AssetSpeedPart `json:"speedParts"`
	HoldFirst  float64          `json:"holdFirst"`
	HoldLast   float64          `json:"holdLast"`
	Note       json.RawMessage  `json:"note"`
}

// AssetSpeedPart — часть принятого участка: секунды оригинала [start, end) и скорость точной
// дробью, как записана в манифесте (ratio, например «3/4»).
type AssetSpeedPart struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Speed string  `json:"speed"`
}

// assetSpeedParts — части скорости accepted_edit в секундах при частоте fps; пропускает записи
// без интервала или дроби.
func assetSpeedParts(speed any, fps float64) []AssetSpeedPart {
	result := []AssetSpeedPart{}
	parts, _ := dynvalue.AsArray(dynvalue.Get(speed, "parts"))
	for _, part := range parts {
		interval, _ := dynvalue.AsArray(dynvalue.Get(part, "source_frame_interval_exclusive"))
		ratio, ok := dynvalue.Get(part, "ratio").(string)
		if len(interval) != 2 || !ok || fps <= 0 {
			continue
		}
		result = append(result, AssetSpeedPart{Start: dynvalue.ToNumber(interval[0]) / fps, End: dynvalue.ToNumber(interval[1]) / fps, Speed: ratio})
	}
	return result
}

// textOriginalMedia — подпись параметров оригинала генерации по сведениям ffprobe из манифеста.
func textOriginalMedia(width, height, rate, frames, duration string) string {
	return width + "×" + height + ", " + rate + " FPS, кадров: " + frames + ", " + duration + " с"
}

func orText(value any, fallback string) string {
	if dynvalue.IsNullish(value) {
		return fallback
	}
	return dynvalue.ToString(value)
}

func rawValue(value any) json.RawMessage {
	if value == dynvalue.Undefined {
		return json.RawMessage("null")
	}
	return dynvalue.Raw(value)
}

// AssetMedia — параметры пары видео принятого комплекта по его manifest.json: подпись оригинала
// (nil, если манифест их не хранит) и рецепт принятого участка. fps — сетка проекта: по ней
// считается длительность, когда манифест хранит только число кадров. Общая для «Производства» и
// «Планов», чтобы обе страницы показывали одно и то же.
func AssetMedia(manifest any, fps float64) (*string, AssetEdit) {
	generation := dynvalue.Coalesce(dynvalue.Get(manifest, "generation"), dynvalue.NewObject())
	edit := dynvalue.Coalesce(dynvalue.Get(manifest, "accepted_edit"), dynvalue.NewObject())
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
	editFps := dynvalue.ToNumber(dynvalue.Get(edit, "fps"))
	if editFps <= 0 || editFps != editFps {
		editFps = fps
	}
	return originalMedia, AssetEdit{
		Fps: editFps, Frames: dynvalue.ToNumber(frames), Duration: dynvalue.ToNumber(duration),
		SourceInterval: rawValue(dynvalue.Coalesce(dynvalue.Get(edit, "source_interval_seconds"), nil)),
		StillAt:        rawValue(dynvalue.Coalesce(dynvalue.Get(edit, "still_source_time_seconds"), nil)),
		Speed:          rawValue(speedValue),
		SpeedParts:     assetSpeedParts(speed, editFps),
		HoldFirst:      dynvalue.ToNumber(dynvalue.Coalesce(dynvalue.Get(edit, "hold_first_seconds"), 0.0)),
		HoldLast:       dynvalue.ToNumber(dynvalue.Coalesce(dynvalue.Get(edit, "hold_last_seconds"), 0.0)),
		Note:           rawValue(dynvalue.Coalesce(dynvalue.Get(edit, "processing_note"), "")),
	}
}

// FirstFrameInput — описание первой опоры среди входов принятого запроса (generation.inputs
// manifest.json комплекта): вход со слотом first_image, иначе первый вход-изображение; nil — у
// комплекта нет изображений-входов (своё видео без опор, производный план). Путь в описании
// отсчитывается от папки комплекта; вызывающий сам проверяет, что файл существует. По этому кадру
// карточки плана показывают принятый план вместо видео: десятки видео в сетке держали бы
// декодер на каждую карточку.
func FirstFrameInput(manifest any) any {
	inputs, _ := dynvalue.AsArray(dynvalue.GetPath(manifest, "generation", "inputs"))
	var first any
	for _, item := range inputs {
		path, _ := dynvalue.Get(item, "path").(string)
		if !imageInput.MatchString(path) {
			continue
		}
		if dynvalue.StrictEqual(dynvalue.Get(item, "slot"), "first_image") {
			return item
		}
		if first == nil {
			first = item
		}
	}
	return first
}

// imageInput — расширения изображений-входов запроса.
var imageInput = regexp.MustCompile(`(?i)\.(png|jpe?g|webp)$`)
