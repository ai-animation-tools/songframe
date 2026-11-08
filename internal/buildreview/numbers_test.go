package buildreview

import (
	"testing"

	"songframe/internal/toolrt"
)

// TestDecimalText — каноническая запись DecimalText на краевых значениях.
// Строка скорости попадает в фильтр setpts и в рецепт; эталоны build-review таких записей не
// различают, поэтому формат закреплён здесь.
func TestDecimalText(t *testing.T) {
	cases := map[string]string{
		"1E+1": "1E+1", "5E-1": "0.5", "0.50": "0.50", "1e-7": "1E-7", "1.5": "1.5", " 2 ": "2",
		"1_000": "1000", "-0.0": "-0.0", "100E-2": "1.00", "0.000001": "0.000001", "0.0000001": "1E-7",
		"12E3": "1.2E+4", "-1.25E+2": "-125", "١.٥": "1.5", "0": "0",
	}
	for input, want := range cases {
		if got, ok := DecimalText(input); !ok || got != want {
			t.Errorf("DecimalText(%q) = %q, %v; ожидалось %q", input, got, ok, want)
		}
	}
	for _, input := range []string{"", "abc", "1.2.3", "NaN", "Infinity", "1e", "."} {
		if got, ok := DecimalText(input); ok {
			t.Errorf("DecimalText(%q) = %q, ожидался отказ", input, got)
		}
	}
}

// TestFramesHalfUp — frames(): половина кадра округляется от нуля.
func TestFramesHalfUp(t *testing.T) {
	cases := map[string]int64{"0.5": 1, "1.5": 2, "2.5": 3, "-0.5": -1, "-1.5": -2, "1.49999": 1, "2.5000001": 3}
	for input, want := range cases {
		value, err := toolrt.NewDecimal(input)
		if err != nil {
			t.Fatal(err)
		}
		got, err := frames(value)
		if err != nil || got.Int64() != want {
			t.Errorf("frames(%s) = %v, %v; ожидалось %d", input, got, err, want)
		}
	}
	nan, _ := toolrt.NewDecimal("NaN")
	if _, err := frames(nan); err == nil {
		t.Error("frames(NaN) без ошибки")
	}
}
