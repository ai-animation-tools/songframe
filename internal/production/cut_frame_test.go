package production

import (
	"testing"

	"songframe/internal/projectfile"
)

// TestCutFrameNamesProjectGrid — отказ по границам участка называет сетку частоты проекта, а не
// одну фиксированную: секунды, не попадающие на кадр 24 кадров/с, отклоняются текстом про 24
// кадра/с; неизвестная частота отклоняется ошибкой маркера проекта до проверки границ.
func TestCutFrameNamesProjectGrid(t *testing.T) {
	offGrid := 0.01
	negative := -1.0
	for _, item := range []struct {
		fps     float64
		seconds *float64
		want    string
	}{
		{24, &offGrid, "Границы участка должны быть конечными неотрицательными секундами на сетке 24 кадра/с."},
		{25, &negative, "Границы участка должны быть конечными неотрицательными секундами на сетке 25 кадров/с."},
		{30, nil, "Границы участка должны быть конечными неотрицательными секундами на сетке 30 кадров/с."},
		{0, &offGrid, projectfile.FrameRateInvalid},
	} {
		if _, err := cutFrame(item.seconds, item.fps); err == nil || err.Error() != item.want {
			t.Fatalf("cutFrame при %v кадрах/с: %v, ожидалось %q", item.fps, err, item.want)
		}
	}
	whole := 2.5
	if frames, err := cutFrame(&whole, 24); err != nil || frames != 60 {
		t.Fatalf("cutFrame(2.5 с, 24) = %d, %v; ожидалось 60 кадров", frames, err)
	}
}
