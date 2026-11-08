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

	"songframe/internal/mediacmd"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// pathType — имя класса пути ОС в текстах TypeError соединения путей.
var pathType = func() string {
	if runtime.GOOS == "windows" {
		return "WindowsPath"
	}
	return "PosixPath"
}()

// Виды исключений записи WAV и упаковки заголовка: необработанные, печатаются трассировкой.
const (
	waveError   = "wave.Error"
	structError = "struct.error"
)

// verify — повтор среза по рецепту в памяти и сверка SHA-256 с записанным; рядом сохранённый WAV
// дополнительно декодируется FFmpeg и сравнивается по PCM (pcm_match; null, если файла нет).
// Значения рецепта берутся как есть: необычные типы и числа дают исключения toolrt, зафиксированные
// эталоном (умножение, срез байтов с отрицательными и большими индексами, проверки параметров WAV
// и полей заголовка). recipePath отсчитывается от рабочего каталога процесса.
func verify(ctx context.Context, root, recipePath string) (*toolrt.Dict, error) {
	text, err := toolrt.ReadText(recipePath)
	if err != nil {
		return nil, err
	}
	recipe, err := toolrt.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	sourceValue, err := toolrt.Item(recipe, "source")
	if err != nil {
		return nil, err
	}
	path, err := toolrt.Item(sourceValue, "path")
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
		if values[key], err = toolrt.Item(recipe, key); err != nil {
			return nil, err
		}
	}
	frame, err := multiply(values["channels"], values["sample_width_bytes"])
	if err != nil {
		return nil, err
	}
	bounds := [2]any{}
	for position, key := range []string{"start_sample", "end_sample_exclusive"} {
		value, err := toolrt.Item(recipe, key)
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
	rate, rateErr := toolrt.Item(recipe, "sample_rate")
	data, err := waveBytes(values["channels"], values["sample_width_bytes"], rate, rateErr, chunk)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	output, err := toolrt.Item(recipe, "output")
	if err != nil {
		return nil, err
	}
	expected, err := toolrt.Item(output, "sha256")
	if err != nil {
		return nil, err
	}
	output, err = toolrt.Item(recipe, "output")
	if err != nil {
		return nil, err
	}
	name, err := toolrt.Item(output, "path")
	if err != nil {
		return nil, err
	}
	stored, err := pathDiv(filepath.Dir(toolrt.JoinPath(recipePath)), name)
	if err != nil {
		return nil, err
	}
	var pcmMatch any
	if toolrt.IsFile(stored) {
		result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-i", stored, "-f", "s16le", "-acodec", "pcm_s16le",
			"-ac", toolrt.Str(values["channels"]), "-ar", toolrt.Str(rate), "pipe:1")
		if err != nil {
			return nil, err
		}
		pcmMatch = result.Code == 0 && bytes.Equal(result.Stdout, chunk)
	}
	return toolcli.Record(
		"recipe", recipePath,
		"expected", expected,
		"actual", digest,
		"match", toolrt.Equal(digest, expected),
		"pcm_match", pcmMatch,
	), nil
}

// repeated — результат повторения последовательности (str или list на целое): содержимое для
// дальнейшего хода не нужно, важен только тип в текстах следующих TypeError.
type repeated struct{ kind string }

// typeName — имя типа значения в текстах исключений (toolrt.TypeName) с учётом repeated.
func typeName(value any) string {
	if item, ok := value.(repeated); ok {
		return item.kind
	}
	return toolrt.TypeName(value)
}

// sequenceKind — имя типа последовательности (str или list), если value — строка, список или повтор.
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

// multiply — произведение значений рецепта: целые точно (bool — 0/1), с float —
// числом float; последовательность на целое — повтор, на нецелое — «can't multiply sequence»;
// прочее — «unsupported operand type(s) for *». Содержимое повтора не строится: далее оно
// годится только для TypeError среза.
func multiply(left, right any) (any, error) {
	a, leftInt := index(left)
	b, rightInt := index(right)
	if leftInt && rightInt {
		return toolrt.IntFromBig(new(big.Int).Mul(a, b)), nil
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
		return nil, toolrt.Raise(toolrt.TypeError, "can't multiply sequence by non-int of type '%s'", typeName(right))
	}
	if kind, ok := sequenceKind(right); ok {
		if leftInt {
			return repeated{kind}, nil
		}
		return nil, toolrt.Raise(toolrt.TypeError, "can't multiply sequence by non-int of type '%s'", typeName(left))
	}
	return nil, toolrt.Raise(toolrt.TypeError, "unsupported operand type(s) for *: '%s' and '%s'", typeName(left), typeName(right))
}

// floatOperand — число для арифметики с float: целое переводится в float (OverflowError для
// слишком большого), float — как есть.
func floatOperand(value any) (func() (float64, error), bool) {
	if number, ok := value.(float64); ok {
		return func() (float64, error) { return number, nil }, true
	}
	if integer, ok := index(value); ok {
		return func() (float64, error) { return toolrt.IntFromBig(integer).Float() }, true
	}
	return nil, false
}

// slice — байты data с start по stop: отрицательные индексы отсчитываются от конца, выход за
// границы обрезается, пустой результат при stop <= start. Нецелые индексы — TypeError.
func slice(data []byte, start, stop any) ([]byte, error) {
	a, okA := index(start)
	b, okB := index(stop)
	if !okA || !okB {
		return nil, toolrt.New(toolrt.TypeError, "slice indices must be integers or None or have an __index__ method")
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

// waveBytes — файл WAV: 44-байтный заголовок PCM (каналы, ширина сэмпла, частота) и данные;
// байты зафиксированы эталоном testdata/golden/cut-speech. Каналы и ширина здесь уже целые
// (иначе раньше упал бы срез). Неверный параметр сообщается при завершении записи: у первого
// незаданного параметра — «… not specified» (waveError); поле заголовка вне диапазона 16 или 32
// бит — structError. rateErr — ошибка чтения sample_rate: она тоже заменяется отказом
// «sampling rate not specified».
func waveBytes(channelsValue, widthValue, rate any, rateErr error, data []byte) ([]byte, error) {
	count, _ := index(channelsValue)
	width, _ := index(widthValue)
	if count.Sign() < 1 {
		return nil, toolrt.New(waveError, "# channels not specified")
	}
	if width.Sign() < 1 || width.Cmp(big.NewInt(4)) > 0 {
		return nil, toolrt.New(waveError, "sample width not specified")
	}
	unspecifiedRate := toolrt.New(waveError, "sampling rate not specified")
	if rateErr != nil {
		return nil, unspecifiedRate
	}
	notPositive, err := toolrt.LessEqual(rate, toolrt.NewInt(0))
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
	// Поля проверяются в порядке заголовка: сообщается первая ошибка диапазона.
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
			return nil, toolrt.New(structError, format)
		}
	}
	// Размеры в заголовке — по фактически записанным байтам данных.
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

// roundRate — целая частота для заголовка: целое как есть, float — к ближайшему, половина к чётному;
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
