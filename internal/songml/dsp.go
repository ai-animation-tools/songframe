// Package songml — принятый ML-путь разметки песни (D-018/D-019): выделение вокала Voc FT
// (MDX-Net) и глобальное CTC-выравнивание известного текста в режиме margin/adaptive.
//
// Код перенесён из songframe-go-probe@d3005fe (internal/mlprobe, internal/ctcalign; SHA-256
// исходников совпадают с ctc-experiment-lock.json) без изменения арифметики: порядок операций,
// разрядность float32/float64, пороги и шаги кадров сохранены, поэтому emissions и границы
// совпадают с сохранёнными результатами эксперимента. Изменено только устройство: ORT
// инициализирует менеджер компонентов (internal/components), сеанс открывается по явному пути
// модели, отмена идёт через context. Пакет не читает проект и не пишет файлы проекта.
package songml

import (
	"fmt"
	"math"

	"gonum.org/v1/gonum/dsp/fourier"
)

// Параметры MDX Voc FT из закреплённого рецепта (manifest компонентов, recipe.mdx).
const (
	// FFT — длина окна STFT в отсчётах 44,1 кГц.
	FFT = 7680
	// Hop — шаг STFT.
	Hop = 1024
	// Bins — число частотных полос, которые видит модель; старшие полосы отбрасываются.
	Bins = 3072
	// Frames — число кадров STFT в одном блоке модели.
	Frames = 256
	// Chunk — длина блока сигнала, дающая ровно Frames кадров.
	Chunk = Hop * (Frames - 1)
	// Compensate — коэффициент громкости выхода Voc FT.
	Compensate = 1.021
	// VocalSampleRate — частота входа и выхода выделения вокала.
	VocalSampleRate = 44100
)

// STFT повторяет mdx.stft: reflect-padding, периодический Hann и порядок [канал, real/imag, bin, frame].
// Умножение на окно выполняется в float32 перед FFT, как у NumPy; сама FFT использует float64.
func STFT(signal [2][]float32, fft, hop int) ([]float32, int, error) {
	if fft < 2 || fft%2 != 0 || hop < 1 || len(signal[0]) != len(signal[1]) || len(signal[0]) < 2 {
		return nil, 0, fmt.Errorf("неверный размер STFT")
	}
	n := len(signal[0])
	frames := n/hop + 1
	bins := fft/2 + 1
	out := make([]float32, 4*bins*frames)
	engine := fourier.NewFFT(fft)
	buf := make([]float64, fft)
	for ch := 0; ch < 2; ch++ {
		for t := 0; t < frames; t++ {
			for j := 0; j < fft; j++ {
				k := t*hop + j - fft/2
				// Отражение без повтора крайнего отсчёта (numpy reflect); цикл нужен для очень коротких сигналов.
				for k < 0 || k >= n {
					if k < 0 {
						k = -k
					}
					if k >= n {
						k = 2*n - 2 - k
					}
				}
				w := float32(.5 - .5*math.Cos(2*math.Pi*float64(j)/float64(fft)))
				buf[j] = float64(signal[ch][k] * w)
			}
			coeff := engine.Coefficients(nil, buf)
			for b, v := range coeff {
				out[((ch*2)*bins+b)*frames+t] = float32(real(v))
				out[((ch*2+1)*bins+b)*frames+t] = float32(imag(v))
			}
		}
	}
	return out, frames, nil
}

// ISTFT нормализует перекрытия окон в float32 и возвращает ровно length отсчётов без сдвига:
// тишина вступления и хвост трека сохраняются на своих местах.
func ISTFT(spectrum []float32, bins, frames, length, fft, hop int) ([2][]float32, error) {
	var out [2][]float32
	if bins < 1 || bins > fft/2+1 || frames < 1 || len(spectrum) != 4*bins*frames || length < 0 || length > hop*(frames-1)+fft/2 {
		return out, fmt.Errorf("неверный размер ISTFT")
	}
	size := hop*(frames-1) + fft
	weight := make([]float32, size)
	window := make([]float32, fft)
	for j := range window {
		window[j] = float32(.5 - .5*math.Cos(2*math.Pi*float64(j)/float64(fft)))
	}
	for t := 0; t < frames; t++ {
		for j, w := range window {
			weight[t*hop+j] += w * w
		}
	}
	engine := fourier.NewFFT(fft)
	coeff := make([]complex128, fft/2+1)
	for ch := 0; ch < 2; ch++ {
		signal := make([]float32, size)
		for t := 0; t < frames; t++ {
			clear(coeff)
			for b := 0; b < bins; b++ {
				coeff[b] = complex(float64(spectrum[(ch*2*bins+b)*frames+t]), float64(spectrum[((ch*2+1)*bins+b)*frames+t]))
			}
			decoded := engine.Sequence(nil, coeff)
			for j, v := range decoded {
				signal[t*hop+j] += float32(v / float64(fft) * float64(window[j]))
			}
		}
		for i := range signal {
			signal[i] /= max(weight[i], 1e-8)
		}
		out[ch] = append([]float32(nil), signal[fft/2:fft/2+length]...)
	}
	return out, nil
}

// Normalize — нормализация блока перед CTC-моделью (среднее 0, дисперсия 1, eps 1e-7) в float64,
// как подготовка CTC в SongFrame.
func Normalize(audio []float32) []float32 {
	var mean float64
	for _, v := range audio {
		mean += float64(v)
	}
	mean /= float64(len(audio))
	var variance float64
	for _, v := range audio {
		d := float64(v) - mean
		variance += d * d
	}
	scale := math.Sqrt(variance/float64(len(audio)) + 1e-7)
	out := make([]float32, len(audio))
	for i, v := range audio {
		out[i] = float32((float64(v) - mean) / scale)
	}
	return out
}

// LogSoftmax переводит логиты [кадр, класс] в логарифмы вероятностей по строкам; вычитание максимума
// и сумма экспонент выполняются в float32, как в принятом эксперименте.
func LogSoftmax(logits []float32, classes int) []float32 {
	out := append([]float32(nil), logits...)
	for i := 0; i < len(out); i += classes {
		peak := out[i]
		for _, v := range out[i : i+classes] {
			peak = max(peak, v)
		}
		var sum float32
		for j := 0; j < classes; j++ {
			out[i+j] -= peak
			sum += float32(math.Exp(float64(out[i+j])))
		}
		normal := float32(math.Log(float64(sum)))
		for j := 0; j < classes; j++ {
			out[i+j] -= normal
		}
	}
	return out
}
