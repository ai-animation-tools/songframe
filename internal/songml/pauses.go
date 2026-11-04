package songml

import (
	"math"
	"sort"
)

// pathTrace — первый и последний кадры и пик каждого токена исходного margin-пути.
type pathTrace struct {
	target, first, last []int
	peaks               []float64
	separator           int
}

// BoundaryChange — строка, границы которой изменил повтор с prior пауз.
type BoundaryChange struct {
	SourceLine int    `json:"source_line"`
	Before     Bounds `json:"before"`
	After      Bounds `json:"after"`
}

// PauseRegularization — параметры и итог adaptive-политики (intraword-blank-p95-half-life-v1).
type PauseRegularization struct {
	Method             string           `json:"method"`
	Applied            bool             `json:"applied"`
	Reason             string           `json:"reason"`
	SampleCount        int              `json:"sample_count"`
	MinimumSamples     int              `json:"minimum_samples"`
	PeakThreshold      float64          `json:"peak_threshold"`
	Quantile           float64          `json:"quantile"`
	P95GapFrames       float64          `json:"p95_gap_frames"`
	MaximumGapFrames   int              `json:"maximum_gap_frames"`
	CostPerFrame       float64          `json:"cost_per_frame"`
	BaselinePathReward *float64         `json:"baseline_path_reward,omitempty"`
	Changes            []BoundaryChange `json:"boundary_changes"`
}

// Внутри слова blank не должен бесплатно переносить недостающие буквы через весь проигрыш.
// Разделители, межсловные паузы и распевы самого буквенного состояния этим prior не штрафуются.
func intraWordStates(target []int, separator int) []bool {
	states := make([]bool, 2*len(target)+1)
	for i := 1; i < len(target); i++ {
		states[2*i] = target[i-1] != separator && target[i] != separator
	}
	return states
}

// Устойчивый масштаб получается из самого пути, а не из ручных интервалов или номера строки.
// Это экспериментальный геометрический prior: за p95 обычной паузы вес продолжения падает вдвое.
func calibratePauses(trace *pathTrace) PauseRegularization {
	policy := PauseRegularization{Method: "intraword-blank-p95-half-life-v1", MinimumSamples: 32, PeakThreshold: .5, Quantile: .95, Changes: []BoundaryChange{}}
	var gaps []int
	for i := 1; i < len(trace.target); i++ {
		if trace.target[i-1] == trace.separator || trace.target[i] == trace.separator || trace.peaks[i-1] < policy.PeakThreshold || trace.peaks[i] < policy.PeakThreshold {
			continue
		}
		gap := trace.first[i] - trace.last[i-1] - 1
		if gap > 0 {
			gaps = append(gaps, gap)
			policy.MaximumGapFrames = max(policy.MaximumGapFrames, gap)
		}
	}
	policy.SampleCount = len(gaps)
	if len(gaps) < policy.MinimumSamples {
		policy.Reason = "Недостаточно уверенных межбуквенных пауз для оценки масштаба; исходный путь сохранён."
		return policy
	}
	sort.Ints(gaps)
	position := float64(len(gaps)-1) * policy.Quantile
	lo, hi := int(math.Floor(position)), int(math.Ceil(position))
	policy.P95GapFrames = float64(gaps[lo]) + float64(gaps[hi]-gaps[lo])*(position-float64(lo))
	policy.CostPerFrame = math.Ln2 / max(1, policy.P95GapFrames)
	policy.Applied = true
	policy.Reason = "Один повтор margin с акустическим масштабом внутрисловного ожидания; это не подтверждение границ человеком."
	return policy
}
