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

	"songframe/internal/mediacmd"
	"songframe/internal/projectfs"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// speech — результат speechLines: путь песни из реестра (значение JSON как есть),
// окно плана в секундах, строки разметки в окне (словари timing.json с добавленным ключом
// «text») и признак lipsync плана.
type speech struct {
	source  any
	window  [2]float64
	lines   []*toolrt.Dict
	lipsync bool
}

// speechLines — строки разметки, пересекающие окно плана. Реестр читается и проверяется
// sceneregistry.Load; текст строки берётся из source/text.md по source_line (целое, bool тоже
// считается целым) и очищается от пробелов по краям, иначе — null. Битые данные
// дают KeyError/TypeError/AttributeError toolrt.
func speechLines(root, shot string) (speech, error) {
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return speech{}, err
	}
	scenesValue, err := toolrt.Item(registry, "scenes")
	if err != nil {
		return speech{}, err
	}
	scenes, err := toolrt.Iter(scenesValue)
	if err != nil {
		return speech{}, err
	}
	var scene any
	for _, item := range scenes {
		id, err := toolrt.Item(item, "id")
		if err != nil {
			return speech{}, err
		}
		if toolrt.Equal(id, shot) {
			scene = item
			break
		}
	}
	if scene == nil {
		return speech{}, toolrt.New(toolrt.ValueError, shot+": план отсутствует в реестре сцен.")
	}
	var window [2]float64
	for index, key := range []string{"start_frame", "end_frame_exclusive"} {
		frame, err := toolrt.Item(scene, key)
		if err != nil {
			return speech{}, err
		}
		fps, err := toolrt.Item(registry, "fps")
		if err != nil {
			return speech{}, err
		}
		if window[index], err = toolrt.TrueDiv(frame, fps); err != nil {
			return speech{}, err
		}
	}
	text, err := toolrt.ReadText(toolrt.JoinPath(root, "plan/audio/timing.json"))
	if err != nil {
		return speech{}, err
	}
	timing, err := toolrt.LoadsJSON(text)
	if err != nil {
		return speech{}, err
	}
	linesValue, err := toolrt.DictGet(timing, "lines", []any{})
	if err != nil {
		return speech{}, err
	}
	items, err := toolrt.Iter(linesValue)
	if err != nil {
		return speech{}, err
	}
	lines := []*toolrt.Dict{}
	for _, line := range items {
		end, err := toolrt.Item(line, "end")
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
		start, err := toolrt.Item(line, "start")
		if err != nil {
			return speech{}, err
		}
		before, err := toolrt.Less(start, window[1])
		if err != nil {
			return speech{}, err
		}
		if before {
			// Ключ «end» нашёлся по строке, значит line — словарь.
			lines = append(lines, line.(*toolrt.Dict))
		}
	}
	lyrics, err := toolrt.ReadText(toolrt.JoinPath(root, "source/text.md"))
	if err != nil {
		return speech{}, err
	}
	rows := toolrt.SplitLines(lyrics)
	for _, line := range lines {
		var value any
		if number, ok := index(line.Value("source_line")); ok && number.Sign() > 0 && number.Cmp(big.NewInt(int64(len(rows)))) <= 0 {
			value = toolrt.Strip(rows[number.Int64()-1])
		}
		line.Set("text", value)
	}
	audio, err := toolrt.Item(registry, "audio")
	if err != nil {
		return speech{}, err
	}
	source, err := toolrt.Item(audio, "path")
	if err != nil {
		return speech{}, err
	}
	lipsync, _ := toolrt.DictGet(scene, "lipsync", nil)
	return speech{source: source, window: window, lines: lines, lipsync: toolrt.Truthy(lipsync)}, nil
}

// propose — границы по строкам: от начала первой минус lead до конца последней плюс tail, не
// короче minSeconds; округление до 3 знаков (round3) и начало не меньше 0.0. Значения — числа
// toolrt (float или целое), поэтому min/max/арифметика идут через toolrt с его текстами TypeError.
func propose(lines []*toolrt.Dict, lead, tail, minSeconds any) (any, any, error) {
	if len(lines) == 0 {
		return nil, nil, toolrt.New(toolrt.ValueError, textNoLines)
	}
	first, err := extreme(lines, "start", false)
	if err != nil {
		return nil, nil, err
	}
	start, err := toolrt.Sub(first, lead)
	if err != nil {
		return nil, nil, err
	}
	last, err := extreme(lines, "end", true)
	if err != nil {
		return nil, nil, err
	}
	end, err := toolrt.Add(last, tail)
	if err != nil {
		return nil, nil, err
	}
	length, err := toolrt.Sub(end, start)
	if err != nil {
		return nil, nil, err
	}
	short, err := toolrt.Less(length, minSeconds)
	if err != nil {
		return nil, nil, err
	}
	if short {
		if end, err = toolrt.Add(start, minSeconds); err != nil {
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

// extreme — наименьшее или наибольшее значение key по строкам: текущий элемент заменяется
// следующим, только если тот строго меньше (больше), поэтому при равенстве остаётся первый.
func extreme(lines []*toolrt.Dict, key string, maximum bool) (any, error) {
	current, err := toolrt.Item(lines[0], key)
	if err != nil {
		return nil, err
	}
	for _, line := range lines[1:] {
		value, err := toolrt.Item(line, key)
		if err != nil {
			return nil, err
		}
		var better bool
		if maximum {
			better, err = greater(value, current)
		} else {
			better, err = toolrt.Less(value, current)
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

// greater — left > right через toolrt.Less; несравнимые типы дают TypeError с оператором «>»
// и типами в исходном порядке.
func greater(left, right any) (bool, error) {
	result, err := toolrt.Less(right, left)
	if err != nil {
		return false, toolrt.Raise(toolrt.TypeError, "'>' not supported between instances of '%s' and '%s'", toolrt.TypeName(left), toolrt.TypeName(right))
	}
	return result, nil
}

// round3 — округление до 3 знаков: float округляется по точному двоичному значению с половиной к
// чётному (корректно округлённая запись strconv), целое остаётся целым.
func round3(value any) any {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return value
	}
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(number, 'f', 3, 64), 64)
	return rounded
}

// index — целое значение для целого или bool (true — 1, false — 0); иначе ok=false.
func index(value any) (*big.Int, bool) {
	switch item := value.(type) {
	case toolrt.Int:
		return item.Big(), true
	case bool:
		if item {
			return big.NewInt(1), true
		}
		return big.NewInt(0), true
	}
	return nil, false
}

// sampleIndex — номер сэмпла для времени seconds: кратчайшая десятичная запись числа (toolrt.Str),
// умноженная на частоту точно, с округлением половины от нуля. Запись float — не больше 17 значащих
// цифр, поэтому точность не теряется. NaN — ValueError, бесконечность — OverflowError (тексты
// зафиксированы эталоном).
func sampleIndex(seconds any) (*big.Int, error) {
	text := toolrt.Str(seconds)
	switch text {
	case "nan", "-nan":
		return nil, toolrt.New(toolrt.ValueError, "cannot convert NaN to integer")
	case "inf", "-inf":
		return nil, toolrt.New(toolrt.OverflowError, "cannot convert Infinity to integer")
	}
	value, ok := new(big.Rat).SetString(text)
	if !ok {
		return nil, toolrt.Raise(toolrt.TypeError, "conversion from %s to Decimal is not supported", toolrt.TypeName(seconds))
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
		return nil, toolrt.New(toolrt.ValueError, textDecodeFailed+mediacmd.Tail(result.Stderr, 300))
	}
	return result.Stdout, nil
}

// pathDiv — base/part: нестроковая часть — TypeError с именем класса пути ОС (pathType).
func pathDiv(base string, part any) (string, error) {
	text, ok := part.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", pathType, toolrt.TypeName(part))
	}
	return toolrt.JoinPath(base, text), nil
}

// fileSHA — SHA-256 файла потоком и его размер.
func fileSHA(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, toolrt.OSErrorFrom(err, path)
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, toolrt.OSErrorFrom(err, path)
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

// cut — срез песни source (путь из реестра, от корня проекта) с start по end секунд в
// out/speech.wav и рецепт out/audio-recipe.json; возвращает рецепт. Существующий WAV не
// перезаписывается, рецепт перезаписывается. Файлы пишутся атомарно через
// projectfs.WriteFile с правами нового файла 0666 (с umask): сбой не оставляет частичного WAV.
// Порядок проверок и записи зафиксирован эталоном: песня, границы, декодирование, конец песни,
// папка, отсутствие WAV, WAV, рецепт.
func cut(ctx context.Context, root string, source, start, end any, out, shot string, lines []*toolrt.Dict) (*toolrt.Dict, error) {
	joined, err := pathDiv(root, source)
	if err != nil {
		return nil, err
	}
	sourcePath := toolrt.ResolvePath(joined)
	if !toolrt.IsFile(sourcePath) {
		return nil, toolrt.New(toolrt.ValueError, textSourceMissing+toolrt.Str(source))
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
		return nil, toolrt.New(toolrt.ValueError, textEmptyInterval)
	}
	// Отрицательное начало отклоняется: срез с отрицательным индексом отсчитывался бы от конца PCM.
	if first.Sign() < 0 {
		return nil, toolrt.New(toolrt.ValueError, textNegativeStart)
	}
	pcm, err := decode(ctx, sourcePath)
	if err != nil {
		return nil, err
	}
	frameBytes := channels * sampleWidth
	total := int64(len(pcm) / frameBytes)
	if last.Cmp(big.NewInt(total)) > 0 {
		return nil, toolrt.New(toolrt.ValueError, "Срез выходит за конец песни: "+toolrt.FormatFixed(float64(total)/sampleRate, 3)+" с.")
	}
	if err := os.MkdirAll(out, 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, out)
	}
	target := toolrt.JoinPath(out, speechName)
	if toolrt.Exists(target) {
		return nil, toolrt.New(toolrt.ValueError, textTargetExists)
	}
	data, err := waveBytes(toolrt.NewInt(channels), toolrt.NewInt(sampleWidth), toolrt.NewInt(sampleRate), nil,
		pcm[first.Int64()*int64(frameBytes):last.Int64()*int64(frameBytes)])
	if err != nil {
		return nil, err
	}
	if err := projectfs.WriteFile(target, data, 0o666); err != nil {
		return nil, toolrt.OSErrorFrom(err, target)
	}
	sourceSHA, sourceSize, err := fileSHA(sourcePath)
	if err != nil {
		return nil, err
	}
	outputSHA := sha256.Sum256(data)
	recipe := toolcli.Record(
		"schema_version", toolrt.NewInt(1),
		"source", toolcli.Record("path", toolrt.JoinPath(source.(string)), "sha256", sourceSHA, "bytes", toolrt.NewInt(sourceSize)),
		"source_interval_seconds", []any{float64(first.Int64()) / sampleRate, float64(last.Int64()) / sampleRate},
		"interval_end_exclusive", true,
		"sample_rate", toolrt.NewInt(sampleRate),
		"channels", toolrt.NewInt(channels),
		"sample_width_bytes", toolrt.NewInt(sampleWidth),
		"start_sample", toolrt.IntFromBig(first),
		"end_sample_exclusive", toolrt.IntFromBig(last),
		"output", toolcli.Record("path", speechName, "sha256", hex.EncodeToString(outputSHA[:]), "bytes", toolrt.NewInt(int64(len(data)))),
		"processing", processing,
	)
	if shot != "" {
		recipe.Set("shot", shot)
	}
	if len(lines) > 0 {
		entries := make([]any, 0, len(lines))
		for _, line := range lines {
			id, err := toolrt.Item(line, "id")
			if err != nil {
				return nil, err
			}
			entries = append(entries, toolcli.Record(
				"id", id, "source_line", line.Value("source_line"), "text", line.Value("text"),
				"start", line.Value("start"), "end", line.Value("end"), "note", line.Value("note"),
			))
		}
		recipe.Set("timing_lines", entries)
	}
	encoded, err := toolrt.EncodeIndented(recipe)
	if err != nil {
		return nil, err
	}
	recipePath := toolrt.JoinPath(out, recipeName)
	if err := projectfs.WriteFile(recipePath, []byte(toolrt.TextMode(string(encoded))), 0o666); err != nil {
		return nil, toolrt.OSErrorFrom(err, recipePath)
	}
	return recipe, nil
}
