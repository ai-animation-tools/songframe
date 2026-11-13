// Package buildreview собирает временную видеопробу стыков из соседних сцен (инструмент
// build_review). Prepare проверяет спецификацию (участки, скорость, удержания, переходы, звук)
// и медиа и возвращает рецепт с фильтрами FFmpeg по кадрам сетки 30 к/с; Build по рецепту
// кодирует MP4 с непрерывным участком песни и публикует его рядом с одноимённым JSON рецепта.
//
// Выход — только plan/batches проекта или временная папка ОС, существующий MP4 или JSON не
// перезаписывается: результат собирается во временной папке рядом и публикуется жёсткими
// ссылками. Проба не меняет assets, исходники и аниматик. Prepare зовёт и приёмка участка
// accept_shot (internal/acceptshot): рецепт одного плана даёт ей фильтр рендера.
//
// Ошибки — исключения toolrt, тексты зафиксированы эталоном build-review: Run печатает текст
// ValueError, остальные ожидаемые ошибки (KeyError, TypeError, OSError, InvalidOperation…) —
// общим текстом без сырого вывода, прочее — необработанной ошибкой «Ошибка: текст». FFmpeg и ffprobe запускаются через internal/mediacmd.
package buildreview

import (
	"context"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"songframe/internal/assetpackage"
	"songframe/internal/mediacmd"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// transitions — допустимые типы перехода xfade.
var transitions = map[string]bool{"fade": true, "fadeblack": true, "fadewhite": true, "dissolve": true, "wipeleft": true, "wiperight": true}

// Тексты ошибок пробы; зафиксированы эталоном build-review.
const (
	textHidden       = "Ошибка параметров или медиа пробы; сырой вывод скрыт."
	textMedia        = "Ошибка обработки медиа; исходники не изменены, сырой вывод скрыт."
	textNoInput      = "Нет входного файла пробы."
	textDestination  = "Пробу сохранять только в plan/batches или во временной папке ОС."
	textProtected    = "Проба не может заменять assets, исходники или аниматик."
	textNotMP4       = "Выход пробы должен быть MP4."
	textExists       = "Проба или её манифест уже существуют; нужен новый выходной путь."
	textSchema       = "Неизвестная схема или пустая проба."
	textFields       = "Неизвестные поля пробы."
	textAudioFields  = "Неизвестные поля audio."
	textShotFields   = "Неизвестные параметры участка пробы."
	textKindPath     = "kind задаётся только вместе с явным path."
	textScene        = "Неизвестный или повторяющийся план пробы."
	textKind         = "kind должен быть video или card."
	textStaleCards   = "Карточки устарели; обновите представления планов."
	textCardChanged  = "Карточка изменена."
	textWindow       = "Конец участка должен быть больше начала."
	textSpeed        = "Скорость должна быть положительной."
	textCard         = "Для карточки задавайте длительность через source_end_frame_exclusive без обрезки и скорости."
	textShort        = "Участок после изменения скорости короче кадра."
	textTransition   = "Неизвестные параметры перехода."
	textJoin         = "Неизвестный, повторный или последний стык перехода."
	textSwallow      = "Переходы поглощают весь план."
	textAudioStart   = "Для непоследовательных планов явно задайте audio.start_frame."
	textNoAudio      = "Нет звуковой дорожки."
	textSongShort    = "Участок песни короче пробы."
	textRegistryPrep = "Реестр изменился при подготовке пробы."
	textBadFormat    = "Проба имеет неверную длину или формат."
	textBadSong      = "Песня в пробе имеет неверную длину."
	textInputChanged = "Вход изменился во время сборки."
	textRegistryRun  = "Реестр изменился во время сборки пробы."
	textOutsideAsset = "Файл комплекта находится вне папки ассета."
)

// textTransform — пояснение преобразований рецепта на сетке частоты проекта fps.
func textTransform(fps int64) string {
	return "Масштаб с сохранением пропорций и полями; все временные преобразования записаны по кадрам при " + strconv.FormatInt(fps, 10) + " FPS."
}

func valueError(message string) error { return toolrt.New(toolrt.ValueError, message) }

// TempDir — временная папка ОС, куда тоже разрешено сохранять пробу (подменяется в тестах).
var TempDir = os.TempDir

// joinTyped склеивает root и name; не строка — TypeError склейки пути.
func joinTyped(root string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(name))
	}
	return toolrt.JoinPath(root, text), nil
}

// source — существующий файл name относительно корня проекта (абсолютный путь
// допустим), разрешённый до реального.
func source(root string, name any) (string, error) {
	joined, err := joinTyped(root, name)
	if err != nil {
		return "", err
	}
	path := toolrt.ResolvePath(joined)
	if !toolrt.IsFile(path) {
		return "", valueError(textNoInput)
	}
	return path, nil
}

// localFile — путь файла name внутри папки комплекта, как assetpackage.LocalFile.
func localFile(directory string, name any) (string, error) {
	joined, err := joinTyped(directory, name)
	if err != nil {
		return "", err
	}
	path := toolrt.ResolvePath(joined)
	if !toolrt.IsRelativeTo(path, toolrt.ResolvePath(directory)) {
		return "", valueError(textOutsideAsset)
	}
	return path, nil
}

// destination проверяет выход name: только в plan/batches или во временной папке ОС,
// не внутри assets, source и plan/animatic, с расширением .mp4.
func destination(root, name string) (string, error) {
	path := toolrt.ResolvePath(name)
	if !toolrt.IsRelativeTo(path, toolrt.ResolvePath(toolrt.JoinPath(root, "plan", "batches"))) &&
		!toolrt.IsRelativeTo(path, toolrt.ResolvePath(TempDir())) {
		return "", valueError(textDestination)
	}
	for _, folder := range []string{"assets", "source", "plan/animatic"} {
		if toolrt.IsRelativeTo(path, toolrt.ResolvePath(toolrt.JoinPath(root, filepath.FromSlash(folder)))) {
			return "", valueError(textProtected)
		}
	}
	if strings.ToLower(toolrt.PathSuffix(path)) != ".mp4" {
		return "", valueError(textNotMP4)
	}
	return path, nil
}

// run запускает медиапрограмму: stdout программы; ненулевой код — ValueError без сырого вывода.
// Незапустившаяся программа — FileNotFoundError (общий текст в Run).
func run(ctx context.Context, program string, args ...string) ([]byte, error) {
	result, err := mediacmd.Run(ctx, program, args...)
	if err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, valueError(textMedia)
	}
	return result.Stdout, nil
}

// probe — JSON ffprobe потоков и формата файла path (без глав, в отличие от
// build_animatic) значением toolrt.
func probe(ctx context.Context, path string) (any, error) {
	data, err := run(ctx, mediacmd.FFprobe(), "-v", "error", "-show_streams", "-show_format", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	text, err := toolrt.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	return toolrt.LoadsJSON(text)
}

// streams — список потоков из сводки ffprobe meta.
func streams(meta any) ([]any, error) {
	value, err := toolrt.Item(meta, "streams")
	if err != nil {
		return nil, err
	}
	return toolrt.Iter(value)
}

// firstStream — первый поток с codec_type, равным kind; нет — StopIteration.
func firstStream(items []any, kind string) (any, error) {
	for _, stream := range items {
		codec, err := toolrt.Item(stream, "codec_type")
		if err != nil {
			return nil, err
		}
		if toolrt.Equal(codec, kind) {
			return stream, nil
		}
	}
	return nil, toolrt.New("StopIteration", "")
}

// decodedAudioDuration — длительность декодированного звука (моно 16 кГц s16le) в секундах
// (toolrt.Decimal); начальная метка MP3 не вычитается. Ошибка
// декодирования — ValueError с хвостом stderr (его Run печатает как текст ошибки).
func decodedAudioDuration(ctx context.Context, path string) (toolrt.Decimal, error) {
	result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-")
	if err != nil {
		return toolrt.Decimal{}, err
	}
	if result.Code != 0 {
		return toolrt.Decimal{}, valueError("Не удалось декодировать трек: " + mediacmd.Tail(result.Stderr, 1200))
	}
	return toolrt.DecimalInt(int64(len(result.Stdout))).Div(toolrt.DecimalInt(32000))
}

// integer — точное целое JSON (не bool и не float) не меньше
// minimum, иначе ValueError «Неверное целое поле …».
func integer(value any, name string, minimum int64) (*big.Int, error) {
	number, ok := value.(toolrt.Int)
	if !ok || bigInt(number).Cmp(big.NewInt(minimum)) < 0 {
		return nil, valueError("Неверное целое поле " + name + ".")
	}
	return bigInt(number), nil
}

// unknownKeys — есть ли среди элементов value не входящие в allowed: элементы — ключи словаря,
// элементы списка или символы строки; нехешируемый элемент и неитерируемое значение — TypeError.
func unknownKeys(value any, allowed ...string) (bool, error) {
	items, err := toolrt.Iter(value)
	if err != nil {
		return false, err
	}
	known := map[string]bool{}
	for _, name := range allowed {
		known[name] = true
	}
	extra := false
	for _, item := range items {
		if _, err := toolrt.HashKey(item); err != nil {
			return false, err
		}
		if text, ok := item.(string); !ok || !known[text] {
			extra = true
		}
	}
	return extra, nil
}

// contains — есть ли key в container (toolrt.Contains); неверный тип контейнера — исключение.
func contains(container any, key string) (bool, error) { return toolrt.Contains(container, key) }

// get — значение по ключу или fallback для словаря участка, аудио и перехода.
func get(container any, key string, fallback any) (any, error) {
	return toolrt.DictGet(container, key, fallback)
}

// sha — SHA-256 файла.
func sha(path string) (string, error) { return assetpackage.FileSHA256(path) }

// registryShot — план реестра с его позицией для проверки последовательности.
type registryShot struct {
	shot     *toolrt.Dict
	position int
}

// Prepare возвращает проверенный рецепт пробы без кодирования и записи. spec — разобранный JSON
// спецификации, root — корень проекта. Рецепт — упорядоченный словарь с полями, зафиксированными
// эталоном (порядок важен для байтов JSON), пути входов — абсолютные. ffprobe читает видео и
// песню, FFmpeg декодирует песню для
// проверки длины; ctx прерывает их.
func Prepare(ctx context.Context, spec any, root string) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	scenesPath := toolrt.JoinPath(root, "plan", "scenes.json")
	registryDigest, err := sha(scenesPath)
	if err != nil {
		return nil, err
	}
	data, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	if err := sceneregistry.SameFPS(root, data); err != nil {
		return nil, err
	}
	fps := sceneregistry.FPS(data.Value("fps"))
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	registry, err := sceneregistry.Shots(data, initial)
	if err != nil {
		return nil, err
	}
	byID := map[string]registryShot{}
	for index, shot := range registry {
		if id, ok := shot.Value("id").(string); ok {
			byID[id] = registryShot{shot: shot, position: index}
		}
	}
	schema, err := get(spec, "schema_version", nil)
	if err != nil {
		return nil, err
	}
	shotsValue, _ := get(spec, "shots", nil)
	if !toolrt.Equal(schema, toolrt.NewInt(1)) || !toolrt.Truthy(shotsValue) {
		return nil, valueError(textSchema)
	}
	if extra, err := unknownKeys(spec, "schema_version", "shots", "audio", "transitions"); err != nil || extra {
		return nil, firstError(err, textFields)
	}
	audioValue, _ := get(spec, "audio", toolrt.NewDict())
	if extra, err := unknownKeys(audioValue, "path", "start_frame"); err != nil || extra {
		return nil, firstError(err, textAudioFields)
	}
	configs, err := toolrt.Iter(shotsValue)
	if err != nil {
		return nil, err
	}
	items := []*toolrt.Dict{}
	seen := map[string]bool{}
	var receipt any
	for _, config := range configs {
		item, err := prepareShot(ctx, root, config, byID, seen, &receipt, scenesPath, fps)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	transitionsValue, _ := get(spec, "transitions", []any{})
	joins, err := prepareTransitions(transitionsValue, items)
	if err != nil {
		return nil, err
	}
	// Суммарные перекрытия не могут поглотить средний план целиком.
	total := new(big.Int)
	for index, item := range items {
		left := big.NewInt(0)
		if index > 0 {
			left = overlap(joins, items[index-1])
		}
		length := bigInt(item.Value("frames").(toolrt.Int))
		if addInt(left, overlap(joins, item)).Cmp(length) >= 0 {
			return nil, valueError(textSwallow)
		}
		total.Add(total, length)
	}
	for _, key := range joins.Keys() {
		total.Sub(total, bigInt(joins.Value(key).(*toolrt.Dict).Value("frames").(toolrt.Int)))
	}
	positions := make([]int, len(items))
	for index, item := range items {
		positions[index] = byID[item.Value("id").(string)].position
	}
	hasStart, err := contains(audioValue, "start_frame")
	if err != nil {
		return nil, err
	}
	consecutive := true
	for index, position := range positions {
		consecutive = consecutive && position == positions[0]+index
	}
	if !hasStart && !consecutive {
		return nil, valueError(textAudioStart)
	}
	first := byID[items[0].Value("id").(string)].shot
	startValue, err := get(audioValue, "start_frame", first.Value("start_frame"))
	if err != nil {
		return nil, err
	}
	audioStart, err := integer(startValue, "audio.start_frame", 0)
	if err != nil {
		return nil, err
	}
	trackName, err := get(audioValue, "path", "source/track.mp3")
	if err != nil {
		return nil, err
	}
	track, err := source(root, trackName)
	if err != nil {
		return nil, err
	}
	meta, err := probe(ctx, track)
	if err != nil {
		return nil, err
	}
	list, err := streams(meta)
	if err != nil {
		return nil, err
	}
	if _, err := firstStream(list, "audio"); err != nil {
		if toolrt.Is(err, "StopIteration") {
			return nil, valueError(textNoAudio)
		}
		return nil, err
	}
	duration, err := decodedAudioDuration(ctx, track)
	if err != nil {
		return nil, err
	}
	// Конец песни округляется к ближайшему кадру так же, как монтажная шкала.
	// Остаток до этой границы дополняется тишиной, но более длинная нехватка запрещена.
	songFrames, err := framesTimesFPS(duration, fps)
	if err != nil {
		return nil, err
	}
	end := addInt(audioStart, total)
	if end.Cmp(songFrames) > 0 {
		return nil, valueError(textSongShort)
	}
	filter := "aresample=44100,atrim=start_sample=" + samples(audioStart, fps).String() + ":end_sample=" + samples(end, fps).String() +
		",asetpts=PTS-STARTPTS,apad=whole_len=" + samples(total, fps).String() + ",atrim=end_sample=" + samples(total, fps).String()
	if digest, err := sha(scenesPath); err != nil {
		return nil, err
	} else if digest != registryDigest {
		return nil, valueError(textRegistryPrep)
	}
	trackDigest, err := sha(track)
	if err != nil {
		return nil, err
	}
	shotList := make([]any, len(items))
	for index, item := range items {
		shotList[index] = item
	}
	durationSeconds, err := secondsFloat(total, fps)
	if err != nil {
		return nil, err
	}
	return toolcli.Record(
		"schema_version", toolrt.NewInt(1),
		"scene_registry_sha256", registryDigest,
		"fps", toolrt.NewInt(fps),
		"resolution", []any{toolrt.NewInt(1920), toolrt.NewInt(1080)},
		"shots", shotList,
		"transitions", joins,
		"total_frames", newInt(total),
		"duration_seconds", durationSeconds,
		"audio", toolcli.Record(
			"path", track,
			"sha256", trackDigest,
			"start_frame", newInt(audioStart),
			"end_frame_exclusive", newInt(end),
			"filter", filter,
		),
		"transform", textTransform(fps),
	), nil
}

// firstError — исключение проверки, если оно было, иначе ValueError с текстом.
func firstError(err error, message string) error {
	if err != nil {
		return err
	}
	return valueError(message)
}

// overlap — перекрытие стыка после плана item в кадрах (0, если стыка нет).
func overlap(joins *toolrt.Dict, item *toolrt.Dict) *big.Int {
	join, ok := joins.Get(item.Value("id").(string))
	if !ok {
		return big.NewInt(0)
	}
	return bigInt(join.(*toolrt.Dict).Value("frames").(toolrt.Int))
}

// prepareShot — тело цикла по участкам Prepare: выбор материала (явный path, принятый монтаж
// или карточка реестра), проверка окна, скорости и удержаний и цепочка фильтров участка.
func prepareShot(ctx context.Context, root string, config any, byID map[string]registryShot, seen map[string]bool, receipt *any, scenesPath string, fps int64) (*toolrt.Dict, error) {
	if extra, err := unknownKeys(config, "scene", "path", "kind", "source_start_frame", "source_end_frame_exclusive", "speed", "hold_first_frames", "hold_last_frames"); err != nil || extra {
		return nil, firstError(err, textShotFields)
	}
	hasKind, err := contains(config, "kind")
	if err != nil {
		return nil, err
	}
	hasPath, err := contains(config, "path")
	if err != nil {
		return nil, err
	}
	if hasKind && !hasPath {
		return nil, valueError(textKindPath)
	}
	sidValue, err := toolrt.Item(config, "scene")
	if err != nil {
		return nil, err
	}
	if _, err := toolrt.HashKey(sidValue); err != nil {
		return nil, err
	}
	sid, isString := sidValue.(string)
	registered, known := byID[sid]
	if !isString || !known || seen[sid] {
		return nil, valueError(textScene)
	}
	seen[sid] = true
	scene := registered.shot
	sceneFrames := bigInt(scene.Value("frames").(toolrt.Int))
	packagePath := toolrt.JoinPath(root, "assets", "shots", sid, "manifest.json")
	var kind, origin, path string
	switch {
	case hasPath:
		kindValue, err := get(config, "kind", "video")
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(kindValue, "video") && !toolrt.Equal(kindValue, "card") {
			return nil, valueError(textKind)
		}
		kind, origin = kindValue.(string), "explicit"
		pathValue, err := toolrt.Item(config, "path")
		if err != nil {
			return nil, err
		}
		if path, err = source(root, pathValue); err != nil {
			return nil, err
		}
	case toolrt.IsFile(packagePath):
		kind, origin = "video", "accepted_edit"
		if path, err = acceptedEdit(packagePath, sid, sceneFrames, fps); err != nil {
			return nil, err
		}
	default:
		kind, origin = "card", "registry_card"
		if path, err = source(root, "plan/animatic/cards/"+sid+".png"); err != nil {
			return nil, err
		}
		if err := checkCard(root, sid, path, receipt, scenesPath); err != nil {
			return nil, err
		}
	}
	startValue, err := get(config, "source_start_frame", toolrt.NewInt(0))
	if err != nil {
		return nil, err
	}
	start, err := integer(startValue, "source_start_frame", 0)
	if err != nil {
		return nil, err
	}
	endValue, err := get(config, "source_end_frame_exclusive", newInt(addInt(start, sceneFrames)))
	if err != nil {
		return nil, err
	}
	end, err := integer(endValue, "source_end_frame_exclusive", 1)
	if err != nil {
		return nil, err
	}
	if end.Cmp(start) <= 0 {
		return nil, valueError(textWindow)
	}
	speedValue, err := get(config, "speed", "1")
	if err != nil {
		return nil, err
	}
	speedText := toolrt.Str(speedValue)
	speed, err := toolrt.NewDecimal(speedText)
	if err != nil {
		return nil, err
	}
	if !isFinite(speed) {
		return nil, valueError(textSpeed)
	}
	if sign, _ := speed.Cmp(toolrt.DecimalInt(0)); sign <= 0 {
		return nil, valueError(textSpeed)
	}
	speedString, _ := DecimalText(speedText)
	firstValue, err := get(config, "hold_first_frames", toolrt.NewInt(0))
	if err != nil {
		return nil, err
	}
	holdFirst, err := integer(firstValue, "hold_first_frames", 0)
	if err != nil {
		return nil, err
	}
	lastValue, err := get(config, "hold_last_frames", toolrt.NewInt(0))
	if err != nil {
		return nil, err
	}
	holdLast, err := integer(lastValue, "hold_last_frames", 0)
	if err != nil {
		return nil, err
	}
	unit, _ := speed.Cmp(toolrt.DecimalInt(1))
	if kind == "card" && (start.Sign() != 0 || unit != 0) {
		return nil, valueError(textCard)
	}
	quotient, err := decimalOf(subInt(end, start)).Div(speed)
	if err != nil {
		return nil, err
	}
	motion, err := frames(quotient)
	if err != nil {
		return nil, err
	}
	if motion.Cmp(big.NewInt(1)) < 0 {
		return nil, valueError(textShort)
	}
	if kind == "video" {
		available, err := availableFrames(ctx, path, fps)
		if err != nil {
			return nil, err
		}
		if end.Cmp(available) > 0 {
			return nil, valueError(sid + ": выбранный участок выходит за пределы видео.")
		}
	}
	rate := strconv.FormatInt(fps, 10)
	filters := []string{}
	if kind == "video" {
		filters = append(filters,
			"fps="+rate,
			"trim=start_frame="+start.String()+":end_frame="+end.String(),
			"setpts=(PTS-STARTPTS)/"+speedString,
			"fps="+rate,
			"tpad=stop_mode=clone:stop=1",
			"trim=end_frame="+motion.String(),
		)
	} else {
		filters = append(filters, "trim=end_frame="+motion.String())
	}
	// Скорость и удержания явные; масштаб сохраняет пропорции и заполняет кадр
	// 1920×1080, выступающие края обрезаются по центру: ролик другого размера (например, созданный
	// вне приложения) не получает чёрных полей. Последний кадр дополняет только округление
	// длительности до сетки.
	filters = append(filters,
		"setpts=N/("+rate+"*TB)",
		"scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos",
		"crop=1920:1080",
		"setsar=1",
		"format=yuv420p",
		"tpad=start_mode=clone:start="+holdFirst.String()+":stop_mode=clone:stop="+holdLast.String(),
		"settb=1/"+rate,
	)
	digest, err := sha(path)
	if err != nil {
		return nil, err
	}
	startSeconds, err := secondsFloat(start, fps)
	if err != nil {
		return nil, err
	}
	endSeconds, err := secondsFloat(end, fps)
	if err != nil {
		return nil, err
	}
	change, err := secondsFloat(subInt(motion, subInt(end, start)), fps)
	if err != nil {
		return nil, err
	}
	return toolcli.Record(
		"id", sid,
		"kind", kind,
		"origin", origin,
		"path", path,
		"sha256", digest,
		"source_start_frame", newInt(start),
		"source_end_frame_exclusive", newInt(end),
		"source_interval_seconds", []any{startSeconds, endSeconds},
		"speed", speedString,
		"motion_frames", newInt(motion),
		"hold_first_frames", newInt(holdFirst),
		"hold_last_frames", newInt(holdLast),
		"duration_change_seconds", change,
		"frames", newInt(addInt(addInt(motion, holdFirst), holdLast)),
		"filter", strings.Join(filters, ","),
	), nil
}

// acceptedEdit — принятый монтаж готовой сцены из её манифеста; повреждённый или чужой монтаж
// карточкой не заменяется.
func acceptedEdit(packagePath, sid string, sceneFrames *big.Int, rate int64) (string, error) {
	pkg, err := toolrt.LoadJSONFile(packagePath)
	if err != nil {
		return "", err
	}
	edit, err := toolrt.Item(pkg, "accepted_edit")
	if err != nil {
		return "", err
	}
	videoValue, err := toolrt.Item(edit, "video")
	if err != nil {
		return "", err
	}
	name, err := toolrt.Item(videoValue, "path")
	if err != nil {
		return "", err
	}
	path, err := localFile(filepath.Dir(packagePath), name)
	if err != nil {
		return "", err
	}
	mismatch := valueError(sid + ": принятый монтаж не совпадает с реестром или хешем.")
	shot, err := toolrt.Item(pkg, "shot")
	if err != nil {
		return "", err
	}
	if !toolrt.Equal(shot, sid) {
		return "", mismatch
	}
	digest, err := sha(path)
	if err != nil {
		return "", err
	}
	expected, err := toolrt.Item(videoValue, "sha256")
	if err != nil {
		return "", err
	}
	if !toolrt.Equal(digest, expected) {
		return "", mismatch
	}
	fps, err := toolrt.Item(edit, "fps")
	if err != nil {
		return "", err
	}
	if !toolrt.Equal(fps, toolrt.NewInt(rate)) {
		return "", mismatch
	}
	count, err := toolrt.Item(edit, "frames")
	if err != nil {
		return "", err
	}
	if !toolrt.Equal(count, newInt(sceneFrames)) {
		return "", mismatch
	}
	return path, nil
}

// checkCard — актуальность карточки: квитанция plan/animatic/cards/manifest.json читается один
// раз на пробу и сверяется с реестром и референсами, затем хеш самой карточки.
func checkCard(root, sid, path string, receipt *any, scenesPath string) error {
	if *receipt == nil {
		value, err := toolrt.LoadJSONFile(toolrt.JoinPath(root, "plan", "animatic", "cards", "manifest.json"))
		if err != nil {
			return err
		}
		*receipt = value
		registered, err := toolrt.Item(value, "registry_sha256")
		if err != nil {
			return err
		}
		current, err := sha(scenesPath)
		if err != nil {
			return err
		}
		stale := !toolrt.Equal(registered, current)
		if !stale {
			hashes, err := get(value, "reference_hashes", toolrt.NewDict())
			if err != nil {
				return err
			}
			table, ok := hashes.(*toolrt.Dict)
			if !ok {
				return toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(hashes))
			}
			for _, key := range table.Keys() {
				reference, err := source(root, key)
				if err != nil {
					return err
				}
				digest, err := sha(reference)
				if err != nil {
					return err
				}
				if !toolrt.Equal(digest, table.Value(key)) {
					stale = true
					break
				}
			}
		}
		if stale {
			return valueError(textStaleCards)
		}
	}
	cards, err := toolrt.Item(*receipt, "cards")
	if err != nil {
		return err
	}
	card, err := toolrt.Item(cards, sid)
	if err != nil {
		return err
	}
	expected, err := toolrt.Item(card, "sha256")
	if err != nil {
		return err
	}
	digest, err := sha(path)
	if err != nil {
		return err
	}
	if !toolrt.Equal(expected, digest) {
		return valueError(textCardChanged)
	}
	return nil
}

// availableFrames — длина ролика в кадрах сетки проекта fps: nb_frames у потока с той же частотой,
// иначе длительность × fps с округлением половины вверх.
func availableFrames(ctx context.Context, path string, fps int64) (*big.Int, error) {
	meta, err := probe(ctx, path)
	if err != nil {
		return nil, err
	}
	list, err := streams(meta)
	if err != nil {
		return nil, err
	}
	video, err := firstStream(list, "video")
	if err != nil {
		return nil, err
	}
	rate, err := get(video, "r_frame_rate", nil)
	if err != nil {
		return nil, err
	}
	count, _ := get(video, "nb_frames", "")
	text := toolrt.Str(count)
	digits := text != ""
	for _, r := range text {
		digits = digits && toolrt.DigitValue(r) >= 0
	}
	// nb_frames совпадает с кадрами шкалы только у постоянной частоты. У переменной (запись экрана,
	// телефон) r_frame_rate может быть 30/1 при средней 23 к/с: фильтр fps=… рендера дублирует кадры
	// по времени, и доступная длина считается по длительности, как у другой частоты.
	average, _ := get(video, "avg_frame_rate", nil)
	constant := average == nil || toolrt.Equal(average, rate)
	if toolrt.Equal(rate, strconv.FormatInt(fps, 10)+"/1") && digits && constant {
		value, ok := toolrt.ParseIntText(text)
		if !ok {
			return nil, toolrt.Raise(toolrt.ValueError, "не целое число: %s", toolrt.Repr(text))
		}
		return bigInt(value), nil
	}
	durationValue, err := toolrt.Item(video, "duration")
	if err != nil {
		return nil, err
	}
	duration, err := toolrt.NewDecimal(durationValue)
	if err != nil {
		return nil, err
	}
	return framesTimesFPS(duration, fps)
}

// prepareTransitions — переходы по стыкам: after — план (не последний), тип из TRANSITIONS,
// frames ≥ 1; один переход на стык. Результат — by_after в порядке спецификации.
func prepareTransitions(value any, items []*toolrt.Dict) (*toolrt.Dict, error) {
	list, err := toolrt.Iter(value)
	if err != nil {
		return nil, err
	}
	joinable := []any{}
	for _, item := range items[:len(items)-1] {
		joinable = append(joinable, item.Value("id"))
	}
	joins := toolrt.NewDict()
	for _, transition := range list {
		if extra, err := unknownKeys(transition, "after", "type", "frames"); err != nil || extra {
			return nil, firstError(err, textTransition)
		}
		after, err := toolrt.Item(transition, "after")
		if err != nil {
			return nil, err
		}
		countValue, err := toolrt.Item(transition, "frames")
		if err != nil {
			return nil, err
		}
		count, err := integer(countValue, "transition.frames", 1)
		if err != nil {
			return nil, err
		}
		if _, err := toolrt.HashKey(after); err != nil {
			return nil, err
		}
		name, isString := after.(string)
		if isString && joins.Has(name) {
			return nil, valueError(textJoin)
		}
		if found, _ := toolrt.Contains(joinable, after); !found {
			return nil, valueError(textJoin)
		}
		kind, err := toolrt.Item(transition, "type")
		if err != nil {
			return nil, err
		}
		if _, err := toolrt.HashKey(kind); err != nil {
			return nil, err
		}
		kindName, _ := kind.(string)
		if !transitions[kindName] {
			return nil, valueError(textJoin)
		}
		joins.Set(name, toolcli.Record("type", kindName, "frames", newInt(count)))
	}
	return joins, nil
}

// encoding — поле encoding рецепта: параметры кодирования пробы.
func encoding() *toolrt.Dict {
	return toolcli.Record(
		"video_codec", "libx264",
		"preset", "fast",
		"crf", toolrt.NewInt(18),
		"threads", toolrt.NewInt(2),
		"filter_complex_threads", toolrt.NewInt(1),
		"pixel_format", "yuv420p",
		"video_track_timescale", toolrt.NewInt(15360),
		"audio_codec", "aac",
		"audio_bitrate", "192k",
		"sample_rate", toolrt.NewInt(44100),
		"channels", toolrt.NewInt(2),
	)
}

// Build — проверка выхода и рецепт Prepare; без planOnly —
// кодирование MP4 во временной папке рядом с выходом, проверка длины, формата и звука, повторная
// сверка входов и публикация MP4 и JSON рецепта жёсткими ссылками (существующий результат не
// перезаписывается, частичная публикация откатывается). Возвращает рецепт, дополненный стыками,
// SHA видео, путём, статусом и версией FFmpeg.
func Build(ctx context.Context, spec any, output, root string, planOnly bool) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	target, err := destination(root, output)
	if err != nil {
		return nil, err
	}
	manifest := toolrt.WithSuffix(target, ".json")
	if toolrt.Exists(target) || toolrt.Exists(manifest) {
		return nil, valueError(textExists)
	}
	plan, err := Prepare(ctx, spec, root)
	if err != nil {
		return nil, err
	}
	if planOnly {
		return plan, nil
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return nil, toolrt.OSErrorFrom(err, parent)
	}
	temporary, err := os.MkdirTemp(parent, ".review-")
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, parent)
	}
	defer os.RemoveAll(temporary)
	if err := render(ctx, plan, root, temporary); err != nil {
		return nil, err
	}
	plan.Set("output", target)
	plan.Set("status", "review_pending")
	versionOutput, err := run(ctx, mediacmd.FFmpeg(), "-version")
	if err != nil {
		return nil, err
	}
	versionText, err := toolrt.DecodeUTF8(versionOutput)
	if err != nil {
		return nil, err
	}
	lines := toolrt.SplitLines(versionText)
	if len(lines) == 0 {
		return nil, toolrt.New(toolrt.IndexError, "индекс за пределами списка")
	}
	plan.Set("ffmpeg_version", lines[0])
	plan.Set("encoding", encoding())
	// Публикация через link не перезапишет результат параллельного запуска.
	metadata := filepath.Join(temporary, "review.json")
	data, err := toolrt.EncodeIndented(plan)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(metadata, data, 0o644); err != nil {
		return nil, toolrt.OSErrorFrom(err, metadata)
	}
	if err := os.Link(filepath.Join(temporary, "review.mp4"), target); err != nil {
		return nil, toolrt.OSErrorFrom(err, target)
	}
	if err := os.Link(metadata, manifest); err != nil {
		_ = os.Remove(target)
		return nil, toolrt.OSErrorFrom(err, manifest)
	}
	return plan, nil
}

// render — тело сборки: граф фильтров (участки, склейки concat или xfade, звук), кодирование
// review.mp4 в temporary и проверки результата. Дописывает в plan cuts и video_sha256.
func render(ctx context.Context, plan *toolrt.Dict, root, temporary string) error {
	shots := plan.Value("shots").([]any)
	joins := plan.Value("transitions").(*toolrt.Dict)
	audio := plan.Value("audio").(*toolrt.Dict)
	total := bigInt(plan.Value("total_frames").(toolrt.Int))
	fps := sceneregistry.FPS(plan.Value("fps"))
	rate := strconv.FormatInt(fps, 10)
	argv := []string{"-v", "error", "-nostdin", "-n"}
	graph := []string{}
	for index, raw := range shots {
		item := raw.(*toolrt.Dict)
		if item.Value("kind") == "card" {
			argv = append(argv, "-loop", "1", "-framerate", rate)
		}
		argv = append(argv, "-i", item.Value("path").(string))
		graph = append(graph, "["+strconv.Itoa(index)+":v]"+item.Value("filter").(string)+"[s"+strconv.Itoa(index)+"]")
	}
	argv = append(argv, "-i", audio.Value("path").(string))
	current := "s0"
	length := bigInt(shots[0].(*toolrt.Dict).Value("frames").(toolrt.Int))
	songStart := bigInt(audio.Value("start_frame").(toolrt.Int))
	cuts := []any{}
	for index := 1; index < len(shots); index++ {
		previous := shots[index-1].(*toolrt.Dict).Value("id").(string)
		label := "join" + strconv.Itoa(index)
		kind := "cut"
		overlapFrames := big.NewInt(0)
		if raw, ok := joins.Get(previous); ok {
			join := raw.(*toolrt.Dict)
			kind = join.Value("type").(string)
			overlapFrames = bigInt(join.Value("frames").(toolrt.Int))
		}
		cut := subInt(length, overlapFrames)
		if kind != "cut" {
			duration, err := seconds(overlapFrames, fps)
			if err != nil {
				return err
			}
			offset, err := seconds(cut, fps)
			if err != nil {
				return err
			}
			graph = append(graph, "["+current+"][s"+strconv.Itoa(index)+"]xfade=transition="+kind+":duration="+duration+":offset="+offset+"["+label+"]")
		} else {
			graph = append(graph, "["+current+"][s"+strconv.Itoa(index)+"]concat=n=2:v=1:a=0,settb=1/"+rate+"["+label+"]")
		}
		cuts = append(cuts, toolcli.Record(
			"after", previous,
			"start_frame", newInt(cut),
			"end_frame_exclusive", newInt(length),
			"song_frame", newInt(addInt(songStart, cut)),
			"type", kind,
		))
		current = label
		length = addInt(length, subInt(bigInt(shots[index].(*toolrt.Dict).Value("frames").(toolrt.Int)), overlapFrames))
	}
	graph = append(graph, "["+strconv.Itoa(len(shots))+":a]"+audio.Value("filter").(string)+"[music]")
	target := filepath.Join(temporary, "review.mp4")
	argv = append(argv,
		"-filter_complex_threads", "1",
		"-filter_complex", strings.Join(graph, ";"),
		"-map", "["+current+"]",
		"-map", "[music]",
		"-frames:v", total.String(),
		"-r", "30",
		"-c:v", "libx264",
		"-threads", "2",
		"-preset", "fast",
		"-crf", "18",
		"-pix_fmt", "yuv420p",
		"-video_track_timescale", "15360",
		"-c:a", "aac",
		"-b:a", "192k",
		"-ar", "44100",
		"-ac", "2",
		"-map_metadata", "-1",
		"-movflags", "+faststart",
		target,
	)
	if _, err := run(ctx, mediacmd.FFmpeg(), argv...); err != nil {
		return err
	}
	if err := checkResult(ctx, target, total, fps); err != nil {
		return err
	}
	for _, raw := range append(append([]any{}, shots...), audio) {
		item := raw.(*toolrt.Dict)
		digest, err := sha(item.Value("path").(string))
		if err != nil {
			return err
		}
		if digest != item.Value("sha256") {
			return valueError(textInputChanged)
		}
	}
	if digest, err := sha(toolrt.JoinPath(root, "plan", "scenes.json")); err != nil {
		return err
	} else if digest != plan.Value("scene_registry_sha256") {
		return valueError(textRegistryRun)
	}
	videoDigest, err := sha(target)
	if err != nil {
		return err
	}
	plan.Set("cuts", cuts)
	plan.Set("video_sha256", videoDigest)
	return nil
}

// checkResult — проба 1920×1080 при частоте проекта ровно с total кадрами, песня — той же длины ±3 мс.
func checkResult(ctx context.Context, target string, total *big.Int, fps int64) error {
	meta, err := probe(ctx, target)
	if err != nil {
		return err
	}
	list, err := streams(meta)
	if err != nil {
		return err
	}
	video, err := firstStream(list, "video")
	if err != nil {
		return err
	}
	music, err := firstStream(list, "audio")
	if err != nil {
		return err
	}
	values := make([]any, 4)
	for index, key := range []string{"nb_frames", "r_frame_rate", "width", "height"} {
		if values[index], err = toolrt.Item(video, key); err != nil {
			return err
		}
	}
	count, ok := toolrt.ParseIntText(toolrt.Str(values[0]))
	if !ok {
		return toolrt.Raise(toolrt.ValueError, "не целое число: %s", toolrt.Repr(values[0]))
	}
	if bigInt(count).Cmp(total) != 0 || !toolrt.Equal(values[1], strconv.FormatInt(fps, 10)+"/1") || !toolrt.Equal(values[2], toolrt.NewInt(1920)) || !toolrt.Equal(values[3], toolrt.NewInt(1080)) {
		return valueError(textBadFormat)
	}
	durationValue, err := toolrt.Item(music, "duration")
	if err != nil {
		return err
	}
	duration, err := toolrt.NewDecimal(durationValue)
	if err != nil {
		return err
	}
	expected, err := decimalOf(total).Div(toolrt.DecimalInt(fps))
	if err != nil {
		return err
	}
	difference, err := duration.Sub(expected)
	if err != nil {
		return err
	}
	tolerance, _ := toolrt.NewDecimal(".003")
	if sign, err := difference.Abs().Cmp(tolerance); err != nil {
		return err
	} else if sign > 0 {
		return valueError(textBadSong)
	}
	return nil
}

// Parser — разбор аргументов build_review. Обязательные --output и группа --shots/--spec
// проверяются в Run (у общего ArgParser нет обязательных опций); usage и справка зафиксированы
// эталоном.
var Parser = toolrt.ArgParser{
	Prog:        "build_review",
	Description: "Сборка временной пробы по параметрам; @link README.md",
	Flags: []toolrt.Flag{
		{Name: "--shots", Plus: true},
		{Name: "--spec", Value: true},
		{Name: "--output", Value: true},
		{Name: "--plan-only"},
	},
	Exclusive: []string{"--shots", "--spec"},
}

// usage — строка использования: обязательная группа в круглых скобках, --output без скобок.
const usage = "использование: build_review [-h] (--shots SHOTS [SHOTS ...] | --spec SPEC)\n" +
	"                            --output OUTPUT [--plan-only]\n"

// fixUsage заменяет usage общего парсера на usage в справке и ошибках разбора.
func fixUsage(text string) string {
	return toolrt.TextMode(strings.Replace(text, Parser.Usage(), usage, 1))
}

// argError — ошибка разбора аргументов (код 2) с usage.
func argError(message string) toolcli.Output {
	return toolcli.Output{Code: 2, Stderr: toolrt.TextMode(usage + "build_review: ошибка: " + message + "\n")}
}

// Run — инструмент build_review на разрешённом корне проекта: спецификация из --spec или
// --shots, сборка или --plan-only и печать рецепта JSON.
func Run(ctx context.Context, root string, args []string) toolcli.Output {
	parsed, exit := Parser.ParseArgs(args)
	if exit != nil {
		return toolcli.Output{Code: exit.Code, Stdout: fixUsage(exit.Stdout), Stderr: fixUsage(exit.Stderr)}
	}
	outputs, hasOutput := parsed.Values["--output"]
	if !hasOutput {
		return argError("обязательные аргументы: --output")
	}
	shots, hasShots := parsed.Values["--shots"]
	specs, hasSpec := parsed.Values["--spec"]
	if !hasShots && !hasSpec {
		return argError("нужен один из аргументов: --shots --spec")
	}
	printer := &toolcli.Printer{}
	result, err := func() (*toolrt.Dict, error) {
		var spec any
		if hasSpec {
			value, err := toolrt.LoadJSONFile(specs[0])
			if err != nil {
				return nil, err
			}
			spec = value
		} else {
			list := []any{}
			for _, sid := range shots {
				list = append(list, toolcli.Record("scene", sid))
			}
			spec = toolcli.Record("schema_version", toolrt.NewInt(1), "shots", list)
		}
		return Build(ctx, spec, outputs[0], root, parsed.Bools["--plan-only"])
	}()
	if err == nil {
		text, err := toolcli.JSON(result)
		if err == nil {
			err = printer.Print(text)
		}
		if err == nil {
			return printer.Exit(0)
		}
	}
	var exception *toolrt.Exception
	switch {
	case errors.As(err, &exception) && exception.Type == toolrt.ValueError:
		return printer.Fail(err.Error())
	case toolrt.IsAny(err, toolrt.ValueError, toolrt.KeyError, toolrt.TypeError, toolrt.OSError, "StopIteration", toolrt.InvalidOperation):
		return printer.Fail(textHidden)
	}
	return printer.Crash(err)
}
