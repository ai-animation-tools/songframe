package timing

import (
	"math"
	"sort"

	"songframe-go/internal/jscompat"
)

// MinTimingLength — минимальная длина размеченной строки в секундах.
const MinTimingLength = 0.3

// Тексты timingTexts.main для проверки разметки.
const (
	invalidCandidates = "Предложения границ повреждены. Обновите автоматическую разметку или исправьте предложения."
	invalidLineOrder  = "Порядок строк содержит повторы или ссылки на отсутствующие строки текста."
)

func duplicateID(id any) string { return "Повторяется id " + jscompat.ToString(id) + "." }
func duplicateSourceLine(id, line any) string {
	return "строка " + jscompat.ToString(id) + ": строка текста " + jscompat.ToString(line) + " размечена дважды."
}
func missingSourceLine(id, line any) string {
	return "строка " + jscompat.ToString(id) + ": в тексте нет строки песни с номером " + jscompat.ToString(line) + "."
}
func invalidBoundaries(id any) string {
	return "строка " + jscompat.ToString(id) + ": границы не числа."
}
func lineTooShort(id any) string {
	return "строка " + jscompat.ToString(id) + ": длиннее " + jscompat.NumberToString(MinTimingLength) + " с должна быть каждая строка."
}
func negativeStart(id any) string {
	return "строка " + jscompat.ToString(id) + ": начало раньше нуля."
}
func endOutsideTrack(id any) string {
	return "строка " + jscompat.ToString(id) + ": конец за пределами трека."
}
func overlappingLines(first, second any) string {
	return "Строки " + jscompat.ToString(first) + " и " + jscompat.ToString(second) + " пересекаются."
}

// HasMinimumTimingLength — длина не короче MinTimingLength с допуском в наносекунду: вычитание
// десятичных секунд может сделать законные 300 мс чуть короче порога.
func HasMinimumTimingLength(start, end float64) bool {
	return jscompat.IsFinite(start) && jscompat.IsFinite(end) && end-start >= MinTimingLength-1e-9
}

// ValidTimingCandidates — validTimingCandidates: массив непринятых предложений границ, каждое —
// объект с положительным целым source_line, 0 ≤ start < end, непустым reason и оценкой в [0, 1].
// Предложения не обязаны быть непересекающимися.
func ValidTimingCandidates(value any) bool {
	items, ok := jscompat.AsArray(value)
	if !ok {
		return false
	}
	for _, candidate := range items {
		if !jscompat.Truthy(candidate) || jscompat.TypeOf(candidate) != "object" {
			return false
		}
		line := jscompat.Get(candidate, "source_line")
		start, startOK := jscompat.Get(candidate, "start").(float64)
		end, endOK := jscompat.Get(candidate, "end").(float64)
		note := jscompat.Get(candidate, "note")
		reason, reasonOK := jscompat.Get(candidate, "reason").(string)
		score := jscompat.Get(candidate, "acoustic_score")
		if !jscompat.IsSafeInteger(line) || !(jscompat.ToNumber(line) > 0) ||
			!startOK || !jscompat.IsFinite(start) || !(start >= 0) ||
			!endOK || !jscompat.IsFinite(end) || !(end > start) ||
			!(note == jscompat.Undefined || jscompat.TypeOf(note) == "string") ||
			!reasonOK || jscompat.Trim(reason) == "" {
			return false
		}
		if score != jscompat.Undefined {
			value, isNumber := score.(float64)
			if !isNumber || !jscompat.IsFinite(value) || !(value >= 0) || !(value <= 1) {
				return false
			}
		}
	}
	return true
}

// lyricIndex — Map номера строки текста; ключ ищется по SameValueZero, поэтому совпадает только
// числовое значение.
type lyricIndex map[float64]LyricsLine

func (index lyricIndex) get(number any) (LyricsLine, bool) {
	value, ok := number.(float64)
	if !ok {
		return LyricsLine{}, false
	}
	line, found := index[value]
	return line, found
}

// Validate — validateTiming(timing, lyrics, duration): проблемы разметки в порядке оригинала;
// пустой список означает, что файл можно сохранить. timing — недоверенный документ (дерево
// jscompat), duration nil или 0 — длительность неизвестна. Ошибка — исключение оригинала
// (например, lines не массив), при котором сохранение тоже отклоняется.
func Validate(timing any, lyrics []LyricsLine, duration *float64) ([]string, error) {
	problems := []string{}
	byNumber := lyricIndex{}
	for _, lyric := range lyrics {
		byNumber[float64(lyric.Number)] = lyric
	}
	knownDuration := duration != nil && *duration != 0 && !math.IsNaN(*duration)
	lines, err := jscompat.Iterate(jscompat.Get(timing, "lines"))
	if err != nil {
		return nil, err
	}
	ids := map[any]bool{}
	numbers := map[any]bool{}
	for _, line := range lines {
		id, err := jscompat.Prop(line, "id")
		if err != nil {
			return nil, err
		}
		if ids[id] {
			problems = append(problems, duplicateID(id))
		}
		ids[id] = true
		source := jscompat.Get(line, "source_line")
		if numbers[source] {
			problems = append(problems, duplicateSourceLine(id, source))
		}
		numbers[source] = true
		if lyric, ok := byNumber.get(source); !ok || lyric.Header || lyric.Text == "" {
			problems = append(problems, missingSourceLine(id, source))
		}
		start, end := jscompat.Get(line, "start"), jscompat.Get(line, "end")
		switch {
		case !jscompat.IsFinite(start) || !jscompat.IsFinite(end):
			problems = append(problems, invalidBoundaries(id))
		case !HasMinimumTimingLength(start.(float64), end.(float64)):
			problems = append(problems, lineTooShort(id))
		case start.(float64) < 0:
			problems = append(problems, negativeStart(id))
		case knownDuration && end.(float64) > *duration+0.5:
			problems = append(problems, endOutsideTrack(id))
		}
	}
	if candidates := jscompat.Get(timing, "candidates"); candidates != jscompat.Undefined {
		if !ValidTimingCandidates(candidates) {
			problems = append(problems, invalidCandidates)
		} else {
			seen := map[any]bool{}
			items, _ := jscompat.AsArray(candidates)
			for _, candidate := range items {
				source := jscompat.Get(candidate, "source_line")
				lyric, ok := byNumber.get(source)
				end := jscompat.Get(candidate, "end").(float64)
				if seen[source] || !ok || lyric.Header || jscompat.Trim(lyric.Text) == "" || (knownDuration && end > *duration+0.5) {
					problems = append(problems, invalidCandidates)
				}
				seen[source] = true
			}
		}
	}
	if order := jscompat.Get(timing, "line_order"); order != jscompat.Undefined && !validLineOrder(order, byNumber) {
		problems = append(problems, invalidLineOrder)
	}
	ordered := append([]any(nil), lines...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return jscompat.ToNumber(jscompat.Get(ordered[i], "start"))-jscompat.ToNumber(jscompat.Get(ordered[j], "start")) < 0
	})
	for index := 1; index < len(ordered); index++ {
		if jscompat.ToNumber(jscompat.Get(ordered[index], "start")) < jscompat.ToNumber(jscompat.Get(ordered[index-1], "end"))-0.001 {
			problems = append(problems, overlappingLines(jscompat.Get(ordered[index-1], "id"), jscompat.Get(ordered[index], "id")))
		}
	}
	return problems, nil
}

// validLineOrder — line_order: массив без повторов из целых номеров строк песни.
func validLineOrder(order any, byNumber lyricIndex) bool {
	items, ok := jscompat.AsArray(order)
	if !ok {
		return false
	}
	seen := map[any]bool{}
	for _, number := range items {
		seen[number] = true
	}
	if len(seen) != len(items) {
		return false
	}
	for _, number := range items {
		lyric, found := byNumber.get(number)
		if !jscompat.IsSafeInteger(number) || !found || lyric.Header || jscompat.Trim(lyric.Text) == "" {
			return false
		}
	}
	return true
}
