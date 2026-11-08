package videoreview

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"songframe/internal/process"
	"songframe/internal/toolrt"
)

// Пределы подготовки кадров; от них зависят выборка и отказы, проверяемые эталоном video-review-frames.
const (
	maxDuration      = 600
	maxDecodedFrames = 72_000
	maxFrames        = 32
	commandTimeout   = 120 * time.Second
	imageFileBudget  = 1024 * 1024
	// stderrTail — хвост stderr FFmpeg в сообщении, в символах (последние 1200).
	stderrTail = 1200
	// probeOutput — предел stdout ffprobe: список PTS 72 000 кадров занимает несколько мегабайт.
	probeOutput = 64 * 1024 * 1024
)

// Tools — пара FFmpeg/ffprobe, найденная менеджером компонентов (абсолютные пути или имена из PATH).
type Tools struct {
	FFmpeg  string
	FFprobe string
}

// ExtractInput — аргументы video_review: видео, новая или пустая папка результата, опоры и бюджет.
type ExtractInput struct {
	Tools       Tools
	Video       string
	Out         string
	References  []string
	BudgetBytes int
}

// ManifestFrame — кадр выборки: ID F001…, фактический PTS от первого кадра и путь копии.
type ManifestFrame struct {
	ID          string
	TimeSeconds float64
	Path        string
}

// ManifestReference — подготовленная копия опоры R001… и канонический путь исходного файла опоры.
type ManifestReference struct {
	ID         string
	SourcePath string
	Path       string
}

// Manifest — отчёт подготовки (manifest.json и stdout video_review).
type Manifest struct {
	SchemaVersion   int
	DurationSeconds float64
	References      []ManifestReference
	Frames          []ManifestFrame
}

// valueError — причина отказа подготовки; её текст попадает в сообщение пользователю.
type valueError struct{ message string }

func (e *valueError) Error() string { return e.message }

func fail(message string) error { return &valueError{message} }

// Extract — подготовка кадров video_review: извлекает реальные кадры видео (ближайшие к шагу 0,5 с,
// обязательно первый и последний, не больше 32) с фактическими PTS, готовит копии опор с
// EXIF-ориентацией и уменьшением до 960×960 без увеличения и упаковывает все изображения в общий
// бюджет, не теряя ни одного ID. Результат публикуется в Out только целиком: всё готовится во
// временной соседней папке и переименовывается после успеха. Исходные видео и опоры не меняются.
//
// Ошибка — текст, который пользователь видел как stderr инструмента: «Не удалось подготовить
// кадры: <причина>». Отмена ctx останавливает FFmpeg вместе с потомками.
func Extract(ctx context.Context, input ExtractInput) (Manifest, error) {
	manifest, err := extract(ctx, input)
	if err != nil {
		if ctx.Err() != nil {
			return Manifest{}, ctx.Err()
		}
		return Manifest{}, errors.New(textFramesPrefix + err.Error())
	}
	return manifest, nil
}

// resolvePath — абсолютный путь, ссылки разыменованы в существующей части пути.
func resolvePath(path string) string {
	absolute := filepath.Clean(path)
	rest := []string{}
	for current := absolute; ; current = filepath.Dir(current) {
		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			return filepath.Join(append([]string{resolved}, rest...)...)
		}
		if filepath.Dir(current) == current {
			return absolute
		}
		rest = append([]string{filepath.Base(current)}, rest...)
	}
}

// isFile — обычный файл после разыменования ссылок.
func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// isDir — каталог после разыменования ссылок.
func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func extract(ctx context.Context, input ExtractInput) (Manifest, error) {
	if input.BudgetBytes <= 0 || input.BudgetBytes > DefaultImageBudget {
		return Manifest{}, fail(textBudgetRange)
	}
	if !filepath.IsAbs(input.Video) || !filepath.IsAbs(input.Out) {
		return Manifest{}, fail(textPathsAbsolute)
	}
	video, out := resolvePath(input.Video), resolvePath(input.Out)
	if !isFile(video) {
		return Manifest{}, fail(textVideoMissing)
	}
	if info, err := os.Stat(out); err == nil {
		entries, _ := os.ReadDir(out)
		if !info.IsDir() || len(entries) > 0 {
			return Manifest{}, fail(textOutputNotEmpty)
		}
	}
	if !isDir(filepath.Dir(out)) {
		return Manifest{}, fail(textOutputParent)
	}
	if len(input.References) > 20 {
		return Manifest{}, fail(textReferencesLimit)
	}
	for _, path := range input.References {
		if !filepath.IsAbs(path) || !isFile(path) {
			return Manifest{}, fail(textReferencesInvalid)
		}
	}
	runner := &mediaRunner{ctx: ctx, tools: input.Tools}
	duration, timestamps, err := runner.probe(video)
	if err != nil {
		return Manifest{}, err
	}
	indices := selectFrames(timestamps)
	// Все результаты готовятся отдельно: ошибка декодирования не оставляет неполный отчёт.
	stage, err := os.MkdirTemp(filepath.Dir(out), "video-review-")
	if err != nil {
		return Manifest{}, osError(err)
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(stage)
		}
	}()
	selection := make([]string, len(indices))
	for position, index := range indices {
		selection[position] = fmt.Sprintf(`eq(n\,%d)`, index)
	}
	scale := "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease"
	if _, err := runner.run(input.Tools.FFmpeg, "ffmpeg", "-v", "error", "-nostdin", "-n", "-protocol_whitelist", "file", "-i", video,
		"-map", "0:v:0", "-an", "-vf", "select="+strings.Join(selection, "+")+","+scale, "-fps_mode", "vfr",
		"-frames:v", fmt.Sprint(len(indices)), "-start_number", "1", filepath.Join(stage, "F%03d.png")); err != nil {
		return Manifest{}, err
	}
	files, _ := filepath.Glob(filepath.Join(stage, "F*.png"))
	sort.Strings(files)
	if len(files) != len(indices) {
		return Manifest{}, fail(textExtractIncomplete)
	}
	for _, file := range files {
		if info, err := os.Stat(file); err != nil || info.Size() == 0 {
			return Manifest{}, fail(textExtractIncomplete)
		}
	}
	references := make([]ManifestReference, 0, len(input.References))
	copies := []string{}
	for number, source := range input.References {
		name := fmt.Sprintf("R%03d.png", number+1)
		// EXIF-ориентация применяется к копии; оплаченный оригинал остаётся нетронутым.
		if err := runner.reference(source, filepath.Join(stage, name)); err != nil {
			return Manifest{}, err
		}
		references = append(references, ManifestReference{ID: fmt.Sprintf("R%03d", number+1), SourcePath: resolvePath(source), Path: filepath.Join(out, name)})
		copies = append(copies, filepath.Join(stage, name))
	}
	packed, err := runner.budgetImages(append(append([]string{}, files...), copies...), input.BudgetBytes, imageFileBudget)
	if err != nil {
		return Manifest{}, err
	}
	for index := range references {
		references[index].Path = filepath.Join(out, filepath.Base(packed[len(files)+index]))
	}
	manifest := Manifest{SchemaVersion: 1, DurationSeconds: duration, References: references, Frames: make([]ManifestFrame, 0, len(files))}
	for position, path := range packed[:len(files)] {
		name := filepath.Base(path)
		manifest.Frames = append(manifest.Frames, ManifestFrame{ID: strings.TrimSuffix(name, filepath.Ext(name)), TimeSeconds: timestamps[indices[position]], Path: filepath.Join(out, name)})
	}
	data, err := manifestJSON(manifest)
	if err != nil {
		return Manifest{}, err
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), data, 0o666); err != nil {
		return Manifest{}, osError(err)
	}
	if isDir(out) {
		// Непустая папка не удаляется, в том числе если изменилась во время извлечения.
		if err := os.Remove(out); err != nil {
			return Manifest{}, osError(err)
		}
	}
	if err := os.Rename(stage, out); err != nil {
		return Manifest{}, osError(err)
	}
	published = true
	return manifest, nil
}

// manifestJSON — байты manifest.json в модели toolrt (отступ два пробела, не-ASCII без экранирования,
// перевод строки в конце, UTF-8): порядок ключей и запись чисел (дробные 0.0, 2.5; schema_version —
// целое) зафиксированы эталоном video-review-frames.
func manifestJSON(manifest Manifest) ([]byte, error) {
	references := []any{}
	for _, item := range manifest.References {
		entry := toolrt.NewDict()
		entry.Set("id", item.ID)
		entry.Set("source_path", item.SourcePath)
		entry.Set("path", item.Path)
		references = append(references, entry)
	}
	frames := []any{}
	for _, item := range manifest.Frames {
		entry := toolrt.NewDict()
		entry.Set("id", item.ID)
		entry.Set("time_seconds", item.TimeSeconds)
		entry.Set("path", item.Path)
		frames = append(frames, entry)
	}
	report := toolrt.NewDict()
	report.Set("schema_version", toolrt.NewInt(int64(manifest.SchemaVersion)))
	report.Set("duration_seconds", manifest.DurationSeconds)
	report.Set("references", references)
	report.Set("frames", frames)
	return toolrt.EncodeIndented(report)
}

// osError — OSError с системным текстом и repr-записью пути, без обёртки ошибки Go.
func osError(err error) error {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return fail(pathErr.Err.Error() + ": " + toolrt.Repr(pathErr.Path))
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
		return fail(linkErr.Err.Error() + ": " + toolrt.Repr(linkErr.Old) + " -> " + toolrt.Repr(linkErr.New))
	}
	return fail(err.Error())
}

// mediaRunner запускает FFmpeg/ffprobe через общий запуск процессов с таймаутом каждой команды.
type mediaRunner struct {
	ctx   context.Context
	tools Tools
}

// run выполняет программу; ненулевой выход — «Ошибка обработки видео: <хвост stderr>», как run()
// инструмента. name — имя программы в сообщениях (ffmpeg/ffprobe).
func (r *mediaRunner) run(path, name string, args ...string) ([]byte, error) {
	if path == "" {
		path = name
	}
	result, err := process.Run(r.ctx, process.Command{Path: path, Args: args, Name: name, Timeout: commandTimeout, StdoutLimit: probeOutput, StderrLimit: 64 * 1024})
	if err == nil {
		return result.Stdout, nil
	}
	if r.ctx.Err() != nil {
		return nil, r.ctx.Err()
	}
	var exit *process.ExitError
	switch {
	case errors.As(err, &exit):
		return nil, fail(textMediaFailed + lastRunes(decodeReplace(result.Stderr), stderrTail))
	case errors.Is(err, process.ErrTimeout):
		quoted := make([]string, 0, len(args)+1)
		for _, part := range append([]string{name}, args...) {
			quoted = append(quoted, toolrt.Repr(part))
		}
		return nil, fail(fmt.Sprintf("Command '[%s]' timed out after 120 seconds", strings.Join(quoted, ", ")))
	}
	var start *process.StartError
	if errors.As(err, &start) {
		return nil, fail("[Errno 2] No such file or directory: " + toolrt.Repr(name))
	}
	return nil, fail(err.Error())
}

// decodeReplace — байты как UTF-8 с заменой неверных последовательностей на U+FFFD.
func decodeReplace(data []byte) string { return strings.ToValidUTF8(string(data), "�") }

// lastRunes — text[-limit:] по символам Unicode.
func lastRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[len(runes)-limit:])
}

// probe — probe инструмента: длительность потока (или контейнера) и реальные PTS всех
// декодированных кадров относительно первого. Индекс/fps дал бы ложные таймкоды на VFR и на
// последнем кадре, поэтому читаются best_effort_timestamp_time.
func (r *mediaRunner) probe(video string) (float64, []float64, error) {
	base := []string{"-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0"}
	output, err := r.run(r.tools.FFprobe, "ffprobe", append(append([]string{}, base...), "-show_streams", "-show_format", "-of", "json", video)...)
	if err != nil {
		return 0, nil, err
	}
	var info struct {
		Streams []map[string]any `json:"streams"`
		Format  map[string]any   `json:"format"`
	}
	if err := decodeJSON(output, &info); err != nil {
		return 0, nil, fail(err.Error())
	}
	if len(info.Streams) == 0 {
		return 0, nil, fail(textNoVideoStream)
	}
	stream := info.Streams[0]
	duration, fps, width, height, ok := streamParameters(stream, info.Format)
	if !ok {
		return 0, nil, fail(textProbeFailed)
	}
	if math.IsInf(duration, 0) || math.IsNaN(duration) || !(duration > 0 && duration <= maxDuration) {
		return 0, nil, fail(textDurationInvalid)
	}
	if math.IsInf(fps, 0) || math.IsNaN(fps) || !(fps > 0 && fps <= 120) || min(width, height) <= 0 {
		return 0, nil, fail(textStreamInvalid)
	}
	output, err = r.run(r.tools.FFprobe, "ffprobe", append(append([]string{}, base...), "-read_intervals", fmt.Sprintf("%%+%d", maxDuration+1),
		"-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", video)...)
	if err != nil {
		return 0, nil, err
	}
	var data struct {
		Frames []map[string]any `json:"frames"`
	}
	if err := decodeJSON(output, &data); err != nil {
		return 0, nil, fail(err.Error())
	}
	if len(data.Frames) == 0 || len(data.Frames) > maxDecodedFrames {
		return 0, nil, fail(textFrameCount)
	}
	timestamps := make([]float64, len(data.Frames))
	for index, frame := range data.Frames {
		value, ok := floatOf(frame["best_effort_timestamp_time"])
		if !ok {
			return 0, nil, fail(textTimestampsMissing)
		}
		timestamps[index] = value
	}
	for _, value := range timestamps {
		if math.IsInf(value, 0) || math.IsNaN(value) {
			return 0, nil, fail(textTimestampsInvalid)
		}
	}
	first := timestamps[0]
	for index := range timestamps {
		timestamps[index] -= first
	}
	for index := 1; index < len(timestamps); index++ {
		if timestamps[index-1] >= timestamps[index] {
			return 0, nil, fail(textTimestampsOrder)
		}
	}
	if timestamps[len(timestamps)-1] > maxDuration {
		return 0, nil, fail(textTimestampsOrder)
	}
	return duration, timestamps, nil
}

// decodeJSON разбирает вывод ffprobe; числа сохраняются как json.Number для точного разбора целых.
func decodeJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(target)
}

// floatOf — дробное из строки или числа JSON (toolrt.FloatFromString); отсутствие ключа и прочие типы — отказ.
func floatOf(value any) (float64, bool) {
	switch item := value.(type) {
	case string:
		result, err := toolrt.FloatFromString(item)
		return result, err == nil
	case json.Number:
		result, err := toolrt.FloatFromString(item.String())
		return result, err == nil
	}
	return 0, false
}

// intOf — целое из числа JSON или строки с целым (крайние пробелы допускаются); прочее — отказ.
func intOf(value any) (int, bool) {
	switch item := value.(type) {
	case json.Number:
		result, err := item.Int64()
		return int(result), err == nil
	case string:
		var result int
		_, err := fmt.Sscan(strings.TrimSpace(item), &result)
		return result, err == nil
	}
	return 0, false
}

// truthy — истинность значения JSON: ложны null, пустая строка, ноль и false (для выбора запасного поля).
func truthy(value any) bool {
	switch item := value.(type) {
	case nil:
		return false
	case string:
		return item != ""
	case json.Number:
		number, err := item.Float64()
		return err != nil || number != 0
	case bool:
		return item
	}
	return true
}

// streamParameters — длительность, частота и размер потока: duration потока (если ложно — формата)
// как дробное, avg_frame_rate (если ложно — r_frame_rate) как дробь, целые width и height.
func streamParameters(stream, format map[string]any) (float64, float64, int, int, bool) {
	durationValue := stream["duration"]
	if !truthy(durationValue) {
		if format == nil {
			return 0, 0, 0, 0, false
		}
		var present bool
		if durationValue, present = format["duration"]; !present {
			return 0, 0, 0, 0, false
		}
	}
	duration, ok := floatOf(durationValue)
	if !ok {
		return 0, 0, 0, 0, false
	}
	rate := stream["avg_frame_rate"]
	if !truthy(rate) {
		var present bool
		if rate, present = stream["r_frame_rate"]; !present {
			return 0, 0, 0, 0, false
		}
	}
	fps, ok := fraction(rate)
	if !ok {
		return 0, 0, 0, 0, false
	}
	width, widthOK := intOf(stream["width"])
	height, heightOK := intOf(stream["height"])
	if !widthOK || !heightOK {
		return 0, 0, 0, 0, false
	}
	return duration, fps, width, height, true
}

// fraction — значение «num/den» или десятичной записи как точная дробь с одним округлением до
// float64. Нулевой знаменатель («0/0» у потока без частоты) — отказ.
func fraction(value any) (float64, bool) {
	var text string
	switch item := value.(type) {
	case string:
		text = strings.TrimSpace(item)
	case json.Number:
		text = item.String()
	default:
		return 0, false
	}
	if numerator, denominator, found := strings.Cut(text, "/"); found {
		top, okTop := new(big.Int).SetString(strings.TrimSpace(numerator), 10)
		bottom, okBottom := new(big.Int).SetString(strings.TrimSpace(denominator), 10)
		if !okTop || !okBottom || bottom.Sign() == 0 {
			return 0, false
		}
		result, _ := new(big.Rat).SetFrac(top, bottom).Float64()
		return result, true
	}
	rat, ok := new(big.Rat).SetString(text)
	if !ok {
		return 0, false
	}
	result, _ := rat.Float64()
	return result, true
}

// selectFrames — выбор кадров: реальные кадры, ближайшие к шагу 0,5 с, плюс первый и
// последний; если точек больше 32, они распределяются равномерно между первым и последним кадром.
// При равном расстоянии выбирается более ранний кадр. Повторы удаляются.
func selectFrames(timestamps []float64) []int {
	last := timestamps[len(timestamps)-1]
	targets := []float64{}
	for position := 0; position < int(math.Floor(last/0.5))+1; position++ {
		targets = append(targets, float64(position)*0.5)
	}
	targets = append(targets, last)
	if len(targets) > maxFrames {
		targets = targets[:0]
		for position := 0; position < maxFrames; position++ {
			targets = append(targets, last*float64(position)/float64(maxFrames-1))
		}
	}
	selected := map[int]bool{0: true, len(timestamps) - 1: true}
	for _, target := range targets {
		right := sort.SearchFloat64s(timestamps, target)
		best := -1
		for _, index := range []int{right - 1, right} {
			if index < 0 || index >= len(timestamps) {
				continue
			}
			if best < 0 || math.Abs(timestamps[index]-target) < math.Abs(timestamps[best]-target) {
				best = index
			}
		}
		selected[best] = true
	}
	result := make([]int, 0, len(selected))
	for index := range selected {
		result = append(result, index)
	}
	sort.Ints(result)
	return result
}
