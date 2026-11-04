package scenario

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"

	"songframe-go/internal/cast"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/sources"
	"songframe-go/internal/timing"
)

// FPS — кадровая сетка реестра (FPS shared/video оригинала).
const FPS = 30

// sceneID — код плана: M01, M23.5.
var sceneID = regexp.MustCompile(`^M\d{2}(\.\d+)?$`)

// View — ScenarioView контракта frontend/src/shared/types.ts, ответ scenario.view. Документы
// проекта передаются как есть: их порядок ключей и неизвестные поля сохраняет редактор.
type View struct {
	// Scenes — plan/scenes.json или null (нет файла, повреждён, ложное значение JSON).
	Scenes json.RawMessage `json:"scenes"`
	// Treatment — plan/treatment.json или null.
	Treatment json.RawMessage `json:"treatment"`
	// Cast — кастинг с проекцией описаний (без дополнения словаря) или null.
	Cast json.RawMessage `json:"cast"`
	// Timing — plan/audio/timing.json или null.
	Timing json.RawMessage `json:"timing"`
	// Lyrics — строки source/text.md; пусто без текста.
	Lyrics []timing.LyricsLine `json:"lyrics"`
	// Duration — длительность трека в секундах: duration_decoded разметки, затем опись, затем
	// duration_container; значение берётся как есть (null, если ничего нет).
	Duration json.RawMessage `json:"duration"`
	// TrackPath — абсолютный путь source/track.mp3 или null.
	TrackPath *string  `json:"trackPath"`
	Problems  []string `json:"problems"`
}

// readDocument — readJson модуля scenario: (значение, true) или (nil, false) для отсутствующего
// файла; повреждённый файл добавляет проблему. Ложное значение JSON считается отсутствием
// (`value || null`).
func readDocument(project, relative string, problems *[]string) any {
	path := filepath.Join(project, filepath.FromSlash(relative))
	if !jscompat.Exists(path) {
		return nil
	}
	value, ok := jscompat.ReadJSONFile(path)
	if !ok {
		*problems = append(*problems, textDamagedDocument(relative))
		return nil
	}
	if !jscompat.Truthy(value) {
		return nil
	}
	return value
}

// rawOrNull — документ для DTO: nil даёт null.
func rawOrNull(value any) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	return jscompat.Raw(value)
}

// ViewProject — viewScenario: реестр, трактовка, кастинг и разметка для страницы «Сценарий» с
// проблемами проверки реестра. Ничего не пишет. Ошибка — исключение оригинала на документе
// другой формы.
func ViewProject(project string) (View, error) {
	problems := []string{}
	scenes := readDocument(project, "plan/scenes.json", &problems)
	treatment := readDocument(project, "plan/treatment.json", &problems)
	timingDocument := readDocument(project, "plan/audio/timing.json", &problems)
	read := cast.Read(project)
	var castValue any
	if read.Damaged {
		problems = append(problems, textDamagedCast)
	} else if !read.Missing {
		castValue = read.Value
	}
	manifest := sources.ReadManifest(project)
	lyrics := []timing.LyricsLine{}
	if text, err := os.ReadFile(filepath.Join(project, "source", "text.md")); err == nil {
		lyrics = timing.ParseLyricsLines(jscompat.DecodeUTF8(text))
	}
	if scenes != nil {
		found, err := ValidateScenes(scenes, castValue)
		if err != nil {
			return View{}, err
		}
		problems = append(problems, found...)
		if jscompat.Truthy(castValue) {
			references, err := cast.References(castValue)
			if err != nil {
				return View{}, err
			}
			if jscompat.Stringify(jscompat.Get(scenes, "references")) != jscompat.Stringify(references) {
				problems = append(problems, textReferencesRefresh)
			}
		}
	}
	duration := jscompat.Coalesce(jscompat.Get(timingDocument, "duration_decoded"),
		jscompat.Coalesce(jscompat.GetPath(manifest, "track", "duration_seconds"),
			jscompat.Coalesce(jscompat.Get(timingDocument, "duration_container"), nil)))
	var trackPath *string
	if track := filepath.Join(project, "source", "track.mp3"); jscompat.Exists(track) {
		trackPath = &track
	}
	return View{
		Scenes:    rawOrNull(scenes),
		Treatment: rawOrNull(treatment),
		Cast:      rawOrNull(castValue),
		Timing:    rawOrNull(timingDocument),
		Lyrics:    lyrics,
		Duration:  rawOrNull(duration),
		TrackPath: trackPath,
		Problems:  problems,
	}, nil
}

// ValidateScenes — validateScenes: структурная проверка реестра как в scene_registry.validate с
// сообщениями для редактора. castValue — кастинг проекта (его начальное состояние входит в проверку
// наследования) или nil. Ошибка — исключение оригинала на реестре другой формы (части не массив,
// камера не строка и т. п.); исключение вычисления состояния, напротив, становится проблемой.
func ValidateScenes(data, castValue any) ([]string, error) {
	scenes, isArray := jscompat.AsArray(jscompat.Get(data, "scenes"))
	if !jscompat.StrictEqual(jscompat.Get(data, "schema_version"), 1.0) || !jscompat.StrictEqual(jscompat.Get(data, "fps"), float64(FPS)) ||
		!isArray || len(scenes) == 0 {
		return []string{textRegistryRequiresScenes}, nil
	}
	sequences, ok := jscompat.AsArray(jscompat.Get(data, "sequences"))
	if !ok {
		return nil, &jscompat.TypeError{Message: "data.sequences.map is not a function"}
	}
	groups := &valueSet{}
	for _, sequence := range sequences {
		id, err := jscompat.Prop(sequence, "id")
		if err != nil {
			return nil, err
		}
		groups.add(id)
	}
	references := jscompat.Get(data, "references")
	problems := []string{}
	seen := &valueSet{}
	end := 0.0
	for _, scene := range scenes {
		rawID, err := jscompat.Prop(scene, "id")
		if err != nil {
			return nil, err
		}
		sid := jscompat.ToString(rawID)
		if !sceneID.MatchString(sid) {
			problems = append(problems, textShotCodeInvalid(sid))
		}
		if seen.has(rawID) {
			problems = append(problems, textDuplicateShotCode(sid))
		}
		seen.add(rawID)
		start := jscompat.Get(scene, "start_frame")
		finish := jscompat.Get(scene, "end_frame_exclusive")
		if !jscompat.IsInteger(start) || !jscompat.IsInteger(finish) {
			problems = append(problems, textShotFramesInteger(sid))
		} else {
			if start.(float64) != end {
				problems = append(problems, textShotStartMismatch(sid, jscompat.NumberToString(start.(float64)), jscompat.NumberToString(end)))
			}
			if finish.(float64) <= start.(float64) {
				problems = append(problems, textShotEndsBeforeStart(sid))
			}
			end = finish.(float64)
		}
		part := jscompat.Get(scene, "sequence")
		if !groups.has(part) {
			problems = append(problems, textShotUnknownPart(sid, jscompat.ToString(part)))
		}
		for _, field := range []struct {
			key     string
			problem func(string) string
		}{{"camera", textShotCameraMissing}, {"action", textShotActionMissing}} {
			// `!scene.camera?.trim()`: null/undefined — пустое поле, иное нестроковое значение — TypeError.
			value := jscompat.Get(scene, field.key)
			if jscompat.IsNullish(value) {
				problems = append(problems, field.problem(sid))
				continue
			}
			text, err := trimmedText(value, "scene."+field.key)
			if err != nil {
				return nil, err
			}
			if text == "" {
				problems = append(problems, field.problem(sid))
			}
		}
		list, err := jscompat.Iterate(jscompat.Get(scene, "references"))
		if err != nil {
			return nil, err
		}
		for _, ref := range list {
			if jscompat.StrictEqual(ref, "—") {
				continue
			}
			known, err := referenceKnown(references, ref)
			if err != nil {
				return nil, err
			}
			if !known {
				problems = append(problems, textShotUnknownReference(sid, jscompat.ToString(ref)))
			}
		}
		known, err := referenceKnown(references, jscompat.GetPath(scene, "card", "primary_reference"))
		if err != nil {
			return nil, err
		}
		if !known {
			problems = append(problems, textShotPrimaryReferenceMissing(sid))
		}
	}
	derived, err := DerivedFromProblems(scenes)
	if err != nil {
		return nil, err
	}
	problems = append(problems, derived...)
	audio := jscompat.Get(data, "audio")
	endSeconds := jscompat.ToNumber(jscompat.Get(audio, "end_seconds"))
	if math.IsNaN(endSeconds) || math.IsInf(endSeconds, 0) || math.Abs(end/FPS-endSeconds) >= 1.0/FPS {
		problems = append(problems, textRegistryDurationMismatch(jscompat.ToFixed(end/FPS, 3), jscompat.ToString(jscompat.Get(audio, "end_seconds"))))
	}
	if initial, err := cast.InitialStates(castValue); err != nil {
		problems = append(problems, err.Error())
	} else if _, err := ResolveStates(data, initial); err != nil {
		problems = append(problems, err.Error())
	}
	return problems, nil
}

// referenceKnown — `!!data.references[ref]`: обращение к свойству null/undefined — TypeError.
func referenceKnown(references, key any) (bool, error) {
	if jscompat.IsNullish(references) {
		_, err := jscompat.Prop(references, jscompat.ToString(key))
		return false, err
	}
	return jscompat.Truthy(jscompat.GetKey(references, key)), nil
}

// trimmedText — `value.trim()` с TypeError для нестроки.
func trimmedText(value any, name string) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", &jscompat.TypeError{Message: name + ".trim is not a function"}
	}
	return jscompat.Trim(text), nil
}

// DerivedFromProblems — derivedFromProblems (derived_from_problems инструментов): производный план
// ссылается объектом {"shot": "Mxx"} на существующий план с собственной генерацией. Отсутствующее
// поле означает обычный план.
func DerivedFromProblems(scenes []any) ([]string, error) {
	// `new Map(scenes.map((s) => [s.id, s]))`: при повторе кода побеждает последний план.
	find := func(id any) (any, bool) {
		for index := len(scenes) - 1; index >= 0; index-- {
			if jscompat.StrictEqual(jscompat.Get(scenes[index], "id"), id) {
				return scenes[index], true
			}
		}
		return nil, false
	}
	problems := []string{}
	for _, scene := range scenes {
		value := jscompat.Get(scene, "derived_from")
		if value == jscompat.Undefined {
			continue
		}
		sid := jscompat.ToString(jscompat.Get(scene, "id"))
		var source any
		if object, ok := jscompat.AsObject(value); ok {
			keys := object.Keys()
			if len(keys) == 1 && keys[0] == "shot" {
				source = object.Value("shot")
			}
		}
		text, isString := source.(string)
		switch {
		case !isString || !sceneID.MatchString(text):
			problems = append(problems, textDerivedInvalidShape(sid))
		case jscompat.StrictEqual(source, jscompat.Get(scene, "id")):
			problems = append(problems, textDerivedSelfReference(sid))
		default:
			origin, found := find(source)
			if !found {
				problems = append(problems, textDerivedUnknownSource(sid, text))
			} else if jscompat.Get(origin, "derived_from") != jscompat.Undefined {
				problems = append(problems, textDerivedChainedSource(sid, text))
			}
		}
	}
	return problems, nil
}

// valueSet — Set JS для значений из JSON (SameValueZero; NaN в JSON не встречается).
type valueSet struct{ items []any }

func (s *valueSet) has(value any) bool {
	for _, item := range s.items {
		if jscompat.StrictEqual(item, value) {
			return true
		}
	}
	return false
}
func (s *valueSet) add(value any) {
	if !s.has(value) {
		s.items = append(s.items, value)
	}
}
