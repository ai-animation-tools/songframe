package songml

import (
	"context"
	"fmt"
	"math"
	"strings"
	"unicode"
)

// Word — слово строки и индексы его первого/последнего токена внутри Line.Tokens.
type Word struct {
	Text       string `json:"text"`
	FirstToken int    `json:"first_token"`
	LastToken  int    `json:"last_token"`
}

// Line — строка песни для глобального пути: физический номер, нормализованные слова через «|»
// и токены словаря. Reason непуст, если в строке есть буква вне словаря: тогда путь не строится.
type Line struct {
	SourceLine int    `json:"source_line"`
	Text       string `json:"text"`
	Normalized string `json:"normalized"`
	Tokens     []int  `json:"-"`
	Separator  int    `json:"-"`
	Words      []Word `json:"-"`
	Reason     string `json:"reason,omitempty"`
}

// Bounds — границы в секундах (центр кадра ±10 мс, в пределах трека) и кадры пути.
type Bounds struct {
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	FirstFrame int     `json:"first_frame"`
	LastFrame  int     `json:"last_frame"`
}

// WordResult — границы слова по реальному CTC-пути, без равномерного деления строки.
type WordResult struct {
	Text string `json:"text"`
	Bounds
	AcousticScore float64 `json:"acoustic_score"`
}

// LineResult — итог строки: границы (nil, если путь не построен), диагностика и статус
// candidate/review_required/unavailable. review_required — повод послушать, а не приговор качеству.
type LineResult struct {
	SourceLine       int          `json:"source_line"`
	Text             string       `json:"text"`
	Normalized       string       `json:"normalized"`
	Start            *float64     `json:"start"`
	End              *float64     `json:"end"`
	FirstFrame       *int         `json:"first_frame,omitempty"`
	LastFrame        *int         `json:"last_frame,omitempty"`
	AcousticScore    float64      `json:"acoustic_score"`
	MinimumTokenPeak float64      `json:"minimum_token_peak"`
	GreedySimilarity float64      `json:"greedy_similarity"`
	Status           string       `json:"status"`
	Reason           string       `json:"reason"`
	Words            []WordResult `json:"words"`
}

// Options — режим и пороги выравнивания; Duration — длительность сигнала CTC в секундах.
type Options struct {
	Scoring     string  `json:"scoring"`
	Duration    float64 `json:"-"`
	MeanPeak    float64 `json:"mean_peak"`
	MinimumPeak float64 `json:"minimum_peak"`
	Similarity  float64 `json:"greedy_similarity"`
	PausePolicy string  `json:"pause_policy"`
}

// DefaultOptions — базовые пороги режима margin без prior пауз (pause_policy off); на них строится
// AcceptedOptions рабочего пути приложения, тесты пауз сравнивают с ними регуляризацию.
func DefaultOptions(duration float64) Options {
	return Options{Scoring: "margin", Duration: duration, MeanPeak: .45, MinimumPeak: .1, Similarity: .8, PausePolicy: "off"}
}

// Result — итог глобального прохода по всему тексту; trace хранит путь для калибровки пауз.
type Result struct {
	Engine         string               `json:"engine"`
	Status         string               `json:"status"`
	Reason         string               `json:"reason"`
	Lines          []LineResult         `json:"lines"`
	Thresholds     Options              `json:"thresholds"`
	TokenCount     int                  `json:"token_count"`
	WordCount      int                  `json:"word_count"`
	PathReward     *float64             `json:"path_reward"`
	AcousticScore  float64              `json:"acoustic_score"`
	FirstFrame     int                  `json:"first_frame"`
	LastFrame      int                  `json:"last_frame"`
	Regularization *PauseRegularization `json:"pause_regularization,omitempty"`
	trace          *pathTrace
}

// ParseLyrics сохраняет физические номера строк; незнакомая буква запрещает весь глобальный проход.
// Пунктуация разделяет слова, ё сохраняется как отдельная буква словаря; заголовки [Куплет] пропускаются.
// Приложение передаёт строки, уже разобранные редактором,
// в TokenizeLine, чтобы номера совпадали с source_line разметки.
func ParseLyrics(text string, vocab map[string]int) ([]Line, error) {
	if _, ok := vocab["|"]; !ok {
		return nil, fmt.Errorf("в словаре нет разделителя |")
	}
	var lines []Line
	for n, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		raw = strings.TrimSpace(strings.TrimPrefix(raw, "\ufeff"))
		if raw == "" || (strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]")) {
			continue
		}
		if line, ok := TokenizeLine(n+1, raw, vocab); ok {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return nil, fmt.Errorf("в исходнике нет строк песни")
	}
	return lines, nil
}

// TokenizeLine нормализует одну строку песни: нижний регистр, буквы и цифры остаются, пунктуация,
// пробелы и символы разделяют слова; слова соединяются разделителем «|». false — в строке нет слов.
// Буква вне словаря не выбрасывается молча: строка получает Reason, и весь путь не строится.
// Словарь обязан содержать «|» (проверяет вызывающий).
func TokenizeLine(number int, raw string, vocab map[string]int) (Line, bool) {
	var normalized strings.Builder
	for _, ch := range strings.ToLower(raw) {
		if unicode.IsLetter(ch) || unicode.IsNumber(ch) {
			normalized.WriteRune(ch)
		} else if unicode.IsPunct(ch) || unicode.IsSpace(ch) || unicode.IsSymbol(ch) {
			normalized.WriteByte(' ')
		} else {
			normalized.WriteRune(ch)
		}
	}
	words := strings.Fields(normalized.String())
	if len(words) == 0 {
		return Line{}, false
	}
	line := Line{SourceLine: number, Text: raw, Normalized: strings.Join(words, "|"), Separator: vocab["|"]}
	for wi, word := range words {
		if wi > 0 {
			line.Tokens = append(line.Tokens, vocab["|"])
		}
		first := len(line.Tokens)
		for _, ch := range word {
			id, ok := vocab[string(ch)]
			if !ok {
				line.Reason = fmt.Sprintf("Символ %q не поддерживается акустическим словарём.", ch)
				id = -1
			}
			line.Tokens = append(line.Tokens, id)
		}
		line.Words = append(line.Words, Word{word, first, len(line.Tokens) - 1})
	}
	return line, true
}

// Align в режиме margin оставляет края свободными и штрафует чужую речь внутри песни; logprob учитывает все кадры.
// Расширенный CTC-граф требует blank между одинаковыми буквами; обратный путь даёт реальные кадры каждого токена.
func Align(ctx context.Context, probs []float32, times []float64, classes, blank int, lines []Line, options Options) (Result, error) {
	if options.PausePolicy != "" && options.PausePolicy != "off" && options.PausePolicy != "adaptive" {
		return Result{}, fmt.Errorf("pause_policy должен быть off или adaptive")
	}
	if options.PausePolicy == "adaptive" && options.Scoring != "margin" {
		return Result{}, fmt.Errorf("адаптивная стоимость пауз поддерживает margin; для logprob нужен pause_policy=off")
	}
	baseline, err := alignPass(ctx, probs, times, classes, blank, lines, options, 0)
	if err != nil || options.PausePolicy != "adaptive" || baseline.trace == nil {
		return baseline, err
	}
	policy := calibratePauses(baseline.trace)
	baseline.Regularization = &policy
	baseline.Engine = "ctc-global-v2"
	if !policy.Applied {
		return baseline, nil
	}
	// Масштаб берётся из первого акустического пути; ручных окон и обратной связи evaluator здесь нет.
	// Повтор ровно один: параметры не пересчитываются до получения удобных времён. @link docs/ctc-boundaries.md
	result, err := alignPass(ctx, probs, times, classes, blank, lines, options, policy.CostPerFrame)
	if err != nil {
		return result, err
	}
	result.Engine = "ctc-global-v2"
	policy.BaselinePathReward = baseline.PathReward
	for i := range result.Lines {
		old, updated := baseline.Lines[i], &result.Lines[i]
		if old.FirstFrame != nil && updated.FirstFrame != nil && (*old.FirstFrame != *updated.FirstFrame || *old.LastFrame != *updated.LastFrame) {
			policy.Changes = append(policy.Changes, BoundaryChange{SourceLine: old.SourceLine, Before: Bounds{*old.Start, *old.End, *old.FirstFrame, *old.LastFrame}, After: Bounds{*updated.Start, *updated.End, *updated.FirstFrame, *updated.LastFrame}})
			updated.Status = "review_required"
			updated.Reason += " Граница изменена стоимостью внутрисловной паузы; требуется проверка на слух."
			result.Status = "review_required"
		}
	}
	result.Regularization = &policy
	return result, nil
}

// alignPass — один проход Витерби по расширенному CTC-графу всего текста. pauseCost штрафует
// blank между буквами одного слова (0 — исходный margin). Отмена проверяется каждые 64 кадра.
func alignPass(ctx context.Context, probs []float32, times []float64, classes, blank int, lines []Line, options Options, pauseCost float64) (Result, error) {
	result := Result{Engine: "ctc-global-v1", Status: "unavailable", Thresholds: options, Lines: make([]LineResult, len(lines))}
	var target []int
	offsets := make([]int, len(lines))
	invalid := false
	for i, line := range lines {
		result.Lines[i] = LineResult{SourceLine: line.SourceLine, Text: line.Text, Normalized: line.Normalized, Status: "unavailable", Words: []WordResult{}}
		if i > 0 {
			target = append(target, line.Separator)
		}
		offsets[i] = len(target)
		if line.Reason != "" {
			invalid = true
			result.Lines[i].Reason = line.Reason
		}
		target = append(target, line.Tokens...)
		result.WordCount += len(line.Words)
	}
	result.TokenCount = len(target)
	if invalid {
		return unavailable(result, "Глобальный путь не построен: исходный текст содержит неподдерживаемые символы."), nil
	}
	if len(target) == 0 || len(lines) == 0 {
		return result, fmt.Errorf("пустой CTC target")
	}
	if options.Scoring != "margin" && options.Scoring != "logprob" {
		return result, fmt.Errorf("scoring должен быть margin или logprob")
	}
	if classes < 2 || blank < 0 || blank >= classes || len(probs) != len(times)*classes || len(times) == 0 {
		return result, fmt.Errorf("неверная форма CTC emissions")
	}
	if math.IsNaN(options.Duration) || math.IsInf(options.Duration, 0) || options.Duration <= 0 || options.MeanPeak < 0 || options.MeanPeak > 1 || options.MinimumPeak < 0 || options.MinimumPeak > 1 || options.Similarity < 0 || options.Similarity > 1 {
		return result, fmt.Errorf("неверная длительность или пороги")
	}
	for i, t := range times {
		if math.IsNaN(t) || math.IsInf(t, 0) || t < 0 || t > options.Duration || (i > 0 && t <= times[i-1]) {
			return result, fmt.Errorf("неверное время кадра %d", i)
		}
	}
	for _, p := range probs {
		if math.IsNaN(float64(p)) || math.IsInf(float64(p), 0) || p > 1e-5 {
			return result, fmt.Errorf("ожидаются log probabilities")
		}
	}
	minimumFrames := len(target)
	for i, id := range target {
		if id < 0 || id >= classes || id == blank {
			return result, fmt.Errorf("неверный target token %d", id)
		}
		if i > 0 && id == target[i-1] {
			minimumFrames++
		}
	}
	if len(times) < minimumFrames {
		return unavailable(result, "Недостаточно кадров для полного CTC-пути; границы не интерполировались."), nil
	}
	states := 2*len(target) + 1
	labels := make([]int, states)
	for s := range labels {
		labels[s] = blank
		if s%2 == 1 {
			labels[s] = target[s/2]
		}
	}
	intraWord := intraWordStates(target, lines[0].Separator)
	negative := float32(math.Inf(-1))
	previous, next := make([]float32, states), make([]float32, states)
	for s := range previous {
		previous[s] = negative
	}
	previous[0] = 0
	moves := make([]uint8, len(times)*states)
	best, finish := negative, -1
	for frame := range times {
		if frame%64 == 0 {
			if err := ctx.Err(); err != nil {
				return result, err
			}
		}
		row := probs[frame*classes : (frame+1)*classes]
		strongest, runner := negative, negative
		for _, p := range row {
			if p >= strongest {
				runner = strongest
				strongest = p
			} else if p > runner {
				runner = p
			}
		}
		for s, label := range labels {
			value, move := previous[s], uint8(0)
			if s > 0 && previous[s-1] > value {
				value = previous[s-1]
				move = 1
			}
			if s > 1 && label != blank && label != labels[s-2] && previous[s-2] > value {
				value = previous[s-2]
				move = 2
			}
			competitor := strongest
			if label != blank && row[label] == strongest {
				competitor = runner
			}
			if options.Scoring == "logprob" {
				next[s] = value + row[label]
			} else {
				reward := row[label] - competitor
				if intraWord[s] {
					reward -= float32(pauseCost)
				}
				next[s] = value + reward
			}
			moves[frame*states+s] = move
		}
		if options.Scoring == "margin" {
			next[0] = 0
		}
		previous, next = next, previous
		if options.Scoring == "margin" && previous[states-2] > best {
			best = previous[states-2]
			finish = frame
		}
	}
	terminal := states - 2
	if options.Scoring == "logprob" {
		// Классический likelihood учитывает blank по краям и выбирает финал последнего кадра.
		finish = len(times) - 1
		best = previous[terminal]
		if previous[states-1] > best {
			terminal = states - 1
			best = previous[terminal]
		}
	}
	if finish < 0 || math.IsInf(float64(best), -1) {
		return unavailable(result, "Полный CTC-путь не найден; границы не интерполировались."), nil
	}
	first, last := make([]int, len(target)), make([]int, len(target))
	peaks := make([]float64, len(target))
	for i := range first {
		first[i] = -1
		last[i] = -1
	}
	state := terminal
	for frame := finish; frame >= 0; frame-- {
		if state%2 == 1 {
			i := state / 2
			first[i] = frame
			if last[i] < 0 {
				last[i] = frame
			}
			peaks[i] = max(peaks[i], math.Exp(float64(probs[frame*classes+target[i]])))
		}
		state -= int(moves[frame*states+state])
		if state == 0 {
			break
		}
	}
	for i := range target {
		if first[i] < 0 {
			return result, fmt.Errorf("обратный CTC-путь не прошёл токен %d", i)
		}
	}
	result.trace = &pathTrace{target, first, last, peaks, lines[0].Separator}
	reward := float64(best)
	result.PathReward = &reward
	result.AcousticScore = mean(peaks)
	result.FirstFrame = first[0]
	result.LastFrame = last[len(last)-1]
	result.Status = "candidate"
	result.Reason = "Акустический кандидат; ручное подтверждение не выполнялось."
	for i, line := range lines {
		entry := &result.Lines[i]
		offset := offsets[i]
		endToken := offset + len(line.Tokens) - 1
		bounds := boundsFor(first[offset], last[endToken], times, options.Duration)
		entry.Start = &bounds.Start
		entry.End = &bounds.End
		entry.FirstFrame = &bounds.FirstFrame
		entry.LastFrame = &bounds.LastFrame
		entry.AcousticScore = mean(peaks[offset : endToken+1])
		entry.MinimumTokenPeak = 1
		for _, p := range peaks[offset : endToken+1] {
			entry.MinimumTokenPeak = min(entry.MinimumTokenPeak, p)
		}
		greedy := decode(probs[first[offset]*classes:(last[endToken]+1)*classes], classes, blank)
		entry.GreedySimilarity = similarity(line.Tokens, greedy)
		var reasons []string
		if entry.AcousticScore < options.MeanPeak {
			reasons = append(reasons, fmt.Sprintf("Средняя вероятность токенов %.3f ниже %.3f.", entry.AcousticScore, options.MeanPeak))
		}
		if entry.MinimumTokenPeak < options.MinimumPeak {
			reasons = append(reasons, fmt.Sprintf("Минимальная вероятность токена %.3f ниже %.3f.", entry.MinimumTokenPeak, options.MinimumPeak))
		}
		if entry.GreedySimilarity < options.Similarity {
			reasons = append(reasons, fmt.Sprintf("Сходство свободного CTC-декодирования %.3f ниже %.3f.", entry.GreedySimilarity, options.Similarity))
		}
		entry.Status = "candidate"
		entry.Reason = "Акустический кандидат; требуется проверка человеком."
		if len(reasons) > 0 {
			entry.Status = "review_required"
			entry.Reason = strings.Join(reasons, " ")
			result.Status = "review_required"
		}
		for _, word := range line.Words {
			left, right := offset+word.FirstToken, offset+word.LastToken
			entry.Words = append(entry.Words, WordResult{word.Text, boundsFor(first[left], last[right], times, options.Duration), mean(peaks[left : right+1])})
		}
	}
	return result, nil
}

// unavailable помечает итог без путей: границы не интерполируются.
func unavailable(result Result, reason string) Result {
	result.Reason = reason
	for i := range result.Lines {
		if result.Lines[i].Reason == "" {
			result.Lines[i].Reason = reason
		}
	}
	return result
}

// boundsFor — границы токенов first..last по центрам кадров с полями ±10 мс.
func boundsFor(first, last int, times []float64, duration float64) Bounds {
	// Центр каждого кадра окружён фиксированным шагом модели 20 мс; долгие blank не раздаются словам.
	return Bounds{max(0, times[first]-.01), min(duration, times[last]+.01), first, last}
}

// mean — среднее пиков вероятностей.
func mean(values []float64) float64 {
	var sum float64
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

// decode — свободное greedy-декодирование отрезка для оценки сходства с текстом.
func decode(probs []float32, classes, blank int) []int {
	var out []int
	previous := -1
	for frame := 0; frame < len(probs)/classes; frame++ {
		row := probs[frame*classes : (frame+1)*classes]
		best := 0
		for i, p := range row {
			if p > row[best] {
				best = i
			}
		}
		if best != blank && best != previous {
			out = append(out, best)
		}
		previous = best
	}
	return out
}

// similarity использует редакционное расстояние, а не текстовые якоря или ручные времена.
func similarity(a, b []int) float64 {
	row := make([]int, len(b)+1)
	for j := range row {
		row[j] = j
	}
	for i, x := range a {
		diagonal := row[0]
		row[0] = i + 1
		for j, y := range b {
			old := row[j+1]
			cost := 1
			if x == y {
				cost = 0
			}
			row[j+1] = min(row[j]+1, row[j+1]+1, diagonal+cost)
			diagonal = old
		}
	}
	if max(len(a), len(b)) == 0 {
		return 1
	}
	return 1 - float64(row[len(b)])/float64(max(len(a), len(b)))
}
