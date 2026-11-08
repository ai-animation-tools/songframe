package timing

import (
	"errors"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
	"songframe/internal/sources"
)

// clock — описание часов разметки; принадлежит формату timing.json, а не текстам интерфейса.
const clock = "Секунды от начала декодированного звука, не SMPTE"

// gapThreshold — промежуток без вокала, с которого в музыкальной карте появляется отдельная часть.
const gapThreshold = 2.0

// round — округление до тысячных: половина округляется к +∞.
func round(value float64) float64 {
	scaled := value * 1000
	result := math.Floor(scaled)
	if scaled-result >= 0.5 {
		result++
	}
	return result / 1000
}

// Prepare — чистая часть сохранения разметки: проверяет вход по тексту и описи проекта и
// строит документ для записи в plan/audio/timing.json. Строки сортируются по началу и
// перенумеровываются, границы округляются до миллисекунд, служебная фраза заметки обновляется,
// автоматическая музыкальная карта пересчитывается, ручные части сохраняются. Файл не пишется:
// запись (атомарная, с сохранением прав существующего файла; новый — 0600) выполняет вызывающий,
// байты даёт Encode. Отказ сохранения — ошибка с текстом проблем через пробел.
func Prepare(project string, input any) (*dynvalue.Object, error) {
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
	rawLines, _ := dynvalue.AsArray(dynvalue.Get(input, "lines"))
	sorted := append([]any(nil), rawLines...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return dynvalue.ToNumber(dynvalue.Get(sorted[i], "start"))-dynvalue.ToNumber(dynvalue.Get(sorted[j], "start")) < 0
	})
	lines := make([]any, len(sorted))
	for index, raw := range sorted {
		line := dynvalue.Spread(raw)
		line.Set("id", float64(index+1))
		line.Set("start", round(dynvalue.Get(raw, "start").(float64)))
		line.Set("end", round(dynvalue.Get(raw, "end").(float64)))
		note, ok := dynvalue.Coalesce(dynvalue.Get(raw, "note"), "").(string)
		if !ok {
			return nil, &dynvalue.TypeError{Message: "(line.note ?? \"\").trim is not a function"}
		}
		line.Set("note", dynvalue.Trim(note))
		lines[index] = withTimingVerification(line)
	}
	var duration any = dynvalue.Get(input, "duration_container")
	if dynvalue.IsNullish(duration) {
		duration = nil
		if view.Duration != nil {
			duration = *view.Duration
		}
	}
	var candidates []any
	if items, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(input, "candidates"), &dynvalue.Array{})); ok {
		for _, candidate := range items {
			source := dynvalue.Get(candidate, "source_line")
			accepted := false
			for _, line := range lines {
				if dynvalue.StrictEqual(dynvalue.Get(line, "source_line"), source) && dynvalue.Truthy(dynvalue.Get(line, "verified")) {
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
	if items, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(input, "line_order"), &dynvalue.Array{})); ok {
		for _, number := range items {
			order.add(number)
		}
	}
	for _, lyric := range view.Lyrics {
		if !lyric.Header && dynvalue.Trim(lyric.Text) != "" {
			sourceCount++
			order.add(float64(lyric.Number))
		}
	}
	previous, ok := dynvalue.Get(input, "status").(string)
	if !ok {
		return nil, &dynvalue.TypeError{Message: "previous.replace is not a function"}
	}
	sections, err := resolveSections(dynvalue.Get(input, "sections"), view.Lyrics, lines, duration, candidates)
	if err != nil {
		return nil, err
	}
	sha := dynvalue.Coalesce(dynvalue.Coalesce(dynvalue.GetPath(manifest, "track", "sha256"), dynvalue.Get(input, "sha256")), nil)
	result := dynvalue.NewObject()
	result.Set("version", 2.0)
	result.Set("status", timingStatus(lines, previous, sourceCount))
	result.Set("source", "source/track.mp3")
	result.Set("sha256", sha)
	result.Set("duration_decoded", dynvalue.Coalesce(dynvalue.Get(input, "duration_decoded"), duration))
	result.Set("duration_container", duration)
	result.Set("clock", clock)
	result.Set("lines", &dynvalue.Array{Items: lines})
	result.Set("sections", &dynvalue.Array{Items: sections})
	result.Set("candidates", &dynvalue.Array{Items: append([]any{}, candidates...)})
	result.Set("line_order", &dynvalue.Array{Items: order.items})
	return result, nil
}

// Encode — байты сохраняемого файла: JSON с отступом два пробела и перевод строки (формат
// зафиксирован эталоном timing-save).
func Encode(result any) []byte {
	return []byte(dynvalue.StringifyIndent(result, "  ") + "\n")
}

// valueSet — множество значений с порядком первой вставки (повторы отбрасываются).
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
	verificationPhrase = regexp.MustCompile(`^([` + dynvalue.SpaceClass + `]*)(?i:(сверка на слух не выполнена|сверка на слух выполнена))`)
	verificationTail   = regexp.MustCompile(`^[` + dynvalue.SpaceClass + `]*(?:[.;]|$)`)
)

// withTimingVerification обновляет verified и служебную фразу заметки, не трогая остальной текст.
func withTimingVerification(line *dynvalue.Object) *dynvalue.Object {
	verified := dynvalue.Truthy(line.Value("verified"))
	result := line.Clone()
	result.Set("verified", verified)
	note, ok := line.Value("note").(string)
	if !ok {
		result.Set("note", dynvalue.Undefined)
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

// matchVerification пробует совпадение с позиции start в порядке альтернатив шаблона: сначала «^»
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

// Шаблоны status разметки: «.» не пересекает переводы строк (\n, \r, U+2028, U+2029).
var (
	statusConfirmed = regexp.MustCompile(`^Разметка подтверждена на слух\.?$`)
	statusPartial   = regexp.MustCompile(`;[` + dynvalue.SpaceClass + `]*подтверждено на слух[^\n\r\x{2028}\x{2029}]*$`)
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
		if dynvalue.Truthy(dynvalue.Get(line, "verified")) {
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
	return base + "; подтверждено на слух " + dynvalue.NumberToString(float64(verified)) + " из " + dynvalue.NumberToString(float64(expected)) + " строк."
}

var (
	autoNote      = regexp.MustCompile(`^строки [1-9]\d*–[1-9]\d*$`)
	interludeName = regexp.MustCompile(`^Проигрыш после «[^\n\r\x{2028}\x{2029}]+»$`)
)

// isAutoSection — часть старой или новой автоматики: явный origin либо полная системная подпись
// (`строки N–M` у части текста, «Вступление»/«Проигрыш после «…»» без вокала, финал до конца
// трека). Нестроковые name/note — ошибка данных: сохранение отклоняется.
func isAutoSection(section any, partNames map[string]bool) (bool, error) {
	if origin := dynvalue.Get(section, "origin"); origin != dynvalue.Undefined {
		return dynvalue.StrictEqual(origin, "auto"), nil
	}
	name := dynvalue.Get(section, "name")
	note := dynvalue.Get(section, "note")
	if note == dynvalue.Undefined {
		note = ""
	}
	nameText, nameIsString := name.(string)
	if nameIsString && partNames[nameText] {
		noteText, ok := note.(string)
		if !ok {
			return false, &dynvalue.TypeError{Message: "note.match is not a function"}
		}
		if autoNote.MatchString(noteText) {
			return true, nil
		}
	}
	if !nameIsString {
		return false, &dynvalue.TypeError{Message: "name.match is not a function"}
	}
	if (nameText == "Вступление" || interludeName.MatchString(nameText)) && dynvalue.StrictEqual(note, "без вокала") {
		return true, nil
	}
	return nameText == "Финал без вокала" && dynvalue.StrictEqual(note, "до конца трека"), nil
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
			current = &sectionPart{name: dynvalue.Trim(name)}
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
	saved, ok := dynvalue.AsArray(dynvalue.Coalesce(sections, &dynvalue.Array{}))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "saved.filter is not a function"}
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
		manualNames[dynvalue.Get(section, "name")] = true
	}
	result := append([]any{}, manual...)
	for _, section := range buildSections(lyrics, lines, duration, candidates) {
		if !manualNames[section.Value("name")] {
			result = append(result, section)
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		return dynvalue.ToNumber(dynvalue.Get(result[i], "start"))-dynvalue.ToNumber(dynvalue.Get(result[j], "start")) < 0
	})
	return result, nil
}

// section строит автоматическую часть; порядок ключей зафиксирован эталоном.
func section(name string, start, end float64, note string) *dynvalue.Object {
	object := dynvalue.NewObject()
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
func buildSections(lyrics []LyricsLine, lines []any, duration any, candidates []any) []*dynvalue.Object {
	byNumber := map[float64]any{}
	for _, line := range lines {
		if number, ok := dynvalue.Get(line, "source_line").(float64); ok {
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
			if dynvalue.StrictEqual(dynvalue.Get(candidate, "source_line"), number) {
				if _, exists := byNumber[number]; !exists {
					member := dynvalue.Spread(candidate)
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
			if dynvalue.StrictEqual(dynvalue.Get(line, "source_line"), float64(lyric.Number)) {
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
			return dynvalue.ToNumber(dynvalue.Get(members[i], "start"))-dynvalue.ToNumber(dynvalue.Get(members[j], "start")) < 0
		})
		end := math.Inf(-1)
		for _, member := range members {
			end = maxNaN(end, dynvalue.ToNumber(dynvalue.Get(member, "end")))
		}
		named = append(named, namedPart{
			name: part.name, start: dynvalue.ToNumber(dynvalue.Get(members[0], "start")), end: end,
			first: dynvalue.Get(members[0], "id"), last: dynvalue.Get(members[len(members)-1], "id"),
		})
	}
	var result []*dynvalue.Object
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
			"строки "+dynvalue.ToString(part.first)+"–"+dynvalue.ToString(part.last)))
		cursor = maxNaN(cursor, part.end)
	}
	if total, ok := duration.(float64); ok && dynvalue.Truthy(total) && total-cursor >= gapThreshold {
		name, note := "Финал без вокала", "до конца трека"
		if uncertain {
			name, note = "Не размечено", "границы вокала не подтверждены"
		}
		result = append(result, section(name, round(cursor), round(total), note))
	}
	return result
}

// maxNaN — максимум двух чисел: NaN заразен.
func maxNaN(left, right float64) float64 {
	if math.IsNaN(left) || math.IsNaN(right) {
		return math.NaN()
	}
	return math.Max(left, right)
}

// TimingPath — относительный путь разметки внутри проекта; его пишут сохранение редактора и черновик CTC.
const TimingPath = "plan/audio/timing.json"

// SaveProject сохраняет разметку целиком: Prepare строит документ, затем шлюз записи
// проверяет отсутствие незавершённых многофайловых публикаций (montage/derived), и байты Encode
// атомарно заменяют plan/audio/timing.json (права существующего файла сохраняются, новый — 0600).
// Отказ проверки или записи оставляет прежний файл нетронутым. Возвращает записанный документ.
func SaveProject(project string, input any) (*dynvalue.Object, error) {
	result, err := Prepare(project, input)
	if err != nil {
		return nil, err
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return nil, err
	}
	if err := projectfs.WriteFile(filepath.Join(project, filepath.FromSlash(TimingPath)), Encode(result), 0); err != nil {
		return nil, err
	}
	return result, nil
}
