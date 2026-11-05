// Package buildanimatic — перенос tools/build_animatic/build_animatic.py и его кэша
// tools/animatic_cache/animatic_cache.py замороженного оригинала (634fd94): детерминированная
// сборка единственного полного аниматика plan/animatic/latest.
//
// Входы: канонический реестр plan/scenes.json (через internal/sceneregistry), принятые монтажи
// accepted_edit.video комплектов assets/shots/<план>, карточки plan/animatic/cards (их квитанция
// manifest.json пишется update_scene_views, internal/sceneviews) и песня source/track.mp3. Каждый
// план кодируется в отдельный фрагмент (кэш plan/animatic/.cache/segments), фрагменты склеиваются
// копированием видеопотока, песня накладывается один раз, главы и название — FFmetadata. До
// успешного завершения всех проверок прежний latest не меняется; затем в него переносятся
// ровно три файла (MP4, manifest.json, README.md), и в конце запуска обновляются текстовые
// представления проекта (internal/projectviews), как main() оригинала.
//
// Внешние программы — только FFmpeg/ffprobe через internal/mediacmd (общий запуск без консоли с
// отменой через context); параметры кодирования Encode и тексты отказов run/probe общие с
// accept_shot. Ошибки — исключения pycompat с типом и текстом Python: Run печатает их, как
// parser.exit(1, …) оригинала, а не перехваченные (TypeError, AttributeError, StopIteration) —
// трассировкой.
//
// Отличие от оригинала: пути входов в манифесте (shots[].path, path_last) всегда записываются
// через «/». Оригинал писал str(Path.relative_to) с разделителем ОС, и в Windows проверка
// свежести приложения (сравнение с путём через «/») навсегда считала сборку устаревшей. В Linux
// байты не меняются.
package buildanimatic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"songframe-go/internal/mediacmd"
	"songframe-go/internal/projectviews"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// fps — FPS оригинала: шкала монтажа и выходного видео.
const fps = mediacmd.FPS

// Тексты отказов оригинала.
const (
	textCardsReceiptMissing = "Нет манифеста карточек; обновите представления реестра сцен."
	textCardsStale          = "Карточки устарели; обновите представления реестра сцен."
	textCardSourcesChanged  = "Источники карточки изменились; обновите представления реестра сцен."
	textEndMismatch         = "Конец монтажного списка не совпадает с длительностью песни."
	textSegmentInvalid      = "Производный фрагмент не соответствует монтажному окну."
	textResultInvalid       = "Полный результат имеет неверный формат, длину или главы."
	textAudioChanged        = "Звуковая дорожка обрезана или продлена."
	textInputChanged        = "Вход изменился во время сборки."
	textCardSourceChanged   = "Источник карточки изменился во время сборки."
	textRegistryChanged     = "Реестр сцен изменился во время сборки."
	textTrackChanged        = "Исходная песня изменилась во время сборки."
	textProjectChanged      = "Данные проекта изменились во время сборки."
)

func textNoInput(name string) string {
	return "Нет допустимого входного файла: " + name
}
func textEditMismatch(shot any) string {
	return pycompat.Str(shot) + ": принятый монтаж не совпадает с окном или хешем."
}
func textClipInvalid(shot any) string {
	return pycompat.Str(shot) + ": принятый клип имеет неверный формат или число кадров."
}
func textDecodeFailed(tail string) string {
	return "Не удалось декодировать трек: " + tail
}

// readme — README.md готовой сборки: ссылки на видео и манифест.
func readme(video string) string {
	return "# Текущий полный аниматик\n\n[Видео](" + video + ") · [Манифест](manifest.json).\n\n" +
		"Сборка: страница «Аниматик» приложения. " +
		"Источники — принятые монтажные клипы сцен, карточки и песня; " +
		"правила находятся в [описании](../README.md).\n"
}

// run — run(args) оригинала (mediacmd.AnimaticRun): stdout программы, ненулевой код — ValueError с
// хвостом stderr. Переменная — точка подмены для тестов, которые меняют входы между командами
// сборки, как patch(build_animatic.run) в тестах оригинала; probe идёт через неё же.
var run = mediacmd.AnimaticRun

// probe — probe(path): JSON ffprobe потоков, формата и глав.
func probe(ctx context.Context, path string) (*pycompat.Dict, error) {
	data, err := run(ctx, mediacmd.FFprobe(), "-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	info, err := mediacmd.LoadProbe(data)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, pycompat.Raise(pycompat.TypeError, "list indices must be integers or slices, not str")
	}
	return info, nil
}

// sha — sha(path) tools/common.py: SHA-256 файла; ошибка — OSError.
func sha(path string) (string, error) { return projectviews.FileSHA(path) }

// writeText — Path.write_text(text): UTF-8 в текстовом режиме ОС (в Windows «\n» → «\r\n»).
func writeText(path, text string) error {
	data, err := pycompat.EncodeUTF8(pycompat.TextMode(text))
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o666); err != nil {
		return pycompat.OSErrorFrom(err, path)
	}
	return nil
}

// pathClass — имя класса Path в тексте TypeError деления пути на не-строку.
func pathClass() string {
	if runtime.GOOS == "windows" {
		return "WindowsPath"
	}
	return "PosixPath"
}

// local — local(root, name): допустимый входной файл внутри root (после разрешения ссылок); иначе
// ValueError «Нет допустимого входного файла: <name>». Не-строка — TypeError деления Path.
func local(root string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", pathClass(), pycompat.TypeName(name))
	}
	path := pycompat.ResolvePath(pycompat.JoinPath(root, text))
	if !pycompat.IsRelativeTo(path, pycompat.ResolvePath(root)) || !pycompat.IsFile(path) {
		return "", pycompat.New(pycompat.ValueError, textNoInput(text))
	}
	return path, nil
}

// relative — str(path.relative_to(root)) с разделителем «/» (см. отличие в описании пакета).
func relative(path, root string) (string, error) {
	text, err := pycompat.RelativeTo(path, root)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(text), nil
}

// item — container[key] с исключением Python.
func item(container any, keys ...any) (any, error) {
	value := container
	for _, key := range keys {
		next, err := pycompat.GetItem(value, key)
		if err != nil {
			return nil, err
		}
		value = next
	}
	return value, nil
}

// get — value.get(key, fallback): у не-словаря — AttributeError.
func get(value any, key string, fallback any) (any, error) {
	return pycompat.DictGet(value, key, fallback)
}

// toInt — int(value) для значения ffprobe: строка по правилам int(), целое как есть, float —
// отбрасыванием дробной части; иное — TypeError.
func toInt(value any) (pycompat.Int, error) {
	switch number := value.(type) {
	case pycompat.Int:
		return number, nil
	case bool:
		if number {
			return pycompat.NewInt(1), nil
		}
		return pycompat.NewInt(0), nil
	case float64:
		whole, err := pycompat.FloatToInt(number, false)
		if err != nil {
			return pycompat.Int{}, err
		}
		return pycompat.NewInt(whole), nil
	case string:
		parsed, ok := pycompat.ParseIntText(number)
		if !ok {
			return pycompat.Int{}, pycompat.New(pycompat.ValueError, "invalid literal for int() with base 10: "+pycompat.Repr(number))
		}
		return parsed, nil
	}
	return pycompat.Int{}, pycompat.Raise(pycompat.TypeError, "int() argument must be a string, a bytes-like object or a real number, not '%s'", pycompat.TypeName(value))
}

// frame — frame(seconds): Decimal(seconds) * 30 с округлением половины вверх до целого кадра.
func frame(seconds any) (pycompat.Int, error) {
	value, err := pycompat.NewDecimal(seconds)
	if err != nil {
		return pycompat.Int{}, err
	}
	text := value.FormatF()
	switch {
	case strings.Contains(text, "NaN"):
		return pycompat.Int{}, pycompat.New(pycompat.ValueError, "cannot convert NaN to integer")
	case strings.Contains(text, "Infinity"):
		return pycompat.Int{}, pycompat.New(pycompat.OverflowError, "cannot convert Infinity to integer")
	}
	rational, _ := new(big.Rat).SetString(text)
	rational.Mul(rational, big.NewRat(fps, 1))
	negative := rational.Sign() < 0
	rational.Abs(rational)
	rational.Add(rational, big.NewRat(1, 2))
	whole := new(big.Int).Quo(rational.Num(), rational.Denom())
	if negative {
		whole.Neg(whole)
	}
	return pycompat.IntFromBig(whole), nil
}

// streamOf — next(s for s in info["streams"] if s["codec_type"] == kind): без такого потока —
// StopIteration, как в оригинале (не перехватывается main и печатается трассировкой).
func streamOf(info any, kind string) (any, error) {
	streams, err := item(info, "streams")
	if err != nil {
		return nil, err
	}
	list, err := pycompat.Iter(streams)
	if err != nil {
		return nil, err
	}
	for _, stream := range list {
		codec, err := item(stream, "codec_type")
		if err != nil {
			return nil, err
		}
		if pycompat.Equal(codec, kind) {
			return stream, nil
		}
	}
	return nil, pycompat.New("StopIteration", "")
}

// videoMatches — (width, height, r_frame_rate, int(nb_frames)) == (1920, 1080, "30/1", frames).
// Поля читаются до сравнения, поэтому отсутствующее поле — KeyError, а нечисловой nb_frames —
// ValueError, как при построении кортежа в оригинале.
func videoMatches(stream any, frames any) (bool, error) {
	values := make([]any, 4)
	for index, key := range []string{"width", "height", "r_frame_rate", "nb_frames"} {
		value, err := item(stream, key)
		if err != nil {
			return false, err
		}
		values[index] = value
	}
	count, err := toInt(values[3])
	if err != nil {
		return false, err
	}
	values[3] = count
	expected := []any{pycompat.NewInt(1920), pycompat.NewInt(1080), "30/1", frames}
	for index := range values {
		if !pycompat.Equal(values[index], expected[index]) {
			return false, nil
		}
	}
	return true, nil
}

// plan — подготовленный монтажный план: планы реестра с выбранными входами и песня (путь от
// корня проекта и SHA-256 байтов на момент проверки).
type plan struct {
	shots    []*pycompat.Dict
	track    string
	trackSHA string
}

// PreparePlan — prepare_plan(root): планы реестра с выбранным входом каждого (media, path, sha256
// и для карточек — card_sources, keyframes, path_last/sha256_last) и песня. Готовая сцена (папка
// с manifest.json) обязана совпадать с окном и хешем: её нельзя молча заменить карточкой;
// карточки проверяются по квитанции update_scene_views. Ничего не пишет. Последним шагом
// декодирует песню FFmpeg и сверяет её длину с концом реестра.
func PreparePlan(ctx context.Context, root string) ([]*pycompat.Dict, *pycompat.Dict, error) {
	prepared, err := preparePlan(ctx, pycompat.ResolvePath(root))
	if err != nil {
		return nil, nil, err
	}
	return prepared.shots, pytool.Record("path", prepared.track, "sha256", prepared.trackSHA), nil
}

func preparePlan(ctx context.Context, root string) (*plan, error) {
	project, err := sceneregistry.LoadProject(root, false)
	if err != nil {
		return nil, err
	}
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	shots, err := sceneregistry.Shots(registry, initial)
	if err != nil {
		return nil, err
	}
	receiptPath := pycompat.JoinPath(root, "plan/animatic/cards/manifest.json")
	var receipt any
	hasReceipt := pycompat.IsFile(receiptPath)
	if hasReceipt {
		if receipt, err = pycompat.LoadJSONFile(receiptPath); err != nil {
			return nil, err
		}
	}
	checked := false
	for _, shot := range shots {
		id := shot.Value("id")
		folder := pycompat.JoinPath(root, "assets/shots", pycompat.Str(id))
		manifest := pycompat.JoinPath(folder, "manifest.json")
		var source string
		if pycompat.IsFile(manifest) {
			if source, err = acceptedEdit(root, folder, manifest, shot); err != nil {
				return nil, err
			}
		} else {
			if source, err = local(root, "plan/animatic/cards/"+pycompat.Str(id)+".png"); err != nil {
				return nil, err
			}
			if !hasReceipt {
				return nil, pycompat.New(pycompat.ValueError, textCardsReceiptMissing)
			}
			if !checked {
				if err := checkReceipt(root, receipt, project); err != nil {
					return nil, err
				}
				checked = true
			}
			if err := cardShot(root, shot, source, receipt, registry); err != nil {
				return nil, err
			}
		}
		digest, err := sha(source)
		if err != nil {
			return nil, err
		}
		shot.Set("sha256", digest)
	}
	track, err := local(root, "source/track.mp3")
	if err != nil {
		return nil, err
	}
	duration, err := decodedAudioDuration(ctx, track)
	if err != nil {
		return nil, err
	}
	end, err := pycompat.NewDecimal(shots[len(shots)-1].Value("end"))
	if err != nil {
		return nil, err
	}
	difference, err := duration.Sub(end)
	if err != nil {
		return nil, err
	}
	step, _ := pycompat.DecimalInt(1).Div(pycompat.DecimalInt(fps))
	if order, err := difference.Abs().Cmp(step); err != nil {
		return nil, err
	} else if order > 0 {
		return nil, pycompat.New(pycompat.ValueError, textEndMismatch)
	}
	trackSHA, err := sha(track)
	if err != nil {
		return nil, err
	}
	return &plan{shots: shots, track: "source/track.mp3", trackSHA: trackSHA}, nil
}

// acceptedEdit — ветка готовой сцены prepare_plan: accepted_edit.video комплекта совпадает с
// планом по ID, SHA-256, fps и числу кадров; план получает media=video и путь клипа.
func acceptedEdit(root, folder, manifest string, shot *pycompat.Dict) (string, error) {
	pkg, err := pycompat.LoadJSONFile(manifest)
	if err != nil {
		return "", err
	}
	edit, err := item(pkg, "accepted_edit")
	if err != nil {
		return "", err
	}
	name, err := item(edit, "video", "path")
	if err != nil {
		return "", err
	}
	source, err := local(folder, name)
	if err != nil {
		return "", err
	}
	mismatch := false
	packageShot, err := item(pkg, "shot")
	if err != nil {
		return "", err
	}
	if !pycompat.Equal(packageShot, shot.Value("id")) {
		mismatch = true
	}
	if !mismatch {
		digest, err := sha(source)
		if err != nil {
			return "", err
		}
		expected, err := item(edit, "video", "sha256")
		if err != nil {
			return "", err
		}
		mismatch = !pycompat.Equal(digest, expected)
	}
	if !mismatch {
		rate, err := item(edit, "fps")
		if err != nil {
			return "", err
		}
		mismatch = !pycompat.Equal(rate, pycompat.NewInt(fps))
	}
	if !mismatch {
		frames, err := item(edit, "frames")
		if err != nil {
			return "", err
		}
		mismatch = !pycompat.Equal(frames, shot.Value("frames"))
	}
	if mismatch {
		return "", pycompat.New(pycompat.ValueError, textEditMismatch(shot.Value("id")))
	}
	path, err := relative(source, root)
	if err != nil {
		return "", err
	}
	shot.Set("media", "video")
	shot.Set("path", path)
	return source, nil
}

// checkReceipt — однократная проверка квитанции карточек: реестр, значимые поля проекта
// (project_inputs без animatic_video) и хеши всех референсов из reference_hashes.
func checkReceipt(root string, receipt any, project *pycompat.Dict) error {
	stored, err := item(receipt, "registry_sha256")
	if err != nil {
		return err
	}
	current, err := sha(pycompat.JoinPath(root, "plan/scenes.json"))
	if err != nil {
		return err
	}
	stale := !pycompat.Equal(stored, current)
	if !stale {
		match, err := projectviews.ProjectInputsMatch(receipt, project, false)
		if err != nil {
			return err
		}
		stale = !match
	}
	if !stale {
		hashes, err := get(receipt, "reference_hashes", pycompat.NewDict())
		if err != nil {
			return err
		}
		dict, ok := hashes.(*pycompat.Dict)
		if !ok {
			return pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'items'", pycompat.TypeName(hashes))
		}
		for _, name := range dict.Keys() {
			path, err := local(root, name)
			if err != nil {
				return err
			}
			digest, err := sha(path)
			if err != nil {
				return err
			}
			if !pycompat.Equal(digest, dict.Value(name)) {
				stale = true
				break
			}
		}
	}
	if stale {
		return pycompat.New(pycompat.ValueError, textCardsStale)
	}
	return nil
}

// cardShot — ветка карточки prepare_plan: запись квитанции для плана совпадает с PNG; план
// получает media=card (или keyframes при last), путь карточки и card_sources — фактически
// нарисованные источники (опоры из квитанции либо использованные референсы реестра).
func cardShot(root string, shot *pycompat.Dict, source string, receipt any, registry *pycompat.Dict) error {
	entry, err := item(receipt, "cards", shot.Value("id"))
	if err != nil {
		return err
	}
	expected, err := item(entry, "sha256")
	if err != nil {
		return err
	}
	digest, err := sha(source)
	if err != nil {
		return err
	}
	if !pycompat.Equal(expected, digest) {
		return pycompat.New(pycompat.ValueError, textCardsStale)
	}
	path, err := relative(source, root)
	if err != nil {
		return err
	}
	shot.Set("media", "card")
	shot.Set("path", path)
	keyframes, err := get(entry, "keyframes", nil)
	if err != nil {
		return err
	}
	sources := pycompat.NewDict()
	if pycompat.Truthy(keyframes) {
		shot.Set("keyframes", keyframes)
		frames, err := pycompat.Iter(keyframes)
		if err != nil {
			return err
		}
		for _, frame := range frames {
			name, err := item(frame, "path")
			if err != nil {
				return err
			}
			value, err := item(frame, "sha256")
			if err != nil {
				return err
			}
			if err := setKey(sources, name, value); err != nil {
				return err
			}
		}
	} else {
		ids, err := cardReferences(shot, registry)
		if err != nil {
			return err
		}
		for _, id := range ids {
			name, err := item(registry, "references", id, "path")
			if err != nil {
				return err
			}
			value, err := item(receipt, "reference_hashes", name)
			if err != nil {
				return err
			}
			if err := setKey(sources, name, value); err != nil {
				return err
			}
		}
	}
	shot.Set("card_sources", sources)
	for _, name := range sources.Keys() {
		path, err := local(root, name)
		if err != nil {
			return err
		}
		digest, err := sha(path)
		if err != nil {
			return err
		}
		if !pycompat.Equal(digest, sources.Value(name)) {
			return pycompat.New(pycompat.ValueError, textCardSourcesChanged)
		}
	}
	last, err := get(entry, "last", nil)
	if err != nil {
		return err
	}
	if pycompat.Truthy(last) {
		name, err := item(last, "path")
		if err != nil {
			return err
		}
		lastPath, err := local(root, name)
		if err != nil {
			return err
		}
		stored, err := item(last, "sha256")
		if err != nil {
			return err
		}
		digest, err := sha(lastPath)
		if err != nil {
			return err
		}
		if !pycompat.Equal(stored, digest) {
			return pycompat.New(pycompat.ValueError, textCardsStale)
		}
		relativeLast, err := relative(lastPath, root)
		if err != nil {
			return err
		}
		shot.Set("media", "keyframes")
		shot.Set("path_last", relativeLast)
		shot.Set("sha256_last", digest)
	}
	return nil
}

// setKey — dict[key] = value для ключа из JSON: словари pycompat строковые, иной хешируемый ключ
// оригинал принял бы, но такой путь не прошёл бы последующий local (TypeError деления Path).
func setKey(dict *pycompat.Dict, key, value any) error {
	if _, err := pycompat.HashKey(key); err != nil {
		return err
	}
	text, ok := key.(string)
	if !ok {
		return pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", pathClass(), pycompat.TypeName(key))
	}
	dict.Set(text, value)
	return nil
}

// cardReferences — sorted(ref for ref in set(refs) | {card.primary_reference} if ref in
// registry["references"]): референсы, которые карточка действительно использует.
func cardReferences(shot, registry *pycompat.Dict) ([]any, error) {
	refs, err := get(shot, "refs", []any{})
	if err != nil {
		return nil, err
	}
	items, err := pycompat.Iter(refs)
	if err != nil {
		return nil, err
	}
	card, err := get(shot, "card", pycompat.NewDict())
	if err != nil {
		return nil, err
	}
	primary, err := get(card, "primary_reference", nil)
	if err != nil {
		return nil, err
	}
	references, err := item(registry, "references")
	if err != nil {
		return nil, err
	}
	unique := pycompat.NewSet()
	for _, ref := range append(append([]any(nil), items...), primary) {
		if err := unique.Add(ref); err != nil {
			return nil, err
		}
	}
	used := []any{}
	for _, ref := range unique.Items() {
		found, err := pycompat.Contains(references, ref)
		if err != nil {
			return nil, err
		}
		if found {
			used = append(used, ref)
		}
	}
	return pycompat.SortByKeys(used, used)
}

// decodedAudioDuration — decoded_audio_duration(path) tools/common.py: длительность
// декодированного звука на шкале разметки (моно 16 кГц s16le, 32000 байт в секунду). Начальная
// метка MP3 start_time не вычитается.
func decodedAudioDuration(ctx context.Context, path string) (pycompat.Decimal, error) {
	result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-")
	if err != nil {
		return pycompat.Decimal{}, err
	}
	if result.Code != 0 {
		return pycompat.Decimal{}, pycompat.New(pycompat.ValueError, textDecodeFailed(mediacmd.Tail(result.Stderr, 1200)))
	}
	return pycompat.DecimalInt(int64(len(result.Stdout))).Div(pycompat.DecimalInt(32000))
}

// mediaCounts — media_counts(shots): сводка входов по видам.
func mediaCounts(shots []*pycompat.Dict) (video, cards, keyframes int64) {
	for _, shot := range shots {
		switch shot.Value("media") {
		case "video":
			video++
		case "card":
			cards++
		case "keyframes":
			keyframes++
		}
	}
	return video, cards, keyframes
}

// segment — segment(cache, root, shot, toolchain): фрагмент плана в едином формате кодирования
// из кэша или новый. Готовый клип не обрезается и не меняет скорость; карточка масштабируется в
// 1920×1080 и удерживается окно плана; карточка опор — удержание первой опоры, растворение в
// последнюю и удержание последней (40 / 20 / 40 % окна). Новый фрагмент проверяется ffprobe.
func segment(ctx context.Context, cache *artifactCache, root string, shot *pycompat.Dict, toolchain string) (string, error) {
	media := shot.Value("media")
	vf := "setpts=PTS-STARTPTS,setsar=1"
	if media == "card" || media == "keyframes" {
		vf = "scale=1920:1080:flags=lanczos,setsar=1,setpts=PTS-STARTPTS"
	}
	recipe := pytool.Record(
		"schema", pycompat.NewInt(2), "sha256", shot.Value("sha256"), "media", media, "frames", shot.Value("frames"),
		"filter", vf, "encode", pytool.Strings(mediacmd.Encode), "toolchain", toolchain,
	)
	if media == "keyframes" {
		recipe.Set("sha256_last", shot.Value("sha256_last"))
	}
	frames := shot.Value("frames")
	produce := func(path string) (any, error) {
		source := pycompat.JoinPath(root, pycompat.Str(shot.Value("path")))
		if media == "video" {
			info, err := probe(ctx, source)
			if err != nil {
				return nil, err
			}
			stream, err := streamOf(info, "video")
			if err != nil {
				return nil, err
			}
			ok, err := videoMatches(stream, frames)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, pycompat.New(pycompat.ValueError, textClipInvalid(shot.Value("id")))
			}
		}
		count, isInt := frames.(pycompat.Int)
		total, fits := count.Int64()
		if !isInt || !fits {
			return nil, pycompat.Raise(pycompat.TypeError, "frames плана %s не целое число", pycompat.Repr(shot.Value("id")))
		}
		args := []string{"-v", "error", "-nostdin", "-n", "-threads", "2"}
		if media == "keyframes" {
			offset := max(0, min(int64(math.RoundToEven(float64(total)*0.4)), total-1))
			fade := max(1, min(int64(math.RoundToEven(float64(total)*0.2)), total-offset))
			graph := "[0:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[a];" +
				"[1:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[b];" +
				"[a][b]xfade=transition=fade:duration=" + seconds(fade) + ":" +
				"offset=" + seconds(offset) + ",setpts=PTS-STARTPTS[v]"
			args = append(args, "-loop", "1", "-framerate", strconv.Itoa(fps), "-t", seconds(offset+fade), "-i", source,
				"-loop", "1", "-framerate", strconv.Itoa(fps), "-t", seconds(total-offset), "-i",
				pycompat.JoinPath(root, pycompat.Str(shot.Value("path_last"))),
				"-filter_complex", graph, "-map", "[v]")
		} else {
			if media == "video" {
				args = append(args, "-i", source)
			} else {
				args = append(args, "-loop", "1", "-framerate", strconv.Itoa(fps), "-i", source)
			}
			args = append(args, "-map", "0:v:0", "-vf", vf)
		}
		args = append(append(args, mediacmd.Encode...), "-frames:v", strconv.FormatInt(total, 10), path)
		if _, err := run(ctx, mediacmd.FFmpeg(), args...); err != nil {
			return nil, err
		}
		info, err := probe(ctx, path)
		if err != nil {
			return nil, err
		}
		stream, err := streamOf(info, "video")
		if err != nil {
			return nil, err
		}
		ok, err := videoMatches(stream, frames)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, pycompat.New(pycompat.ValueError, textSegmentInvalid)
		}
		return pytool.Record("frames", frames), nil
	}
	return cache.obtain("segments", recipe, ".mp4", produce)
}

// seconds — f"{frames / FPS:.6f}": время в секундах с шестью знаками.
func seconds(frames int64) string {
	return strconv.FormatFloat(float64(frames)/fps, 'f', 6, 64)
}

// metadataSpecial — символы FFmetadata, которые экранируются обратной косой чертой.
var metadataSpecial = regexp.MustCompile(`([\\=;#])`)

// Build — build(root, plan_only): проверка входов и, без planOnly, сборка latest. Отчёт — для
// --plan-only сводка входов, иначе результат сборки (порядок ключей оригинала). out получает
// строки «<план> из кэша|подготовлена» по мере готовности фрагментов (print оригинала). Прежний
// latest заменяется только после всех проверок; временные файлы сборки удаляются в любом случае.
func Build(ctx context.Context, root string, planOnly bool, out func(line string) error) (*pycompat.Dict, error) {
	root = pycompat.ResolvePath(root)
	registryDigest, err := sha(pycompat.JoinPath(root, "plan/scenes.json"))
	if err != nil {
		return nil, err
	}
	project, err := sceneregistry.LoadProject(root, false)
	if err != nil {
		return nil, err
	}
	inputs, err := projectviews.ProjectInputs(project, true)
	if err != nil {
		return nil, err
	}
	videoName, err := item(project, "animatic_video")
	if err != nil {
		return nil, err
	}
	prepared, err := preparePlan(ctx, root)
	if err != nil {
		return nil, err
	}
	shots := prepared.shots
	video, cards, keyframes := mediaCounts(shots)
	if planOnly {
		return pytool.Record("shots", pycompat.NewInt(int64(len(shots))), "video", pycompat.NewInt(video), "cards", pycompat.NewInt(cards),
			"keyframes", pycompat.NewInt(keyframes), "build_started", false), nil
	}
	started := time.Now()
	cache := &artifactCache{directory: pycompat.JoinPath(root, "plan/animatic/.cache")}
	versionOutput, err := run(ctx, mediacmd.FFmpeg(), "-version")
	if err != nil {
		return nil, err
	}
	toolchain, err := pycompat.DecodeUTF8(versionOutput)
	if err != nil {
		return nil, err
	}
	parts := make([]string, 0, len(shots))
	for _, shot := range shots {
		part, err := segment(ctx, cache, root, shot, toolchain)
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
		status := "подготовлена"
		if cache.events[len(cache.events)-1].hit {
			status = "из кэша"
		}
		if err := out(pycompat.Str(shot.Value("id")) + " " + status); err != nil {
			return nil, err
		}
	}
	result, err := assemble(ctx, root, cache, shots, prepared, project, inputs, pycompat.Str(videoName), registryDigest, toolchain)
	if err != nil {
		return nil, err
	}
	created, reused := int64(0), int64(0)
	for _, event := range cache.events {
		if event.hit {
			reused++
		} else {
			created++
		}
	}
	elapsed := math.Round(time.Since(started).Seconds()*1000) / 1000
	return pytool.Record(
		"status", "passed", "video_sha256", result.Value("video_sha256"), "shots", pycompat.NewInt(int64(len(shots))),
		"video", pycompat.NewInt(video), "cards", pycompat.NewInt(cards), "keyframes", pycompat.NewInt(keyframes),
		"segments_created", pycompat.NewInt(created), "segments_reused", pycompat.NewInt(reused), "seconds", elapsed,
	), nil
}

// assemble — вторая половина build(): склейка во временной папке кэша, проверки результата и
// неизменности входов, публикация трёх файлов в latest. Возвращает записанный манифест.
func assemble(ctx context.Context, root string, cache *artifactCache, shots []*pycompat.Dict, prepared *plan, project *pycompat.Dict,
	inputs *pycompat.Dict, videoName, registryDigest, toolchain string) (*pycompat.Dict, error) {
	base := pycompat.JoinPath(root, "plan/animatic")
	if err := os.MkdirAll(cache.directory, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, cache.directory)
	}
	// До успешного завершения кодирования и проверок прежний latest остаётся доступным.
	// Временные файлы и кэш не являются дополнительными версиями.
	work, err := os.MkdirTemp(cache.directory, "build-")
	if err != nil {
		return nil, pycompat.OSErrorFrom(err, cache.directory)
	}
	defer os.RemoveAll(work)
	listing := pycompat.JoinPath(work, "concat.txt")
	var concat strings.Builder
	for _, part := range parts(cache) {
		concat.WriteString("file '" + strings.ReplaceAll(part, "'", `'\''`) + "'\n")
	}
	if err := writeText(listing, concat.String()); err != nil {
		return nil, err
	}
	// Спецсимволы названия не должны менять структуру FFmetadata.
	title := metadataSpecial.ReplaceAllString(pycompat.Str(project.Value("name"))+" — текущий аниматик", `\$1`)
	chapters := []string{";FFMETADATA1", "title=" + title}
	for _, shot := range shots {
		start, err := frame(shot.Value("start"))
		if err != nil {
			return nil, err
		}
		end, err := frame(shot.Value("end"))
		if err != nil {
			return nil, err
		}
		chapters = append(chapters, "[CHAPTER]", "TIMEBASE=1/30", "START="+start.String(), "END="+end.String(), "title="+pycompat.Str(shot.Value("id")))
	}
	metadata := pycompat.JoinPath(work, "chapters.ffmeta")
	if err := writeText(metadata, strings.Join(chapters, "\n")+"\n"); err != nil {
		return nil, err
	}
	video := pycompat.JoinPath(work, videoName)
	track := pycompat.JoinPath(root, prepared.track)
	if _, err := run(ctx, mediacmd.FFmpeg(),
		"-v", "error", "-nostdin", "-n", "-f", "concat", "-safe", "0", "-i", listing, "-i", track, "-i", metadata,
		"-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "2", "-map_chapters", "2",
		// Входной MP3 может быть моно или с другой частотой: выход всегда соответствует контракту сборки.
		"-c:v", "copy", "-c:a", "aac", "-ac", "2", "-ar", "44100", "-threads", "1", "-b:a", "192k",
		"-af", "asetpts=PTS-STARTPTS", "-movflags", "+faststart", video); err != nil {
		return nil, err
	}
	info, err := probe(ctx, video)
	if err != nil {
		return nil, err
	}
	v, err := streamOf(info, "video")
	if err != nil {
		return nil, err
	}
	a, err := streamOf(info, "audio")
	if err != nil {
		return nil, err
	}
	if err := checkResult(info, v, a, shots); err != nil {
		return nil, err
	}
	if _, err := run(ctx, mediacmd.FFmpeg(), "-v", "error", "-threads", "2", "-i", video, "-f", "null", "-"); err != nil {
		return nil, err
	}
	if err := checkInputs(root, shots, prepared, registryDigest, inputs); err != nil {
		return nil, err
	}
	manifest, err := manifestOf(v, a, shots, prepared, inputs, videoName, registryDigest, toolchain, video)
	if err != nil {
		return nil, err
	}
	text, err := pycompat.DumpsJSON(manifest, pycompat.Indented)
	if err != nil {
		return nil, err
	}
	if err := writeText(pycompat.JoinPath(work, "manifest.json"), text+"\n"); err != nil {
		return nil, err
	}
	if err := writeText(pycompat.JoinPath(work, "README.md"), readme(videoName)); err != nil {
		return nil, err
	}
	if err := publish(base, work, videoName); err != nil {
		return nil, err
	}
	return manifest, nil
}

// parts — пути фрагментов в порядке планов (события кэша одного запуска).
func parts(cache *artifactCache) []string {
	result := make([]string, len(cache.events))
	for index, event := range cache.events {
		result[index] = event.path
	}
	return result
}

// checkResult — проверки готового MP4: 1920×1080, 30 к/с, число кадров до конца последнего
// плана на кадровой сетке, по главе на план, стерео 44,1 кГц и звук песни до её конца
// (расхождение не больше 3 мс).
func checkResult(info, v, a any, shots []*pycompat.Dict) error {
	end, err := frame(shots[len(shots)-1].Value("end"))
	if err != nil {
		return err
	}
	ok, err := videoMatches(v, end)
	if err != nil {
		return err
	}
	if ok {
		chapters, err := item(info, "chapters")
		if err != nil {
			return err
		}
		list, err := pycompat.Iter(chapters)
		if err != nil {
			return err
		}
		ok = len(list) == len(shots)
	}
	if ok {
		channels, err := item(a, "channels")
		if err != nil {
			return err
		}
		ok = pycompat.Equal(channels, pycompat.NewInt(2))
	}
	if ok {
		rate, err := item(a, "sample_rate")
		if err != nil {
			return err
		}
		ok = pycompat.Equal(rate, "44100")
	}
	if !ok {
		return pycompat.New(pycompat.ValueError, textResultInvalid)
	}
	duration, err := item(a, "duration")
	if err != nil {
		return err
	}
	audio, err := pycompat.NewDecimal(duration)
	if err != nil {
		return err
	}
	last, err := pycompat.NewDecimal(shots[len(shots)-1].Value("end"))
	if err != nil {
		return err
	}
	difference, err := audio.Sub(last)
	if err != nil {
		return err
	}
	limit, _ := pycompat.NewDecimal(".003")
	if order, err := difference.Abs().Cmp(limit); err != nil {
		return err
	} else if order > 0 {
		return pycompat.New(pycompat.ValueError, textAudioChanged)
	}
	return nil
}

// checkInputs — входы не изменились за время кодирования: выбранные клипы и карточки, источники
// карточек, реестр, песня и значимые поля проекта (настройки генерации в них не входят).
func checkInputs(root string, shots []*pycompat.Dict, prepared *plan, registryDigest string, inputs *pycompat.Dict) error {
	for _, shot := range shots {
		digest, err := sha(pycompat.JoinPath(root, pycompat.Str(shot.Value("path"))))
		if err != nil {
			return err
		}
		changed := !pycompat.Equal(digest, shot.Value("sha256"))
		if !changed && shot.Value("media") == "keyframes" {
			last, err := sha(pycompat.JoinPath(root, pycompat.Str(shot.Value("path_last"))))
			if err != nil {
				return err
			}
			changed = !pycompat.Equal(last, shot.Value("sha256_last"))
		}
		if changed {
			return pycompat.New(pycompat.ValueError, textInputChanged)
		}
	}
	for _, shot := range shots {
		sources, _ := shot.Value("card_sources").(*pycompat.Dict)
		for _, name := range sources.Keys() {
			path, err := local(root, name)
			if err != nil {
				return err
			}
			digest, err := sha(path)
			if err != nil {
				return err
			}
			if !pycompat.Equal(digest, sources.Value(name)) {
				return pycompat.New(pycompat.ValueError, textCardSourceChanged)
			}
		}
	}
	if digest, err := sha(pycompat.JoinPath(root, "plan/scenes.json")); err != nil {
		return err
	} else if digest != registryDigest {
		return pycompat.New(pycompat.ValueError, textRegistryChanged)
	}
	if digest, err := sha(pycompat.JoinPath(root, prepared.track)); err != nil {
		return err
	} else if digest != prepared.trackSHA {
		return pycompat.New(pycompat.ValueError, textTrackChanged)
	}
	// Смена провайдера во время кодирования не меняет входы текущего монтажа.
	project, err := sceneregistry.LoadProject(root, false)
	if err != nil {
		return err
	}
	current, err := projectviews.ProjectInputs(project, true)
	if err != nil {
		return err
	}
	if !pycompat.Equal(current, inputs) {
		return pycompat.New(pycompat.ValueError, textProjectChanged)
	}
	return nil
}

// manifestOf — манифест latest/manifest.json в порядке полей оригинала.
func manifestOf(v, a any, shots []*pycompat.Dict, prepared *plan, inputs *pycompat.Dict, videoName, registryDigest, toolchain, video string) (*pycompat.Dict, error) {
	frames, err := item(v, "nb_frames")
	if err != nil {
		return nil, err
	}
	total, err := toInt(frames)
	if err != nil {
		return nil, err
	}
	videoDuration, err := floatItem(v, "duration")
	if err != nil {
		return nil, err
	}
	audioDuration, err := floatItem(a, "duration")
	if err != nil {
		return nil, err
	}
	hashes := pycompat.NewDict()
	for _, shot := range shots {
		hashes.Set(pycompat.Str(shot.Value("path")), shot.Value("sha256"))
	}
	for _, shot := range shots {
		if shot.Value("media") == "keyframes" {
			hashes.Set(pycompat.Str(shot.Value("path_last")), shot.Value("sha256_last"))
		}
	}
	hashes.Set(prepared.track, prepared.trackSHA)
	for _, shot := range shots {
		sources, _ := shot.Value("card_sources").(*pycompat.Dict)
		for _, name := range sources.Keys() {
			hashes.Set(name, sources.Value(name))
		}
	}
	videoSHA, err := sha(video)
	if err != nil {
		return nil, err
	}
	toolchainSum := sha256.Sum256([]byte(toolchain))
	list := make([]any, len(shots))
	for index, shot := range shots {
		list[index] = shot
	}
	return pytool.Record(
		"schema_version", pycompat.NewInt(1), "version", "latest", "path_base", "project_root",
		"resolution", []any{pycompat.NewInt(1920), pycompat.NewInt(1080)}, "fps", pycompat.NewInt(fps),
		"total_frames", total, "video_duration", videoDuration, "source_audio", prepared.track,
		"source_audio_sha256", prepared.trackSHA, "source_audio_duration", audioDuration,
		"scene_registry_sha256", registryDigest, "project_inputs", inputs, "shots", list, "source_hashes", hashes,
		"video_file", videoName, "toolchain_sha256", hex.EncodeToString(toolchainSum[:]), "video_sha256", videoSHA,
	), nil
}

// floatItem — float(container[key]).
func floatItem(container any, key string) (float64, error) {
	value, err := item(container, key)
	if err != nil {
		return 0, err
	}
	return pycompat.Float(value)
}

// publish — перенос трёх файлов готовой сборки в latest, удаление прежней HTML-страницы и
// прежнего MP4 из манифеста при смене имени. Список склейки и описание глав остаются во временной
// папке. Прежний манифест читается до переноса: повреждённый JSON останавливает публикацию.
func publish(base, work, videoName string) error {
	latest := pycompat.JoinPath(base, "latest")
	if err := os.Mkdir(latest, 0o777); err != nil && !(os.IsExist(err) && pycompat.IsDir(latest)) {
		return pycompat.OSErrorFrom(err, latest)
	}
	previousManifest := pycompat.JoinPath(latest, "manifest.json")
	var previous any
	if pycompat.IsFile(previousManifest) {
		value, err := pycompat.LoadJSONFile(previousManifest)
		if err != nil {
			return err
		}
		if previous, err = get(value, "video_file", nil); err != nil {
			return err
		}
	}
	for _, name := range []string{videoName, "manifest.json", "README.md"} {
		from, to := pycompat.JoinPath(work, name), pycompat.JoinPath(latest, name)
		if err := os.Rename(from, to); err != nil {
			return pycompat.OSErrorFrom(err, from)
		}
	}
	// Прежняя HTML-страница больше не входит в сборку; убираем её после успешной проверки.
	if err := unlinkMissingOK(pycompat.JoinPath(latest, "index.html")); err != nil {
		return err
	}
	// При смене настроенного имени прежний результат не становится архивом. Удаляем только
	// известный MP4 из манифеста, после публикации новой сборки.
	if pycompat.Truthy(previous) && !pycompat.Equal(previous, videoName) {
		name, ok := previous.(string)
		if !ok {
			return pycompat.Raise(pycompat.TypeError, "expected str, bytes or os.PathLike object, not %s", pycompat.TypeName(previous))
		}
		if pycompat.PathName(name) == name && strings.HasSuffix(name, ".mp4") {
			if err := unlinkMissingOK(pycompat.JoinPath(latest, name)); err != nil {
				return err
			}
		}
	}
	return nil
}

// unlinkMissingOK — Path.unlink(missing_ok=True).
func unlinkMissingOK(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		if pycompat.IsDir(path) {
			return pycompat.OSErrorFrom(syscall.EISDIR, path)
		}
		return pycompat.OSErrorFrom(err, path)
	}
	return nil
}

// Parser — argparse оригинала.
var Parser = pycompat.ArgParser{
	Prog:        "build_animatic.py",
	Description: "Детерминированная сборка единственного latest; @link README.md",
	Flags:       []pycompat.Flag{{Name: "--plan-only", Help: "Проверить входы без записи и кодирования."}},
}

// Run — main() build_animatic.py на разрешённом корне проекта: сборка (или --plan-only),
// обновление текстовых представлений после сборки и отчёт JSON. ValueError, KeyError и OSError —
// текст в stderr с кодом 1 (строки готовности фрагментов остаются в stdout); прочие исключения —
// трассировка.
func Run(ctx context.Context, root string, args []string) pytool.Output {
	parsed, exit := pytool.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &pytool.Printer{}
	planOnly := parsed.Bools["--plan-only"]
	fail := func(err error) pytool.Output {
		if pycompat.IsAny(err, pycompat.ValueError, pycompat.KeyError, pycompat.OSError) {
			return printer.Fail(err.Error())
		}
		return printer.Crash(err)
	}
	report, err := Build(ctx, root, planOnly, printer.Print)
	if err != nil {
		return fail(err)
	}
	if !planOnly {
		if err := writeDocuments(root); err != nil {
			return fail(err)
		}
	}
	text, err := pytool.JSON(report)
	if err != nil {
		return printer.Crash(err)
	}
	if err := printer.Print(text); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}

// writeDocuments — запись представлений project_views после сборки: файл пишется, только если его
// нет или текст отличается (сравнение после чтения в текстовом режиме, как read_text).
func writeDocuments(root string) error {
	sources := projectviews.NewSources(root)
	prepared, err := projectviews.Prepare(sources)
	if err != nil {
		return err
	}
	documents, err := projectviews.Documents(sources, prepared)
	if err != nil {
		return err
	}
	for _, document := range documents {
		path := pycompat.JoinPath(root, document.Path)
		if pycompat.Exists(path) {
			current, err := pycompat.ReadText(path)
			if err != nil {
				return err
			}
			if current == document.Text {
				continue
			}
		}
		if err := writeText(path, document.Text); err != nil {
			return err
		}
	}
	return nil
}
