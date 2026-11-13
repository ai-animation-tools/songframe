package plural

import "testing"

// TestWord фиксирует правило согласования, общее с frontend/src/shared/plural.ts.
func TestWord(t *testing.T) {
	cases := map[int]string{
		0: "кадров", 1: "кадр", 2: "кадра", 5: "кадров", 11: "кадров", 12: "кадров", 14: "кадров",
		21: "кадр", 22: "кадра", 24: "кадра", 25: "кадров", 30: "кадров", 101: "кадр", 111: "кадров",
		-1: "кадр", -24: "кадра",
	}
	for count, want := range cases {
		if got := Word(count, "кадр", "кадра", "кадров"); got != want {
			t.Errorf("Word(%d) = %q, ожидалось %q", count, got, want)
		}
	}
}
