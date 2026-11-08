package songml

import (
	"context"
	"fmt"
	"math"
	"time"

	ort "github.com/microsoft/onnxruntime/go/onnxruntime"
)

// Session — открытая ONNX-модель принятого пути (Voc FT или CTC) на CPU.
//
// Глобальную инициализацию ORT (SetSharedLibraryPath + Init) выполняет только менеджер
// компонентов: components.PrepareORT вызывается до Open. Поэтому пакет не выбирает
// библиотеку сам и не может подменить уже загруженный runtime. Session не безопасна для
// параллельных Run из разных горутин: задание разметки использует её последовательно.
type Session struct {
	session *ort.Session
	// Version — версия ORT из загруженной библиотеки (для журнала задания).
	Version string
	// Threads — фактическое число intra-op потоков.
	Threads int
	// LoadSeconds — время создания сессии.
	LoadSeconds float64
}

// Open создаёт сессию модели с intra-op threads и одним inter-op потоком.
// CreateSession binding не принимает context: отменённое во время загрузки задание закрывает
// сессию сразу после возврата native вызова.
func Open(ctx context.Context, model string, threads int) (*Session, error) {
	if threads < 1 {
		return nil, fmt.Errorf("число потоков ORT должно быть положительным")
	}
	options, err := ort.NewSessionOptions()
	if err != nil {
		return nil, err
	}
	defer options.Close()
	if err = options.SetIntraOpNumThreads(threads); err != nil {
		return nil, err
	}
	if err = options.SetInterOpNumThreads(1); err != nil {
		return nil, err
	}
	start := time.Now()
	session, err := ort.NewSession(model, options)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		session.Close()
		return nil, err
	}
	version, err := ort.GetVersion()
	if err != nil {
		session.Close()
		return nil, err
	}
	return &Session{session: session, Version: version, Threads: threads, LoadSeconds: time.Since(start).Seconds()}, nil
}

// Close освобождает native-сессию; повторный вызов безопасен.
func (s *Session) Close() error {
	if s == nil || s.session == nil {
		return nil
	}
	err := s.session.Close()
	s.session = nil
	return err
}

// run выполняет один inference. Для CTC вход — input_values и, если модель его требует,
// attention_mask из единиц; для MDX — первый вход модели. Отмена ctx прерывает Run через
// RunOptionsSetTerminate binding. NaN/Inf в выходе — ошибка, а не тихо испорченный результат.
func (s *Session) run(ctx context.Context, data []float32, shape []int64, ctc bool) ([]float32, []int64, error) {
	input, err := ort.CreateTensor(shape, data)
	if err != nil {
		return nil, nil, err
	}
	defer input.Close()
	inputs := map[string]*ort.Tensor{s.session.Inputs()[0].Name: input}
	if ctc {
		inputs = map[string]*ort.Tensor{"input_values": input}
		for _, info := range s.session.Inputs() {
			if info.Name == "attention_mask" {
				mask := make([]int64, len(data))
				for i := range mask {
					mask[i] = 1
				}
				tensor, err := ort.CreateTensor(shape, mask)
				if err != nil {
					return nil, nil, err
				}
				defer tensor.Close()
				inputs["attention_mask"] = tensor
			}
		}
	}
	outputName := s.session.Outputs()[0].Name
	outputs, err := s.session.Run(ctx, inputs, []string{outputName})
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		for _, tensor := range outputs {
			tensor.Close()
		}
	}()
	tensor := outputs[outputName]
	values, err := ort.TensorData[float32](tensor)
	if err != nil {
		return nil, nil, err
	}
	for _, v := range values {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil, nil, fmt.Errorf("модель вернула нечисловое значение")
		}
	}
	return append([]float32(nil), values...), tensor.Shape(), nil
}

// Separate — выделение вокала Voc FT (MDX-Net): полный стерео-сигнал 44,1 кГц режется на
// блоки Chunk с отбрасываемым контекстом FFT/2 с каждой стороны; длина и временная шкала выхода
// совпадают с входом, вступление и хвост не обрезаются. progress получает номер блока и их число.
func (s *Session) Separate(ctx context.Context, signal [2][]float32, progress func(done, total int)) ([2][]float32, error) {
	var out [2][]float32
	n := len(signal[0])
	if n < 1 || len(signal[1]) != n {
		return out, fmt.Errorf("нужно непустое stereo")
	}
	trim := FFT / 2
	stride := Chunk - 2*trim
	var padded [2][]float32
	for ch := 0; ch < 2; ch++ {
		padded[ch] = make([]float32, trim+n+trim+stride)
		copy(padded[ch][trim:], signal[ch])
		out[ch] = make([]float32, n)
	}
	total := (n + stride - 1) / stride
	for index, start := 0, 0; start < n; index, start = index+1, start+stride {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		chunk := [2][]float32{padded[0][start : start+Chunk], padded[1][start : start+Chunk]}
		full, frames, err := STFT(chunk, FFT, Hop)
		if err != nil {
			return out, err
		}
		spectrum := make([]float32, 4*Bins*frames)
		for ch := 0; ch < 4; ch++ {
			copy(spectrum[ch*Bins*frames:(ch+1)*Bins*frames], full[ch*(FFT/2+1)*frames:ch*(FFT/2+1)*frames+Bins*frames])
			// Три нижние полосы обнуляются, как в рецепте UVR.
			clear(spectrum[ch*Bins*frames : ch*Bins*frames+3*frames])
		}
		predicted, shape, err := s.run(ctx, spectrum, []int64{1, 4, Bins, int64(frames)}, false)
		if err != nil {
			return out, err
		}
		if len(shape) != 4 || shape[0] != 1 || shape[1] != 4 || shape[2] != Bins || shape[3] != int64(frames) {
			return out, fmt.Errorf("неверная форма MDX: %v", shape)
		}
		decoded, err := ISTFT(predicted, Bins, frames, Chunk, FFT, Hop)
		if err != nil {
			return out, err
		}
		size := min(stride, n-start)
		for ch := 0; ch < 2; ch++ {
			for i := 0; i < size; i++ {
				out[ch][start+i] = decoded[ch][trim+i] * float32(Compensate)
			}
		}
		if progress != nil {
			progress(index+1, total)
		}
	}
	return out, nil
}

// Параметры CTC-модели из закреплённого рецепта (recipe.ctc).
const (
	// CTCSampleRate — частота моно-входа CTC.
	CTCSampleRate = 16000
	// ctcBlock — полезная длина блока inference (18 с).
	ctcBlock = CTCSampleRate * 18
	// ctcContext — контекст с каждой стороны блока (1 с).
	ctcContext = CTCSampleRate
	// ctcStride и ctcCenter — шаг кадра модели и смещение его центра в отсчётах.
	ctcStride = 320
	ctcCenter = 200
	// ctcReceptive — минимальная длина сигнала, дающая хотя бы один кадр.
	ctcReceptive = 400
)

// Emissions считает CTC log-probabilities по 18-секундным блокам с контекстом 1 с с каждой
// стороны и абсолютными центрами кадров (times в секундах). Кадры контекста отбрасываются,
// поэтому склейка блоков не сдвигает время. Возвращает [кадр*классы], времена и число классов.
// progress получает обработанные секунды и длительность сигнала.
func (s *Session) Emissions(ctx context.Context, audio []float32, progress func(done, total float64)) ([]float32, []float64, int, error) {
	if len(audio) < ctcReceptive {
		return []float32{}, []float64{}, 0, nil
	}
	var probs []float32
	var times []float64
	classes := 0
	for start := 0; start < len(audio); start += ctcBlock {
		left := max(0, start-ctcContext)
		right := min(len(audio), start+ctcBlock+ctcContext)
		clip := Normalize(audio[left:right])
		logits, shape, err := s.run(ctx, clip, []int64{1, int64(len(clip))}, true)
		if err != nil {
			return nil, nil, 0, err
		}
		if len(shape) != 3 || shape[0] != 1 || shape[1] < 1 || shape[2] < 2 {
			return nil, nil, 0, fmt.Errorf("неверная форма CTC: %v", shape)
		}
		classes = int(shape[2])
		normalized := LogSoftmax(logits, classes)
		for frame := 0; frame < int(shape[1]); frame++ {
			center := float64(left+frame*ctcStride+ctcCenter) / CTCSampleRate
			if center >= float64(start)/CTCSampleRate && center < float64(min(len(audio), start+ctcBlock))/CTCSampleRate {
				times = append(times, center)
				probs = append(probs, normalized[frame*classes:(frame+1)*classes]...)
			}
		}
		if progress != nil {
			progress(float64(min(len(audio), start+ctcBlock))/CTCSampleRate, float64(len(audio))/CTCSampleRate)
		}
	}
	return probs, times, classes, nil
}
