package timing

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Сборка черновика plan/audio/timing.json после автоматической разметки (семантика Python
// зафиксирована эталоном testdata/golden/timing-draft): подтверждённые строки прежней разметки
// переносятся без изменений, ручные заметки сохраняются, сомнительные пути становятся кандидатами,
// части песни пересчитываются только в автоматической части карты. Новые границы не публикуются,
// если они пересекаются между собой или с подтверждёнными строками.
//
// Акустику (выделение вокала и CTC) выполняет internal/songml; сюда приходит готовый Recognition.
// Значения прежнего файла читаются с различием int/float (pyjson.go), чтобы перенесённые строки и
// числа записывались байт в байт в формате черновика.

// AlignmentModel — подпись акустической модели в recognition.alignment и в статусе черновика:
// распознавания слов нет, границы даёт CTC-модель.
const AlignmentModel = "wav2vec2-large-xlsr-53-russian ONNX CTC"

// ctcNote — заметка новой строки, найденной акустическим выравниванием.
const ctcNote = "Границы уточнены по выделенному вокалу и исходному тексту; " + unverified + "."

const (
	unverified  = "сверка на слух не выполнена"
	minLength   = 0.3
	timeEpsilon = 1e-9
	sourceTrack = "source/track.mp3"
	clockText   = "Секунды от начала декодированного звука, не SMPTE"
	gapMinimum  = 2.0
)

// Сообщения автоматической разметки; текст показывается в причине задания без изменений.
var (
	errNoLyrics   = errors.New("В source/text.md нет строк песни.")
	errDuration   = errors.New("В распознавании или треке указана неверная длительность.")
	errCandidate  = errors.New("В сомнительном кандидате есть неверные границы, оценка или причина сомнения.")
	errNoMatch    = errors.New("Не удалось сопоставить ни одной строки с аудио. Прежняя разметка сохранена; задайте границы вручную или выберите другую модель.")
	errConflict   = errors.New("Новые границы конфликтуют между собой или с подтверждёнными строками. Прежняя разметка сохранена; исправьте границы вручную.")
	errNotNumeric = errors.New("В разметке есть нечисловые значения. Прежний JSON сохранён.")
	// errPrevious — прежний файл с неожиданной структурой: разметка не записывается, причина
	// объясняет, как продолжить.
	errPrevious = errors.New("Прежняя разметка имеет неожиданную структуру. Исправьте её вручную или запустите разметку заново без сохранения подтверждённых строк.")
)

// Segment — строка, принятая акустическим выравниванием (сегмент recognition).
// Start/End — секунды декодированного вокала без округления.
type Segment struct {
	SourceLine int
	Start, End float64
}

// Candidate — сомнительный акустический путь для ручной проверки (candidates recognition).
type Candidate struct {
	SourceLine    int
	Start, End    float64
	Reason        string
	AcousticScore float64
}

// Recognition — итог акустического выравнивания для сборки черновика.
type Recognition struct {
	Segments   []Segment
	Candidates []Candidate
	// DecodedDuration — длительность декодированного вокала (отсчёты 16 кГц / 16000).
	DecodedDuration float64
}

// pySpace — str.isspace() Python: пробелы Unicode и разделители \x1c–\x1f.
func pySpace(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) }

// pyStrip — str.strip() без аргументов.
func pyStrip(text string) string { return strings.TrimFunc(text, pySpace) }

// pySplitLines — str.splitlines(): все переводы строк Python, \r\n как один, без пустого хвоста.
func pySplitLines(text string) []string {
	var lines []string
	start := 0
	for index := 0; index < len(text); {
		r, size := utf8.DecodeRuneInString(text[index:])
		switch r {
		case '\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\u0085', ' ', ' ':
			lines = append(lines, text[start:index])
			start = index + size
		case '\r':
			lines = append(lines, text[start:index])
			if strings.HasPrefix(text[index+size:], "\n") {
				size++
			}
			start = index + size
		}
		index += size
	}
	if start < len(text) {
		lines = append(lines, text[start:])
	}
	return lines
}

// Регулярные выражения разбора текста для черновика; \s и \d Python для str — Unicode-классы.
var (
	pyHeader       = regexp.MustCompile(`^\[([^\[\]]+)\]$`)
	pyMarkdown     = regexp.MustCompile(`^(?:#{1,6}[\s\p{Z}\x1c-\x1f\x85]|[-*+][\s\p{Z}\x1c-\x1f\x85]|\p{Nd}+[.)][\s\p{Z}\x1c-\x1f\x85]|` + "```" + `|~~~)`)
	pySectionTitle = regexp.MustCompile(`(?i)^(?:[а-яёa-z]+[\s\p{Z}\x1c-\x1f\x85]+){0,2}(?:припев|куплет|бридж|интро|вступление|аутро|проигрыш|кода|финал|запев)(?:[\s\p{Z}\x1c-\x1f\x85]+(?:[а-яёa-z]+|\p{Nd}+)){0,2}[:.]?$`)
	pyAutoNote     = regexp.MustCompile(`^(?:(?:Совпало [0-9]+ из [0-9]+ слов|Совпали все [0-9]+ слов|Слова не распознаны, оценка по соседним строкам|Границы уточнены по выделенному вокалу и исходному тексту); ` + regexp.QuoteMeta(unverified) + `\.)$`)
	pyLinesNote    = regexp.MustCompile(`^(?:строки [1-9]\p{Nd}*–[1-9]\p{Nd}*)$`)
	pyInterlude    = regexp.MustCompile(`^(?:Проигрыш после «.+»)$`)
)

// LyricLine — строка песни align_lyrics: физический номер (1-based) и текст без крайних пробелов.
type LyricLine struct {
	Number int
	Text   string
}

// LyricLines — строки песни без пустых и заголовков; ошибка формата
// заголовка или Markdown останавливает разметку до долгого вычисления.
func LyricLines(text string) ([]LyricLine, error) {
	var lines []LyricLine
	for index, raw := range pySplitLines(strings.TrimLeft(text, "\ufeff")) {
		number := index + 1
		line := pyStrip(raw)
		section := pyHeader.FindStringSubmatch(line)
		if strings.ContainsAny(line, "[]") && (section == nil || pyStrip(section[1]) == "") {
			return nil, fmt.Errorf("Строка %d: заголовок секции должен быть отдельной строкой вида [Припев], с непустым названием и обеими скобками.", number)
		}
		if pyMarkdown.MatchString(line) || pySectionTitle.MatchString(line) {
			return nil, fmt.Errorf("Строка %d: слова песни пишутся обычным текстом, секции — как [Припев], без Markdown и нумерации.", number)
		}
		if line != "" && section == nil {
			lines = append(lines, LyricLine{number, line})
		}
	}
	return lines, nil
}

// textPart — часть песни по заголовку: имя и номера первой и последней строки.
type textPart struct {
	name        string
	first, last int
}

// textSections — text_sections: строки до первого заголовка идут в «Без названия».
func textSections(text string) []textPart {
	var parts []*textPart
	var current *textPart
	for index, raw := range pySplitLines(strings.TrimLeft(text, "\ufeff")) {
		line := pyStrip(raw)
		if header := pyHeader.FindStringSubmatch(line); header != nil {
			current = &textPart{name: pyStrip(header[1])}
			parts = append(parts, current)
		} else if line != "" {
			if current == nil {
				current = &textPart{name: "Без названия"}
				parts = append(parts, current)
			}
			if current.first == 0 {
				current.first = index + 1
			}
			current.last = index + 1
		}
	}
	result := []textPart{}
	for _, part := range parts {
		if part.first != 0 {
			result = append(result, *part)
		}
	}
	return result
}

// pyKey — ключ dict Python для значения: равные числа (3, 3.0, True и 1) дают один ключ.
// ok=false — значение не хешируется (список или объект), Python остановился бы с TypeError.
func pyKey(value any) (string, bool) {
	switch item := value.(type) {
	case nil:
		return "n", true
	case bool:
		if item {
			return "1", true
		}
		return "0", true
	case pyInt:
		return item.text, true
	case float64:
		if !math.IsInf(item, 0) && !math.IsNaN(item) && item == math.Trunc(item) {
			return strconv.FormatFloat(item, 'f', -1, 64), true
		}
		text, _ := pyFloatRepr(item)
		return "f:" + text, true
	case string:
		return "s:" + item, true
	}
	return "", false
}

// lineKey — ключ номера строки исходного текста.
func lineKey(number int) string { return strconv.Itoa(number) }

// asObject — элемент как dict; иное значение означает неожиданную структуру прежнего файла.
func asObject(value any) (*pyObject, error) {
	object, ok := value.(*pyObject)
	if !ok {
		return nil, errPrevious
	}
	return object, nil
}

// previousList — (previous or {}).get(key, []): отсутствие ключа — пустой список, иное не-список — ошибка.
func previousList(previous *pyObject, key string) ([]any, error) {
	if previous == nil {
		return nil, nil
	}
	value, ok := previous.get(key)
	if !ok {
		return nil, nil
	}
	items, isList := value.([]any)
	if !isList {
		return nil, errPrevious
	}
	return items, nil
}

// BuildDraft собирает черновик разметки по акустическому выравниванию. previous — прежний
// timing.json в модели pyjson (nil — нет файла, повреждён или выбран сброс). duration —
// длительность контейнера по ffprobe, округлённая до миллисекунд. sha256 — SHA исходного трека.
func BuildDraft(text string, recognition Recognition, duration float64, previous any, sha256 string) (*pyObject, error) {
	decoded := recognition.DecodedDuration
	for _, value := range []float64{duration, decoded} {
		if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
			return nil, errDuration
		}
	}
	lines, err := LyricLines(text)
	if err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return nil, errNoLyrics
	}
	old, _ := previous.(*pyObject)
	segments := map[int]Segment{}
	for _, segment := range recognition.Segments {
		segments[segment.SourceLine] = segment
	}

	previousLines, err := previousList(old, "lines")
	if err != nil {
		return nil, err
	}
	kept := map[string]*pyObject{}
	for _, value := range previousLines {
		line, err := asObject(value)
		if err != nil {
			return nil, err
		}
		verified, _ := line.get("verified")
		number, _ := line.get("source_line")
		if pyTruthy(verified) && pyIsInt(number) {
			key, _ := pyKey(number)
			kept[key] = line
		}
	}
	// Заметка кандидата — ручная правка текста; ручная заметка прежней строки важнее.
	retained := map[string]string{}
	previousCandidates, err := previousList(old, "candidates")
	if err != nil {
		return nil, err
	}
	for _, value := range previousCandidates {
		item, err := asObject(value)
		if err != nil {
			return nil, err
		}
		if note, ok := item.values["note"].(string); ok {
			number, exists := item.get("source_line")
			key, hashable := pyKey(number)
			if !exists || !hashable {
				return nil, errPrevious
			}
			retained[key] = note
		}
	}
	for _, value := range previousLines {
		item, _ := value.(*pyObject)
		if note, ok := item.values["note"].(string); ok && pyStrip(note) != "" && !pyAutoNote.MatchString(note) {
			number, exists := item.get("source_line")
			key, hashable := pyKey(number)
			if !exists || !hashable {
				return nil, errPrevious
			}
			retained[key] = note
		}
	}

	resultLines := []*pyObject{}
	for index, line := range lines {
		if previousLine, ok := kept[lineKey(line.Number)]; ok {
			copied := previousLine.clone()
			copied.set("id", newPyInt(index+1))
			resultLines = append(resultLines, copied)
			continue
		}
		segment, ok := segments[line.Number]
		if !ok {
			continue
		}
		note := ctcNote
		if value, ok := retained[lineKey(line.Number)]; ok {
			note = value
		}
		entry := newPyObject()
		entry.set("id", newPyInt(index+1))
		entry.set("source_line", newPyInt(line.Number))
		entry.set("start", pyRound(segment.Start))
		entry.set("end", pyRound(segment.End))
		entry.set("verified", false)
		entry.set("note", note)
		resultLines = append(resultLines, entry)
	}

	assigned := map[string]bool{}
	for _, line := range resultLines {
		key, hashable := pyKey(line.values["source_line"])
		if !hashable {
			return nil, errPrevious
		}
		assigned[key] = true
	}
	numbers := map[int]int{}
	for index, line := range lines {
		numbers[line.Number] = index + 1
	}
	candidates := []*pyObject{}
	seen := map[int]bool{}
	for _, item := range recognition.Candidates {
		if _, known := numbers[item.SourceLine]; !known || seen[item.SourceLine] {
			return nil, errors.New("Неверный или повторный source_line сомнительного кандидата.")
		}
		seen[item.SourceLine] = true
		if !finite(item.Start) || !finite(item.End) || item.Start < 0 || item.End <= item.Start || item.End > duration+0.5 ||
			pyStrip(item.Reason) == "" || !finite(item.AcousticScore) || item.AcousticScore < 0 || item.AcousticScore > 1 {
			return nil, errCandidate
		}
		if assigned[lineKey(item.SourceLine)] {
			continue
		}
		entry := newPyObject()
		entry.set("source_line", newPyInt(item.SourceLine))
		entry.set("start", item.Start)
		entry.set("end", item.End)
		entry.set("reason", item.Reason)
		entry.set("acoustic_score", item.AcousticScore)
		if note, ok := retained[lineKey(item.SourceLine)]; ok {
			entry.set("note", note)
		}
		candidates = append(candidates, entry)
	}
	if len(resultLines) == 0 && len(candidates) == 0 {
		return nil, errNoMatch
	}
	// После пропусков номера плотные, физические source_line не меняются.
	members := map[string]*pyObject{}
	for index, line := range resultLines {
		line.set("id", newPyInt(index+1))
		key, _ := pyKey(line.values["source_line"])
		members[key] = line
	}
	for _, candidate := range candidates {
		number, _ := candidate.values["source_line"].(pyInt).int()
		member := candidate.clone()
		member.set("id", newPyInt(numbers[number]))
		members[lineKey(number)] = member
	}
	previousSections, err := sectionsOf(old)
	if err != nil {
		return nil, err
	}
	sections, err := pyResolveSections(previousSections, textSections(text), members, duration, len(candidates) > 0 || len(resultLines) < len(lines))
	if err != nil {
		return nil, err
	}
	if err := checkLines(resultLines, duration); err != nil {
		return nil, err
	}

	verified := 0
	for _, line := range resultLines {
		if value, _ := line.get("verified"); pyTruthy(value) {
			verified++
		}
	}
	missing := len(lines) - len(resultLines) - len(candidates)
	status := "Разметка подтверждена на слух."
	if verified != len(resultLines) || missing != 0 || len(candidates) > 0 {
		status = fmt.Sprintf("Автоматическая разметка по локальному распознаванию (%s); подтверждено на слух %d из %d строк.", AlignmentModel, verified, len(lines))
	}
	if len(candidates) > 0 {
		status += fmt.Sprintf(" Предложений для ручной проверки: %d.", len(candidates))
	}
	if missing != 0 {
		status += fmt.Sprintf(" Не найдено строк: %d; укажите их границы вручную.", missing)
	}
	order, err := lineOrder(lines, old)
	if err != nil {
		return nil, err
	}
	result := newPyObject()
	result.set("version", newPyInt(2))
	result.set("status", status)
	result.set("source", sourceTrack)
	result.set("sha256", sha256)
	result.set("duration_decoded", decoded)
	result.set("duration_container", duration)
	result.set("clock", clockText)
	result.set("lines", objectList(resultLines))
	result.set("candidates", objectList(candidates))
	result.set("line_order", order)
	result.set("sections", sections)
	// Ручная карта тоже входит в публикацию: нечисловые значения не портят прежний файл.
	if _, err := encodePyJSON(result); err != nil {
		return nil, errNotNumeric
	}
	return result, nil
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func objectList(items []*pyObject) []any {
	result := make([]any, len(items))
	for index, item := range items {
		result[index] = item
	}
	return result
}

// checkLines — итоговая проверка align_lyrics: конечные границы в пределах трека, длина не
// меньше 300 мс (допуск только на двоичную погрешность) и отсутствие пересечений.
func checkLines(lines []*pyObject, duration float64) error {
	type bounds struct{ start, end float64 }
	ordered := make([]bounds, 0, len(lines))
	for _, line := range lines {
		start, okStart := line.get("start")
		end, okEnd := line.get("end")
		if !okStart || !okEnd {
			return errPrevious
		}
		startValue, isNumber := pyNumber(start)
		endValue, isEndNumber := pyNumber(end)
		if !isNumber || !isEndNumber {
			return errPrevious
		}
		ordered = append(ordered, bounds{startValue, endValue})
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].start < ordered[j].start })
	for index, line := range ordered {
		if !finite(line.start) || !finite(line.end) || line.start < 0 || line.end > duration+0.5 || line.end-line.start < minLength-timeEpsilon {
			return errConflict
		}
		if index > 0 && line.start < ordered[index-1].end-0.001 {
			return errConflict
		}
	}
	return nil
}

// lineOrder — timing_line_order: ручная очередь по физическим номерам и новые строки в конце.
func lineOrder(lines []LyricLine, previous *pyObject) ([]any, error) {
	present := map[int]bool{}
	for _, line := range lines {
		present[line.Number] = true
	}
	result := []any{}
	added := map[int]bool{}
	if previous != nil {
		if value, ok := previous.get("line_order"); ok {
			if items, isList := value.([]any); isList {
				for _, item := range items {
					// type(number) is int: bool сюда не входит.
					number, isInt := item.(pyInt)
					if !isInt {
						continue
					}
					value, fits := number.int()
					if fits && present[value] && !added[value] {
						added[value] = true
						result = append(result, newPyInt(value))
					}
				}
			}
		}
	}
	for _, line := range lines {
		if !added[line.Number] {
			result = append(result, newPyInt(line.Number))
		}
	}
	return result, nil
}

// sectionsOf — (previous or {}).get("sections"): ложное значение — нет карты, иной не-список — ошибка.
func sectionsOf(previous *pyObject) ([]any, error) {
	if previous == nil {
		return nil, nil
	}
	value, _ := previous.get("sections")
	if !pyTruthy(value) {
		return nil, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, errPrevious
	}
	return items, nil
}

// pyIsAutoSection — is_auto_section: автоматическую часть узнаём по origin или полной системной подписи.
func pyIsAutoSection(section *pyObject, names map[string]bool) (bool, error) {
	if origin, ok := section.get("origin"); ok {
		text, isText := origin.(string)
		return isText && text == "auto", nil
	}
	nameValue, ok := section.get("name")
	if !ok {
		nameValue = ""
	}
	noteValue, ok := section.get("note")
	if !ok {
		noteValue = ""
	}
	name, nameText := nameValue.(string)
	if !nameText {
		// name in set для нехешируемого значения и re.fullmatch для не-строки — TypeError в Python.
		return false, errPrevious
	}
	note, noteText := noteValue.(string)
	if names[name] {
		if !noteText {
			return false, errPrevious
		}
		if pyLinesNote.MatchString(note) {
			return true, nil
		}
	}
	if (name == "Вступление" || pyInterlude.MatchString(name)) && noteText && note == "без вокала" {
		return true, nil
	}
	return name == "Финал без вокала" && noteText && note == "до конца трека", nil
}

// pyResolveSections — resolve_sections: полностью ручная карта остаётся как есть, у смешанной
// пересчитываются только автоматические части; ручные имеют приоритет по имени.
func pyResolveSections(previous []any, parts []textPart, members map[string]*pyObject, duration float64, uncertain bool) ([]any, error) {
	names := map[string]bool{}
	for _, part := range parts {
		names[part.name] = true
	}
	var manual []*pyObject
	for _, value := range previous {
		section, err := asObject(value)
		if err != nil {
			return nil, err
		}
		auto, err := pyIsAutoSection(section, names)
		if err != nil {
			return nil, err
		}
		if !auto {
			manual = append(manual, section)
		}
	}
	if len(previous) > 0 && len(manual) == len(previous) {
		return previous, nil
	}
	generated := pyBuildSections(parts, members, duration, uncertain)
	manualNames := map[string]bool{}
	for _, section := range manual {
		name, exists := section.get("name")
		key, hashable := pyKey(name)
		if !exists || !hashable {
			return nil, errPrevious
		}
		manualNames[key] = true
	}
	combined := append([]*pyObject{}, manual...)
	for _, section := range generated {
		key, _ := pyKey(section.values["name"])
		if !manualNames[key] {
			combined = append(combined, section)
		}
	}
	starts := make([]float64, len(combined))
	for index, section := range combined {
		value, exists := section.get("start")
		number, isNumber := pyNumber(value)
		if !exists || !isNumber {
			return nil, errPrevious
		}
		starts[index] = number
	}
	indexes := make([]int, len(combined))
	for index := range indexes {
		indexes[index] = index
	}
	sort.SliceStable(indexes, func(i, j int) bool { return starts[indexes[i]] < starts[indexes[j]] })
	result := make([]any, len(combined))
	for position, index := range indexes {
		result[position] = combined[index]
	}
	return result, nil
}

// pyLess — a < b для чисел Python (int/float/bool сравниваются по значению).
func pyLess(a, b any) bool {
	left, _ := pyNumber(a)
	right, _ := pyNumber(b)
	return left < right
}

// pyBuildSections — части песни по строкам и кандидатам; промежутки от 2 с без вокала
// называются только при полной карте, иначе — «Не размечено». Сохраняется тип чисел Python
// (min/max возвращают сам элемент, round(int) остаётся int).
func pyBuildSections(parts []textPart, members map[string]*pyObject, duration float64, uncertain bool) []*pyObject {
	type named struct {
		name, note string
		start, end any
	}
	var groups []named
	for _, part := range parts {
		var list []*pyObject
		for number := part.first; number <= part.last; number++ {
			if member, ok := members[lineKey(number)]; ok {
				list = append(list, member)
			}
		}
		if len(list) == 0 {
			continue
		}
		sort.SliceStable(list, func(i, j int) bool { return pyLess(list[i].values["start"], list[j].values["start"]) })
		start, end := list[0].values["start"], list[0].values["end"]
		for _, member := range list[1:] {
			if pyLess(member.values["start"], start) {
				start = member.values["start"]
			}
			if pyLess(end, member.values["end"]) {
				end = member.values["end"]
			}
		}
		first, _ := list[0].values["id"].(pyInt)
		last, _ := list[len(list)-1].values["id"].(pyInt)
		groups = append(groups, named{part.name, "строки " + first.text + "–" + last.text, start, end})
	}
	sections := []*pyObject{}
	gap := func(name, note string, start, end any) *pyObject {
		if uncertain {
			name, note = "Не размечено", "границы вокала не подтверждены"
		}
		section := newPyObject()
		section.set("name", name)
		section.set("start", pyRound(start))
		section.set("end", pyRound(end))
		section.set("note", note)
		section.set("origin", "auto")
		return section
	}
	var cursor any = 0.0
	for index, group := range groups {
		startValue, _ := pyNumber(group.start)
		cursorValue, _ := pyNumber(cursor)
		if startValue-cursorValue >= gapMinimum {
			name := "Вступление"
			if index > 0 {
				name = "Проигрыш после «" + groups[index-1].name + "»"
			}
			sections = append(sections, gap(name, "без вокала", cursor, group.start))
		}
		section := newPyObject()
		section.set("name", group.name)
		section.set("start", pyRound(group.start))
		section.set("end", pyRound(group.end))
		section.set("note", group.note)
		section.set("origin", "auto")
		sections = append(sections, section)
		if pyLess(cursor, group.end) {
			cursor = group.end
		}
	}
	cursorValue, _ := pyNumber(cursor)
	if duration != 0 && duration-cursorValue >= gapMinimum {
		sections = append(sections, gap("Финал без вокала", "до конца трека", cursor, duration))
	}
	return sections
}

// FromAlignment переводит строки CTC-выравнивания в принятые сегменты и сомнительных кандидатов
// по правилам отбора: строка без пути не попадает никуда (её размечают вручную),
// строка с причиной сомнения или короче 300 мс — кандидат, если средняя вероятность не ниже 0,45,
// остальные — принятые неподтверждённые строки.
func FromAlignment(lines []AlignedLine, decodedDuration float64) Recognition {
	result := Recognition{Segments: []Segment{}, Candidates: []Candidate{}, DecodedDuration: decodedDuration}
	for _, line := range lines {
		if line.Start == nil || line.End == nil {
			continue
		}
		start, end := *line.Start, *line.End
		reason := ""
		if line.ReviewRequired {
			reason = line.Reason
		}
		if end-start < minLength-timeEpsilon {
			reason = pyStrip(reason + " Акустический интервал слишком короткий; укажите границы вручную.")
		}
		if reason != "" {
			if line.AcousticScore >= 0.45 && end > start {
				result.Candidates = append(result.Candidates, Candidate{line.SourceLine, start, end, reason, line.AcousticScore})
			}
			continue
		}
		result.Segments = append(result.Segments, Segment{line.SourceLine, start, end})
	}
	return result
}

// AlignedLine — строка итога songml.Align, нужная черновику (без зависимости timing от ORT).
type AlignedLine struct {
	SourceLine     int
	Start, End     *float64
	AcousticScore  float64
	ReviewRequired bool
	Reason         string
}

// EncodeDraft — байты timing.json в формате черновика (json.dumps indent=2 + перевод строки).
func EncodeDraft(draft *pyObject) ([]byte, error) {
	data, err := encodePyJSON(draft)
	if err != nil {
		return nil, errNotNumeric
	}
	return data, nil
}

// ParsePrevious читает прежний timing.json для переноса подтверждённых строк: повреждённый
// или не-объектный файл считается отсутствующим.
func ParsePrevious(data []byte) any {
	if !utf8.Valid(data) {
		return nil
	}
	value, err := parsePyJSON(data)
	if err != nil {
		return nil
	}
	if _, ok := value.(*pyObject); !ok {
		return nil
	}
	return value
}
