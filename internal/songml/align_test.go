package songml

import (
	"context"
	"math"
	"testing"
)

var testVocab = map[string]int{"<pad>": 0, "|": 1, "а": 2, "б": 3, "ё": 4}

func fixture(labels []int) ([]float32, []float64, float64) {
	var probs []float32
	var times []float64
	for i, label := range labels {
		for c := 0; c < 5; c++ {
			probability := .0025
			if c == label {
				probability = .99
			}
			probs = append(probs, float32(math.Log(probability)))
		}
		times = append(times, .01+float64(i)*.02)
	}
	return probs, times, float64(len(labels)) * .02
}

func alignFixture(t *testing.T, text string, labels []int, scoring string) Result {
	t.Helper()
	lines, err := ParseLyrics(text, testVocab)
	if err != nil {
		t.Fatal(err)
	}
	p, times, duration := fixture(labels)
	options := DefaultOptions(duration)
	options.Scoring = scoring
	r, err := Align(context.Background(), p, times, 5, 0, lines, options)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRepeatedLetterNeedsBlank(t *testing.T) {
	for _, scoring := range []string{"margin", "logprob"} {
		r := alignFixture(t, "аа", []int{0, 0, 2, 0, 2, 0, 0}, scoring)
		line := r.Lines[0]
		if r.Status != "candidate" || *line.FirstFrame != 2 || *line.LastFrame != 4 {
			t.Fatalf("%s: %+v", scoring, r)
		}
		if *line.Start < .039999 || *line.Start > .040001 || *line.End < .099999 || *line.End > .100001 {
			t.Fatalf("неверные края: %+v", line)
		}
		if len(line.Words) != 1 || line.Words[0].FirstFrame != 2 || line.Words[0].LastFrame != 4 {
			t.Fatalf("нет реального пути слова: %+v", line)
		}
	}
	// Две одинаковые буквы не могут занять два соседних кадра без blank.
	r := alignFixture(t, "аа", []int{2, 2}, "margin")
	if r.Status != "unavailable" || r.Lines[0].Start != nil || len(r.Lines[0].Words) != 0 {
		t.Fatalf("появились выдуманные границы: %+v", r)
	}
}

func TestRepeatedChorusMonotonic(t *testing.T) {
	r := alignFixture(t, "[Припев]\nа б\n\n[Припев]\nа б", []int{0, 2, 1, 3, 0, 1, 0, 2, 1, 3, 0}, "margin")
	if len(r.Lines) != 2 || r.Lines[0].SourceLine != 2 || r.Lines[1].SourceLine != 5 || r.TokenCount != 7 || r.WordCount != 4 {
		t.Fatalf("разобран не весь текст: %+v", r)
	}
	if *r.Lines[0].FirstFrame != 1 || *r.Lines[0].LastFrame != 3 || *r.Lines[1].FirstFrame != 7 || *r.Lines[1].LastFrame != 9 {
		t.Fatalf("припевы спутаны: %+v", r)
	}
	if *r.Lines[0].End > *r.Lines[1].Start {
		t.Fatal("нарушена монотонность")
	}
}

func TestMissingPhraseRemainsReviewRequired(t *testing.T) {
	r := alignFixture(t, "а\nб", []int{0, 2, 0, 1, 0, 4, 0, 0}, "margin")
	if r.Lines[1].Status != "review_required" || r.Lines[1].MinimumTokenPeak > .01 || r.Lines[1].Reason == "" {
		t.Fatalf("чужая буква принята: %+v", r)
	}
	if r.Lines[1].Status == "accepted" {
		t.Fatal("forced alignment не подтверждает себя сам")
	}
	for _, line := range r.Lines {
		if line.FirstFrame == nil || line.LastFrame == nil || line.Words[0].FirstFrame < *line.FirstFrame || line.Words[0].LastFrame > *line.LastFrame {
			t.Fatalf("слова не опираются на путь: %+v", line)
		}
	}
}

func TestUnsupportedLetterBlocksGlobalPath(t *testing.T) {
	r := alignFixture(t, "а\nї б", []int{2, 1, 3, 0, 0, 0, 0}, "margin")
	if r.Status != "unavailable" || r.Lines[1].Reason == "" {
		t.Fatalf("незнакомая буква исчезла: %+v", r)
	}
	for _, line := range r.Lines {
		if line.Start != nil || line.End != nil || len(line.Words) != 0 {
			t.Fatalf("есть интерполяция: %+v", line)
		}
	}
}

func TestNormalizationPreservesYoAndPhysicalLine(t *testing.T) {
	lines, err := ParseLyrics("\ufeff[Куплет]\r\n\r\nЁ, а-б!", testVocab)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].SourceLine != 3 || lines[0].Normalized != "ё|а|б" || lines[0].Tokens[0] != 4 {
		t.Fatalf("неверная нормализация: %+v", lines)
	}
}

func TestNoInterpolationAndCancellation(t *testing.T) {
	r := alignFixture(t, "а б\nа б", []int{2, 1, 3}, "margin")
	if r.Status != "unavailable" {
		t.Fatalf("нехватка кадров скрыта: %+v", r)
	}
	for _, line := range r.Lines {
		if line.Start != nil || line.End != nil || len(line.Words) > 0 {
			t.Fatal("интервалы выдуманы")
		}
	}
	lines, _ := ParseLyrics("а", testVocab)
	p, times, duration := fixture([]int{0, 2, 0})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Align(ctx, p, times, 5, 0, lines, DefaultOptions(duration))
	if err != context.Canceled {
		t.Fatalf("отмена потеряна: %v", err)
	}
}

func TestLongBlankIsNotUniformlyGivenToWords(t *testing.T) {
	r := alignFixture(t, "а б", []int{0, 2, 0, 0, 0, 0, 1, 0, 0, 3, 0}, "margin")
	words := r.Lines[0].Words
	if len(words) != 2 || words[0].FirstFrame != 1 || words[0].LastFrame != 1 || words[1].FirstFrame != 9 || words[1].LastFrame != 9 {
		t.Fatalf("слова распределены по длительности вместо CTC: %+v", words)
	}
}
