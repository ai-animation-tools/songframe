package timing

import (
	"math"
	"sort"

	"songframe/internal/dynvalue"
)

// MinTimingLength — минимальная длина размеченной строки в секундах.
const MinTimingLength = 0.3

// Тексты timingTexts.main для проверки разметки.
const (
	invalidCandidates = "Предложения границ повреждены. Обновите автоматическую разметку или исправьте предложения."
	invalidLineOrder  = "Порядок строк содержит повторы или ссылки на отсутствующие строки текста."
)

func duplicateID(id any) string { return "Повторяется id " + dynvalue.ToString(id) + "." }
func duplicateSourceLine(id, line any) string {
	return "строка " + dynvalue.ToString(id) + ": строка текста " + dynvalue.ToString(line) + " размечена дважды."
}
func missingSourceLine(id, line any) string {
	return "строка " + dynvalue.ToString(id) + ": в тексте нет строки песни с номером " + dynvalue.ToString(line) + "."
}
func invalidBoundaries(id any) string {
	return "строка " + dynvalue.ToString(id) + ": границы не числа."
}
func lineTooShort(id any) string {
	return "строка " + dynvalue.ToString(id) + ": длиннее " + dynvalue.NumberToString(MinTimingLength) + " с должна быть каждая строка."
}
func negativeStart(id any) string {
	return "строка " + dynvalue.ToString(id) + ": начало раньше нуля."
}
func endOutsideTrack(id any) string {
	return "строка " + dynvalue.ToString(id) + ": конец за пределами трека."
}
func overlappingLines(first, second any) string {
	return "Строки " + dynvalue.ToString(first) + " и " + dynvalue.ToString(second) + " пересекаются."
}

// HasMinimumTimingLength — длина не короче MinTimingLength с допуском в наносекунду: вычитание
// десятичных секунд может сделать законные 300 мс чуть короче порога.
func HasMinimumTimingLength(start, end float64) bool {
	return dynvalue.IsFinite(start) && dynvalue.IsFinite(end) && end-start >= MinTimingLength-1e-9
}

// ValidTimingCandidates — validTimingCandidates: массив непринятых предложений границ, каждое —
// объект с положительным целым source_line, 0 ≤ start < end, непустым reason и оценкой в [0, 1].
// Предложения не обязаны быть непересекающимися.
func ValidTimingCandidates(value any) bool {
	items, ok := dynvalue.AsArray(value)
	if !ok {
		return false
	}
	for _, candidate := range items {
		if !dynvalue.Truthy(candidate) || dynvalue.TypeOf(candidate) != "object" {
			return false
		}
		line := dynvalue.Get(candidate, "source_line")
		start, startOK := dynvalue.Get(candidate, "start").(float64)
		end, endOK := dynvalue.Get(candidate, "end").(float64)
		note := dynvalue.Get(candidate, "note")
		reason, reasonOK := dynvalue.Get(candidate, "reason").(string)
		score := dynvalue.Get(candidate, "acoustic_score")
		if !dynvalue.IsSafeInteger(line) || !(dynvalue.ToNumber(line) > 0) ||
			!startOK || !dynvalue.IsFinite(start) || !(start >= 0) ||
			!endOK || !dynvalue.IsFinite(end) || !(end > start) ||
			!(note == dynvalue.Undefined || dynvalue.TypeOf(note) == "string") ||
			!reasonOK || dynvalue.Trim(reason) == "" {
			return false
		}
		if score != dynvalue.Undefined {
			value, isNumber := score.(float64)
			if !isNumber || !dynvalue.IsFinite(value) || !(value >= 0) || !(value <= 1) {
				return false
			}
		}
	}
	return true
}

// lyricIndex — номера строк текста; ключ совпадает только с числовым значением того же номера
// (строка «3» не находит строку 3).
type lyricIndex map[float64]LyricsLine

func (index lyricIndex) get(number any) (LyricsLine, bool) {
	value, ok := number.(float64)
	if !ok {
		return LyricsLine{}, false
	}
	line, found := index[value]
	return line, found
}

// Validate возвращает проблемы разметки в порядке проверок, зафиксированном эталоном
// timing-validation; пустой список означает, что файл можно сохранить. timing — недоверенный
// документ (дерево dynvalue), duration nil или 0 — длительность неизвестна. Ошибка — документ
// неверной формы (например, lines не массив), сохранение тоже отклоняется.
func Validate(timing any, lyrics []LyricsLine, duration *float64) ([]string, error) {
	problems := []string{}
	byNumber := lyricIndex{}
	for _, lyric := range lyrics {
		byNumber[float64(lyric.Number)] = lyric
	}
	knownDuration := duration != nil && *duration != 0 && !math.IsNaN(*duration)
	lines, err := dynvalue.Iterate(dynvalue.Get(timing, "lines"))
	if err != nil {
		return nil, err
	}
	ids := map[any]bool{}
	numbers := map[any]bool{}
	for _, line := range lines {
		id, err := dynvalue.Prop(line, "id")
		if err != nil {
			return nil, err
		}
		if ids[id] {
			problems = append(problems, duplicateID(id))
		}
		ids[id] = true
		source := dynvalue.Get(line, "source_line")
		if numbers[source] {
			problems = append(problems, duplicateSourceLine(id, source))
		}
		numbers[source] = true
		if lyric, ok := byNumber.get(source); !ok || lyric.Header || lyric.Text == "" {
			problems = append(problems, missingSourceLine(id, source))
		}
		start, end := dynvalue.Get(line, "start"), dynvalue.Get(line, "end")
		switch {
		case !dynvalue.IsFinite(start) || !dynvalue.IsFinite(end):
			problems = append(problems, invalidBoundaries(id))
		case !HasMinimumTimingLength(start.(float64), end.(float64)):
			problems = append(problems, lineTooShort(id))
		case start.(float64) < 0:
			problems = append(problems, negativeStart(id))
		case knownDuration && end.(float64) > *duration+0.5:
			problems = append(problems, endOutsideTrack(id))
		}
	}
	if candidates := dynvalue.Get(timing, "candidates"); candidates != dynvalue.Undefined {
		if !ValidTimingCandidates(candidates) {
			problems = append(problems, invalidCandidates)
		} else {
			seen := map[any]bool{}
			items, _ := dynvalue.AsArray(candidates)
			for _, candidate := range items {
				source := dynvalue.Get(candidate, "source_line")
				lyric, ok := byNumber.get(source)
				end := dynvalue.Get(candidate, "end").(float64)
				if seen[source] || !ok || lyric.Header || dynvalue.Trim(lyric.Text) == "" || (knownDuration && end > *duration+0.5) {
					problems = append(problems, invalidCandidates)
				}
				seen[source] = true
			}
		}
	}
	if order := dynvalue.Get(timing, "line_order"); order != dynvalue.Undefined && !validLineOrder(order, byNumber) {
		problems = append(problems, invalidLineOrder)
	}
	ordered := append([]any(nil), lines...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return dynvalue.ToNumber(dynvalue.Get(ordered[i], "start"))-dynvalue.ToNumber(dynvalue.Get(ordered[j], "start")) < 0
	})
	for index := 1; index < len(ordered); index++ {
		if dynvalue.ToNumber(dynvalue.Get(ordered[index], "start")) < dynvalue.ToNumber(dynvalue.Get(ordered[index-1], "end"))-0.001 {
			problems = append(problems, overlappingLines(dynvalue.Get(ordered[index-1], "id"), dynvalue.Get(ordered[index], "id")))
		}
	}
	return problems, nil
}

// validLineOrder — line_order: массив без повторов из целых номеров строк песни.
func validLineOrder(order any, byNumber lyricIndex) bool {
	items, ok := dynvalue.AsArray(order)
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
		if !dynvalue.IsSafeInteger(number) || !found || lyric.Header || dynvalue.Trim(lyric.Text) == "" {
			return false
		}
	}
	return true
}
