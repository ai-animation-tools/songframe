package songml

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"

	"songframe-go/internal/process"
)

// AcceptedOptions — закреплённая конфигурация рабочего пути (recipe.ctc): margin, adaptive prior пауз
// и пороги диагностики 0,45/0,1/0,8. duration — длительность моно-сигнала CTC в секундах.
func AcceptedOptions(duration float64) Options {
	options := DefaultOptions(duration)
	options.PausePolicy = "adaptive"
	return options
}

// AcceptedEngine — идентификатор рецепта для ключа кэша emissions и журнала задания.
const AcceptedEngine = "go-ctc-global-v2"

// ToPCM16 переводит float32 в 16-битный PCM так же, как separate_vocals оригинала
// (np.rint(np.clip(x, -1, 32767/32768) * 32768)) и FFmpeg f32le→s16le: умножение на 2^15 точное,
// округление к чётному, насыщение до [-32768, 32767]. Это граница «PCM16 stereo44100» рецепта.
func ToPCM16(value float32) int16 {
	scaled := math.RoundToEven(float64(value) * 32768)
	if scaled > 32767 {
		return 32767
	}
	if scaled < -32768 {
		return -32768
	}
	return int16(scaled)
}

// WAVHeaderSize — размер канонического заголовка PCM WAV без дополнительных chunks.
const WAVHeaderSize = 44

// WriteStereoWAV пишет канонический PCM16 WAV 44,1 кГц стерео (RIFF/fmt 16/data) — формат
// vocals.wav кэша вокала, который проверяют VocalStore и прежний оригинал.
func WriteStereoWAV(w io.Writer, signal [2][]float32) error {
	n := len(signal[0])
	if len(signal[1]) != n || n == 0 {
		return errors.New("нужно непустое stereo одинаковой длины")
	}
	data := uint32(n * 4)
	header := make([]byte, WAVHeaderSize)
	copy(header[0:], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], 36+data)
	copy(header[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1)
	binary.LittleEndian.PutUint16(header[22:], 2)
	binary.LittleEndian.PutUint32(header[24:], VocalSampleRate)
	binary.LittleEndian.PutUint32(header[28:], VocalSampleRate*4)
	binary.LittleEndian.PutUint16(header[32:], 4)
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], data)
	if _, err := w.Write(header); err != nil {
		return err
	}
	// Блоками по 64 КиБ: большой трек не требует второй копии сигнала в памяти.
	buffer := make([]byte, 0, 64*1024)
	for i := 0; i < n; i++ {
		buffer = binary.LittleEndian.AppendUint16(buffer, uint16(ToPCM16(signal[0][i])))
		buffer = binary.LittleEndian.AppendUint16(buffer, uint16(ToPCM16(signal[1][i])))
		if len(buffer) >= cap(buffer)-4 {
			if _, err := w.Write(buffer); err != nil {
				return err
			}
			buffer = buffer[:0]
		}
	}
	_, err := w.Write(buffer)
	return err
}

// DecodeFloat32 разбирает f32le (interleaved для stereo) и отклоняет NaN/Inf: такие данные не
// должны становиться входом модели.
func DecodeFloat32(data []byte) ([]float32, error) {
	if len(data) == 0 || len(data)%4 != 0 {
		return nil, fmt.Errorf("ожидается непустой f32le")
	}
	out := make([]float32, len(data)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(data[i*4:]))
		if math.IsNaN(float64(out[i])) || math.IsInf(float64(out[i]), 0) {
			return nil, fmt.Errorf("нечисловой отсчёт %d", i)
		}
	}
	return out, nil
}

// EncodeFloat32 — обратное преобразование для кэша emissions.
func EncodeFloat32(values []float32) []byte {
	data := make([]byte, len(values)*4)
	for i, v := range values {
		binary.LittleEndian.PutUint32(data[i*4:], math.Float32bits(v))
	}
	return data
}

// DecodePCM16 переводит s16le в float32 делением на 2^15 (как FFmpeg s16→flt): это шаг
// «PCM16 mono16000 → float32» рецепта CTC.
func DecodePCM16(data []byte) ([]float32, error) {
	if len(data) == 0 || len(data)%2 != 0 {
		return nil, fmt.Errorf("ожидается непустой s16le")
	}
	out := make([]float32, len(data)/2)
	for i := range out {
		out[i] = float32(int16(binary.LittleEndian.Uint16(data[i*2:]))) * (1.0 / 32768)
	}
	return out, nil
}

// MonoInput готовит вход CTC из готового vocals.wav так же, как принятый эксперимент:
// FFmpeg сводит PCM16 stereo 44,1 кГц в PCM16 mono 16 кГц (штатный ресемплер swresample), затем
// s16 переводится в float32. Промежуточный PCM16 — часть рецепта: прямой f32-выход FFmpeg дал бы
// другие отсчёты. Программа запускается через общий process (отмена завершает её с потомками);
// stdout собирается в память, stderr — в хвост ошибки. log получает служебные строки FFmpeg.
func MonoInput(ctx context.Context, ffmpeg, wav string) ([]float32, error) {
	var stdout bytes.Buffer
	result, err := process.Run(ctx, process.Command{
		Path:        ffmpeg,
		Args:        []string{"-nostdin", "-v", "error", "-i", wav, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"},
		StderrLimit: 16 * 1024,
		OnOutput: func(data []byte, stderr bool) {
			if !stderr {
				stdout.Write(data)
			}
		},
	})
	if err != nil {
		if message := strings.TrimSpace(string(result.Stderr)); message != "" {
			return nil, fmt.Errorf("FFmpeg не подготовил вокал для CTC: %s", message)
		}
		return nil, fmt.Errorf("FFmpeg не подготовил вокал для CTC: %w", err)
	}
	audio, err := DecodePCM16(stdout.Bytes())
	if err != nil {
		return nil, fmt.Errorf("готовый вокал не содержит корректного аудио: %w", err)
	}
	return audio, nil
}

// DecodeStereo декодирует полный трек в interleaved float32 stereo 44,1 кГц без обрезки и
// нормализации (mdx.decode_stereo оригинала) и раскладывает каналы для Separate.
func DecodeStereo(ctx context.Context, ffmpeg, source string) ([2][]float32, error) {
	var signal [2][]float32
	var stdout bytes.Buffer
	result, err := process.Run(ctx, process.Command{
		Path:        ffmpeg,
		Args:        []string{"-nostdin", "-v", "error", "-i", source, "-f", "f32le", "-ac", "2", "-ar", "44100", "pipe:1"},
		StderrLimit: 16 * 1024,
		OnOutput: func(data []byte, stderr bool) {
			if !stderr {
				stdout.Write(data)
			}
		},
	})
	if err != nil {
		if message := strings.TrimSpace(string(result.Stderr)); message != "" {
			return signal, fmt.Errorf("FFmpeg не декодировал трек: %s", message)
		}
		return signal, fmt.Errorf("FFmpeg не декодировал трек: %w", err)
	}
	values, err := DecodeFloat32(stdout.Bytes())
	if err != nil || len(values)%2 != 0 {
		return signal, errors.New("исходная запись не содержит корректного аудио")
	}
	n := len(values) / 2
	signal = [2][]float32{make([]float32, n), make([]float32, n)}
	for i := 0; i < n; i++ {
		signal[0][i] = values[2*i]
		signal[1][i] = values[2*i+1]
	}
	return signal, nil
}
