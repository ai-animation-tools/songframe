package songtiming

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"songframe-go/internal/components"
	"songframe-go/internal/filedigest"
	"songframe-go/internal/jobs"
	"songframe-go/internal/process"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/songml"
	"songframe-go/internal/timing"
)

// alignRequest — снимок запуска разметки: выбранный вокал и SHA трека на момент Start.
type alignRequest struct {
	project    string
	resultPath string
	vocal      metadata
	sourceSHA  string
	reset      bool
}

// Сообщения публикации align_lyrics оригинала.
const (
	textVocalChanged  = "Вокал изменился во время выравнивания. Прежняя разметка сохранена."
	textSourceStale   = "Исходный трек или текст изменились во время обработки. Результат не записан; повторите разметку."
	textTimingChanged = "Разметка изменилась во время обработки. Сохранённые правки не перезаписаны; повторите разметку."
	textNoDuration    = "ffprobe не смог определить длительность трека."
)

// align — шаг разметки (align_lyrics + CTC оригинала). До записи сохраняются снимки трека,
// текста, прежнего timing.json и метаданных вокала; результат публикуется одной атомарной
// записью после всех проверок, поэтому отмена или сбой на любом этапе оставляют прежнюю
// разметку нетронутой.
func (s *Service) align(ctx context.Context, step *jobs.StepContext, request alignRequest) error {
	project := request.project
	trackPath := filepath.Join(project, "source", "track.mp3")
	textPath := filepath.Join(project, "source", "text.md")
	timingPath := filepath.Join(project, filepath.FromSlash(timing.TimingPath))
	sourceSHA, err := fileSHA256(trackPath)
	if err != nil || sourceSHA != request.sourceSHA {
		return errors.New(textSourceStale)
	}
	original, err := os.ReadFile(textPath)
	if err != nil {
		return errors.New(textTimingSource)
	}
	previousBytes, previousExists := readOptional(timingPath)
	if !utf8.Valid(original) {
		return errors.New("source/text.md должен быть в кодировке UTF-8.")
	}
	text := strings.TrimPrefix(string(original), "\ufeff")
	// Ошибка формата текста появляется до долгого вычисления.
	lyrics, err := timing.LyricLines(text)
	if err != nil {
		return err
	}
	paths, err := s.ready(ctx, operationAlign)
	if err != nil {
		return err
	}
	duration, err := trackDuration(ctx, paths["ffmpeg/ffprobe"], trackPath)
	if err != nil {
		return err
	}
	started := time.Now()
	audio, err := songml.MonoInput(ctx, paths["ffmpeg/ffmpeg"], filepath.Join(filepath.Dir(request.resultPath), "vocals.wav"))
	if err != nil {
		return err
	}
	decoded := float64(len(audio)) / songml.CTCSampleRate
	step.Log(fmt.Sprintf("Вокал mono 16 кГц: %.1f с; длительность трека %s с.\n", decoded, strconv.FormatFloat(duration, 'f', -1, 64)))
	vocabBytes, err := os.ReadFile(paths["ctc-vocab/vocab"])
	if err != nil {
		return err
	}
	var vocab map[string]int
	if err := json.Unmarshal(vocabBytes, &vocab); err != nil {
		return fmt.Errorf("словарь CTC повреждён: %w", err)
	}
	blank, ok := vocab["<pad>"]
	if _, separator := vocab["|"]; !ok || !separator {
		return errors.New("в словаре CTC нет <pad> или разделителя |")
	}
	emissions, err := s.emissions(ctx, step, paths, audio, vocabBytes)
	if err != nil {
		return err
	}
	var lines []songml.Line
	for _, line := range lyrics {
		if tokenized, ok := songml.TokenizeLine(line.Number, line.Text, vocab); ok {
			lines = append(lines, tokenized)
		} else {
			step.Log(fmt.Sprintf("Строка %d: В строке есть символы, не поддерживаемые русской акустической моделью.\n", line.Number))
		}
	}
	aligned := []timing.AlignedLine{}
	if len(lines) > 0 && emissions.frames() > 0 {
		result, err := songml.Align(ctx, emissions.probs, emissions.times, emissions.classes, blank, lines, songml.AcceptedOptions(decoded))
		if err != nil {
			return err
		}
		step.Log(fmt.Sprintf("Выравнивание %s: %s\n", result.Engine, result.Reason))
		for _, line := range result.Lines {
			aligned = append(aligned, timing.AlignedLine{SourceLine: line.SourceLine, Start: line.Start, End: line.End, AcousticScore: line.AcousticScore, ReviewRequired: line.Status == "review_required", Reason: line.Reason})
			if line.Start == nil || line.Status == "review_required" {
				step.Log(fmt.Sprintf("Строка %d: %s\n", line.SourceLine, line.Reason))
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	recognition := timing.FromAlignment(aligned, decoded)
	var previous any
	if previousExists && !request.reset {
		previous = timing.ParsePrevious(previousBytes)
	}
	draft, err := timing.BuildDraft(text, recognition, duration, previous, sourceSHA)
	if err != nil {
		return err
	}
	data, err := timing.EncodeDraft(draft)
	if err != nil {
		return err
	}
	// Публикация: вокал, исходники и сохранённая разметка не должны были измениться.
	if !s.store.revalidate(request.resultPath, request.sourceSHA, request.vocal) {
		return errors.New(textVocalChanged)
	}
	if digest, err := fileSHA256(trackPath); err != nil || digest != sourceSHA {
		return errors.New(textSourceStale)
	}
	if current, err := os.ReadFile(textPath); err != nil || !bytes.Equal(current, original) {
		return errors.New(textSourceStale)
	}
	if current, exists := readOptional(timingPath); exists != previousExists || !bytes.Equal(current, previousBytes) {
		return errors.New(textTimingChanged)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	if err := projectfs.WriteFile(timingPath, data, 0); err != nil {
		return err
	}
	step.Log(fmt.Sprintf("Разметка записана за %.1f с: строк %d, кандидатов %d.\n", time.Since(started).Seconds(), len(recognition.Segments), len(recognition.Candidates)))
	return nil
}

// readOptional — содержимое файла и признак его наличия (ошибка чтения — как отсутствие).
func readOptional(path string) ([]byte, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	return data, true
}

// trackDuration — длительность контейнера по ffprobe, округлённая до миллисекунд (track_duration).
func trackDuration(ctx context.Context, ffprobe, track string) (float64, error) {
	var stdout bytes.Buffer
	_, err := process.Run(ctx, process.Command{
		Path:        ffprobe,
		Args:        []string{"-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", track},
		StderrLimit: 16 * 1024,
		OnOutput: func(data []byte, stderr bool) {
			if !stderr {
				stdout.Write(data)
			}
		},
	})
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	value, parseErr := strconv.ParseFloat(strings.TrimSpace(stdout.String()), 64)
	if err != nil || parseErr != nil || math.IsNaN(value) {
		return 0, errors.New(textNoDuration)
	}
	return timing.RoundSeconds(value), nil
}

// emissionSet — CTC log-probabilities [кадр*класс] и центры кадров в секундах.
type emissionSet struct {
	probs   []float32
	times   []float64
	classes int
}

func (e emissionSet) frames() int { return len(e.times) }

// emissionRecipe — версия расчёта emissions (блоки 18 с ± 1 с, нормализация, log-softmax).
// Входит в ключ кэша: изменение рецепта не должно читать старые вероятности.
const emissionRecipe = "ctc-emissions-v1"

// cacheMetadata — metadata.json кэша emissions; пишется последним и подтверждает целостность.
type cacheMetadata struct {
	SchemaVersion int    `json:"schemaVersion"`
	Recipe        string `json:"recipe"`
	AudioSHA256   string `json:"audioSha256"`
	ModelSHA256   string `json:"modelSha256"`
	VocabSHA256   string `json:"vocabSha256"`
	Samples       int    `json:"samples"`
	Frames        int    `json:"frames"`
	Classes       int    `json:"classes"`
}

// emissions считает CTC-вероятности или берёт их из <профиль>/ctc-emissions/<ключ>/. Ключ —
// SHA-256 рецепта, модели, словаря и float32-входа: тот же вокал с той же моделью при повторной
// разметке (например, после правки текста) не требует нового inference. Кэш вне проекта и
// публикуется переименованием готового каталога, поэтому отмена не оставляет частичных файлов.
func (s *Service) emissions(ctx context.Context, step *jobs.StepContext, paths map[string]string, audio []float32, vocab []byte) (emissionSet, error) {
	model := paths["ctc-ru/model"]
	modelSHA, ok := filedigest.File(model)
	if !ok {
		return emissionSet{}, errors.New("не удалось прочитать CTC-модель")
	}
	audioHash := sha256.Sum256(songml.EncodeFloat32(audio))
	vocabHash := sha256.Sum256(vocab)
	expected := cacheMetadata{SchemaVersion: 1, Recipe: emissionRecipe, AudioSHA256: hex.EncodeToString(audioHash[:]), ModelSHA256: modelSHA, VocabSHA256: hex.EncodeToString(vocabHash[:]), Samples: len(audio)}
	key := sha256.Sum256([]byte(strings.Join([]string{expected.Recipe, expected.ModelSHA256, expected.VocabSHA256, expected.AudioSHA256}, "\n")))
	root := filepath.Join(s.profile, "ctc-emissions")
	directory := filepath.Join(root, hex.EncodeToString(key[:]))
	if cached, ok := readEmissions(directory, expected); ok {
		step.Log("CTC-вероятности взяты из кэша.\n")
		return cached, nil
	}
	if err := components.PrepareORT(ctx, paths["ort-cpu/ort-library"]); err != nil {
		return emissionSet{}, err
	}
	session, err := songml.Open(ctx, model, threads())
	if err != nil {
		return emissionSet{}, err
	}
	step.Log(fmt.Sprintf("ONNX Runtime %s, потоков: %d, загрузка модели %.1f с.\n", session.Version, session.Threads, session.LoadSeconds))
	probs, times, classes, err := session.Emissions(ctx, audio, func(done, total float64) {
		step.Log(fmt.Sprintf("Акустическое выравнивание: %.0f/%.0f с\n", done, total))
	})
	session.Close()
	if err != nil {
		return emissionSet{}, err
	}
	result := emissionSet{probs: probs, times: times, classes: classes}
	expected.Frames, expected.Classes = len(times), classes
	if err := writeEmissions(root, directory, result, expected); err != nil {
		// Кэш — ускорение: его сбой не мешает разметке.
		step.Log("Не удалось сохранить кэш CTC-вероятностей: " + err.Error() + "\n")
	}
	return result, nil
}

// readEmissions читает кэш, если метаданные и размеры файлов совпадают с ожидаемыми.
func readEmissions(directory string, expected cacheMetadata) (emissionSet, bool) {
	var saved cacheMetadata
	if found, err := projectfs.ReadJSON(filepath.Join(directory, "metadata.json"), &saved); !found || err != nil {
		return emissionSet{}, false
	}
	expected.Frames, expected.Classes = saved.Frames, saved.Classes
	if saved != expected || saved.Frames < 0 || saved.Classes < 0 {
		return emissionSet{}, false
	}
	probBytes, err := os.ReadFile(filepath.Join(directory, "logprobs.f32le"))
	if err != nil || len(probBytes) != saved.Frames*saved.Classes*4 {
		return emissionSet{}, false
	}
	timeBytes, err := os.ReadFile(filepath.Join(directory, "times.f64le"))
	if err != nil || len(timeBytes) != saved.Frames*8 {
		return emissionSet{}, false
	}
	probs := make([]float32, saved.Frames*saved.Classes)
	for i := range probs {
		probs[i] = math.Float32frombits(binary.LittleEndian.Uint32(probBytes[i*4:]))
	}
	times := make([]float64, saved.Frames)
	for i := range times {
		times[i] = math.Float64frombits(binary.LittleEndian.Uint64(timeBytes[i*8:]))
	}
	return emissionSet{probs: probs, times: times, classes: saved.Classes}, true
}

// writeEmissions собирает кэш во временном каталоге и переименовывает его в итоговый.
func writeEmissions(root, directory string, set emissionSet, meta cacheMetadata) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(root, ".partial-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	times := make([]byte, len(set.times)*8)
	for i, value := range set.times {
		binary.LittleEndian.PutUint64(times[i*8:], math.Float64bits(value))
	}
	if err := os.WriteFile(filepath.Join(temporary, "logprobs.f32le"), songml.EncodeFloat32(set.probs), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(temporary, "times.f64le"), times, 0o600); err != nil {
		return err
	}
	if err := projectfs.WriteJSON(filepath.Join(temporary, "metadata.json"), meta); err != nil {
		return err
	}
	os.RemoveAll(directory)
	return os.Rename(temporary, directory)
}
