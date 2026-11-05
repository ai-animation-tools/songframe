package cutspeech

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"math"
	"math/big"
	"os"
	"strconv"

	"songframe-go/internal/mediacmd"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// speech — результат speech_lines оригинала: путь песни из реестра (значение JSON как есть),
// окно плана в секундах, строки разметки в окне (словари timing.json с добавленным ключом
// «text») и признак lipsync плана.
type speech struct {
	source  any
	window  [2]float64
	lines   []*pycompat.Dict
	lipsync bool
}

// speechLines — строки разметки, пересекающие окно плана. Реестр читается и проверяется
// sceneregistry.Load; текст строки берётся из source/text.md по source_line (целое, включая bool,
// как isinstance(…, int) Python) и очищается от пробелов по краям, иначе — None. Ошибки — те же
// исключения, что у оригинала: битые данные дают KeyError/TypeError/AttributeError Python.
func speechLines(root, shot string) (speech, error) {
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return speech{}, err
	}
	scenesValue, err := pycompat.Item(registry, "scenes")
	if err != nil {
		return speech{}, err
	}
	scenes, err := pycompat.Iter(scenesValue)
	if err != nil {
		return speech{}, err
	}
	var scene any
	for _, item := range scenes {
		id, err := pycompat.Item(item, "id")
		if err != nil {
			return speech{}, err
		}
		if pycompat.Equal(id, shot) {
			scene = item
			break
		}
	}
	if scene == nil {
		return speech{}, pycompat.New(pycompat.ValueError, shot+": план отсутствует в реестре сцен.")
	}
	var window [2]float64
	for index, key := range []string{"start_frame", "end_frame_exclusive"} {
		frame, err := pycompat.Item(scene, key)
		if err != nil {
			return speech{}, err
		}
		fps, err := pycompat.Item(registry, "fps")
		if err != nil {
			return speech{}, err
		}
		if window[index], err = pycompat.TrueDiv(frame, fps); err != nil {
			return speech{}, err
		}
	}
	text, err := pycompat.ReadText(pycompat.JoinPath(root, "plan/audio/timing.json"))
	if err != nil {
		return speech{}, err
	}
	timing, err := pycompat.LoadsJSON(text)
	if err != nil {
		return speech{}, err
	}
	linesValue, err := pycompat.DictGet(timing, "lines", []any{})
	if err != nil {
		return speech{}, err
	}
	items, err := pycompat.Iter(linesValue)
	if err != nil {
		return speech{}, err
	}
	lines := []*pycompat.Dict{}
	for _, line := range items {
		end, err := pycompat.Item(line, "end")
		if err != nil {
			return speech{}, err
		}
		after, err := greater(end, window[0])
		if err != nil || !after {
			if err != nil {
				return speech{}, err
			}
			continue
		}
		start, err := pycompat.Item(line, "start")
		if err != nil {
			return speech{}, err
		}
		before, err := pycompat.Less(start, window[1])
		if err != nil {
			return speech{}, err
		}
		if before {
			// Ключ «end» нашёлся по строке, значит line — словарь.
			lines = append(lines, line.(*pycompat.Dict))
		}
	}
	lyrics, err := pycompat.ReadText(pycompat.JoinPath(root, "source/text.md"))
	if err != nil {
		return speech{}, err
	}
	rows := pycompat.SplitLines(lyrics)
	for _, line := range lines {
		var value any
		if number, ok := index(line.Value("source_line")); ok && number.Sign() > 0 && number.Cmp(big.NewInt(int64(len(rows)))) <= 0 {
			value = pycompat.Strip(rows[number.Int64()-1])
		}
		line.Set("text", value)
	}
	audio, err := pycompat.Item(registry, "audio")
	if err != nil {
		return speech{}, err
	}
	source, err := pycompat.Item(audio, "path")
	if err != nil {
		return speech{}, err
	}
	lipsync, _ := pycompat.DictGet(scene, "lipsync", nil)
	return speech{source: source, window: window, lines: lines, lipsync: pycompat.Truthy(lipsync)}, nil
}

// propose — границы по строкам: от начала первой минус lead до конца последней плюс tail, не
// короче minSeconds; round(…, 3) и начало не меньше 0.0, как у оригинала. Значения — числа Python
// (float или int), поэтому min/max/арифметика идут через pycompat с его текстами TypeError.
func propose(lines []*pycompat.Dict, lead, tail, minSeconds any) (any, any, error) {
	if len(lines) == 0 {
		return nil, nil, pycompat.New(pycompat.ValueError, textNoLines)
	}
	first, err := extreme(lines, "start", false)
	if err != nil {
		return nil, nil, err
	}
	start, err := pycompat.Sub(first, lead)
	if err != nil {
		return nil, nil, err
	}
	last, err := extreme(lines, "end", true)
	if err != nil {
		return nil, nil, err
	}
	end, err := pycompat.Add(last, tail)
	if err != nil {
		return nil, nil, err
	}
	length, err := pycompat.Sub(end, start)
	if err != nil {
		return nil, nil, err
	}
	short, err := pycompat.Less(length, minSeconds)
	if err != nil {
		return nil, nil, err
	}
	if short {
		if end, err = pycompat.Add(start, minSeconds); err != nil {
			return nil, nil, err
		}
	}
	rounded := round3(start)
	positive, err := greater(rounded, 0.0)
	if err != nil {
		return nil, nil, err
	}
	if !positive {
		rounded = 0.0
	}
	return rounded, round3(end), nil
}

// extreme — min() или max() значений key по строкам: как встроенные функции Python, текущий
// элемент заменяется следующим, только если тот строго меньше (больше).
func extreme(lines []*pycompat.Dict, key string, maximum bool) (any, error) {
	current, err := pycompat.Item(lines[0], key)
	if err != nil {
		return nil, err
	}
	for _, line := range lines[1:] {
		value, err := pycompat.Item(line, key)
		if err != nil {
			return nil, err
		}
		var better bool
		if maximum {
			better, err = greater(value, current)
		} else {
			better, err = pycompat.Less(value, current)
		}
		if err != nil {
			return nil, err
		}
		if better {
			current = value
		}
	}
	return current, nil
}

// greater — left > right Python: сравнение через Less с тем же текстом TypeError (оператор «>»
// и типы в исходном порядке).
func greater(left, right any) (bool, error) {
	result, err := pycompat.Less(right, left)
	if err != nil {
		return false, pycompat.Raise(pycompat.TypeError, "'>' not supported between instances of '%s' and '%s'", pycompat.TypeName(left), pycompat.TypeName(right))
	}
	return result, nil
}

// round3 — round(value, 3) Python: float округляется по точному двоичному значению с половиной к
// чётному (корректно округлённая запись strconv), целое остаётся целым.
func round3(value any) any {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return value
	}
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(number, 'f', 3, 64), 64)
	return rounded
}

// index — целое значение для isinstance(value, int) Python: int и bool.
func index(value any) (*big.Int, bool) {
	switch item := value.(type) {
	case pycompat.Int:
		return item.Big(), true
	case bool:
		if item {
			return big.NewInt(1), true
		}
		return big.NewInt(0), true
	}
	return nil, false
}

// sampleIndex — int((Decimal(str(seconds)) * 44100).to_integral_value(ROUND_HALF_UP)): точная
// десятичная запись числа, умноженная на частоту, с округлением половины от нуля. Точность
// контекста Decimal (28 знаков) не ограничивает результат: repr float — не больше 17 значащих
// цифр. NaN — ValueError, бесконечность — OverflowError с текстами int(Decimal).
func sampleIndex(seconds any) (*big.Int, error) {
	text := pycompat.Str(seconds)
	switch text {
	case "nan", "-nan":
		return nil, pycompat.New(pycompat.ValueError, "cannot convert NaN to integer")
	case "inf", "-inf":
		return nil, pycompat.New(pycompat.OverflowError, "cannot convert Infinity to integer")
	}
	value, ok := new(big.Rat).SetString(text)
	if !ok {
		return nil, pycompat.Raise(pycompat.TypeError, "conversion from %s to Decimal is not supported", pycompat.TypeName(seconds))
	}
	value.Mul(value, new(big.Rat).SetInt64(sampleRate))
	negative := value.Sign() < 0
	value.Abs(value)
	// floor(|x| + 1/2): половина округляется от нуля.
	value.Add(value, big.NewRat(1, 2))
	result := new(big.Int).Quo(value.Num(), value.Denom())
	if negative {
		result.Neg(result)
	}
	return result, nil
}

// decode — весь трек в PCM s16le 44,1 кГц стерео, как в принятых рецептах. Ненулевой код или
// пустой вывод — ValueError с последними 300 знаками stderr; отсутствие FFmpeg —
// FileNotFoundError, отмена — ошибка context.
func decode(ctx context.Context, source string) ([]byte, error) {
	result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-v", "error", "-nostdin", "-i", source, "-f", "s16le",
		"-acodec", "pcm_s16le", "-ac", strconv.Itoa(channels), "-ar", strconv.Itoa(sampleRate), "pipe:1")
	if err != nil {
		return nil, err
	}
	if result.Code != 0 || len(result.Stdout) == 0 {
		return nil, pycompat.New(pycompat.ValueError, textDecodeFailed+mediacmd.Tail(result.Stderr, 300))
	}
	return result.Stdout, nil
}

// pathDiv — Path(base) / part: нестроковая часть — TypeError Python, как у pathlib.
func pathDiv(base string, part any) (string, error) {
	text, ok := part.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", pathType, pycompat.TypeName(part))
	}
	return pycompat.JoinPath(base, text), nil
}

// fileSHA — SHA-256 файла потоком (sha() tools/common.py) и его размер.
func fileSHA(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, pycompat.OSErrorFrom(err, path)
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, pycompat.OSErrorFrom(err, path)
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

// cut — срез песни source (путь из реестра, от корня проекта) с start по end секунд в
// out/speech.wav и рецепт out/audio-recipe.json; возвращает рецепт. Существующий WAV не
// перезаписывается, рецепт перезаписывается, как в оригинале. Файлы пишутся атомарно через
// projectfs.WriteFile с правами нового файла 0666 (с umask), как open()/write_text Python: сбой
// не оставляет частичного WAV. Порядок проверок и записи — оригинала: песня, границы, декодирование,
// конец песни, папка, отсутствие WAV, WAV, рецепт.
func cut(ctx context.Context, root string, source, start, end any, out, shot string, lines []*pycompat.Dict) (*pycompat.Dict, error) {
	joined, err := pathDiv(root, source)
	if err != nil {
		return nil, err
	}
	sourcePath := pycompat.ResolvePath(joined)
	if !pycompat.IsFile(sourcePath) {
		return nil, pycompat.New(pycompat.ValueError, textSourceMissing+pycompat.Str(source))
	}
	first, err := sampleIndex(start)
	if err != nil {
		return nil, err
	}
	last, err := sampleIndex(end)
	if err != nil {
		return nil, err
	}
	if last.Cmp(first) <= 0 {
		return nil, pycompat.New(pycompat.ValueError, textEmptyInterval)
	}
	// Исправление оригинала: отрицательный индекс Python отсчитывал от конца PCM.
	if first.Sign() < 0 {
		return nil, pycompat.New(pycompat.ValueError, textNegativeStart)
	}
	pcm, err := decode(ctx, sourcePath)
	if err != nil {
		return nil, err
	}
	frameBytes := channels * sampleWidth
	total := int64(len(pcm) / frameBytes)
	if last.Cmp(big.NewInt(total)) > 0 {
		return nil, pycompat.New(pycompat.ValueError, "Срез выходит за конец песни: "+pycompat.FormatFixed(float64(total)/sampleRate, 3)+" с.")
	}
	if err := os.MkdirAll(out, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, out)
	}
	target := pycompat.JoinPath(out, speechName)
	if pycompat.Exists(target) {
		return nil, pycompat.New(pycompat.ValueError, textTargetExists)
	}
	data, err := waveBytes(pycompat.NewInt(channels), pycompat.NewInt(sampleWidth), pycompat.NewInt(sampleRate), nil,
		pcm[first.Int64()*int64(frameBytes):last.Int64()*int64(frameBytes)])
	if err != nil {
		return nil, err
	}
	if err := projectfs.WriteFile(target, data, 0o666); err != nil {
		return nil, pycompat.OSErrorFrom(err, target)
	}
	sourceSHA, sourceSize, err := fileSHA(sourcePath)
	if err != nil {
		return nil, err
	}
	outputSHA := sha256.Sum256(data)
	recipe := pytool.Record(
		"schema_version", pycompat.NewInt(1),
		"source", pytool.Record("path", pycompat.JoinPath(source.(string)), "sha256", sourceSHA, "bytes", pycompat.NewInt(sourceSize)),
		"source_interval_seconds", []any{float64(first.Int64()) / sampleRate, float64(last.Int64()) / sampleRate},
		"interval_end_exclusive", true,
		"sample_rate", pycompat.NewInt(sampleRate),
		"channels", pycompat.NewInt(channels),
		"sample_width_bytes", pycompat.NewInt(sampleWidth),
		"start_sample", pycompat.IntFromBig(first),
		"end_sample_exclusive", pycompat.IntFromBig(last),
		"output", pytool.Record("path", speechName, "sha256", hex.EncodeToString(outputSHA[:]), "bytes", pycompat.NewInt(int64(len(data)))),
		"processing", processing,
	)
	if shot != "" {
		recipe.Set("shot", shot)
	}
	if len(lines) > 0 {
		entries := make([]any, 0, len(lines))
		for _, line := range lines {
			id, err := pycompat.Item(line, "id")
			if err != nil {
				return nil, err
			}
			entries = append(entries, pytool.Record(
				"id", id, "source_line", line.Value("source_line"), "text", line.Value("text"),
				"start", line.Value("start"), "end", line.Value("end"), "note", line.Value("note"),
			))
		}
		recipe.Set("timing_lines", entries)
	}
	encoded, err := pycompat.EncodeIndented(recipe)
	if err != nil {
		return nil, err
	}
	recipePath := pycompat.JoinPath(out, recipeName)
	if err := projectfs.WriteFile(recipePath, []byte(pycompat.TextMode(string(encoded))), 0o666); err != nil {
		return nil, pycompat.OSErrorFrom(err, recipePath)
	}
	return recipe, nil
}
