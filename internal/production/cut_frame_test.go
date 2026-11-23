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
		{24, &offGrid, "Границы участка должны быть конечными неотрицательными секундами на сетке 24 кадра/с; секунды кадра достаточно указать до тысячных."},
		{25, &negative, "Границы участка должны быть конечными неотрицательными секундами на сетке 25 кадров/с; секунды кадра достаточно указать до тысячных."},
		{30, nil, "Границы участка должны быть конечными неотрицательными секундами на сетке 30 кадров/с; секунды кадра достаточно указать до тысячных."},
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

// TestCutFrameThousandths — секунды кадра, записанные до тысячных, приводятся к кадру сетки;
// граница между кадрами (0,875 с при 30 кадрах/с — 26,25 кадра) по-прежнему отклоняется.
func TestCutFrameThousandths(t *testing.T) {
	for _, item := range []struct {
		seconds, fps float64
		frame        int
	}{{0.833, 30, 25}, {5.167, 30, 155}, {0.042, 24, 1}, {6.0416666666666667, 24, 145}, {0.8333333333333334, 30, 25}} {
		seconds := item.seconds
		if frame, err := cutFrame(&seconds, item.fps); err != nil || frame != item.frame {
			t.Fatalf("cutFrame(%v с, %v) = %d, %v; ожидался кадр %d", item.seconds, item.fps, frame, err, item.frame)
		}
	}
	for _, seconds := range []float64{0.875, 0.8325, 0.01} {
		value := seconds
		if _, err := cutFrame(&value, 30); err == nil {
			t.Fatalf("граница %v с между кадрами 30 кадров/с принята", seconds)
		}
	}
}
