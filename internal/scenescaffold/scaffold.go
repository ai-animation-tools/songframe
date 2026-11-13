// Package scenescaffold строит детерминированный каркас реестра сцен plan/scenes.json
// (инструмент scene_scaffold) из сохранённой трактовки (plan/treatment.json), разметки трека
// (plan/audio/timing.json), текста песни и кастинга.
//
// Каркас нарезает кадровые окна планов на кадровой сетке частоты проекта по строкам песни и частям трактовки,
// выводит карту references из кастинга и заполняет поля постановки заготовками; смысл планов
// (камера, действие, непрерывность, состояние) дописывает агент или редактор сценария. Результат
// проходит sceneregistry.Validate.
//
// Байты файла, вывод --json и текстовый, тексты ошибок и коды завершения (Run) зафиксированы
// эталоном testdata/golden/scene-scaffold. Значения — модель toolrt: числа трактовки и разметки
// читаются с различием целых и дробных, а сообщения содержат repr-запись значений toolrt.
// Трактовка может быть сохранена редактором черновиком с проблемами (scenario.SaveTreatment),
// поэтому каркас проверяет её сам (ValidateTreatment) и отказывает текстом проблемы.
package scenescaffold

import (
	"math/big"

	"songframe/internal/castregistry"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolrt"
)

// Пути документов каркаса и правила разбиения. Частота кадров берётся из plan/project.json и
// записывается в реестр: на ней строятся все границы планов.
const (
	TreatmentPath = "plan/treatment.json"
	TimingPath    = "plan/audio/timing.json"
	ScenesPath    = "plan/scenes.json"
	TextPath      = "source/text.md"
	// MinShotSeconds — наименьшая длина плана при разбиении части (полсекунды).
	MinShotSeconds = 0.5
	GapSeconds     = 2.5
	DefaultMaxShot = 6.0
	Placeholder    = "ЗАПОЛНИТЬ"
)

// maxPieces — предел числа равных кусков одного участка: такой список строился бы минутами и
// исчерпал бы память (шаг в доли кадра на длинном треке), поэтому инструмент сразу отказывает
// необработанной ошибкой «нехватка памяти».
const maxPieces = 100_000_000

// frame — номер кадра: seconds как дробное × fps, округлённое до целого с половиной к чётному.
func frame(seconds any, fps int64) (int64, error) {
	value, err := toolrt.Float(seconds)
	if err != nil {
		return 0, err
	}
	return toolrt.FloatToInt(value*float64(fps), true)
}

// trueDiv — частное a / b целых как корректно округлённое float64; деление на ноль — ZeroDivisionError.
func trueDiv(a, b int64) (float64, error) {
	if b == 0 {
		return 0, toolrt.Raise(toolrt.ZeroDivisionError, "деление на ноль")
	}
	value, _ := new(big.Rat).SetFrac(big.NewInt(a), big.NewInt(b)).Float64()
	return value, nil
}

// ValidateTreatment — части трактовки покрывают трек без
// разрывов и наложений (допуск 0,06 с); возвращает части, отсортированные по началу.
func ValidateTreatment(data any, duration float64) ([]any, error) {
	document, ok := data.(*toolrt.Dict)
	parts, isList := document.Value("sequences").([]any)
	if !ok || !toolrt.Equal(document.Value("schema_version"), toolrt.NewInt(1)) || !isList || len(parts) == 0 {
		return nil, toolrt.Raise(toolrt.ValueError, "plan/treatment.json: нужны schema_version 1 и непустой список sequences.")
	}
	keys := make([]any, len(parts))
	for index, part := range parts {
		start, err := toolrt.GetItem(part, "start")
		if err != nil {
			return nil, err
		}
		if keys[index], err = toolrt.Float(start); err != nil {
			return nil, err
		}
	}
	sorted, err := toolrt.SortByKeys(parts, keys)
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
			return nil, toolrt.Raise(toolrt.ValueError, "Часть без уникального id: %s", toolrt.Repr(part))
		}
		seen[id] = true
		startValue, err := toolrt.GetItem(part, "start")
		if err != nil {
			return nil, err
		}
		start, err := toolrt.Float(startValue)
		if err != nil {
			return nil, err
		}
		endValue, err := toolrt.GetItem(part, "end")
		if err != nil {
			return nil, err
		}
		end, err := toolrt.Float(endValue)
		if err != nil {
			return nil, err
		}
		if abs(start-cursor) > 0.06 || end <= start {
			return nil, toolrt.Raise(toolrt.ValueError, "Часть %s: начало %s не стыкуется с %s или конец раньше начала.", id, toolrt.FloatRepr(start), toolrt.FormatFixed(cursor, 2))
		}
		cursor = end
	}
	if abs(cursor-duration) > 0.06 {
		return nil, toolrt.Raise(toolrt.ValueError, "Части заканчиваются на %s, а трек длится %s.", toolrt.FormatFixed(cursor, 2), toolrt.FormatFixed(duration, 2))
	}
	return sorted, nil
}

// abs — модуль дробного числа с сохранением NaN (сравнение с NaN ложно).
func abs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

// asDict — часть трактовки как словарь: не-словарь — AttributeError (текст зафиксирован эталоном).
func asDict(value any) (*toolrt.Dict, error) {
	dict, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(value))
	}
	return dict, nil
}

// midpointFrame — frame((line["start"] + line["end"]) / 2): кадр середины строки песни.
func midpointFrame(line any, fps int64) (int64, error) {
	start, err := toolrt.GetItem(line, "start")
	if err != nil {
		return 0, err
	}
	end, err := toolrt.GetItem(line, "end")
	if err != nil {
		return 0, err
	}
	sum, err := toolrt.Add(start, end)
	if err != nil {
		return 0, err
	}
	middle, err := toolrt.TrueDiv(sum, toolrt.NewInt(2))
	if err != nil {
		return 0, err
	}
	return frame(middle, fps)
}

// lineFrame — frame(line[key]).
func lineFrame(line any, key string, fps int64) (int64, error) {
	value, err := toolrt.GetItem(line, key)
	if err != nil {
		return 0, err
	}
	return frame(value, fps)
}

// maxShotSeconds — max_shot_seconds части как дробное, по умолчанию 6.0.
func maxShotSeconds(part *toolrt.Dict) (float64, error) {
	value, _ := toolrt.DictGet(part, "max_shot_seconds", DefaultMaxShot)
	return toolrt.Float(value)
}

// pieces — start + round(length * index / count) для index от 1 до count-1.
func pieces(start, length, count int64) ([]int64, error) {
	if count > maxPieces {
		return nil, toolrt.New("MemoryError", "нехватка памяти: участок делится на слишком много частей")
	}
	result := []int64{}
	for index := int64(1); index < count; index++ {
		offset, err := trueDiv(length*index, count)
		if err != nil {
			return nil, err
		}
		rounded, err := toolrt.FloatToInt(offset, true)
		if err != nil {
			return nil, err
		}
		result = append(result, start+rounded)
	}
	return result, nil
}

// ShotBoundaries — начала планов внутри части в кадрах и
// строки песни, середина которых попадает в часть. Границы — начала строк (пауза до первой и после
// последней строки длиннее 2,5 с — отдельный план), часть без строк делится на равные куски по
// max_shot_seconds; планы короче 15 кадров сливаются, длинный кусок без строки делится на равные
// планы не длиннее шага.
func ShotBoundaries(part *toolrt.Dict, lines []any, endFrame, fps int64) ([]int64, []any, error) {
	start, err := lineFrame(part, "start", fps)
	if err != nil {
		return nil, nil, err
	}
	inside := []any{}
	for _, line := range lines {
		middle, err := midpointFrame(line, fps)
		if err != nil {
			return nil, nil, err
		}
		if start <= middle && middle < endFrame {
			inside = append(inside, line)
		}
	}
	gap, _ := frame(GapSeconds, fps)
	boundaries := []int64{start}
	if len(inside) > 0 {
		first, err := lineFrame(inside[0], "start", fps)
		if err != nil {
			return nil, nil, err
		}
		if first-start >= gap {
			boundaries = append(boundaries, first)
		}
		for _, line := range inside[1:] {
			value, err := lineFrame(line, "start", fps)
			if err != nil {
				return nil, nil, err
			}
			boundaries = append(boundaries, value)
		}
		lastEnd, err := lineFrame(inside[len(inside)-1], "end", fps)
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
		seconds, err := trueDiv(endFrame-start, fps)
		if err != nil {
			return nil, nil, err
		}
		if step == 0 {
			return nil, nil, toolrt.Raise(toolrt.ZeroDivisionError, "деление на ноль")
		}
		rounded, err := toolrt.FloatToInt(seconds/step, true)
		if err != nil {
			return nil, nil, err
		}
		extra, err := pieces(start, endFrame-start, max(1, rounded))
		if err != nil {
			return nil, nil, err
		}
		boundaries = append(boundaries, extra...)
	}
	// minShot — полсекунды в кадрах проекта (15 при 30 к/с).
	minShot, _ := toolrt.FloatToInt(MinShotSeconds*float64(fps), true)
	cleaned := []int64{boundaries[0]}
	for _, value := range boundaries[1:] {
		if value-cleaned[len(cleaned)-1] >= minShot && endFrame-value >= minShot {
			cleaned = append(cleaned, value)
		}
	}
	step, err := maxShotSeconds(part)
	if err != nil {
		return nil, nil, err
	}
	stepFrames, err := toolrt.FloatToInt(step*float64(fps), false)
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
			middle, _ := midpointFrame(line, fps)
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
			count, err := toolrt.FloatToInt(ratio, true)
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

// FormatSeconds — запись с шестью знаками после точки без хвостовых нулей и точки.
func FormatSeconds(value float64) string {
	text := toolrt.FormatFixed(value, 6)
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
func originalText(part *toolrt.Dict, covering []any, textLines []string) (string, error) {
	pieces := []string{}
	count := toolrt.NewInt(int64(len(textLines)))
	items := make([]any, len(textLines))
	for position, text := range textLines {
		items[position] = text
	}
	for _, line := range covering {
		number, err := toolrt.GetItem(line, "source_line")
		if err != nil {
			return "", err
		}
		positive, err := toolrt.Less(toolrt.NewInt(0), number)
		if err != nil {
			return "", err
		}
		if !positive {
			continue
		}
		within, err := toolrt.LessEqual(number, count)
		if err != nil {
			return "", err
		}
		if !within {
			continue
		}
		index, err := toolrt.Sub(number, toolrt.NewInt(1))
		if err != nil {
			return "", err
		}
		text, err := toolrt.GetItem(items, index)
		if err != nil {
			return "", err
		}
		pieces = append(pieces, toolrt.Strip(text.(string)))
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
	return "Инструментал: " + toolrt.Str(title), nil
}

// partTitle — title части, иначе её id; id читается заранее (без id — KeyError даже при наличии title).
func partTitle(part *toolrt.Dict) (any, error) {
	id, err := toolrt.GetItem(part, "id")
	if err != nil {
		return nil, err
	}
	return toolrt.DictGet(part, "title", id)
}

// BuildScenes — реестр сцен —
// последовательности из частей трактовки, планы по ShotBoundaries, заготовки полей постановки,
// references из кастинга и visual_direction из прежнего реестра (existing, может быть nil) или
// заготовка. initial — начальное состояние кастинга для итоговой проверки Validate.
func BuildScenes(treatment any, timing *toolrt.Dict, textLines []string, cast *toolrt.Dict, duration float64, existing *toolrt.Dict, initial *toolrt.Dict, fps int64) (*toolrt.Dict, error) {
	parts, err := ValidateTreatment(treatment, duration)
	if err != nil {
		return nil, err
	}
	refs := toolrt.NewDict()
	if cast.Len() > 0 {
		if refs, err = castregistry.References(cast); err != nil {
			return nil, err
		}
	}
	lineList, _ := toolrt.DictGet(timing, "lines", []any{})
	lineItems, err := toolrt.Iter(lineList)
	if err != nil {
		return nil, err
	}
	keys := make([]any, len(lineItems))
	for index, line := range lineItems {
		if keys[index], err = toolrt.GetItem(line, "start"); err != nil {
			return nil, err
		}
	}
	lines, err := toolrt.SortByKeys(lineItems, keys)
	if err != nil {
		return nil, err
	}
	totalEnd, err := frame(duration, fps)
	if err != nil {
		return nil, err
	}
	sequences := make([]any, 0, len(parts))
	for _, item := range parts {
		part := item.(*toolrt.Dict)
		title, err := partTitle(part)
		if err != nil {
			return nil, err
		}
		direction, _ := toolrt.DictGet(part, "direction", "")
		sequence := toolrt.NewDict()
		sequence.Set("id", part.Value("id"))
		sequence.Set("title", title)
		sequence.Set("direction", direction)
		sequences = append(sequences, sequence)
	}
	scenes := []any{}
	var previous any
	for index, item := range parts {
		part := item.(*toolrt.Dict)
		endFrame := totalEnd
		if index != len(parts)-1 {
			if endFrame, err = lineFrame(parts[index+1], "start", fps); err != nil {
				return nil, err
			}
		}
		boundaries, inside, err := ShotBoundaries(part, lines, endFrame, fps)
		if err != nil {
			return nil, err
		}
		entityList, _ := toolrt.DictGet(part, "entities", []any{})
		entityItems, err := toolrt.Iter(entityList)
		if err != nil {
			return nil, err
		}
		entities := []any{}
		for _, entity := range entityItems {
			found, err := toolrt.Contains(refs, entity)
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
				middle, _ := midpointFrame(line, fps)
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
				return nil, toolrt.Raise(toolrt.ValueError, "Больше 99 планов: укрупните части или увеличьте max_shot_seconds.")
			}
			sid := "M" + leftPad(number)
			scene := toolrt.NewDict()
			scene.Set("id", sid)
			scene.Set("original", original)
			scene.Set("sequence", part.Value("id"))
			scene.Set("start_frame", toolrt.NewInt(start))
			scene.Set("end_frame_exclusive", toolrt.NewInt(end))
			scene.Set("camera", Placeholder)
			scene.Set("action", Placeholder+": "+original)
			scene.Set("continuity", "")
			if len(entities) > 0 {
				scene.Set("references", append([]any(nil), entities...))
			} else {
				scene.Set("references", []any{"—"})
			}
			lipsync, _ := toolrt.DictGet(part, "lipsync", false)
			scene.Set("lipsync", toolrt.Truthy(lipsync) && len(covering) > 0)
			card := toolrt.NewDict()
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
			scene.Set("state_changes", toolrt.NewDict())
			scenes = append(scenes, scene)
			previous = sid
		}
	}
	audio := toolrt.NewDict()
	audio.Set("path", "source/track.mp3")
	audio.Set("end_seconds", FormatSeconds(duration))
	visual := existing.Value("visual_direction")
	if !toolrt.Truthy(visual) {
		visual = Placeholder + ": общие визуальные правила клипа (стиль, формат, возраст героев, сезон, свет)."
	}
	data := toolrt.NewDict()
	data.Set("schema_version", toolrt.NewInt(1))
	data.Set("fps", toolrt.NewInt(fps))
	data.Set("audio", audio)
	data.Set("references", refs)
	data.Set("visual_direction", visual)
	data.Set("sequences", sequences)
	data.Set("scenes", scenes)
	if refs.Len() == 0 {
		return nil, toolrt.Raise(toolrt.ValueError, "В кастинге нет сущностей с изображениями: карточкам планов нужен хотя бы один референс.")
	}
	if _, err := sceneregistry.Validate(data, initial); err != nil {
		return nil, err
	}
	return data, nil
}

// leftPad — двузначная запись положительного номера плана (с ведущим нулём).
func leftPad(number int) string {
	if number < 10 {
		return "0" + string(rune('0'+number))
	}
	return big.NewInt(int64(number)).String()
}
