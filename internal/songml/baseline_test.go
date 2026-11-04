package songml_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"songframe-go/internal/components"
	"songframe-go/internal/songml"
	"songframe-go/internal/timing"
)

// Добровольные сверки с сохранёнными результатами принятого эксперимента (A-06/A-08).
// Артефакты (emissions, отчёты, WAV) лежат локально в songframe-go-probe/reports и в Git не входят:
//
//	SONGFRAME_CTC_BASELINE=<probe>/reports SONGFRAME_CTC_VOCAB=<папка>/vocab.json \
//	  [SONGFRAME_ORT_LIBRARY=<lib> SONGFRAME_CTC_MODEL=<alignment.onnx> SONGFRAME_VOCALS_MODEL=<vocals.onnx>] \
//	  [SONGFRAME_OGOROD_TEXT=<ogorod>/source/text.md] go test ./internal/songml -run Baseline -v
//
// Ручные секунды не читаются: сравниваются только emissions, пути и границы эксперимента.

type baselineCase struct {
	name, lyrics, emissions string
	reports                 map[string]string
}

// baselineCases — 12 Suno-треков пакета и «Огород» (если указан его текст).
func baselineCases(t *testing.T, root string) []baselineCase {
	var cases []baselineCase
	batch := filepath.Join(root, "suno-ctc-2026-11-03")
	entries, _ := os.ReadDir(batch)
	for _, entry := range entries {
		dir := filepath.Join(batch, entry.Name())
		if _, err := os.Stat(filepath.Join(dir, "alignment-adaptive.json")); err != nil {
			continue
		}
		cases = append(cases, baselineCase{entry.Name(), filepath.Join(dir, "lyrics.txt"), filepath.Join(dir, "emissions"),
			map[string]string{"off": filepath.Join(dir, "alignment-off.json"), "adaptive": filepath.Join(dir, "alignment-adaptive.json")}})
	}
	if text := os.Getenv("SONGFRAME_OGOROD_TEXT"); text != "" {
		cases = append(cases, baselineCase{"ogorod", text, filepath.Join(root, "ctc-ogorod", "emissions"),
			map[string]string{"adaptive": filepath.Join(root, "ctc-boundaries", "alignment-adaptive.json"), "off": filepath.Join(root, "ctc-boundaries", "alignment-off.json")}})
	}
	if len(cases) == 0 {
		t.Fatal("в SONGFRAME_CTC_BASELINE нет сохранённых результатов")
	}
	return cases
}

func baselineEnv(t *testing.T) (string, map[string]int, int) {
	root, vocabPath := os.Getenv("SONGFRAME_CTC_BASELINE"), os.Getenv("SONGFRAME_CTC_VOCAB")
	if root == "" || vocabPath == "" {
		t.Skip("SONGFRAME_CTC_BASELINE и SONGFRAME_CTC_VOCAB не заданы; сверка с экспериментом добровольная")
	}
	var vocab map[string]int
	data, err := os.ReadFile(vocabPath)
	if err != nil || json.Unmarshal(data, &vocab) != nil {
		t.Fatalf("словарь не прочитан: %v", err)
	}
	return root, vocab, vocab["<pad>"]
}

func readEmissions(t *testing.T, dir string) ([]float32, []float64, int, []byte) {
	data, err := os.ReadFile(filepath.Join(dir, "logprobs.f32le"))
	if err != nil {
		t.Fatal(err)
	}
	probs, err := songml.DecodeFloat32(data)
	if err != nil {
		t.Fatal(err)
	}
	var times []float64
	var meta struct {
		Classes int `json:"classes"`
	}
	timesData, _ := os.ReadFile(filepath.Join(dir, "times.json"))
	metaData, _ := os.ReadFile(filepath.Join(dir, "metadata.json"))
	if json.Unmarshal(timesData, &times) != nil || json.Unmarshal(metaData, &meta) != nil {
		t.Fatal("кэш emissions повреждён")
	}
	return probs, times, meta.Classes, data
}

// TestBaselineAlignment повторяет Align на сохранённых emissions и требует побайтно тех же
// строк, слов, статусов, reward и adaptive-политики, что в отчётах off/adaptive эксперимента.
// Дополнительно строки, разобранные редактором (AnalyzeLyrics → TokenizeLine), совпадают с ParseLyrics.
func TestBaselineAlignment(t *testing.T) {
	root, vocab, blank := baselineEnv(t)
	for _, item := range baselineCases(t, root) {
		t.Run(item.name, func(t *testing.T) {
			text, err := os.ReadFile(item.lyrics)
			if err != nil {
				t.Fatal(err)
			}
			lines, err := songml.ParseLyrics(string(text), vocab)
			if err != nil {
				t.Fatal(err)
			}
			var editor []songml.Line
			for _, row := range timing.AnalyzeLyrics(string(text)).Rows {
				if row.Header || row.Text == "" {
					continue
				}
				if line, ok := songml.TokenizeLine(row.Number, row.Text, vocab); ok {
					editor = append(editor, line)
				}
			}
			if !reflect.DeepEqual(lines, editor) {
				t.Fatal("строки редактора и эксперимента разобраны по-разному")
			}
			probs, times, classes, _ := readEmissions(t, item.emissions)
			for mode, path := range item.reports {
				var report map[string]any
				data, err := os.ReadFile(path)
				if err != nil || json.Unmarshal(data, &report) != nil {
					t.Fatalf("%s: отчёт не прочитан", mode)
				}
				options := songml.DefaultOptions(report["audio_duration_seconds"].(float64))
				options.PausePolicy = mode
				result, err := songml.Align(context.Background(), probs, times, classes, blank, editor, options)
				if err != nil {
					t.Fatal(err)
				}
				encoded, _ := json.Marshal(result)
				var got map[string]any
				_ = json.Unmarshal(encoded, &got)
				for key, value := range got {
					if !reflect.DeepEqual(value, report[key]) {
						t.Errorf("%s: поле %s отличается от эксперимента", mode, key)
					}
				}
			}
		})
	}
}

// TestBaselinePCM — шаги рецепта «PCM16 stereo44100 → PCM16 mono16000 → float32»: ToPCM16
// повторяет отсчёты vocals-stereo.wav, а MonoInput (FFmpeg из PATH) — vocals.f32 эксперимента.
func TestBaselinePCM(t *testing.T) {
	root, _, _ := baselineEnv(t)
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg не найден в PATH")
	}
	dir := filepath.Join(root, "suno-ctc-2026-11-03", "01_A")
	stereo, err := os.ReadFile(filepath.Join(dir, "vocals-stereo.f32"))
	if err != nil {
		t.Skip("нет vocals-stereo.f32 пакета")
	}
	values, err := songml.DecodeFloat32(stereo)
	if err != nil {
		t.Fatal(err)
	}
	wav, _ := os.ReadFile(filepath.Join(dir, "vocals-stereo.wav"))
	samples := wavData(t, wav)
	if len(samples) != len(values)*2 {
		t.Fatalf("длина PCM %d, ожидалось %d", len(samples), len(values)*2)
	}
	for i, v := range values {
		if uint16(songml.ToPCM16(v)) != binary.LittleEndian.Uint16(samples[i*2:]) {
			t.Fatalf("отсчёт PCM16 %d отличается", i)
		}
	}
	n := len(values) / 2
	signal := [2][]float32{make([]float32, n), make([]float32, n)}
	for i := 0; i < n; i++ {
		signal[0][i], signal[1][i] = values[2*i], values[2*i+1]
	}
	path := filepath.Join(t.TempDir(), "vocals.wav")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := songml.WriteStereoWAV(file, signal); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	mono, err := songml.MonoInput(context.Background(), ffmpeg, path)
	if err != nil {
		t.Fatal(err)
	}
	expected, _ := os.ReadFile(filepath.Join(dir, "vocals.f32"))
	if string(songml.EncodeFloat32(mono)) != string(expected) {
		t.Fatal("вход CTC отличается от vocals.f32 эксперимента")
	}
}

// wavData возвращает содержимое chunk data (FFmpeg добавляет LIST перед ним).
func wavData(t *testing.T, wav []byte) []byte {
	for offset := 12; offset+8 <= len(wav); {
		size := int(binary.LittleEndian.Uint32(wav[offset+4:]))
		if string(wav[offset:offset+4]) == "data" {
			return wav[offset+8 : offset+8+size]
		}
		offset += 8 + size + size%2
	}
	t.Fatal("в WAV нет data")
	return nil
}

func prepareORT(t *testing.T, model string) {
	library := os.Getenv("SONGFRAME_ORT_LIBRARY")
	if library == "" || model == "" {
		t.Skip("SONGFRAME_ORT_LIBRARY и путь модели не заданы; inference-сверка добровольная")
	}
	if err := components.PrepareORT(context.Background(), library); err != nil {
		t.Fatal(err)
	}
}

// TestBaselineEmissions — адресный inference «Огорода» с 8 потоками: logprobs и времена кадров
// совпадают с сохранённым кэшем эксперимента (вход — его vocals.f32).
func TestBaselineEmissions(t *testing.T) {
	root, _, _ := baselineEnv(t)
	prepareORT(t, os.Getenv("SONGFRAME_CTC_MODEL"))
	data, err := os.ReadFile(filepath.Join(root, "ctc-ogorod", "vocals.f32"))
	if err != nil {
		t.Skip("нет ctc-ogorod/vocals.f32")
	}
	audio, err := songml.DecodeFloat32(data)
	if err != nil {
		t.Fatal(err)
	}
	session, err := songml.Open(context.Background(), os.Getenv("SONGFRAME_CTC_MODEL"), 8)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	probs, times, classes, err := session.Emissions(context.Background(), audio, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantProbs, wantTimes, wantClasses, raw := readEmissions(t, filepath.Join(root, "ctc-ogorod", "emissions"))
	if classes != wantClasses || !reflect.DeepEqual(times, wantTimes) {
		t.Fatal("форма или времена кадров отличаются")
	}
	if string(songml.EncodeFloat32(probs)) != string(raw) {
		t.Errorf("emissions не побайтно равны; max_abs=%g", maxAbs(probs, wantProbs))
	}
}

// TestBaselineSeparation — Voc FT на начале трека 01_A: первые два полных шага блока совпадают
// с vocals-stereo.f32 пакета (последний блок усечённого входа видит нули вместо продолжения).
func TestBaselineSeparation(t *testing.T) {
	root, _, _ := baselineEnv(t)
	prepareORT(t, os.Getenv("SONGFRAME_VOCALS_MODEL"))
	dir := filepath.Join(root, "suno-ctc-2026-11-03", "01_A")
	source, err1 := os.ReadFile(filepath.Join(dir, "source-stereo.f32"))
	vocals, err2 := os.ReadFile(filepath.Join(dir, "vocals-stereo.f32"))
	if err1 != nil || err2 != nil {
		t.Skip("нет stereo-входа/выхода пакета")
	}
	stride := songml.Chunk - songml.FFT
	n := 3 * stride
	input, _ := songml.DecodeFloat32(source[:n*8])
	want, _ := songml.DecodeFloat32(vocals[:2*stride*8])
	signal := [2][]float32{make([]float32, n), make([]float32, n)}
	for i := 0; i < n; i++ {
		signal[0][i], signal[1][i] = input[2*i], input[2*i+1]
	}
	threads := min(8, runtime.NumCPU())
	session, err := songml.Open(context.Background(), os.Getenv("SONGFRAME_VOCALS_MODEL"), threads)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	out, err := session.Separate(context.Background(), signal, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]float32, 0, 4*stride)
	for i := 0; i < 2*stride; i++ {
		got = append(got, out[0][i], out[1][i])
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Voc FT отличается; max_abs=%g", maxAbs(got, want))
	}
}

func maxAbs(a, b []float32) float64 {
	worst := 0.0
	for i := range min(len(a), len(b)) {
		worst = max(worst, math.Abs(float64(a[i]-b[i])))
	}
	return worst
}
