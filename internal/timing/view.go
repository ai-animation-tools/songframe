package timing

import (
	"encoding/json"
	"os"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/sources"
)

// Тексты timingTexts.main для просмотра разметки.
const (
	lyricsRequired   = "Сначала добавьте текст песни на странице «Исходники»."
	unreadableTiming = "Не удалось прочитать сохранённую разметку. Восстановите её из копии или выполните автоматическую разметку заново."
	trackChanged     = "Разметка сделана для другого трека: трек заменён после разметки."
	lyricsChanged    = "После изменения текста часть строк разметки больше не соответствует словам песни и скрыта в редакторе. Повторите автоматическую разметку, чтобы восстановить соответствие. Сохранённая разметка пока не изменена."
)

// View — TimingView контракта.
type View struct {
	// Timing — прочитанный plan/audio/timing.json как есть (неизвестные поля сохраняются) или null,
	// если файла нет либо его структура непригодна.
	Timing json.RawMessage `json:"timing"`
	// Lyrics — строки source/text.md; пусто, если текста нет.
	Lyrics []LyricsLine `json:"lyrics"`
	// TrackPath — абсолютный путь source/track.mp3 или null.
	TrackPath *string `json:"trackPath"`
	// TrackSha256 — sha256 трека из описи исходников.
	TrackSha256 *string `json:"trackSha256"`
	// Duration — duration_seconds трека из описи исходников.
	Duration *float64 `json:"duration"`
	Problems []string `json:"problems"`
}

// readTiming читает timing.json: Undefined для отсутствующего файла, false для битого JSON.
func readTiming(path string) any {
	if !dynvalue.Exists(path) {
		return nil
	}
	value, ok := dynvalue.ReadJSONFile(path)
	if !ok {
		return false
	}
	return value
}

// usableTiming повторяет проверки структуры viewTiming: строки — объекты, кандидаты, порядок
// редактора и секции допустимы. Повреждённый формат не прерывает открытие страниц, а делает файл
// «нечитаемым» (false).
func usableTiming(timing any) bool {
	lines, ok := dynvalue.AsArray(dynvalue.Get(timing, "lines"))
	if !ok {
		return false
	}
	for _, line := range lines {
		if !dynvalue.Truthy(line) || dynvalue.TypeOf(line) != "object" {
			return false
		}
	}
	if candidates := dynvalue.Get(timing, "candidates"); candidates != dynvalue.Undefined && !ValidTimingCandidates(candidates) {
		return false
	}
	if order := dynvalue.Get(timing, "line_order"); order != dynvalue.Undefined {
		items, ok := dynvalue.AsArray(order)
		if !ok {
			return false
		}
		for _, number := range items {
			if !dynvalue.IsSafeInteger(number) {
				return false
			}
		}
	}
	if sections := dynvalue.Get(timing, "sections"); sections != dynvalue.Undefined {
		items, ok := dynvalue.AsArray(sections)
		if !ok {
			return false
		}
		for _, section := range items {
			origin := dynvalue.Get(section, "origin")
			if !dynvalue.Truthy(section) || dynvalue.TypeOf(section) != "object" ||
				dynvalue.TypeOf(dynvalue.Get(section, "name")) != "string" ||
				!dynvalue.IsFinite(dynvalue.Get(section, "start")) || !dynvalue.IsFinite(dynvalue.Get(section, "end")) ||
				(origin != dynvalue.Undefined && !dynvalue.StrictEqual(origin, "auto") && !dynvalue.StrictEqual(origin, "manual")) {
				return false
			}
		}
	}
	return true
}

// ViewProject — вид редактора таймингов: текст песни с проблемами разбора, сохранённая разметка
// и сведения трека. Ошибка — только сбой чтения source/text.md (например, это каталог);
// отсутствие и повреждение файлов выражаются проблемами.
func ViewProject(project string) (View, error) {
	view := View{Timing: json.RawMessage("null"), Lyrics: []LyricsLine{}, Problems: []string{}}
	textPath := filepath.Join(project, "source", "text.md")
	hasText := dynvalue.Exists(textPath)
	text := ""
	if hasText {
		data, err := os.ReadFile(textPath)
		if err != nil {
			return View{}, dynvalue.FsError("read", "", err)
		}
		text = dynvalue.DecodeUTF8(data)
	}
	parsed := AnalyzeLyrics(text)
	if hasText {
		view.Lyrics = parsed.Rows
		view.Problems = append(view.Problems, parsed.Problems...)
	} else {
		view.Problems = append(view.Problems, lyricsRequired)
	}
	trackPath := filepath.Join(project, "source", "track.mp3")
	manifest := sources.ReadManifest(project)
	timing := readTiming(filepath.Join(project, "plan", "audio", "timing.json"))
	if dynvalue.Truthy(timing) && !usableTiming(timing) {
		timing = false
	}
	if timing == false {
		view.Problems = append(view.Problems, unreadableTiming)
	}
	track := dynvalue.Get(manifest, "track")
	if dynvalue.Truthy(timing) && dynvalue.Truthy(track) {
		if sha := dynvalue.Get(timing, "sha256"); dynvalue.Truthy(sha) && !dynvalue.StrictEqual(sha, dynvalue.Get(track, "sha256")) {
			view.Problems = append(view.Problems, trackChanged)
		}
	}
	if dynvalue.Truthy(timing) && hasInvalidLines(timing, view.Lyrics) {
		view.Problems = append(view.Problems, lyricsChanged)
	}
	if dynvalue.Truthy(timing) {
		view.Timing = dynvalue.Raw(timing)
	}
	if dynvalue.Exists(trackPath) {
		view.TrackPath = &trackPath
	}
	// Опись пишет только приложение: sha256 — строка, duration_seconds — число. Значение другого
	// типа контракт TimingView не допускает и отдаётся как null.
	if sha, ok := dynvalue.Get(track, "sha256").(string); ok {
		view.TrackSha256 = &sha
	}
	if duration, ok := dynvalue.Get(track, "duration_seconds").(float64); ok {
		view.Duration = &duration
	}
	return view, nil
}

// hasInvalidLines — selectLyricTimings(...).invalidIds непуст: строка разметки указывает не на
// строку песни (заголовок или номер, которого больше нет).
func hasInvalidLines(timing any, lyrics []LyricsLine) bool {
	numbers := map[float64]bool{}
	for _, lyric := range lyrics {
		if lyric.Text != "" && !lyric.Header {
			numbers[float64(lyric.Number)] = true
		}
	}
	lines, _ := dynvalue.AsArray(dynvalue.Get(timing, "lines"))
	for _, line := range lines {
		number, ok := dynvalue.Get(line, "source_line").(float64)
		if !ok || !numbers[number] {
			return true
		}
	}
	return false
}
