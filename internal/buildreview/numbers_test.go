package buildreview

import (
	"math/big"
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

// TestFrameGridSamples — границы звука на сетке проекта: при 30 кадрах/с кадр — ровно 1470
// отсчётов, при 24 — 1837,5 с округлением половины вверх; секунды и кадры длительности считаются
// по той же частоте.
func TestFrameGridSamples(t *testing.T) {
	for _, item := range []struct {
		frames, fps int64
		want        string
	}{{1, 30, "1470"}, {1, 24, "1838"}, {2, 24, "3675"}, {1, 25, "1764"}} {
		if got := samples(big.NewInt(item.frames), item.fps).String(); got != item.want {
			t.Fatalf("samples(%d, %d) = %s, ждали %s", item.frames, item.fps, got, item.want)
		}
	}
	if got, err := seconds(big.NewInt(12), 24); err != nil || got != "0.500000000" {
		t.Fatalf("seconds(12, 24) = %s %v", got, err)
	}
	duration, _ := toolrt.NewDecimal("0.5")
	if got, err := framesTimesFPS(duration, 24); err != nil || got.Int64() != 12 {
		t.Fatalf("framesTimesFPS(0.5, 24) = %v %v", got, err)
	}
}
