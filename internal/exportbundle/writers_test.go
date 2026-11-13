package exportbundle

import "testing"

// TestFrameRateLabel проверяет согласование частоты кадров в README пакета для всех частот
// проекта: эталоны пакета собраны только на 30 кадрах/с.
func TestFrameRateLabel(t *testing.T) {
	for fps, want := range map[int64]string{24: "24 кадра/с", 25: "25 кадров/с", 30: "30 кадров/с"} {
		if got := frameRateLabel(fps); got != want {
			t.Errorf("frameRateLabel(%d) = %q, ожидалось %q", fps, got, want)
		}
	}
}
