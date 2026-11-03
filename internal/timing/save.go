package timing

import (
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/sources"
)

// clock — описание часов разметки; принадлежит формату timing.json, а не текстам интерфейса.
const clock = "Секунды от начала декодированного звука, не SMPTE"

// gapThreshold — промежуток без вокала, с которого в музыкальной карте появляется отдельная часть.
const gapThreshold = 2.0

// round — Math.round(value * 1000) / 1000: половина округляется к +∞.
func round(value float64) float64 {
	scaled := value * 1000
	result := math.Floor(scaled)
	if scaled-result >= 0.5 {
		result++
	}
	return result / 1000
}

// Prepare — чистая часть saveTiming(project, timing): проверяет вход по тексту и описи проекта и
// строит документ для записи в plan/audio/timing.json. Строки сортируются по началу и
// перенумеровываются, границы округляются до миллисекунд, служебная фраза заметки обновляется,
// автоматическая музыкальная карта пересчитывается, ручные части сохраняются. Файл не пишется:
// запись (атомарная, с сохранением прав существующего файла; новый — 0600) выполняет вызывающий,
// байты даёт Encode. Ошибка с текстом проблем через пробел — отказ сохранения оригинала.
func Prepare(project string, input any) (*jscompat.Object, error) {
	view, err := ViewProject(project)
	if err != nil {
		return nil, err
	}
	problems, err := Validate(input, view.Lyrics, view.Duration)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, " "))
	}
	manifest := sources.ReadManifest(project)
	rawLines, _ := jscompat.AsArray(jscompat.Get(input, "lines"))
	sorted := append([]any(nil), rawLines...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return jscompat.ToNumber(jscompat.Get(sorted[i], "start"))-jscompat.ToNumber(jscompat.Get(sorted[j], "start")) < 0
	})
	lines := make([]any, len(sorted))
	for index, raw := range sorted {
		line := jscompat.Spread(raw)
		line.Set("id", float64(index+1))
		line.Set("start", round(jscompat.Get(raw, "start").(float64)))
		line.Set("end", round(jscompat.Get(raw, "end").(float64)))
		note, ok := jscompat.Coalesce(jscompat.Get(raw, "note"), "").(string)
		if !ok {
			return nil, &jscompat.TypeError{Message: "(line.note ?? \"\").trim is not a function"}
		}
		line.Set("note", jscompat.Trim(note))
		lines[index] = withTimingVerification(line)
	}
	var duration any = jscompat.Get(input, "duration_container")
	if jscompat.IsNullish(duration) {
		duration = nil
		if view.Duration != nil {
			duration = *view.Duration
		}
	}
	var candidates []any
	if items, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(input, "candidates"), &jscompat.Array{})); ok {
		for _, candidate := range items {
			source := jscompat.Get(candidate, "source_line")
			accepted := false
			for _, line := range lines {
				if jscompat.StrictEqual(jscompat.Get(line, "source_line"), source) && jscompat.Truthy(jscompat.Get(line, "verified")) {
					accepted = true
					break
				}
			}
			if !accepted {
				candidates = append(candidates, candidate)
			}
		}
	}
	sourceCount := 0
	order := newValueSet()
	if items, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(input, "line_order"), &jscompat.Array{})); ok {
		for _, number := range items {
			order.add(number)
		}
	}
	for _, lyric := range view.Lyrics {
		if !lyric.Header && jscompat.Trim(lyric.Text) != "" {
			sourceCount++
			order.add(float64(lyric.Number))
		}
	}
	previous, ok := jscompat.Get(input, "status").(string)
	if !ok {
		return nil, &jscompat.TypeError{Message: "previous.replace is not a function"}
	}
	sections, err := resolveSections(jscompat.Get(input, "sections"), view.Lyrics, lines, duration, candidates)
	if err != nil {
		return nil, err
	}
	sha := jscompat.Coalesce(jscompat.Coalesce(jscompat.GetPath(manifest, "track", "sha256"), jscompat.Get(input, "sha256")), nil)
	result := jscompat.NewObject()
	result.Set("version", 2.0)
	result.Set("status", timingStatus(lines, previous, sourceCount))
	result.Set("source", "source/track.mp3")
	result.Set("sha256", sha)
	result.Set("duration_decoded", jscompat.Coalesce(jscompat.Get(input, "duration_decoded"), duration))
	result.Set("duration_container", duration)
	result.Set("clock", clock)
	result.Set("lines", &jscompat.Array{Items: lines})
	result.Set("sections", &jscompat.Array{Items: sections})
	result.Set("candidates", &jscompat.Array{Items: append([]any{}, candidates...)})
	result.Set("line_order", &jscompat.Array{Items: order.items})
	return result, nil
}

// Encode — байты файла, которые пишет оригинал: JSON.stringify(result, null, 2) и перевод строки.
func Encode(result any) []byte {
	return []byte(jscompat.StringifyIndent(result, "  ") + "\n")
}

// valueSet — Set значений с порядком вставки (`[...new Set(...)]`).
type valueSet struct {
	items []any
	seen  map[any]bool
}

func newValueSet() *valueSet { return &valueSet{items: []any{}, seen: map[any]bool{}} }

func (s *valueSet) add(value any) {
	if !s.seen[value] {
		s.seen[value] = true
		s.items = append(s.items, value)
	}
}

// Служебные фразы проверки на слух в note и их распознавание (withTimingVerification). Граница
// фразы — начало заметки или «.»/«;», после неё — пробелы и «.»/«;» либо конец: упоминание внутри
// произвольного комментария не заменяется. Опережающую проверку RE2 не поддерживает, поэтому
// хвост проверяется отдельно.
var (
	verificationPhrase = regexp.MustCompile(`^([` + jscompat.SpaceClass + `]*)(?i:(сверка на слух не выполнена|сверка на слух выполнена))`)
	verificationTail   = regexp.MustCompile(`^[` + jscompat.SpaceClass + `]*(?:[.;]|$)`)
)

// withTimingVerification обновляет verified и служебную фразу заметки, не трогая остальной текст.
func withTimingVerification(line *jscompat.Object) *jscompat.Object {
	verified := jscompat.Truthy(line.Value("verified"))
	result := line.Clone()
	result.Set("verified", verified)
	note, ok := line.Value("note").(string)
	if !ok {
		result.Set("note", jscompat.Undefined)
		return result
	}
	replacement := "сверка на слух не выполнена"
	if verified {
		replacement = "сверка на слух выполнена"
	}
	var builder strings.Builder
	last := 0
	for position := 0; position <= len(note); {
		if prefixEnd, end, ok := matchVerification(note, position); ok {
			builder.WriteString(note[last:prefixEnd])
			builder.WriteString(replacement)
			last, position = end, end
			continue
		}
		if position == len(note) {
			break
		}
		_, size := utf8.DecodeRuneInString(note[position:])
		position += size
	}
	builder.WriteString(note[last:])
	result.Set("note", builder.String())
	return result
}

// matchVerification пробует совпадение с позиции start в порядке альтернатив JS: сначала «^»
// (только в начале строки), затем граница «.»/«;». Возвращает конец границы с пробелами (до
// фразы) и конец фразы. Пробелы \s* жадны, а фраза начинается не с пробела, поэтому возврат
// внутрь них ничего не даёт; две формы фразы не совпадают на одной позиции.
func matchVerification(note string, start int) (int, int, bool) {
	try := func(from int) (int, int, bool) {
		rest := note[from:]
		match := verificationPhrase.FindStringSubmatchIndex(rest)
		if match == nil || !verificationTail.MatchString(rest[match[1]:]) {
			return 0, 0, false
		}
		return from + match[3], from + match[1], true
	}
	if start == 0 {
		if prefixEnd, end, ok := try(0); ok {
			return prefixEnd, end, true
		}
	}
	if start < len(note) && (note[start] == '.' || note[start] == ';') {
		return try(start + 1)
	}
	return 0, 0, false
}

// Шаблоны status разметки: регулярные выражения JS без флага s — «.» не пересекает переводы строк.
var (
	statusConfirmed = regexp.MustCompile(`^Разметка подтверждена на слух\.?$`)
	statusPartial   = regexp.MustCompile(`;[` + jscompat.SpaceClass + `]*подтверждено на слух[^\n\r\x{2028}\x{2029}]*$`)
	statusDot       = regexp.MustCompile(`\.$`)
)

// replaceFirst — String.prototype.replace без флага g.
func replaceFirst(pattern *regexp.Regexp, text, replacement string) string {
	match := pattern.FindStringIndex(text)
	if match == nil {
		return text
	}
	return text[:match[0]] + replacement + text[match[1]:]
}

// timingStatus — сохраняемая фраза status: полное подтверждение либо «…; подтверждено на слух N
// из M строк.» на основе прежнего текста без прежней отметки.
func timingStatus(lines []any, previous string, expected int) string {
	verified := 0
	for _, line := range lines {
		if jscompat.Truthy(jscompat.Get(line, "verified")) {
			verified++
		}
	}
	if len(lines) > 0 && verified == expected && len(lines) == expected {
		return "Разметка подтверждена на слух."
	}
	base := replaceFirst(statusConfirmed, previous, "Разметка")
	base = replaceFirst(statusPartial, base, "")
	base = replaceFirst(statusDot, base, "")
	if base == "" {
		base = "Разметка"
	}
	return base + "; подтверждено на слух " + jscompat.NumberToString(float64(verified)) + " из " + jscompat.NumberToString(float64(expected)) + " строк."
}

var (
	autoNote      = regexp.MustCompile(`^строки [1-9]\d*–[1-9]\d*$`)
	interludeName = regexp.MustCompile(`^Проигрыш после «[^\n\r\x{2028}\x{2029}]+»$`)
)

// isAutoSection — часть старой или новой автоматики: явный origin либо полная системная подпись
// (`строки N–M` у части текста, «Вступление»/«Проигрыш после «…»» без вокала, финал до конца
// трека). Нестроковые name/note дают TypeError вызова .match, как в оригинале.
func isAutoSection(section any, partNames map[string]bool) (bool, error) {
	if origin := jscompat.Get(section, "origin"); origin != jscompat.Undefined {
		return jscompat.StrictEqual(origin, "auto"), nil
	}
	name := jscompat.Get(section, "name")
	note := jscompat.Get(section, "note")
	if note == jscompat.Undefined {
		note = ""
	}
	nameText, nameIsString := name.(string)
	if nameIsString && partNames[nameText] {
		noteText, ok := note.(string)
		if !ok {
			return false, &jscompat.TypeError{Message: "note.match is not a function"}
		}
		if autoNote.MatchString(noteText) {
			return true, nil
		}
	}
	if !nameIsString {
		return false, &jscompat.TypeError{Message: "name.match is not a function"}
	}
	if (nameText == "Вступление" || interludeName.MatchString(nameText)) && jscompat.StrictEqual(note, "без вокала") {
		return true, nil
	}
	return nameText == "Финал без вокала" && jscompat.StrictEqual(note, "до конца трека"), nil
}

// sectionPart — часть текста песни с найденными строками разметки.
type sectionPart struct {
	name      string
	members   []any
	hasSource bool
}

// groupParts — части текста по заголовкам; части без строк песни отбрасываются.
func groupParts(lyrics []LyricsLine, byNumber map[float64]any) []sectionPart {
	var parts []*sectionPart
	var current *sectionPart
	for _, lyric := range lyrics {
		if lyric.Header {
			units := utf16.Encode([]rune(lyric.Text))
			name := ""
			if len(units) > 2 {
				name = string(utf16.Decode(units[1 : len(units)-1]))
			}
			current = &sectionPart{name: jscompat.Trim(name)}
			parts = append(parts, current)
		} else if lyric.Text != "" {
			if current == nil {
				current = &sectionPart{name: "Без названия"}
				parts = append(parts, current)
			}
			current.hasSource = true
			if line, ok := byNumber[float64(lyric.Number)]; ok {
				current.members = append(current.members, line)
			}
		}
	}
	var result []sectionPart
	for _, part := range parts {
		if part.hasSource {
			result = append(result, *part)
		}
	}
	return result
}

// resolveSections — resolveTimingSections: полностью ручная карта сохраняется как есть, у
// смешанной пересчитываются только автоматические части, итог сортируется по началу.
func resolveSections(sections any, lyrics []LyricsLine, lines []any, duration any, candidates []any) ([]any, error) {
	saved, ok := jscompat.AsArray(jscompat.Coalesce(sections, &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "saved.filter is not a function"}
	}
	partNames := map[string]bool{}
	for _, part := range groupParts(lyrics, map[float64]any{}) {
		partNames[part.name] = true
	}
	var manual []any
	for _, section := range saved {
		auto, err := isAutoSection(section, partNames)
		if err != nil {
			return nil, err
		}
		if !auto {
			manual = append(manual, section)
		}
	}
	if len(saved) > 0 && len(manual) == len(saved) {
		return saved, nil
	}
	manualNames := map[any]bool{}
	for _, section := range manual {
		manualNames[jscompat.Get(section, "name")] = true
	}
	result := append([]any{}, manual...)
	for _, section := range buildSections(lyrics, lines, duration, candidates) {
		if !manualNames[section.Value("name")] {
			result = append(result, section)
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		return jscompat.ToNumber(jscompat.Get(result[i], "start"))-jscompat.ToNumber(jscompat.Get(result[j], "start")) < 0
	})
	return result, nil
}

// section строит автоматическую часть в порядке ключей оригинала.
func section(name string, start, end float64, note string) *jscompat.Object {
	object := jscompat.NewObject()
	object.Set("name", name)
	object.Set("start", start)
	object.Set("end", end)
	object.Set("note", note)
	object.Set("origin", "auto")
	return object
}

// buildSections — автоматическая музыкальная карта (общая с align_lyrics): части текста по
// границам строк и кандидатов, промежутки от 2 с — вступление, проигрыши и финал. Если есть
// кандидаты или неразмеченные строки, промежутки не объявляются инструменталом («Не размечено»).
func buildSections(lyrics []LyricsLine, lines []any, duration any, candidates []any) []*jscompat.Object {
	byNumber := map[float64]any{}
	for _, line := range lines {
		if number, ok := jscompat.Get(line, "source_line").(float64); ok {
			byNumber[number] = line
		}
	}
	var sourceLines []LyricsLine
	for _, lyric := range lyrics {
		if !lyric.Header && lyric.Text != "" {
			sourceLines = append(sourceLines, lyric)
		}
	}
	for index, lyric := range sourceLines {
		number := float64(lyric.Number)
		for _, candidate := range candidates {
			if jscompat.StrictEqual(jscompat.Get(candidate, "source_line"), number) {
				if _, exists := byNumber[number]; !exists {
					member := jscompat.Spread(candidate)
					member.Set("id", float64(index+1))
					byNumber[number] = member
				}
				break
			}
		}
	}
	uncertain := len(candidates) > 0
	for _, lyric := range sourceLines {
		covered := false
		for _, line := range lines {
			if jscompat.StrictEqual(jscompat.Get(line, "source_line"), float64(lyric.Number)) {
				covered = true
				break
			}
		}
		if !covered {
			uncertain = true
		}
	}
	type namedPart struct {
		name        string
		start, end  float64
		first, last any
	}
	var named []namedPart
	for _, part := range groupParts(lyrics, byNumber) {
		if len(part.members) == 0 {
			continue
		}
		members := append([]any(nil), part.members...)
		sort.SliceStable(members, func(i, j int) bool {
			return jscompat.ToNumber(jscompat.Get(members[i], "start"))-jscompat.ToNumber(jscompat.Get(members[j], "start")) < 0
		})
		end := math.Inf(-1)
		for _, member := range members {
			end = jsMax(end, jscompat.ToNumber(jscompat.Get(member, "end")))
		}
		named = append(named, namedPart{
			name: part.name, start: jscompat.ToNumber(jscompat.Get(members[0], "start")), end: end,
			first: jscompat.Get(members[0], "id"), last: jscompat.Get(members[len(members)-1], "id"),
		})
	}
	var result []*jscompat.Object
	cursor := 0.0
	for index, part := range named {
		if part.start-cursor >= gapThreshold {
			name := "Вступление"
			if index > 0 {
				name = "Проигрыш после «" + named[index-1].name + "»"
			}
			note := "без вокала"
			if uncertain {
				name, note = "Не размечено", "границы вокала не подтверждены"
			}
			result = append(result, section(name, round(cursor), round(part.start), note))
		}
		result = append(result, section(part.name, round(part.start), round(part.end),
			"строки "+jscompat.ToString(part.first)+"–"+jscompat.ToString(part.last)))
		cursor = jsMax(cursor, part.end)
	}
	if total, ok := duration.(float64); ok && jscompat.Truthy(total) && total-cursor >= gapThreshold {
		name, note := "Финал без вокала", "до конца трека"
		if uncertain {
			name, note = "Не размечено", "границы вокала не подтверждены"
		}
		result = append(result, section(name, round(cursor), round(total), note))
	}
	return result
}

// jsMax — Math.max для двух чисел: NaN заразен.
func jsMax(left, right float64) float64 {
	if math.IsNaN(left) || math.IsNaN(right) {
		return math.NaN()
	}
	return math.Max(left, right)
}
