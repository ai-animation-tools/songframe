package timing

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/golden"
)

// draftCase — случай testdata/golden/timing-draft/cases.json: вход build_timing оригинала
// и его результат (точные байты json.dumps или текст ValueError).
type draftCase struct {
	Name  string `json:"name"`
	Input struct {
		Text            string  `json:"text"`
		Duration        float64 `json:"duration"`
		DecodedDuration float64 `json:"decodedDuration"`
		SHA256          string  `json:"sha256"`
		Segments        []struct {
			SourceLine int     `json:"sourceLine"`
			Start      float64 `json:"start"`
			End        float64 `json:"end"`
		} `json:"segments"`
		Candidates []struct {
			SourceLine    int     `json:"sourceLine"`
			Start         float64 `json:"start"`
			End           float64 `json:"end"`
			Reason        string  `json:"reason"`
			AcousticScore float64 `json:"acousticScore"`
		} `json:"candidates"`
		Previous *string `json:"previous"`
	} `json:"input"`
	Expected struct {
		Error  *string `json:"error"`
		Timing *string `json:"timing"`
	} `json:"expected"`
}

// TestBuildDraftMatchesOriginal сверяет черновик с build_timing оригинала побайтно: перенос
// подтверждённых строк, заметки, кандидаты, очередь, части песни, ошибки и формат чисел Python.
func TestBuildDraftMatchesOriginal(t *testing.T) {
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "timing-draft", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []draftCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("нет случаев")
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			recognition := Recognition{Segments: []Segment{}, Candidates: []Candidate{}, DecodedDuration: item.Input.DecodedDuration}
			for _, segment := range item.Input.Segments {
				recognition.Segments = append(recognition.Segments, Segment{segment.SourceLine, segment.Start, segment.End})
			}
			for _, candidate := range item.Input.Candidates {
				recognition.Candidates = append(recognition.Candidates, Candidate{candidate.SourceLine, candidate.Start, candidate.End, candidate.Reason, candidate.AcousticScore})
			}
			var previous any
			if item.Input.Previous != nil {
				previous = ParsePrevious([]byte(*item.Input.Previous))
			}
			draft, err := BuildDraft(item.Input.Text, recognition, item.Input.Duration, previous, item.Input.SHA256)
			if item.Expected.Error != nil {
				if err == nil || err.Error() != *item.Expected.Error {
					t.Fatalf("ошибка %v, ожидалась %q", err, *item.Expected.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := EncodeDraft(draft)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != *item.Expected.Timing {
				t.Fatalf("черновик отличается от оригинала:\n%s\nожидалось:\n%s", encoded, *item.Expected.Timing)
			}
		})
	}
}

// TestPyFloatRepr — repr(float) Python для чисел, которые встречаются в разметке.
func TestPyFloatRepr(t *testing.T) {
	for value, want := range map[float64]string{
		0: "0.0", 1: "1.0", 0.1: "0.1", 12.5: "12.5", 1e16: "1e+16", 1e15: "1000000000000000.0", 1e-5: "1e-05", 0.0001: "0.0001",
		123456789012345678: "1.2345678901234568e+17", 5e-324: "5e-324", -2.75: "-2.75", 1e22: "1e+22", 59.98725: "59.98725",
	} {
		if got, err := pyFloatRepr(value); err != nil || got != want {
			t.Errorf("repr(%v) = %q, %v; ожидалось %q", value, got, err, want)
		}
	}
	if got, _ := pyFloatRepr(math.Copysign(0, -1)); got != "-0.0" {
		t.Errorf("-0.0: %q", got)
	}
	if _, err := pyFloatRepr(math.NaN()); err == nil {
		t.Error("NaN должен отклоняться")
	}
}

// TestPyJSONRoundTrip — прежний файл, записанный Python, перечитывается и записывается теми же
// байтами: int и float, порядок ключей, экранирование и пустые коллекции сохраняются.
func TestPyJSONRoundTrip(t *testing.T) {
	text := "{\n  \"a\": 1,\n  \"b\": 1.0,\n  \"c\": [],\n  \"d\": {},\n  \"e\": \"«ё»\\n\\t\\u0001\\\"\\\\\",\n  \"f\": [\n    true,\n    null,\n    123456789012345678901234567890\n  ]\n}\n"
	value, err := parsePyJSON([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := encodePyJSON(value)
	if err != nil || string(encoded) != text {
		t.Fatalf("%v\n%s", err, encoded)
	}
	if ParsePrevious([]byte("[1]")) != nil || ParsePrevious([]byte("{")) != nil || ParsePrevious([]byte("\ufeff{}")) != nil {
		t.Fatal("не-объект, битый JSON и BOM считаются отсутствием прежней разметки")
	}
}

// TestFromAlignment — правила refine_lines: без пути строка не попадает никуда, сомнение с
// уверенностью ≥0,45 — кандидат, короткий интервал — причина сомнения.
func TestFromAlignment(t *testing.T) {
	value := func(v float64) *float64 { return &v }
	result := FromAlignment([]AlignedLine{
		{SourceLine: 1, Start: value(1), End: value(3), AcousticScore: 0.9, Reason: "Акустический кандидат; требуется проверка человеком."},
		{SourceLine: 2, Start: value(3.1), End: value(4), AcousticScore: 0.5, ReviewRequired: true, Reason: "Сомнение."},
		{SourceLine: 3, Start: value(4.1), End: value(4.3), AcousticScore: 0.9},
		{SourceLine: 4, Start: value(5), End: value(6), AcousticScore: 0.3, ReviewRequired: true, Reason: "Слабо."},
		{SourceLine: 5},
	}, 10)
	if len(result.Segments) != 1 || result.Segments[0].SourceLine != 1 {
		t.Fatalf("сегменты %+v", result.Segments)
	}
	if len(result.Candidates) != 2 || result.Candidates[0].Reason != "Сомнение." ||
		result.Candidates[1].Reason != "Акустический интервал слишком короткий; укажите границы вручную." {
		t.Fatalf("кандидаты %+v", result.Candidates)
	}
}

// TestLyricLinesPython — splitlines и strip Python: \r, \v и U+2028 — переводы строк.
func TestLyricLinesPython(t *testing.T) {
	lines, err := LyricLines("\ufeffА\rБ\r\nВ\vГ [Часть]\n  Д  \n")
	if err != nil {
		t.Fatal(err)
	}
	want := []LyricLine{{1, "А"}, {2, "Б"}, {3, "В"}, {4, "Г"}, {6, "Д"}}
	if len(lines) != len(want) {
		t.Fatalf("%+v", lines)
	}
	for index := range want {
		if lines[index] != want[index] {
			t.Fatalf("%+v", lines)
		}
	}
	if _, err := LyricLines("Припев:\n"); err == nil {
		t.Fatal("часть без скобок должна отклоняться")
	}
}
