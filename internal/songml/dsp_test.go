package songml

import (
	"math"
	"testing"
)

func TestRoundtripLengthAndSilence(t *testing.T) {
	// Нестандартная длина выявляет обрезку хвоста; тишина проверяет отсутствие сдвига начала.
	n := 3457
	signal := [2][]float32{make([]float32, n), make([]float32, n)}
	for i := 512; i < n; i++ {
		signal[0][i] = float32(.2 * math.Sin(float64(i)*.1))
		signal[1][i] = signal[0][i] * .7
	}
	spectrum, frames, err := STFT(signal, 256, 64)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := ISTFT(spectrum, 129, frames, n, 256, 64)
	if err != nil {
		t.Fatal(err)
	}
	for ch := 0; ch < 2; ch++ {
		if len(decoded[ch]) != n {
			t.Fatal("потеря длины")
		}
		for i, v := range decoded[ch] {
			if math.Abs(float64(v-signal[ch][i])) > 1e-6 {
				t.Fatalf("канал %d отсчёт %d", ch, i)
			}
		}
	}
}
