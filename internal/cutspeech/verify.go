package cutspeech

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"math/big"
	"path/filepath"
	"runtime"

	"songframe-go/internal/mediacmd"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// pathType — имя класса Path в текстах TypeError pathlib.
var pathType = func() string {
	if runtime.GOOS == "windows" {
		return "WindowsPath"
	}
	return "PosixPath"
}()

// Классы исключений модулей wave и struct: необработанные, печатаются трассировкой.
const (
	waveError   = "wave.Error"
	structError = "struct.error"
)

// verify — повтор среза по рецепту в памяти и сверка SHA-256 с записанным; рядом сохранённый WAV
// дополнительно декодируется FFmpeg и сравнивается по PCM (pcm_match; None, если файла нет).
// Значения рецепта берутся как есть: необычные типы и числа дают те же исключения, что у
// оригинала (умножение, срез bytes Python с отрицательными и большими индексами, проверки wave и
// struct). recipePath отсчитывается от рабочего каталога процесса, как Path(recipe) оригинала.
func verify(ctx context.Context, root, recipePath string) (*pycompat.Dict, error) {
	text, err := pycompat.ReadText(recipePath)
	if err != nil {
		return nil, err
	}
	recipe, err := pycompat.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	sourceValue, err := pycompat.Item(recipe, "source")
	if err != nil {
		return nil, err
	}
	path, err := pycompat.Item(sourceValue, "path")
	if err != nil {
		return nil, err
	}
	source, err := pathDiv(root, path)
	if err != nil {
		return nil, err
	}
	pcm, err := decode(ctx, source)
	if err != nil {
		return nil, err
	}
	values := map[string]any{}
	for _, key := range []string{"channels", "sample_width_bytes"} {
		if values[key], err = pycompat.Item(recipe, key); err != nil {
			return nil, err
		}
	}
	frame, err := multiply(values["channels"], values["sample_width_bytes"])
	if err != nil {
		return nil, err
	}
	bounds := [2]any{}
	for position, key := range []string{"start_sample", "end_sample_exclusive"} {
		value, err := pycompat.Item(recipe, key)
		if err != nil {
			return nil, err
		}
		if bounds[position], err = multiply(value, frame); err != nil {
			return nil, err
		}
	}
	chunk, err := slice(pcm, bounds[0], bounds[1])
	if err != nil {
		return nil, err
	}
	rate, rateErr := pycompat.Item(recipe, "sample_rate")
	data, err := waveBytes(values["channels"], values["sample_width_bytes"], rate, rateErr, chunk)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	output, err := pycompat.Item(recipe, "output")
	if err != nil {
		return nil, err
	}
	expected, err := pycompat.Item(output, "sha256")
	if err != nil {
		return nil, err
	}
	output, err = pycompat.Item(recipe, "output")
	if err != nil {
		return nil, err
	}
	name, err := pycompat.Item(output, "path")
	if err != nil {
		return nil, err
	}
	stored, err := pathDiv(filepath.Dir(pycompat.JoinPath(recipePath)), name)
	if err != nil {
		return nil, err
	}
	var pcmMatch any
	if pycompat.IsFile(stored) {
		result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-i", stored, "-f", "s16le", "-acodec", "pcm_s16le",
			"-ac", pycompat.Str(values["channels"]), "-ar", pycompat.Str(rate), "pipe:1")
		if err != nil {
			return nil, err
		}
		pcmMatch = result.Code == 0 && bytes.Equal(result.Stdout, chunk)
	}
	return pytool.Record(
		"recipe", recipePath,
		"expected", expected,
		"actual", digest,
		"match", pycompat.Equal(digest, expected),
		"pcm_match", pcmMatch,
	), nil
}

// repeated — результат повторения последовательности (str или list на целое): содержимое для
// дальнейшего хода не нужно, важен только тип в текстах следующих TypeError.
type repeated struct{ kind string }

// typeName — type(value).__name__ с учётом repeated.
func typeName(value any) string {
	if item, ok := value.(repeated); ok {
		return item.kind
	}
	return pycompat.TypeName(value)
}

// sequenceKind — имя типа последовательности Python, если value — str, list или повтор.
func sequenceKind(value any) (string, bool) {
	switch item := value.(type) {
	case string:
		return "str", true
	case []any:
		return "list", true
	case repeated:
		return item.kind, true
	}
	return "", false
}

// multiply — left * right Python для значений рецепта: целые точно (bool — 0/1), с float —
// числом float; последовательность на целое — повтор, на нецелое — «can't multiply sequence»;
// прочее — «unsupported operand type(s) for *». Содержимое повтора не строится: далее оно
// годится только для TypeError среза.
func multiply(left, right any) (any, error) {
	a, leftInt := index(left)
	b, rightInt := index(right)
	if leftInt && rightInt {
		return pycompat.IntFromBig(new(big.Int).Mul(a, b)), nil
	}
	if x, ok := floatOperand(left); ok {
		if y, ok := floatOperand(right); ok {
			fx, err := x()
			if err != nil {
				return nil, err
			}
			fy, err := y()
			if err != nil {
				return nil, err
			}
			return fx * fy, nil
		}
	}
	if kind, ok := sequenceKind(left); ok {
		if rightInt {
			return repeated{kind}, nil
		}
		return nil, pycompat.Raise(pycompat.TypeError, "can't multiply sequence by non-int of type '%s'", typeName(right))
	}
	if kind, ok := sequenceKind(right); ok {
		if leftInt {
			return repeated{kind}, nil
		}
		return nil, pycompat.Raise(pycompat.TypeError, "can't multiply sequence by non-int of type '%s'", typeName(left))
	}
	return nil, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for *: '%s' and '%s'", typeName(left), typeName(right))
}

// floatOperand — число для арифметики с float: целое переводится в float (OverflowError для
// слишком большого), float — как есть.
func floatOperand(value any) (func() (float64, error), bool) {
	if number, ok := value.(float64); ok {
		return func() (float64, error) { return number, nil }, true
	}
	if integer, ok := index(value); ok {
		return func() (float64, error) { return pycompat.IntFromBig(integer).Float() }, true
	}
	return nil, false
}

// slice — data[start:stop] Python: отрицательные индексы отсчитываются от конца, выход за
// границы обрезается, пустой результат при stop <= start. Нецелые индексы — TypeError.
func slice(data []byte, start, stop any) ([]byte, error) {
	a, okA := index(start)
	b, okB := index(stop)
	if !okA || !okB {
		return nil, pycompat.New(pycompat.TypeError, "slice indices must be integers or None or have an __index__ method")
	}
	length := big.NewInt(int64(len(data)))
	clamp := func(value *big.Int) int {
		value = new(big.Int).Set(value)
		if value.Sign() < 0 {
			value.Add(value, length)
			if value.Sign() < 0 {
				return 0
			}
		}
		if value.Cmp(length) > 0 {
			return len(data)
		}
		return int(value.Int64())
	}
	from, to := clamp(a), clamp(b)
	if to <= from {
		return []byte{}, nil
	}
	return data[from:to], nil
}

// waveBytes — байты, которые модуль wave Python 3.12 пишет для setnchannels/setsampwidth/
// setframerate и writeframes(data): 44-байтный заголовок PCM и данные. Каналы и ширина здесь уже
// целые (иначе раньше упал бы срез). Ошибка установки параметра внутри `with wave.open(…)`
// заменяется исключением close(): у первого незаданного параметра — «… not specified»; поля
// заголовка вне диапазона struct — struct.error. rateErr — исключение чтения sample_rate внутри
// with (тоже замещается ошибкой close).
func waveBytes(channelsValue, widthValue, rate any, rateErr error, data []byte) ([]byte, error) {
	count, _ := index(channelsValue)
	width, _ := index(widthValue)
	if count.Sign() < 1 {
		return nil, pycompat.New(waveError, "# channels not specified")
	}
	if width.Sign() < 1 || width.Cmp(big.NewInt(4)) > 0 {
		return nil, pycompat.New(waveError, "sample width not specified")
	}
	unspecifiedRate := pycompat.New(waveError, "sampling rate not specified")
	if rateErr != nil {
		return nil, unspecifiedRate
	}
	notPositive, err := pycompat.LessEqual(rate, pycompat.NewInt(0))
	if err != nil || notPositive {
		return nil, unspecifiedRate
	}
	framerate, ok := roundRate(rate)
	if !ok || framerate.Sign() == 0 {
		return nil, unspecifiedRate
	}
	frameSize := new(big.Int).Mul(count, width)
	frames := new(big.Int).Quo(big.NewInt(int64(len(data))), frameSize)
	initial := new(big.Int).Mul(frames, frameSize)
	byteRate := new(big.Int).Mul(new(big.Int).Mul(count, framerate), width)
	bits := new(big.Int).Mul(width, big.NewInt(8))
	// Порядок полей '<L4s4sLHHLLHH4s': первая ошибка диапазона — та, что видит Python.
	fields := []struct {
		value *big.Int
		wide  bool
	}{
		{new(big.Int).Add(initial, big.NewInt(36)), true}, {count, false}, {framerate, true}, {byteRate, true}, {frameSize, false}, {bits, false},
	}
	for _, field := range fields {
		limit, format := big.NewInt(math.MaxUint16), "'H' format requires 0 <= number <= 65535"
		if field.wide {
			limit, format = big.NewInt(math.MaxUint32), "'L' format requires 0 <= number <= 4294967295"
		}
		if field.value.Cmp(limit) > 0 {
			return nil, pycompat.New(structError, format)
		}
	}
	// writeframes исправляет размеры заголовка по фактически записанным байтам.
	header := make([]byte, 0, 44+len(data))
	header = append(header, "RIFF"...)
	header = binary.LittleEndian.AppendUint32(header, uint32(36+len(data)))
	header = append(header, "WAVEfmt "...)
	header = binary.LittleEndian.AppendUint32(header, 16)
	header = binary.LittleEndian.AppendUint16(header, 1)
	header = binary.LittleEndian.AppendUint16(header, uint16(count.Uint64()))
	header = binary.LittleEndian.AppendUint32(header, uint32(framerate.Uint64()))
	header = binary.LittleEndian.AppendUint32(header, uint32(byteRate.Uint64()))
	header = binary.LittleEndian.AppendUint16(header, uint16(frameSize.Uint64()))
	header = binary.LittleEndian.AppendUint16(header, uint16(bits.Uint64()))
	header = append(header, "data"...)
	header = binary.LittleEndian.AppendUint32(header, uint32(len(data)))
	return append(header, data...), nil
}

// roundRate — int(round(framerate)) setframerate: целое как есть, float — к ближайшему чётному;
// NaN и бесконечность — исключение (false).
func roundRate(rate any) (*big.Int, bool) {
	if integer, ok := index(rate); ok {
		return integer, true
	}
	number, ok := rate.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return nil, false
	}
	result, _ := new(big.Float).SetFloat64(math.RoundToEven(number)).Int(nil)
	return result, true
}
