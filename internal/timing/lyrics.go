// Package timing ведёт разметку песни plan/audio/timing.json: разбор текста source/text.md,
// вид для редактора таймингов, проверку и сохранение ручной разметки и сборку черновика после
// автоматической разметки.
//
// Правила разбора текста и проверки совпадают с frontend/src/shared/lyrics.ts и
// timing-validation.ts, которыми редактор проверяет разметку до сохранения. Сохранённый
// timing.json отдаётся редактору как прочитанный документ — с неизвестными полями, различием
// отсутствующего ключа и null, без округления секунд. Проверки работают с деревом jscompat,
// потому что вход — недоверенный JSON, а правила заданы в семантике JS.
package timing

import (
	"regexp"
	"strconv"
	"strings"

	"songframe-go/internal/jscompat"
)

// LyricsLine — LyricsLine контракта: физическая строка source/text.md.
type LyricsLine struct {
	// Number — номер строки файла с единицы.
	Number int `json:"number"`
	// Text — строка без пробелов по краям (String.prototype.trim).
	Text string `json:"text"`
	// Header — заголовок части или строка, которую нельзя размечать (ошибочный заголовок, Markdown,
	// название части без скобок).
	Header bool `json:"header"`
}

// Lyrics — результат analyzeLyrics.
type Lyrics struct {
	Rows []LyricsLine
	// Lines — число строк песни (непустых и не заголовков).
	Lines    int
	Sections []string
	Problems []string
}

// Грамматика заголовков. \s JS шире \s RE2, поэтому класс пробелов задан явно. Флаг i JS без u не
// сопоставляет «ſ» и знак Кельвина с латиницей, а (?i) RE2 сопоставляет: латиница перечислена
// в обоих регистрах, без учёта регистра сравниваются только кириллические слова.
var (
	lineBreak    = regexp.MustCompile(`\r\n?|\n`)
	header       = regexp.MustCompile(`^\[([^\[\]]+)\]$`)
	markdown     = regexp.MustCompile(`^(?:#{1,6}[` + jscompat.SpaceClass + `]|[-*+][` + jscompat.SpaceClass + `]|\d+[.)][` + jscompat.SpaceClass + `]|` + "```" + `|~~~)`)
	letter       = `(?:[a-zA-Z]|(?i:[а-яё]))`
	space        = `[` + jscompat.SpaceClass + `]`
	sectionTitle = regexp.MustCompile(`^(?:` + letter + `+` + space + `+){0,2}(?i:припев|куплет|бридж|интро|вступление|аутро|проигрыш|кода|финал|запев)(?:` +
		space + `+(?:` + letter + `+|\d+)){0,2}[:.]?$`)
	trailingPunct = regexp.MustCompile(`[:.]$`)
)

// Тексты lyricsTexts.
const lyricsNoLines = "В тексте песни нет ни одной строки. Добавьте слова песни под заголовком секции."

func lyricsInvalidHeader(number int) string {
	return "Строка " + strconv.Itoa(number) + ": заголовок секции должен быть отдельной строкой вида [Припев], с непустым названием и обеими скобками."
}

func lyricsMarkdown(number int) string {
	return "Строка " + strconv.Itoa(number) + ": уберите Markdown-разметку или нумерацию. Слова песни пишутся обычным текстом, секции — как [Припев]."
}

func lyricsUnmarked(titles []string, numbers []int, example string) string {
	quoted := make([]string, len(titles))
	for index, title := range titles {
		quoted[index] = "«" + title + "»"
	}
	parts := make([]string, len(numbers))
	for index, number := range numbers {
		parts[index] = strconv.Itoa(number)
	}
	return "Похоже на названия частей без скобок: " + strings.Join(quoted, ", ") + " (строки " + strings.Join(parts, ", ") +
		"). Оформите их как [" + example + "]."
}

// AnalyzeLyrics — analyzeLyrics: одна строка файла — одна строка песни, части в квадратных
// скобках. Пустой текст даёт одну пустую строку, финальный перевод строки — пустую последнюю.
func AnalyzeLyrics(text string) Lyrics {
	result := Lyrics{Rows: []LyricsLine{}, Sections: []string{}, Problems: []string{}}
	type unmarkedRow struct {
		number int
		text   string
	}
	var unmarked []unmarkedRow
	for index, raw := range lineBreak.Split(text, -1) {
		line := jscompat.Trim(raw)
		number := index + 1
		isHeader := false
		if match := header.FindStringSubmatch(line); match != nil && jscompat.Trim(match[1]) != "" {
			result.Sections = append(result.Sections, jscompat.Trim(match[1]))
			isHeader = true
		} else if strings.ContainsAny(line, "[]") {
			// Ошибочный заголовок не превращаем в строку песни даже при чтении старого файла.
			isHeader = true
			result.Problems = append(result.Problems, lyricsInvalidHeader(number))
		} else if markdown.MatchString(line) {
			isHeader = true
			result.Problems = append(result.Problems, lyricsMarkdown(number))
		} else if sectionTitle.MatchString(line) {
			isHeader = true
			unmarked = append(unmarked, unmarkedRow{number, line})
		}
		result.Rows = append(result.Rows, LyricsLine{Number: number, Text: line, Header: isHeader})
	}
	for _, row := range result.Rows {
		if row.Text != "" && !row.Header {
			result.Lines++
		}
	}
	if result.Lines == 0 {
		result.Problems = append(result.Problems, lyricsNoLines)
	}
	if len(unmarked) > 0 {
		titles := make([]string, len(unmarked))
		numbers := make([]int, len(unmarked))
		for index, row := range unmarked {
			titles[index], numbers[index] = row.text, row.number
		}
		result.Problems = append(result.Problems, lyricsUnmarked(titles, numbers, trailingPunct.ReplaceAllString(unmarked[0].text, "")))
	}
	return result
}

// ParseLyricsLines — parseLyricsLines: только строки разбора.
func ParseLyricsLines(text string) []LyricsLine {
	return AnalyzeLyrics(text).Rows
}
