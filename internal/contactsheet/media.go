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

	"songframe-go/internal/mediacmd"
	"songframe-go/internal/pycompat"
)

// stderrTail — сколько последних символов stderr FFmpeg/ffprobe попадает в текст ошибки ([-600:]).
const stderrTail = 600

// runMedia — run(argv) оригинала: stdout программы; ненулевой код — ValueError «Ошибка обработки медиа: »
// с хвостом stderr. Незапустившаяся программа — FileNotFoundError (скрытый текст), отмена — ошибка
// контекста.
func runMedia(ctx context.Context, program string, args ...string) ([]byte, error) {
	result, err := mediacmd.Run(ctx, program, args...)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, pycompat.New(pycompat.ValueError, textMediaFailed+mediacmd.Tail(result.Stderr, stderrTail))
	}
	return result.Stdout, nil
}

// media — параметры потока probe(path); поля в порядке словаря оригинала. Значения из JSON
// ffprobe (codec, pixFmt, rFrameRate) хранятся как есть: отчёт печатает их без преобразования.
type media struct {
	width, height pycompat.Int
	rFrameRate    any
	fps, duration float64
	frames        pycompat.Int
	codec, pixFmt any
	audio         int
	bytes         pycompat.Int
}

// dict — словарь media отчёта.
func (m media) dict() *pycompat.Dict {
	result := pycompat.NewDict()
	result.Set("width", m.width)
	result.Set("height", m.height)
	result.Set("r_frame_rate", m.rFrameRate)
	result.Set("fps", m.fps)
	result.Set("duration", m.duration)
	result.Set("nb_frames", m.frames)
	result.Set("codec", m.codec)
	result.Set("pix_fmt", m.pixFmt)
	result.Set("audio_streams", pycompat.NewInt(int64(m.audio)))
	result.Set("bytes", m.bytes)
	return result
}

// probe — probe(path): первый видеопоток ffprobe, частота Decimal(числитель)/Decimal(знаменатель)
// (28 знаков), длительность потока или формата, число кадров из nb_frames либо округлённое
// произведение длительности на частоту. Порядок обращений к полям повторяет оригинал, поэтому
// неполный JSON даёт то же исключение (KeyError — скрытый текст, прочее — трассировка).
func probe(ctx context.Context, path string) (media, error) {
	output, err := runMedia(ctx, mediacmd.FFprobe(), "-v", "error", "-show_streams", "-show_format", "-of", "json", path)
	if err != nil {
		return media{}, err
	}
	text, err := pycompat.DecodeUTF8(output)
	if err != nil {
		return media{}, err
	}
	info, err := pycompat.LoadsJSON(text)
	if err != nil {
		return media{}, err
	}
	listed, err := pycompat.Item(info, "streams")
	if err != nil {
		return media{}, err
	}
	streams, err := pycompat.Iter(listed)
	if err != nil {
		return media{}, err
	}
	var video any
	for _, stream := range streams {
		kind, err := pycompat.Item(stream, "codec_type")
		if err != nil {
			return media{}, err
		}
		if pycompat.Equal(kind, "video") {
			video = stream
			break
		}
	}
	if video == nil {
		return media{}, pycompat.New(pycompat.ValueError, textNoVideoStream)
	}
	rate, err := frameRate(video)
	if err != nil {
		return media{}, err
	}
	durationValue, err := pycompat.DictGet(video, "duration", nil)
	if err != nil {
		return media{}, err
	}
	if !pycompat.Truthy(durationValue) {
		format, err := pycompat.Item(info, "format")
		if err != nil {
			return media{}, err
		}
		if durationValue, err = pycompat.DictGet(format, "duration", nil); err != nil {
			return media{}, err
		}
		if !pycompat.Truthy(durationValue) {
			durationValue = "0"
		}
	}
	duration, err := pycompat.NewDecimal(durationValue)
	if err != nil {
		return media{}, err
	}
	var result media
	counted, err := pycompat.DictGet(video, "nb_frames", "")
	if err != nil {
		return media{}, err
	}
	if isDigit(pycompat.Str(counted)) {
		raw, err := pycompat.Item(video, "nb_frames")
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
		target *pycompat.Int
	}{{"width", &result.width}, {"height", &result.height}} {
		raw, err := pycompat.Item(video, field.key)
		if err != nil {
			return media{}, err
		}
		if *field.target, err = toInt(raw); err != nil {
			return media{}, err
		}
	}
	if result.rFrameRate, err = pycompat.Item(video, "r_frame_rate"); err != nil {
		return media{}, err
	}
	if result.fps, err = decimalFloat(rate); err != nil {
		return media{}, err
	}
	if result.duration, err = decimalFloat(duration); err != nil {
		return media{}, err
	}
	result.codec, _ = pycompat.DictGet(video, "codec_name", nil)
	result.pixFmt, _ = pycompat.DictGet(video, "pix_fmt", nil)
	for _, stream := range streams {
		kind, err := pycompat.Item(stream, "codec_type")
		if err != nil {
			return media{}, err
		}
		if pycompat.Equal(kind, "audio") {
			result.audio++
		}
	}
	format, err := pycompat.Item(info, "format")
	if err != nil {
		return media{}, err
	}
	size, err := pycompat.DictGet(format, "size", pycompat.NewInt(0))
	if err != nil {
		return media{}, err
	}
	if result.bytes, err = toInt(size); err != nil {
		return media{}, err
	}
	return result, nil
}

// frameRate — Decimal(r.split("/")[0]) / Decimal(r.split("/")[1]): 0/0 — decimal.InvalidOperation,
// N/0 — DivisionByZero, строка без «/» — IndexError (все — трассировка, как в оригинале).
func frameRate(video any) (pycompat.Decimal, error) {
	raw, err := pycompat.Item(video, "r_frame_rate")
	if err != nil {
		return pycompat.Decimal{}, err
	}
	text, ok := raw.(string)
	if !ok {
		return pycompat.Decimal{}, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'split'", pycompat.TypeName(raw))
	}
	parts := strings.Split(text, "/")
	numerator, err := pycompat.NewDecimal(parts[0])
	if err != nil {
		return pycompat.Decimal{}, err
	}
	if len(parts) < 2 {
		return pycompat.Decimal{}, pycompat.New(pycompat.IndexError, "list index out of range")
	}
	denominator, err := pycompat.NewDecimal(parts[1])
	if err != nil {
		return pycompat.Decimal{}, err
	}
	return numerator.Div(denominator)
}

// isDigit — str.isdigit() для записи nb_frames: непустая строка из десятичных цифр Unicode.
// Надстрочные цифры (тоже isdigit у Python) ffprobe не выводит.
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

// toInt — int(value) для чисел и строк из JSON ffprobe: int как есть, bool — 0/1, float —
// отбрасывание дробной части, строка — десятичная запись с необязательными пробелами и знаком.
func toInt(value any) (pycompat.Int, error) {
	switch item := value.(type) {
	case pycompat.Int:
		return item, nil
	case bool:
		if item {
			return pycompat.NewInt(1), nil
		}
		return pycompat.NewInt(0), nil
	case float64:
		truncated, err := pycompat.FloatToInt(item, false)
		if err != nil {
			return pycompat.Int{}, err
		}
		return pycompat.NewInt(truncated), nil
	case string:
		if parsed, ok := parseIntText(item); ok {
			return parsed, nil
		}
		return pycompat.Int{}, pycompat.Raise(pycompat.ValueError, "invalid literal for int() with base 10: %s", pycompat.Repr(item))
	}
	return pycompat.Int{}, pycompat.Raise(pycompat.TypeError,
		"int() argument must be a string, a bytes-like object or a real number, not '%s'", pycompat.TypeName(value))
}

// parseIntText — int(str): пробелы по краям, необязательный знак, десятичные цифры Unicode с
// одиночными подчёркиваниями между ними.
func parseIntText(text string) (pycompat.Int, bool) {
	text = pycompat.Strip(text)
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
			builder.WriteByte(byte('0' + pycompat.DigitValue(r)))
		default:
			return pycompat.Int{}, false
		}
		previous = r
	}
	if text == "" || previous == '_' {
		return pycompat.Int{}, false
	}
	return pycompat.ParseInt(builder.String())
}

// decimalFloat — float(Decimal): ближайшее двоичное значение десятичной записи.
func decimalFloat(value pycompat.Decimal) (float64, error) {
	text := value.FormatF()
	switch strings.TrimPrefix(text, "-") {
	case "Infinity":
		if strings.HasPrefix(text, "-") {
			return math.Inf(-1), nil
		}
		return math.Inf(1), nil
	}
	if strings.Contains(text, "sNaN") {
		return 0, pycompat.New(pycompat.ValueError, "cannot convert signaling NaN to float")
	}
	if strings.Contains(text, "NaN") {
		return math.NaN(), nil
	}
	return strconv.ParseFloat(text, 64)
}

// decimalParts — знак, коэффициент и показатель конечного Decimal по записи format(d, "f").
func decimalParts(value pycompat.Decimal) (bool, *big.Int, int) {
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

// roundedProduct — int((duration * rate).to_integral_value()): произведение в контексте Decimal
// по умолчанию (28 значащих цифр, ROUND_HALF_EVEN), затем округление до целого тем же правилом.
// Особые значения дают исключения Python: NaN — ValueError, бесконечность — OverflowError,
// бесконечность на ноль — InvalidOperation.
func roundedProduct(duration, rate pycompat.Decimal) (pycompat.Int, error) {
	special := func(value pycompat.Decimal) string {
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
	invalid := pycompat.New(pycompat.InvalidOperation, "[<class 'decimal.InvalidOperation'>]")
	left, right := special(duration), special(rate)
	switch {
	case left == "snan" || right == "snan":
		return pycompat.Int{}, invalid
	case left == "nan" || right == "nan":
		return pycompat.Int{}, pycompat.New(pycompat.ValueError, "cannot convert NaN to integer")
	case left == "inf" || right == "inf":
		other := rate
		if left != "inf" {
			other = duration
		}
		if _, coef, _ := decimalParts(other); special(other) == "" && coef.Sign() == 0 {
			return pycompat.Int{}, invalid
		}
		return pycompat.Int{}, pycompat.New(pycompat.OverflowError, "cannot convert Infinity to integer")
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
	return pycompat.IntFromBig(coef), nil
}

// extract — extract(video, indices, directory, scale): один проход FFmpeg с фильтром select по
// номерам кадров, PNG frame-NNN.png по порядку. Номер сопоставляется с файлом по порядку (zip):
// если кадров оказалось меньше, чем обещал ffprobe, у последних номеров файла нет, и обращение к
// ним даёт KeyError (скрытый текст), как в оригинале.
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
		return "", pycompat.NewKeyError(pycompat.NewInt(index))
	}
	return path, nil
}

// uniqueSorted — sorted(set(indices)).
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

// preview — превью на скорости 2×: 960 px по ширине, без звука, H.264 CRF 28, как в оригинале.
func preview(ctx context.Context, video, target string) error {
	_, err := runMedia(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-y", "-i", video, "-vf", "setpts=PTS/2,scale=960:-2",
		"-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", target)
	return err
}
