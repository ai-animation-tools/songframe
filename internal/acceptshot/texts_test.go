package acceptshot

import "testing"

// TestCutMissingNamesProjectGrid — отказ без участка называет сетку частоты проекта с согласованным
// словом «кадр»: 24 кадра/с, 25 и 30 кадров/с. Остальное поведение accept_shot закреплено
// эталоном testdata/golden/production-tools.
func TestCutMissingNamesProjectGrid(t *testing.T) {
	for fps, want := range map[int64]string{
		24: "Укажите участок: --review или --cut НАЧАЛО:КОНЕЦ на сетке 24 кадра/с.",
		25: "Укажите участок: --review или --cut НАЧАЛО:КОНЕЦ на сетке 25 кадров/с.",
		30: "Укажите участок: --review или --cut НАЧАЛО:КОНЕЦ на сетке 30 кадров/с.",
	} {
		if got := textCutMissing(fps); got != want {
			t.Errorf("textCutMissing(%d) = %q, ожидалось %q", fps, got, want)
		}
	}
}
