package timing

import (
	"encoding/json"
	"os"
	"path/filepath"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/sources"
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
	if !jscompat.Exists(path) {
		return nil
	}
	value, ok := jscompat.ReadJSONFile(path)
	if !ok {
		return false
	}
	return value
}

// usableTiming повторяет проверки структуры viewTiming: строки — объекты, кандидаты, порядок
// редактора и секции допустимы. Повреждённый формат не прерывает открытие страниц, а делает файл
// «нечитаемым» (false).
func usableTiming(timing any) bool {
	lines, ok := jscompat.AsArray(jscompat.Get(timing, "lines"))
	if !ok {
		return false
	}
	for _, line := range lines {
		if !jscompat.Truthy(line) || jscompat.TypeOf(line) != "object" {
			return false
		}
	}
	if candidates := jscompat.Get(timing, "candidates"); candidates != jscompat.Undefined && !ValidTimingCandidates(candidates) {
		return false
	}
	if order := jscompat.Get(timing, "line_order"); order != jscompat.Undefined {
		items, ok := jscompat.AsArray(order)
		if !ok {
			return false
		}
		for _, number := range items {
			if !jscompat.IsSafeInteger(number) {
				return false
			}
		}
	}
	if sections := jscompat.Get(timing, "sections"); sections != jscompat.Undefined {
		items, ok := jscompat.AsArray(sections)
		if !ok {
			return false
		}
		for _, section := range items {
			origin := jscompat.Get(section, "origin")
			if !jscompat.Truthy(section) || jscompat.TypeOf(section) != "object" ||
				jscompat.TypeOf(jscompat.Get(section, "name")) != "string" ||
				!jscompat.IsFinite(jscompat.Get(section, "start")) || !jscompat.IsFinite(jscompat.Get(section, "end")) ||
				(origin != jscompat.Undefined && !jscompat.StrictEqual(origin, "auto") && !jscompat.StrictEqual(origin, "manual")) {
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
	hasText := jscompat.Exists(textPath)
	text := ""
	if hasText {
		data, err := os.ReadFile(textPath)
		if err != nil {
			return View{}, jscompat.FsError("read", "", err)
		}
		text = jscompat.DecodeUTF8(data)
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
	if jscompat.Truthy(timing) && !usableTiming(timing) {
		timing = false
	}
	if timing == false {
		view.Problems = append(view.Problems, unreadableTiming)
	}
	track := jscompat.Get(manifest, "track")
	if jscompat.Truthy(timing) && jscompat.Truthy(track) {
		if sha := jscompat.Get(timing, "sha256"); jscompat.Truthy(sha) && !jscompat.StrictEqual(sha, jscompat.Get(track, "sha256")) {
			view.Problems = append(view.Problems, trackChanged)
		}
	}
	if jscompat.Truthy(timing) && hasInvalidLines(timing, view.Lyrics) {
		view.Problems = append(view.Problems, lyricsChanged)
	}
	if jscompat.Truthy(timing) {
		view.Timing = jscompat.Raw(timing)
	}
	if jscompat.Exists(trackPath) {
		view.TrackPath = &trackPath
	}
	// Опись пишет только приложение: sha256 — строка, duration_seconds — число. Значение другого
	// типа контракт TimingView не допускает и отдаётся как null.
	if sha, ok := jscompat.Get(track, "sha256").(string); ok {
		view.TrackSha256 = &sha
	}
	if duration, ok := jscompat.Get(track, "duration_seconds").(float64); ok {
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
	lines, _ := jscompat.AsArray(jscompat.Get(timing, "lines"))
	for _, line := range lines {
		number, ok := jscompat.Get(line, "source_line").(float64)
		if !ok || !numbers[number] {
			return true
		}
	}
	return false
}
