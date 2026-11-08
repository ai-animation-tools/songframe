package songml

import (
	"context"
	"math"
	"reflect"
	"strings"
	"testing"
)

// Каждая пара изолирована разделителем: соседние слова не добавляют обучающих пауз.
func pauseTrace(gaps []int, peaks [2]float64) *pathTrace {
	trace := &pathTrace{separator: 1}
	frame := 0
	for _, gap := range gaps {
		trace.target = append(trace.target, 2, 3, 1)
		trace.first = append(trace.first, frame, frame+gap+1, frame+gap+2)
		trace.last = append(trace.last, frame, frame+gap+1, frame+gap+2)
		trace.peaks = append(trace.peaks, peaks[0], peaks[1], .99)
		frame += gap + 3
	}
	return trace
}

func TestPauseCalibrationSelectsOnlyConfidentPositiveIntrawordGaps(t *testing.T) {
	for _, tc := range []struct {
		name  string
		trace *pathTrace
		want  int
	}{
		{"уверенная пара на пороге", pauseTrace([]int{4}, [2]float64{.5, .5}), 1},
		{"слабая левая буква", pauseTrace([]int{4}, [2]float64{.49, .9}), 0},
		{"слабая правая буква", pauseTrace([]int{4}, [2]float64{.9, .49}), 0},
		{"соседние кадры", pauseTrace([]int{0}, [2]float64{.9, .9}), 0},
		{"межсловная пауза", &pathTrace{target: []int{2, 1, 3}, first: []int{0, 100, 200}, last: []int{0, 100, 200}, peaks: []float64{.9, .9, .9}, separator: 1}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := calibratePauses(tc.trace)
			if policy.SampleCount != tc.want || policy.Applied || policy.CostPerFrame != 0 {
				t.Fatalf("неверная выборка: %+v", policy)
			}
		})
	}
}

func TestPauseCalibrationRobustQuantileAndMinimumSamples(t *testing.T) {
	// Единичный длинный выброс не превращает типичную паузу в длину проигрыша.
	gaps := make([]int, 40)
	for i := range gaps {
		gaps[i] = 2
	}
	gaps[39] = 1000
	policy := calibratePauses(pauseTrace(gaps, [2]float64{.9, .9}))
	if !policy.Applied || policy.SampleCount != 40 || policy.MaximumGapFrames != 1000 || policy.P95GapFrames != 2 || math.Abs(policy.CostPerFrame-math.Ln2/2) > 1e-12 {
		t.Fatalf("выброс испортил масштаб: %+v", policy)
	}
	for i := range gaps[:32] {
		gaps[i] = i + 1
	}
	policy = calibratePauses(pauseTrace(gaps[:32], [2]float64{.9, .9}))
	if !policy.Applied || math.Abs(policy.P95GapFrames-30.45) > 1e-12 {
		t.Fatalf("потеряна интерполяция квантиля: %+v", policy)
	}
	policy = calibratePauses(pauseTrace(gaps[:31], [2]float64{.9, .9}))
	if policy.Applied || policy.SampleCount != 31 || policy.CostPerFrame != 0 || policy.P95GapFrames != 0 {
		t.Fatalf("малой выборке назначен prior: %+v", policy)
	}
}

var pauseVocab = map[string]int{"<pad>": 0, "|": 1, "а": 2, "б": 3, "т": 4}

func pauseFixture(labels []int) ([]float32, []float64, float64) {
	probs := make([]float32, 0, len(labels)*5)
	times := make([]float64, len(labels))
	for i, label := range labels {
		for c := 0; c < 5; c++ {
			p := .0025
			if c == label {
				p = .99
			}
			probs = append(probs, float32(math.Log(p)))
		}
		times[i] = .01 + float64(i)*.02
	}
	return probs, times, float64(len(labels)) * .02
}

func pauseRun(t *testing.T, text string, labels []int, cost float64) Result {
	t.Helper()
	lines, err := ParseLyrics(text, pauseVocab)
	if err != nil {
		t.Fatal(err)
	}
	p, times, duration := pauseFixture(labels)
	result, err := alignPass(context.Background(), p, times, 5, 0, lines, DefaultOptions(duration), cost)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestAdaptivePauseLeavesPathUnchangedWhenCalibrationInsufficient(t *testing.T) {
	labels := []int{0, 2, 0, 3, 0, 0, 0}
	lines, err := ParseLyrics("аб", pauseVocab)
	if err != nil {
		t.Fatal(err)
	}
	p, times, duration := pauseFixture(labels)
	opts := DefaultOptions(duration)
	before, err := Align(context.Background(), p, times, 5, 0, lines, opts)
	if err != nil {
		t.Fatal(err)
	}
	opts.PausePolicy = "adaptive"
	after, err := Align(context.Background(), p, times, 5, 0, lines, opts)
	if err != nil {
		t.Fatal(err)
	}
	if after.Regularization == nil || after.Regularization.Applied || after.Regularization.SampleCount != 1 {
		t.Fatalf("неверная диагностика: %+v", after.Regularization)
	}
	if !reflect.DeepEqual(before.Lines, after.Lines) || !reflect.DeepEqual(before.trace, after.trace) || *before.PathReward != *after.PathReward || len(after.Regularization.Changes) != 0 {
		t.Fatalf("без обучающей выборки изменён путь: до=%+v после=%+v", before, after)
	}
}

func TestPausePriorPreservesRequiredRepeatBlank(t *testing.T) {
	// Обязательный blank между одинаковыми буквами остаётся разрешённым, хотя имеет конечную стоимость.
	labels := []int{0, 2, 0, 2, 0}
	before := pauseRun(t, "аа", labels, 0)
	after := pauseRun(t, "аа", labels, .3)
	if after.Status != "candidate" || !reflect.DeepEqual(after.trace.first, []int{1, 3}) || !reflect.DeepEqual(after.trace.last, []int{1, 3}) {
		t.Fatalf("сломано повторение буквы: %+v", after)
	}
	if math.Abs((*before.PathReward-*after.PathReward)-.3) > 1e-5 {
		t.Fatalf("неверная стоимость обязательного blank: %v", *before.PathReward-*after.PathReward)
	}
}

func TestPausePriorDoesNotPenalizeStretchedLetterState(t *testing.T) {
	labels := make([]int, 54)
	for i := 1; i <= 50; i++ {
		labels[i] = 2
	}
	labels[52] = 3
	before := pauseRun(t, "аб", labels, 0)
	after := pauseRun(t, "аб", labels, .3)
	if !reflect.DeepEqual(before.trace.first, after.trace.first) || !reflect.DeepEqual(before.trace.last, after.trace.last) || after.trace.last[0] != 50 || after.trace.first[1] != 52 {
		t.Fatalf("распев сжат prior: %+v", after.trace)
	}
	if math.Abs((*before.PathReward-*after.PathReward)-.3) > 1e-4 {
		t.Fatalf("штраф взят с буквенного состояния: %v", *before.PathReward-*after.PathReward)
	}
}

func TestPausePriorAllowsLongGapBetweenLines(t *testing.T) {
	labels := make([]int, 205)
	labels[1] = 2
	labels[102] = 1
	labels[203] = 3
	before := pauseRun(t, "а\nб", labels, 0)
	after := pauseRun(t, "а\nб", labels, 100)
	if !reflect.DeepEqual(before.Lines, after.Lines) || *before.PathReward != *after.PathReward || *after.Lines[0].LastFrame != 1 || *after.Lines[1].FirstFrame != 203 {
		t.Fatalf("межстрочная пауза приписана буквам: %+v", after)
	}
}

func TestPausePriorChoosesWeakLocalSuffixOverLateFalseContinuation(t *testing.T) {
	// Слабая последняя буква рядом с основой конкурирует с сильной чужой буквой после проигрыша.
	// Следующая строка закреплена акустикой: prior должен менять конец слова, сохраняя её начало.
	labels := make([]int, 111)
	labels[1] = 2
	labels[3] = 3
	labels[105] = 4
	labels[106] = 1
	labels[108] = 3
	p, times, duration := pauseFixture(labels)
	for c := 0; c < 5; c++ {
		prob := .05 / 3
		if c == 0 {
			prob = .8
		}
		if c == 4 {
			prob = .15
		}
		p[5*5+c] = float32(math.Log(prob))
	}
	lines, err := ParseLyrics("абт\nб", pauseVocab)
	if err != nil {
		t.Fatal(err)
	}
	opts := DefaultOptions(duration)
	before, err := alignPass(context.Background(), p, times, 5, 0, lines, opts, 0)
	if err != nil {
		t.Fatal(err)
	}
	after, err := alignPass(context.Background(), p, times, 5, 0, lines, opts, .2)
	if err != nil {
		t.Fatal(err)
	}
	if *before.Lines[0].LastFrame != 105 || *after.Lines[0].LastFrame != 5 {
		t.Fatalf("не выбрано локальное окончание: до=%+v после=%+v", before.Lines, after.Lines)
	}
	if *after.Lines[0].FirstFrame != 1 || *after.Lines[1].FirstFrame != 108 || *after.Lines[1].LastFrame != 108 {
		t.Fatalf("изменились соседние опоры: %+v", after.Lines)
	}
	if after.Lines[0].Status != "review_required" || math.Abs(after.trace.peaks[2]-.15) > 1e-6 {
		t.Fatalf("слабая буква объявлена достоверной: %+v", after.Lines[0])
	}
}

func TestAdaptivePauseUsesBaselineCalibrationAndReportsChangedBoundary(t *testing.T) {
	// Полный API калибруется на достаточной выборке и явно помечает исправленный край сомнительным.
	// Слабая локальная буква после повтора не должна незаметно пересчитать масштаб ещё раз.
	labels := []int{0}
	for i := 0; i < 17; i++ {
		labels = append(labels, 2, 0, 3, 0)
	}
	localFrame := len(labels)
	labels = append(labels, 0)
	labels = append(labels, make([]int, 100)...)
	lateFrame := len(labels)
	labels = append(labels, 4, 1, 0, 3, 0)
	p, times, duration := pauseFixture(labels)
	for c := 0; c < 5; c++ {
		prob := .05 / 3
		if c == 0 {
			prob = .8
		}
		if c == 4 {
			prob = .15
		}
		p[localFrame*5+c] = float32(math.Log(prob))
	}
	lines, err := ParseLyrics(strings.Repeat("аб", 17)+"т\nб", pauseVocab)
	if err != nil {
		t.Fatal(err)
	}
	opts := DefaultOptions(duration)
	before, err := Align(context.Background(), p, times, 5, 0, lines, opts)
	if err != nil {
		t.Fatal(err)
	}
	opts.PausePolicy = "adaptive"
	after, err := Align(context.Background(), p, times, 5, 0, lines, opts)
	if err != nil {
		t.Fatal(err)
	}
	policy := after.Regularization
	if policy == nil || !policy.Applied || policy.SampleCount != 34 || policy.P95GapFrames != 1 || policy.BaselinePathReward == nil || *policy.BaselinePathReward != *before.PathReward {
		t.Fatalf("масштаб взят не из исходного пути: %+v", policy)
	}
	if *before.Lines[0].LastFrame != lateFrame || *after.Lines[0].LastFrame != localFrame || len(policy.Changes) != 1 || policy.Changes[0].SourceLine != 1 || policy.Changes[0].Before.LastFrame != lateFrame || policy.Changes[0].After.LastFrame != localFrame {
		t.Fatalf("потеряна диагностика изменения: %+v", policy)
	}
	if after.Status != "review_required" || after.Lines[0].Status != "review_required" || !strings.Contains(after.Lines[0].Reason, "Граница изменена") {
		t.Fatalf("изменение границы прошло без проверки: %+v", after.Lines[0])
	}
	if calibratePauses(after.trace).SampleCount != 33 {
		t.Fatalf("фикстура не различает первый и повторный путь: %+v", after.trace)
	}
}
