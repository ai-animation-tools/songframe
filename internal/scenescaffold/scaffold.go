// Package scenescaffold — перенос tools/scene_scaffold/scene_scaffold.py замороженного оригинала:
// детерминированный каркас реестра сцен plan/scenes.json из сохранённой трактовки
// (plan/treatment.json), разметки трека (plan/audio/timing.json), текста песни и кастинга.
//
// Каркас нарезает кадровые окна планов на сетке 30 кадров/с по строкам песни и частям трактовки,
// выводит карту references из кастинга и заполняет поля постановки заготовками; смысл планов
// (камера, действие, непрерывность, состояние) дописывает агент или редактор сценария. Результат
// проходит sceneregistry.Validate.
//
// Перенос сохраняет поведение Python-инструмента целиком: те же байты файла, вывод --json и
// текстовый, тексты ошибок и коды завершения (Run). Значения — модель pycompat: числа трактовки и
// разметки читаются с различием int/float, а сообщения повторяют repr Python. Трактовка может быть
// сохранена редактором черновиком с проблемами (scenario.SaveTreatment); каркас, как и оригинал,
// проверяет её сам (ValidateTreatment) и отказывает тем же текстом.
package scenescaffold

import (
	"math/big"

	"songframe-go/internal/castregistry"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/sceneregistry"
)

// Константы оригинала.
const (
	FPS            = 30
	TreatmentPath  = "plan/treatment.json"
	TimingPath     = "plan/audio/timing.json"
	ScenesPath     = "plan/scenes.json"
	TextPath       = "source/text.md"
	MinShotFrames  = 15
	GapSeconds     = 2.5
	DefaultMaxShot = 6.0
	Placeholder    = "ЗАПОЛНИТЬ"
)

// maxPieces — предел числа равных кусков одного участка. Python строил бы такой список минутами и
// исчерпал память (шаг в доли кадра на длинном треке); Go отказывает сразу MemoryError.
const maxPieces = 100_000_000

// frame — frame(seconds): int(round(float(seconds) * 30)) с половиной к чётному.
func frame(seconds any) (int64, error) {
	value, err := pycompat.Float(seconds)
	if err != nil {
		return 0, err
	}
	return pycompat.FloatToInt(value*FPS, true)
}

// trueDiv — a / b целых Python: корректно округлённое частное.
func trueDiv(a, b int64) (float64, error) {
	if b == 0 {
		return 0, pycompat.Raise(pycompat.ZeroDivisionError, "division by zero")
	}
	value, _ := new(big.Rat).SetFrac(big.NewInt(a), big.NewInt(b)).Float64()
	return value, nil
}

// ValidateTreatment — validate_treatment(data, duration): части трактовки покрывают трек без
// разрывов и наложений (допуск 0,06 с); возвращает части, отсортированные по началу.
func ValidateTreatment(data any, duration float64) ([]any, error) {
	document, ok := data.(*pycompat.Dict)
	parts, isList := document.Value("sequences").([]any)
	if !ok || !pycompat.Equal(document.Value("schema_version"), pycompat.NewInt(1)) || !isList || len(parts) == 0 {
		return nil, pycompat.Raise(pycompat.ValueError, "plan/treatment.json: нужны schema_version 1 и непустой список sequences.")
	}
	keys := make([]any, len(parts))
	for index, part := range parts {
		start, err := pycompat.GetItem(part, "start")
		if err != nil {
			return nil, err
		}
		if keys[index], err = pycompat.Float(start); err != nil {
			return nil, err
		}
	}
	sorted, err := pycompat.SortByKeys(parts, keys)
	if err != nil {
		return nil, err
	}
	cursor := 0.0
	seen := map[string]bool{}
	for _, item := range sorted {
		part, err := asDict(item)
		if err != nil {
			return nil, err
		}
		id, isString := part.Value("id").(string)
		if !isString || id == "" || seen[id] {
			return nil, pycompat.Raise(pycompat.ValueError, "Часть без уникального id: %s", pycompat.Repr(part))
		}
		seen[id] = true
		startValue, err := pycompat.GetItem(part, "start")
		if err != nil {
			return nil, err
		}
		start, err := pycompat.Float(startValue)
		if err != nil {
			return nil, err
		}
		endValue, err := pycompat.GetItem(part, "end")
		if err != nil {
			return nil, err
		}
		end, err := pycompat.Float(endValue)
		if err != nil {
			return nil, err
		}
		if abs(start-cursor) > 0.06 || end <= start {
			return nil, pycompat.Raise(pycompat.ValueError, "Часть %s: начало %s не стыкуется с %s или конец раньше начала.", id, pycompat.FloatRepr(start), pycompat.FormatFixed(cursor, 2))
		}
		cursor = end
	}
	if abs(cursor-duration) > 0.06 {
		return nil, pycompat.Raise(pycompat.ValueError, "Части заканчиваются на %s, а трек длится %s.", pycompat.FormatFixed(cursor, 2), pycompat.FormatFixed(duration, 2))
	}
	return sorted, nil
}

// abs — abs(float) с сохранением NaN (сравнение с NaN ложно, как в Python).
func abs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

// asDict — часть, у которой оригинал вызывает .get: не-словарь — AttributeError.
func asDict(value any) (*pycompat.Dict, error) {
	dict, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'get'", pycompat.TypeName(value))
	}
	return dict, nil
}

// midpointFrame — frame((line["start"] + line["end"]) / 2): кадр середины строки песни.
func midpointFrame(line any) (int64, error) {
	start, err := pycompat.GetItem(line, "start")
	if err != nil {
		return 0, err
	}
	end, err := pycompat.GetItem(line, "end")
	if err != nil {
		return 0, err
	}
	sum, err := pycompat.Add(start, end)
	if err != nil {
		return 0, err
	}
	middle, err := pycompat.TrueDiv(sum, pycompat.NewInt(2))
	if err != nil {
		return 0, err
	}
	return frame(middle)
}

// lineFrame — frame(line[key]).
func lineFrame(line any, key string) (int64, error) {
	value, err := pycompat.GetItem(line, key)
	if err != nil {
		return 0, err
	}
	return frame(value)
}

// maxShotSeconds — float(part.get("max_shot_seconds", 6.0)).
func maxShotSeconds(part *pycompat.Dict) (float64, error) {
	value, _ := pycompat.DictGet(part, "max_shot_seconds", DefaultMaxShot)
	return pycompat.Float(value)
}

// pieces — start + round(length * index / count) для index от 1 до count-1.
func pieces(start, length, count int64) ([]int64, error) {
	if count > maxPieces {
		return nil, pycompat.New("MemoryError", "")
	}
	result := []int64{}
	for index := int64(1); index < count; index++ {
		offset, err := trueDiv(length*index, count)
		if err != nil {
			return nil, err
		}
		rounded, err := pycompat.FloatToInt(offset, true)
		if err != nil {
			return nil, err
		}
		result = append(result, start+rounded)
	}
	return result, nil
}

// ShotBoundaries — shot_boundaries(part, lines, end_frame): начала планов внутри части в кадрах и
// строки песни, середина которых попадает в часть. Границы — начала строк (пауза до первой и после
// последней строки длиннее 2,5 с — отдельный план), часть без строк делится на равные куски по
// max_shot_seconds; планы короче 15 кадров сливаются, длинный кусок без строки делится на равные
// планы не длиннее шага.
func ShotBoundaries(part *pycompat.Dict, lines []any, endFrame int64) ([]int64, []any, error) {
	start, err := lineFrame(part, "start")
	if err != nil {
		return nil, nil, err
	}
	inside := []any{}
	for _, line := range lines {
		middle, err := midpointFrame(line)
		if err != nil {
			return nil, nil, err
		}
		if start <= middle && middle < endFrame {
			inside = append(inside, line)
		}
	}
	gap, _ := frame(GapSeconds)
	boundaries := []int64{start}
	if len(inside) > 0 {
		first, err := lineFrame(inside[0], "start")
		if err != nil {
			return nil, nil, err
		}
		if first-start >= gap {
			boundaries = append(boundaries, first)
		}
		for _, line := range inside[1:] {
			value, err := lineFrame(line, "start")
			if err != nil {
				return nil, nil, err
			}
			boundaries = append(boundaries, value)
		}
		lastEnd, err := lineFrame(inside[len(inside)-1], "end")
		if err != nil {
			return nil, nil, err
		}
		if endFrame-lastEnd >= gap {
			boundaries = append(boundaries, lastEnd)
		}
	} else {
		step, err := maxShotSeconds(part)
		if err != nil {
			return nil, nil, err
		}
		seconds, err := trueDiv(endFrame-start, FPS)
		if err != nil {
			return nil, nil, err
		}
		if step == 0 {
			return nil, nil, pycompat.Raise(pycompat.ZeroDivisionError, "float division by zero")
		}
		rounded, err := pycompat.FloatToInt(seconds/step, true)
		if err != nil {
			return nil, nil, err
		}
		extra, err := pieces(start, endFrame-start, max(1, rounded))
		if err != nil {
			return nil, nil, err
		}
		boundaries = append(boundaries, extra...)
	}
	cleaned := []int64{boundaries[0]}
	for _, value := range boundaries[1:] {
		if value-cleaned[len(cleaned)-1] >= MinShotFrames && endFrame-value >= MinShotFrames {
			cleaned = append(cleaned, value)
		}
	}
	step, err := maxShotSeconds(part)
	if err != nil {
		return nil, nil, err
	}
	stepFrames, err := pycompat.FloatToInt(step*FPS, false)
	if err != nil {
		return nil, nil, err
	}
	result := []int64{}
	for index, startAt := range cleaned {
		stopAt := endFrame
		if index+1 < len(cleaned) {
			stopAt = cleaned[index+1]
		}
		result = append(result, startAt)
		hasLine := false
		for _, line := range inside {
			middle, _ := midpointFrame(line)
			if startAt <= middle && middle < stopAt {
				hasLine = true
				break
			}
		}
		if !hasLine && float64(stopAt-startAt) > float64(stepFrames)*1.5 {
			ratio, err := trueDiv(stopAt-startAt, stepFrames)
			if err != nil {
				return nil, nil, err
			}
			count, err := pycompat.FloatToInt(ratio, true)
			if err != nil {
				return nil, nil, err
			}
			extra, err := pieces(startAt, stopAt-startAt, count)
			if err != nil {
				return nil, nil, err
			}
			result = append(result, extra...)
		}
	}
	return result, inside, nil
}

// FormatSeconds — format_seconds(value): f"{float(value):.6f}" без хвостовых нулей и точки.
func FormatSeconds(value float64) string {
	text := pycompat.FormatFixed(value, 6)
	for len(text) > 0 && text[len(text)-1] == '0' {
		text = text[:len(text)-1]
	}
	for len(text) > 0 && text[len(text)-1] == '.' {
		text = text[:len(text)-1]
	}
	if text == "" {
		return "0"
	}
	return text
}

// originalText — строки песни плана через « / » или «Инструментал: <часть>».
func originalText(part *pycompat.Dict, covering []any, textLines []string) (string, error) {
	pieces := []string{}
	count := pycompat.NewInt(int64(len(textLines)))
	items := make([]any, len(textLines))
	for position, text := range textLines {
		items[position] = text
	}
	for _, line := range covering {
		number, err := pycompat.GetItem(line, "source_line")
		if err != nil {
			return "", err
		}
		positive, err := pycompat.Less(pycompat.NewInt(0), number)
		if err != nil {
			return "", err
		}
		if !positive {
			continue
		}
		within, err := pycompat.LessEqual(number, count)
		if err != nil {
			return "", err
		}
		if !within {
			continue
		}
		index, err := pycompat.Sub(number, pycompat.NewInt(1))
		if err != nil {
			return "", err
		}
		text, err := pycompat.GetItem(items, index)
		if err != nil {
			return "", err
		}
		pieces = append(pieces, pycompat.Strip(text.(string)))
	}
	joined := ""
	for index, piece := range pieces {
		if index > 0 {
			joined += " / "
		}
		joined += piece
	}
	if joined != "" {
		return joined, nil
	}
	title, err := partTitle(part)
	if err != nil {
		return "", err
	}
	return "Инструментал: " + pycompat.Str(title), nil
}

// partTitle — part.get("title", part["id"]): id вычисляется заранее, как аргумент get.
func partTitle(part *pycompat.Dict) (any, error) {
	id, err := pycompat.GetItem(part, "id")
	if err != nil {
		return nil, err
	}
	return pycompat.DictGet(part, "title", id)
}

// BuildScenes — build_scenes(treatment, timing, textLines, cast, duration, existing): реестр сцен —
// последовательности из частей трактовки, планы по ShotBoundaries, заготовки полей постановки,
// references из кастинга и visual_direction из прежнего реестра (existing, может быть nil) или
// заготовка. initial — начальное состояние кастинга для итоговой проверки Validate.
func BuildScenes(treatment any, timing *pycompat.Dict, textLines []string, cast *pycompat.Dict, duration float64, existing *pycompat.Dict, initial *pycompat.Dict) (*pycompat.Dict, error) {
	parts, err := ValidateTreatment(treatment, duration)
	if err != nil {
		return nil, err
	}
	refs := pycompat.NewDict()
	if cast.Len() > 0 {
		if refs, err = castregistry.References(cast); err != nil {
			return nil, err
		}
	}
	lineList, _ := pycompat.DictGet(timing, "lines", []any{})
	lineItems, err := pycompat.Iter(lineList)
	if err != nil {
		return nil, err
	}
	keys := make([]any, len(lineItems))
	for index, line := range lineItems {
		if keys[index], err = pycompat.GetItem(line, "start"); err != nil {
			return nil, err
		}
	}
	lines, err := pycompat.SortByKeys(lineItems, keys)
	if err != nil {
		return nil, err
	}
	totalEnd, err := frame(duration)
	if err != nil {
		return nil, err
	}
	sequences := make([]any, 0, len(parts))
	for _, item := range parts {
		part := item.(*pycompat.Dict)
		title, err := partTitle(part)
		if err != nil {
			return nil, err
		}
		direction, _ := pycompat.DictGet(part, "direction", "")
		sequence := pycompat.NewDict()
		sequence.Set("id", part.Value("id"))
		sequence.Set("title", title)
		sequence.Set("direction", direction)
		sequences = append(sequences, sequence)
	}
	scenes := []any{}
	var previous any
	for index, item := range parts {
		part := item.(*pycompat.Dict)
		endFrame := totalEnd
		if index != len(parts)-1 {
			if endFrame, err = lineFrame(parts[index+1], "start"); err != nil {
				return nil, err
			}
		}
		boundaries, inside, err := ShotBoundaries(part, lines, endFrame)
		if err != nil {
			return nil, err
		}
		entityList, _ := pycompat.DictGet(part, "entities", []any{})
		entityItems, err := pycompat.Iter(entityList)
		if err != nil {
			return nil, err
		}
		entities := []any{}
		for _, entity := range entityItems {
			found, err := pycompat.Contains(refs, entity)
			if err != nil {
				return nil, err
			}
			if found {
				entities = append(entities, entity)
			}
		}
		for position, start := range boundaries {
			end := endFrame
			if position+1 < len(boundaries) {
				end = boundaries[position+1]
			}
			covering := []any{}
			for _, line := range inside {
				middle, _ := midpointFrame(line)
				if start <= middle && middle < end {
					covering = append(covering, line)
				}
			}
			original, err := originalText(part, covering, textLines)
			if err != nil {
				return nil, err
			}
			number := len(scenes) + 1
			if number > 99 {
				return nil, pycompat.Raise(pycompat.ValueError, "Больше 99 планов: укрупните части или увеличьте max_shot_seconds.")
			}
			sid := "M" + leftPad(number)
			scene := pycompat.NewDict()
			scene.Set("id", sid)
			scene.Set("original", original)
			scene.Set("sequence", part.Value("id"))
			scene.Set("start_frame", pycompat.NewInt(start))
			scene.Set("end_frame_exclusive", pycompat.NewInt(end))
			scene.Set("camera", Placeholder)
			scene.Set("action", Placeholder+": "+original)
			scene.Set("continuity", "")
			if len(entities) > 0 {
				scene.Set("references", append([]any(nil), entities...))
			} else {
				scene.Set("references", []any{"—"})
			}
			lipsync, _ := pycompat.DictGet(part, "lipsync", false)
			scene.Set("lipsync", pycompat.Truthy(lipsync) && len(covering) > 0)
			card := pycompat.NewDict()
			switch {
			case len(entities) > 0:
				card.Set("primary_reference", entities[0])
			case refs.Len() > 0:
				card.Set("primary_reference", refs.Keys()[0])
			default:
				card.Set("primary_reference", "")
			}
			scene.Set("card", card)
			scene.Set("state_from", previous)
			scene.Set("state_changes", pycompat.NewDict())
			scenes = append(scenes, scene)
			previous = sid
		}
	}
	audio := pycompat.NewDict()
	audio.Set("path", "source/track.mp3")
	audio.Set("end_seconds", FormatSeconds(duration))
	visual := existing.Value("visual_direction")
	if !pycompat.Truthy(visual) {
		visual = Placeholder + ": общие визуальные правила клипа (стиль, формат, возраст героев, сезон, свет)."
	}
	data := pycompat.NewDict()
	data.Set("schema_version", pycompat.NewInt(1))
	data.Set("fps", pycompat.NewInt(FPS))
	data.Set("audio", audio)
	data.Set("references", refs)
	data.Set("visual_direction", visual)
	data.Set("sequences", sequences)
	data.Set("scenes", scenes)
	if refs.Len() == 0 {
		return nil, pycompat.Raise(pycompat.ValueError, "В кастинге нет сущностей с изображениями: карточкам планов нужен хотя бы один референс.")
	}
	if _, err := sceneregistry.Validate(data, initial); err != nil {
		return nil, err
	}
	return data, nil
}

// leftPad — f"{number:02d}" для положительного номера плана.
func leftPad(number int) string {
	if number < 10 {
		return "0" + string(rune('0'+number))
	}
	return big.NewInt(int64(number)).String()
}
