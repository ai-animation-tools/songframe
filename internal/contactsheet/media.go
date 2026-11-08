package contactsheet

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"songframe/internal/mediacmd"
	"songframe/internal/toolrt"
)

// stderrTail — сколько последних символов stderr FFmpeg/ffprobe попадает в текст ошибки.
const stderrTail = 600

// runMedia запускает программу и возвращает её stdout; ненулевой код — ValueError «Ошибка обработки медиа: »
// с хвостом stderr. Незапустившаяся программа — FileNotFoundError (скрытый текст), отмена — ошибка
// контекста.
func runMedia(ctx context.Context, program string, args ...string) ([]byte, error) {
	result, err := mediacmd.Run(ctx, program, args...)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, toolrt.New(toolrt.ValueError, textMediaFailed+mediacmd.Tail(result.Stderr, stderrTail))
	}
	return result.Stdout, nil
}

// media — параметры потока probe; поля в порядке словаря media отчёта. Значения из JSON
// ffprobe (codec, pixFmt, rFrameRate) хранятся как есть: отчёт печатает их без преобразования.
type media struct {
	width, height toolrt.Int
	rFrameRate    any
	fps, duration float64
	frames        toolrt.Int
	codec, pixFmt any
	audio         int
	bytes         toolrt.Int
}

// dict — словарь media отчёта.
func (m media) dict() *toolrt.Dict {
	result := toolrt.NewDict()
	result.Set("width", m.width)
	result.Set("height", m.height)
	result.Set("r_frame_rate", m.rFrameRate)
	result.Set("fps", m.fps)
	result.Set("duration", m.duration)
	result.Set("nb_frames", m.frames)
	result.Set("codec", m.codec)
	result.Set("pix_fmt", m.pixFmt)
	result.Set("audio_streams", toolrt.NewInt(int64(m.audio)))
	result.Set("bytes", m.bytes)
	return result
}

// probe — первый видеопоток ffprobe, частота числитель/знаменатель в toolrt.Decimal
// (28 знаков), длительность потока или формата, число кадров из nb_frames либо округлённое
// произведение длительности на частоту. Порядок обращений к полям определяет, какое исключение даёт
// неполный JSON (KeyError — скрытый текст, прочее — необработанная ошибка); он зафиксирован эталоном.
func probe(ctx context.Context, path string) (media, error) {
	output, err := runMedia(ctx, mediacmd.FFprobe(), "-v", "error", "-show_streams", "-show_format", "-of", "json", path)
	if err != nil {
		return media{}, err
	}
	text, err := toolrt.DecodeUTF8(output)
	if err != nil {
		return media{}, err
	}
	info, err := toolrt.LoadsJSON(text)
	if err != nil {
		return media{}, err
	}
	listed, err := toolrt.Item(info, "streams")
	if err != nil {
		return media{}, err
	}
	streams, err := toolrt.Iter(listed)
	if err != nil {
		return media{}, err
	}
	var video any
	for _, stream := range streams {
		kind, err := toolrt.Item(stream, "codec_type")
		if err != nil {
			return media{}, err
		}
		if toolrt.Equal(kind, "video") {
			video = stream
			break
		}
	}
	if video == nil {
		return media{}, toolrt.New(toolrt.ValueError, textNoVideoStream)
	}
	rate, err := frameRate(video)
	if err != nil {
		return media{}, err
	}
	durationValue, err := toolrt.DictGet(video, "duration", nil)
	if err != nil {
		return media{}, err
	}
	if !toolrt.Truthy(durationValue) {
		format, err := toolrt.Item(info, "format")
		if err != nil {
			return media{}, err
		}
		if durationValue, err = toolrt.DictGet(format, "duration", nil); err != nil {
			return media{}, err
		}
		if !toolrt.Truthy(durationValue) {
			durationValue = "0"
		}
	}
	duration, err := toolrt.NewDecimal(durationValue)
	if err != nil {
		return media{}, err
	}
	var result media
	counted, err := toolrt.DictGet(video, "nb_frames", "")
	if err != nil {
		return media{}, err
	}
	if isDigit(toolrt.Str(counted)) {
		raw, err := toolrt.Item(video, "nb_frames")
		if err != nil {
			return media{}, err
		}
		if result.frames, err = toInt(raw); err != nil {
			return media{}, err
		}
	} else if result.frames, err = roundedProduct(duration, rate); err != nil {
		return media{}, err
	}
	for _, field := range []struct {
		key    string
		target *toolrt.Int
	}{{"width", &result.width}, {"height", &result.height}} {
		raw, err := toolrt.Item(video, field.key)
		if err != nil {
			return media{}, err
		}
		if *field.target, err = toInt(raw); err != nil {
			return media{}, err
		}
	}
	if result.rFrameRate, err = toolrt.Item(video, "r_frame_rate"); err != nil {
		return media{}, err
	}
	if result.fps, err = decimalFloat(rate); err != nil {
		return media{}, err
	}
	if result.duration, err = decimalFloat(duration); err != nil {
		return media{}, err
	}
	result.codec, _ = toolrt.DictGet(video, "codec_name", nil)
	result.pixFmt, _ = toolrt.DictGet(video, "pix_fmt", nil)
	for _, stream := range streams {
		kind, err := toolrt.Item(stream, "codec_type")
		if err != nil {
			return media{}, err
		}
		if toolrt.Equal(kind, "audio") {
			result.audio++
		}
	}
	format, err := toolrt.Item(info, "format")
	if err != nil {
		return media{}, err
	}
	size, err := toolrt.DictGet(format, "size", toolrt.NewInt(0))
	if err != nil {
		return media{}, err
	}
	if result.bytes, err = toInt(size); err != nil {
		return media{}, err
	}
	return result, nil
}

// frameRate — r_frame_rate «числитель/знаменатель» как частное toolrt.Decimal: 0/0 —
// InvalidOperation, N/0 — DivisionByZero, строка без «/» — IndexError (все — необработанная ошибка).
func frameRate(video any) (toolrt.Decimal, error) {
	raw, err := toolrt.Item(video, "r_frame_rate")
	if err != nil {
		return toolrt.Decimal{}, err
	}
	text, ok := raw.(string)
	if !ok {
		return toolrt.Decimal{}, toolrt.Raise(toolrt.AttributeError, "ожидается строка, получено: %s", toolrt.TypeName(raw))
	}
	parts := strings.Split(text, "/")
	numerator, err := toolrt.NewDecimal(parts[0])
	if err != nil {
		return toolrt.Decimal{}, err
	}
	if len(parts) < 2 {
		return toolrt.Decimal{}, toolrt.New(toolrt.IndexError, "индекс за пределами списка")
	}
	denominator, err := toolrt.NewDecimal(parts[1])
	if err != nil {
		return toolrt.Decimal{}, err
	}
	return numerator.Div(denominator)
}

// isDigit — запись nb_frames — непустая строка из десятичных цифр Unicode (unicode.IsDigit).
// Надстрочные и прочие особые цифры ffprobe не выводит, поэтому их не различаем.
func isDigit(text string) bool {
	if text == "" {
		return false
	}
	for _, r := range text {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// toInt — целое из числа или строки JSON ffprobe: целое как есть, bool — 0/1, float —
// отбрасывание дробной части, строка — десятичная запись с необязательными пробелами и знаком.
func toInt(value any) (toolrt.Int, error) {
	switch item := value.(type) {
	case toolrt.Int:
		return item, nil
	case bool:
		if item {
			return toolrt.NewInt(1), nil
		}
		return toolrt.NewInt(0), nil
	case float64:
		truncated, err := toolrt.FloatToInt(item, false)
		if err != nil {
			return toolrt.Int{}, err
		}
		return toolrt.NewInt(truncated), nil
	case string:
		if parsed, ok := parseIntText(item); ok {
			return parsed, nil
		}
		return toolrt.Int{}, toolrt.Raise(toolrt.ValueError, "не целое число: %s", toolrt.Repr(item))
	}
	return toolrt.Int{}, toolrt.Raise(toolrt.TypeError, "ожидается число или строка, получено: %s", toolrt.TypeName(value))
}

// parseIntText — целое из строки: пробелы по краям, необязательный знак, десятичные цифры Unicode с
// одиночными подчёркиваниями между ними.
func parseIntText(text string) (toolrt.Int, bool) {
	text = toolrt.Strip(text)
	var builder strings.Builder
	if strings.HasPrefix(text, "-") || strings.HasPrefix(text, "+") {
		if text[0] == '-' {
			builder.WriteByte('-')
		}
		text = text[1:]
	}
	previous := '_'
	for _, r := range text {
		switch {
		case r == '_' && previous != '_':
		case unicode.IsDigit(r):
			builder.WriteByte(byte('0' + toolrt.DigitValue(r)))
		default:
			return toolrt.Int{}, false
		}
		previous = r
	}
	if text == "" || previous == '_' {
		return toolrt.Int{}, false
	}
	return toolrt.ParseInt(builder.String())
}

// decimalFloat — ближайшее float64 к значению toolrt.Decimal; бесконечности и NaN переносятся,
// сигнальный NaN — ValueError.
func decimalFloat(value toolrt.Decimal) (float64, error) {
	text := value.FormatF()
	switch strings.TrimPrefix(text, "-") {
	case "Infinity":
		if strings.HasPrefix(text, "-") {
			return math.Inf(-1), nil
		}
		return math.Inf(1), nil
	}
	if strings.Contains(text, "sNaN") {
		return 0, toolrt.New(toolrt.ValueError, "NaN нельзя преобразовать в число")
	}
	if strings.Contains(text, "NaN") {
		return math.NaN(), nil
	}
	return strconv.ParseFloat(text, 64)
}

// decimalParts — знак, коэффициент и показатель конечного toolrt.Decimal по его записи FormatF.
func decimalParts(value toolrt.Decimal) (bool, *big.Int, int) {
	text := value.FormatF()
	negative := strings.HasPrefix(text, "-")
	text = strings.TrimPrefix(text, "-")
	whole, fraction, _ := strings.Cut(text, ".")
	coef, _ := new(big.Int).SetString(whole+fraction, 10)
	return negative, coef, -len(fraction)
}

// roundHalfEven — coef / 10**drop с округлением половины к чётному.
func roundHalfEven(coef *big.Int, drop int) *big.Int {
	divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(drop)), nil)
	quotient, remainder := new(big.Int).QuoRem(coef, divisor, new(big.Int))
	twice := new(big.Int).Lsh(remainder, 1)
	if cmp := twice.Cmp(divisor); cmp > 0 || (cmp == 0 && quotient.Bit(0) == 1) {
		quotient.Add(quotient, big.NewInt(1))
	}
	return quotient
}

// roundedProduct — оценка числа кадров: произведение duration × rate округляется до 28 значащих
// цифр половиной к чётному, затем до целого тем же правилом. Особые значения дают исключения:
// NaN — ValueError, бесконечность — OverflowError, бесконечность на ноль — InvalidOperation.
func roundedProduct(duration, rate toolrt.Decimal) (toolrt.Int, error) {
	special := func(value toolrt.Decimal) string {
		text := strings.TrimPrefix(value.FormatF(), "-")
		switch {
		case strings.HasPrefix(text, "sNaN"):
			return "snan"
		case strings.HasPrefix(text, "NaN"):
			return "nan"
		case text == "Infinity":
			return "inf"
		}
		return ""
	}
	invalid := toolrt.New(toolrt.InvalidOperation, "недопустимая операция с десятичным числом")
	left, right := special(duration), special(rate)
	switch {
	case left == "snan" || right == "snan":
		return toolrt.Int{}, invalid
	case left == "nan" || right == "nan":
		return toolrt.Int{}, toolrt.New(toolrt.ValueError, "NaN нельзя преобразовать в целое число")
	case left == "inf" || right == "inf":
		other := rate
		if left != "inf" {
			other = duration
		}
		if _, coef, _ := decimalParts(other); special(other) == "" && coef.Sign() == 0 {
			return toolrt.Int{}, invalid
		}
		return toolrt.Int{}, toolrt.New(toolrt.OverflowError, "бесконечность нельзя преобразовать в целое число")
	}
	negativeA, coefA, expA := decimalParts(duration)
	negativeB, coefB, expB := decimalParts(rate)
	coef := new(big.Int).Mul(coefA, coefB)
	exp := expA + expB
	if count := len(coef.String()); coef.Sign() != 0 && count > 28 {
		coef = roundHalfEven(coef, count-28)
		exp += count - 28
	}
	if exp >= 0 {
		coef.Mul(coef, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(exp)), nil))
	} else {
		coef = roundHalfEven(coef, -exp)
	}
	if negativeA != negativeB {
		coef.Neg(coef)
	}
	return toolrt.IntFromBig(coef), nil
}

// extract — один проход FFmpeg с фильтром select по
// номерам кадров, PNG frame-NNN.png по порядку. Номер сопоставляется с файлом по порядку:
// если кадров оказалось меньше, чем обещал ffprobe, у последних номеров файла нет, и обращение к
// ним даёт KeyError (скрытый текст).
func extract(ctx context.Context, video string, indices []int64, directory string, scale bool) (map[int64]string, error) {
	unique := uniqueSorted(indices)
	selection := make([]string, len(unique))
	for position, index := range unique {
		selection[position] = fmt.Sprintf("eq(n\\,%d)", index)
	}
	filters := []string{"select=" + strings.Join(selection, "+")}
	if scale {
		filters = append(filters, fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", cellWidth, cellHeight))
	}
	if _, err := runMedia(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-y", "-i", video, "-vf", strings.Join(filters, ","),
		"-fps_mode", "vfr", "-f", "image2", filepath.Join(directory, "frame-%03d.png")); err != nil {
		return nil, err
	}
	files, _ := filepath.Glob(filepath.Join(directory, "frame-*.png"))
	sort.Strings(files)
	result := map[int64]string{}
	for position := 0; position < len(unique) && position < len(files); position++ {
		result[unique[position]] = files[position]
	}
	return result, nil
}

// frame — файл кадра index или KeyError(index).
func frame(frames map[int64]string, index int64) (string, error) {
	path, ok := frames[index]
	if !ok {
		return "", toolrt.NewKeyError(toolrt.NewInt(index))
	}
	return path, nil
}

// uniqueSorted — номера кадров без повторов по возрастанию.
func uniqueSorted(indices []int64) []int64 {
	seen := map[int64]bool{}
	result := []int64{}
	for _, index := range indices {
		if !seen[index] {
			seen[index] = true
			result = append(result, index)
		}
	}
	sort.Slice(result, func(a, b int) bool { return result[a] < result[b] })
	return result
}

// preview — превью на скорости 2×: 960 px по ширине, без звука, H.264 CRF 28.
func preview(ctx context.Context, video, target string) error {
	_, err := runMedia(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-y", "-i", video, "-vf", "setpts=PTS/2,scale=960:-2",
		"-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", target)
	return err
}
