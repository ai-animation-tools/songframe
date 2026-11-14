// Package buildanimatic детерминированно собирает единственный полный аниматик
// plan/animatic/latest (инструмент build_animatic) с кэшем проверенных фрагментов.
//
// Входы: канонический реестр plan/scenes.json (через internal/sceneregistry), принятые монтажи
// accepted_edit.video комплектов assets/shots/<план>, карточки plan/animatic/cards (их квитанция
// manifest.json пишется update_scene_views, internal/sceneviews) и песня source/track.mp3. Каждый
// план кодируется в отдельный фрагмент (кэш plan/animatic/.cache/segments), фрагменты склеиваются
// копированием видеопотока, песня накладывается один раз, главы и название — FFmetadata. До
// успешного завершения всех проверок прежний latest не меняется; затем в него переносятся
// ровно три файла (MP4, manifest.json, README.md), и в конце запуска обновляются текстовые
// представления проекта (internal/projectviews).
//
// Внешние программы — только FFmpeg/ffprobe через internal/mediacmd (общий запуск без консоли с
// отменой через context); параметры кодирования Encode и тексты отказов run/probe общие с
// accept_shot. Ошибки — исключения toolrt с типом и текстом, зафиксированными эталоном:
// ожидаемые Run печатает текстом с кодом 1, а не перехваченные (TypeError, AttributeError,
// StopIteration) — необработанной ошибкой «Ошибка: текст».
//
// Пути входов в манифесте (shots[].path, path_last) всегда записываются через «/»: проверка
// свежести приложения сравнивает их с путём через «/», и разделитель ОС в Windows навсегда
// делал бы сборку устаревшей.
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
	"strconv"
	"strings"
	"syscall"
	"time"

	"songframe/internal/filedigest"
	"songframe/internal/mediacmd"
	"songframe/internal/projectviews"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Тексты отказов сборки; зафиксированы эталоном build-animatic.
const (
	textCardsReceiptMissing = "Нет манифеста карточек; обновите представления реестра планов."
	textCardsStale          = "Карточки устарели; обновите представления реестра планов."
	textCardSourcesChanged  = "Источники карточки изменились; обновите представления реестра планов."
	textEndMismatch         = "Конец монтажного списка не совпадает с длительностью песни."
	textSegmentInvalid      = "Производный фрагмент не соответствует монтажному окну."
	textResultInvalid       = "Полный результат имеет неверный формат, длину или главы."
	textAudioChanged        = "Звуковая дорожка обрезана или продлена."
	textInputChanged        = "Вход изменился во время сборки."
	textCardSourceChanged   = "Источник карточки изменился во время сборки."
	textRegistryChanged     = "Реестр планов изменился во время сборки."
	textTrackChanged        = "Исходная песня изменилась во время сборки."
	textProjectChanged      = "Данные проекта изменились во время сборки."
)

func textNoInput(name string) string {
	return "Нет допустимого входного файла: " + name
}
func textEditMismatch(shot any) string {
	return toolrt.Str(shot) + ": принятый монтаж не совпадает с окном или хешем."
}
func textClipInvalid(shot any) string {
	return toolrt.Str(shot) + ": принятый клип имеет неверный формат или число кадров."
}
func textDecodeFailed(tail string) string {
	return "Не удалось декодировать трек: " + tail
}

// readme — README.md готовой сборки: ссылки на видео и манифест.
func readme(video string) string {
	return "# Текущий полный аниматик\n\n[Видео](" + video + ") · [Манифест](manifest.json).\n\n" +
		"Сборка: страница «Аниматик» приложения. " +
		"Источники — принятые монтажные клипы планов, карточки и песня; " +
		"правила находятся в [описании](../README.md).\n"
}

// run — запуск FFmpeg/ffprobe (mediacmd.AnimaticRun): stdout программы, ненулевой код — ValueError
// с хвостом stderr. Переменная — точка подмены для тестов, которые меняют входы между командами
// сборки; probe идёт через неё же.
var run = mediacmd.AnimaticRun

// probe — JSON ffprobe потоков, формата и глав файла path.
func probe(ctx context.Context, path string) (*toolrt.Dict, error) {
	data, err := run(ctx, mediacmd.FFprobe(), "-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	info, err := mediacmd.LoadProbe(data)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, toolrt.Raise(toolrt.TypeError, "индекс списка должен быть целым числом, получено: строка")
	}
	return info, nil
}

// sha — SHA-256 файла; ошибка — OSError.
func sha(path string) (string, error) { return projectviews.FileSHA(path) }

// writeText записывает текст в UTF-8 в текстовом режиме ОС (в Windows «\n» → «\r\n»).
func writeText(path, text string) error {
	data, err := toolrt.EncodeUTF8(toolrt.TextMode(text))
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o666); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}

// local — допустимый входной файл name внутри root (после разрешения ссылок); иначе
// ValueError «Нет допустимого входного файла: <name>». Не-строка — TypeError склейки пути.
func local(root string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(name))
	}
	path := toolrt.ResolvePath(toolrt.JoinPath(root, text))
	if !toolrt.IsRelativeTo(path, toolrt.ResolvePath(root)) || !toolrt.IsFile(path) {
		return "", toolrt.New(toolrt.ValueError, textNoInput(text))
	}
	return path, nil
}

// relative — путь path относительно root с разделителем «/» (см. описание пакета).
func relative(path, root string) (string, error) {
	text, err := toolrt.RelativeTo(path, root)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(text), nil
}

// item — значение по цепочке ключей keys; отсутствие ключа и неверный тип — исключения
// toolrt.GetItem.
func item(container any, keys ...any) (any, error) {
	value := container
	for _, key := range keys {
		next, err := toolrt.GetItem(value, key)
		if err != nil {
			return nil, err
		}
		value = next
	}
	return value, nil
}

// get — значение словаря по ключу или fallback; у не-словаря — AttributeError.
func get(value any, key string, fallback any) (any, error) {
	return toolrt.DictGet(value, key, fallback)
}

// toInt — целое из значения ffprobe: строка — десятичное целое toolrt.ParseIntText, целое и
// bool как есть, float — отбрасыванием дробной части; иное — TypeError. Тексты отказов
// зафиксированы эталоном.
func toInt(value any) (toolrt.Int, error) {
	switch number := value.(type) {
	case toolrt.Int:
		return number, nil
	case bool:
		if number {
			return toolrt.NewInt(1), nil
		}
		return toolrt.NewInt(0), nil
	case float64:
		whole, err := toolrt.FloatToInt(number, false)
		if err != nil {
			return toolrt.Int{}, err
		}
		return toolrt.NewInt(whole), nil
	case string:
		parsed, ok := toolrt.ParseIntText(number)
		if !ok {
			return toolrt.Int{}, toolrt.New(toolrt.ValueError, "не целое число: "+toolrt.Repr(number))
		}
		return parsed, nil
	}
	return toolrt.Int{}, toolrt.Raise(toolrt.TypeError, "ожидается число или строка, получено: %s", toolrt.TypeName(value))
}

// frame — секунды как точное десятичное число, умноженные на частоту кадров проекта fps, с
// округлением половины от нуля до целого кадра.
func frame(seconds any, fps int64) (toolrt.Int, error) {
	value, err := toolrt.NewDecimal(seconds)
	if err != nil {
		return toolrt.Int{}, err
	}
	text := value.FormatF()
	switch {
	case strings.Contains(text, "NaN"):
		return toolrt.Int{}, toolrt.New(toolrt.ValueError, "NaN нельзя преобразовать в целое число")
	case strings.Contains(text, "Infinity"):
		return toolrt.Int{}, toolrt.New(toolrt.OverflowError, "бесконечность нельзя преобразовать в целое число")
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
	return toolrt.IntFromBig(whole), nil
}

// streamOf — первый поток сводки info с codec_type, равным kind; без такого потока —
// StopIteration (не перехватывается Run и печатается необработанной ошибкой).
func streamOf(info any, kind string) (any, error) {
	streams, err := item(info, "streams")
	if err != nil {
		return nil, err
	}
	list, err := toolrt.Iter(streams)
	if err != nil {
		return nil, err
	}
	for _, stream := range list {
		codec, err := item(stream, "codec_type")
		if err != nil {
			return nil, err
		}
		if toolrt.Equal(codec, kind) {
			return stream, nil
		}
	}
	return nil, toolrt.New("StopIteration", "")
}

// videoMatches — совпадают ли width, height, r_frame_rate и целое nb_frames потока с 1920, 1080,
// «30/1» и frames.
// Поля читаются до сравнения, поэтому отсутствующее поле — KeyError, а нечисловой nb_frames —
// ValueError.
func videoMatches(stream any, frames any, fps int64) (bool, error) {
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
	expected := []any{toolrt.NewInt(1920), toolrt.NewInt(1080), strconv.FormatInt(fps, 10) + "/1", frames}
	for index := range values {
		if !toolrt.Equal(values[index], expected[index]) {
			return false, nil
		}
	}
	return true, nil
}

// plan — подготовленный монтажный план: планы реестра с выбранными входами и песня (путь от
// корня проекта и SHA-256 байтов на момент проверки).
type plan struct {
	shots    []*toolrt.Dict
	track    string
	trackSHA string
	// fps — частота кадров проекта: шкала монтажа, фрагментов и выходного видео.
	fps int64
}

// PreparePlan — планы реестра с выбранным входом каждого (media, path, sha256
// и для карточек — card_sources, keyframes, path_last/sha256_last) и песня. Готовая сцена (папка
// с manifest.json) обязана совпадать с окном и хешем: её нельзя молча заменить карточкой;
// карточки проверяются по квитанции update_scene_views. Ничего не пишет. Последним шагом
// декодирует песню FFmpeg и сверяет её длину с концом реестра.
func PreparePlan(ctx context.Context, root string) ([]*toolrt.Dict, *toolrt.Dict, error) {
	prepared, err := preparePlan(ctx, toolrt.ResolvePath(root))
	if err != nil {
		return nil, nil, err
	}
	return prepared.shots, toolcli.Record("path", prepared.track, "sha256", prepared.trackSHA), nil
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
	if err := sceneregistry.SameFPS(root, registry); err != nil {
		return nil, err
	}
	fps := sceneregistry.FPS(registry.Value("fps"))
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	shots, err := sceneregistry.Shots(registry, initial)
	if err != nil {
		return nil, err
	}
	receiptPath := toolrt.JoinPath(root, "plan/animatic/cards/manifest.json")
	var receipt any
	hasReceipt := toolrt.IsFile(receiptPath)
	if hasReceipt {
		if receipt, err = toolrt.LoadJSONFile(receiptPath); err != nil {
			return nil, err
		}
	}
	checked := false
	for _, shot := range shots {
		id := shot.Value("id")
		folder := toolrt.JoinPath(root, "assets/shots", toolrt.Str(id))
		manifest := toolrt.JoinPath(folder, "manifest.json")
		var source string
		if toolrt.IsFile(manifest) {
			if source, err = acceptedEdit(root, folder, manifest, shot, fps); err != nil {
				return nil, err
			}
		} else {
			if source, err = local(root, "plan/animatic/cards/"+toolrt.Str(id)+".png"); err != nil {
				return nil, err
			}
			if !hasReceipt {
				return nil, toolrt.New(toolrt.ValueError, textCardsReceiptMissing)
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
	end, err := toolrt.NewDecimal(shots[len(shots)-1].Value("end"))
	if err != nil {
		return nil, err
	}
	difference, err := duration.Sub(end)
	if err != nil {
		return nil, err
	}
	step, _ := toolrt.DecimalInt(1).Div(toolrt.DecimalInt(fps))
	if order, err := difference.Abs().Cmp(step); err != nil {
		return nil, err
	} else if order > 0 {
		return nil, toolrt.New(toolrt.ValueError, textEndMismatch)
	}
	trackSHA, err := sha(track)
	if err != nil {
		return nil, err
	}
	return &plan{shots: shots, track: "source/track.mp3", trackSHA: trackSHA, fps: fps}, nil
}

// acceptedEdit — ветка готовой сцены prepare_plan: accepted_edit.video комплекта совпадает с
// планом по ID, SHA-256, fps и числу кадров; план получает media=video и путь клипа.
func acceptedEdit(root, folder, manifest string, shot *toolrt.Dict, fps int64) (string, error) {
	pkg, err := toolrt.LoadJSONFile(manifest)
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
	if !toolrt.Equal(packageShot, shot.Value("id")) {
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
		mismatch = !toolrt.Equal(digest, expected)
		// Указатель Git LFS вместо клипа — незагруженное содержимое клона, а не чужой монтаж.
		if mismatch {
			display, err := relative(source, root)
			if err != nil {
				display = source
			}
			if text, ok := filedigest.LFSPointerProblem(source, display); ok {
				return "", toolrt.New(toolrt.ValueError, text)
			}
		}
	}
	if !mismatch {
		rate, err := item(edit, "fps")
		if err != nil {
			return "", err
		}
		mismatch = !toolrt.Equal(rate, toolrt.NewInt(fps))
	}
	if !mismatch {
		frames, err := item(edit, "frames")
		if err != nil {
			return "", err
		}
		mismatch = !toolrt.Equal(frames, shot.Value("frames"))
	}
	if mismatch {
		return "", toolrt.New(toolrt.ValueError, textEditMismatch(shot.Value("id")))
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
func checkReceipt(root string, receipt any, project *toolrt.Dict) error {
	stored, err := item(receipt, "registry_sha256")
	if err != nil {
		return err
	}
	current, err := sha(toolrt.JoinPath(root, "plan/scenes.json"))
	if err != nil {
		return err
	}
	stale := !toolrt.Equal(stored, current)
	if !stale {
		match, err := projectviews.ProjectInputsMatch(receipt, project, false)
		if err != nil {
			return err
		}
		stale = !match
	}
	if !stale {
		hashes, err := get(receipt, "reference_hashes", toolrt.NewDict())
		if err != nil {
			return err
		}
		dict, ok := hashes.(*toolrt.Dict)
		if !ok {
			return toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(hashes))
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
			if !toolrt.Equal(digest, dict.Value(name)) {
				stale = true
				break
			}
		}
	}
	if stale {
		return toolrt.New(toolrt.ValueError, textCardsStale)
	}
	return nil
}

// cardShot — ветка карточки prepare_plan: запись квитанции для плана совпадает с PNG; план
// получает media=card (или keyframes при last), путь карточки и card_sources — фактически
// нарисованные источники (опоры из квитанции либо использованные референсы реестра).
func cardShot(root string, shot *toolrt.Dict, source string, receipt any, registry *toolrt.Dict) error {
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
	if !toolrt.Equal(expected, digest) {
		return toolrt.New(toolrt.ValueError, textCardsStale)
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
	sources := toolrt.NewDict()
	if toolrt.Truthy(keyframes) {
		shot.Set("keyframes", keyframes)
		frames, err := toolrt.Iter(keyframes)
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
		if !toolrt.Equal(digest, sources.Value(name)) {
			return toolrt.New(toolrt.ValueError, textCardSourcesChanged)
		}
	}
	last, err := get(entry, "last", nil)
	if err != nil {
		return err
	}
	if toolrt.Truthy(last) {
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
		if !toolrt.Equal(stored, digest) {
			return toolrt.New(toolrt.ValueError, textCardsStale)
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

// setKey записывает value в словарь по ключу из JSON. Словари toolrt строковые; нестроковый ключ
// здесь не встречается, потому что такой путь отвергает уже последующий local.
func setKey(dict *toolrt.Dict, key, value any) error {
	if _, err := toolrt.HashKey(key); err != nil {
		return err
	}
	text, ok := key.(string)
	if !ok {
		return toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(key))
	}
	dict.Set(text, value)
	return nil
}

// cardReferences — отсортированные уникальные refs плана вместе с card.primary_reference,
// которые есть в registry["references"]: референсы, которые карточка действительно использует.
func cardReferences(shot, registry *toolrt.Dict) ([]any, error) {
	refs, err := get(shot, "refs", []any{})
	if err != nil {
		return nil, err
	}
	items, err := toolrt.Iter(refs)
	if err != nil {
		return nil, err
	}
	card, err := get(shot, "card", toolrt.NewDict())
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
	unique := toolrt.NewSet()
	for _, ref := range append(append([]any(nil), items...), primary) {
		if err := unique.Add(ref); err != nil {
			return nil, err
		}
	}
	used := []any{}
	for _, ref := range unique.Items() {
		found, err := toolrt.Contains(references, ref)
		if err != nil {
			return nil, err
		}
		if found {
			used = append(used, ref)
		}
	}
	return toolrt.SortByKeys(used, used)
}

// decodedAudioDuration — длительность декодированного звука на шкале разметки (моно 16 кГц
// s16le, 32000 байт в секунду). Начальная
// метка MP3 start_time не вычитается.
func decodedAudioDuration(ctx context.Context, path string) (toolrt.Decimal, error) {
	result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-")
	if err != nil {
		return toolrt.Decimal{}, err
	}
	if result.Code != 0 {
		return toolrt.Decimal{}, toolrt.New(toolrt.ValueError, textDecodeFailed(mediacmd.Tail(result.Stderr, 1200)))
	}
	return toolrt.DecimalInt(int64(len(result.Stdout))).Div(toolrt.DecimalInt(32000))
}

// mediaCounts — сводка входов планов по видам.
func mediaCounts(shots []*toolrt.Dict) (video, cards, keyframes int64) {
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
func segment(ctx context.Context, cache *artifactCache, root string, shot *toolrt.Dict, toolchain string, fps int64) (string, error) {
	media := shot.Value("media")
	vf := "setpts=PTS-STARTPTS,setsar=1"
	if media == "card" || media == "keyframes" {
		vf = "scale=1920:1080:flags=lanczos,setsar=1,setpts=PTS-STARTPTS"
	}
	recipe := toolcli.Record(
		"schema", toolrt.NewInt(2), "sha256", shot.Value("sha256"), "media", media, "frames", shot.Value("frames"),
		"filter", vf, "encode", toolcli.Strings(mediacmd.Encode(fps)), "toolchain", toolchain,
	)
	if media == "keyframes" {
		recipe.Set("sha256_last", shot.Value("sha256_last"))
	}
	frames := shot.Value("frames")
	produce := func(path string) (any, error) {
		source := toolrt.JoinPath(root, toolrt.Str(shot.Value("path")))
		if media == "video" {
			info, err := probe(ctx, source)
			if err != nil {
				return nil, err
			}
			stream, err := streamOf(info, "video")
			if err != nil {
				return nil, err
			}
			ok, err := videoMatches(stream, frames, fps)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, toolrt.New(toolrt.ValueError, textClipInvalid(shot.Value("id")))
			}
		}
		count, isInt := frames.(toolrt.Int)
		total, fits := count.Int64()
		if !isInt || !fits {
			return nil, toolrt.Raise(toolrt.TypeError, "frames плана %s не целое число", toolrt.Repr(shot.Value("id")))
		}
		args := []string{"-v", "error", "-nostdin", "-n", "-threads", "2"}
		if media == "keyframes" {
			offset := max(0, min(int64(math.RoundToEven(float64(total)*0.4)), total-1))
			fade := max(1, min(int64(math.RoundToEven(float64(total)*0.2)), total-offset))
			graph := "[0:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[a];" +
				"[1:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[b];" +
				"[a][b]xfade=transition=fade:duration=" + seconds(fade, fps) + ":" +
				"offset=" + seconds(offset, fps) + ",setpts=PTS-STARTPTS[v]"
			args = append(args, "-loop", "1", "-framerate", strconv.FormatInt(fps, 10), "-t", seconds(offset+fade, fps), "-i", source,
				"-loop", "1", "-framerate", strconv.FormatInt(fps, 10), "-t", seconds(total-offset, fps), "-i",
				toolrt.JoinPath(root, toolrt.Str(shot.Value("path_last"))),
				"-filter_complex", graph, "-map", "[v]")
		} else {
			if media == "video" {
				args = append(args, "-i", source)
			} else {
				args = append(args, "-loop", "1", "-framerate", strconv.FormatInt(fps, 10), "-i", source)
			}
			args = append(args, "-map", "0:v:0", "-vf", vf)
		}
		args = append(append(args, mediacmd.Encode(fps)...), "-frames:v", strconv.FormatInt(total, 10), path)
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
		ok, err := videoMatches(stream, frames, fps)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, toolrt.New(toolrt.ValueError, textSegmentInvalid)
		}
		return toolcli.Record("frames", frames), nil
	}
	return cache.obtain("segments", recipe, ".mp4", produce)
}

// seconds — время frames кадров при частоте fps в секундах с шестью знаками.
func seconds(frames, fps int64) string {
	return strconv.FormatFloat(float64(frames)/float64(fps), 'f', 6, 64)
}

// metadataSpecial — символы FFmetadata, которые экранируются обратной косой чертой.
var metadataSpecial = regexp.MustCompile(`([\\=;#])`)

// Build проверяет входы и, без planOnly, собирает latest. Отчёт — для --plan-only сводка входов,
// иначе результат сборки (порядок ключей зафиксирован эталоном). out получает строки
// «<план> из кэша|подготовлена» по мере готовности фрагментов. Прежний
// latest заменяется только после всех проверок; временные файлы сборки удаляются в любом случае.
func Build(ctx context.Context, root string, planOnly bool, out func(line string) error) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	registryDigest, err := sha(toolrt.JoinPath(root, "plan/scenes.json"))
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
		return toolcli.Record("shots", toolrt.NewInt(int64(len(shots))), "video", toolrt.NewInt(video), "cards", toolrt.NewInt(cards),
			"keyframes", toolrt.NewInt(keyframes), "build_started", false), nil
	}
	started := time.Now()
	cache := &artifactCache{directory: toolrt.JoinPath(root, "plan/animatic/.cache")}
	versionOutput, err := run(ctx, mediacmd.FFmpeg(), "-version")
	if err != nil {
		return nil, err
	}
	toolchain, err := toolrt.DecodeUTF8(versionOutput)
	if err != nil {
		return nil, err
	}
	parts := make([]string, 0, len(shots))
	for _, shot := range shots {
		part, err := segment(ctx, cache, root, shot, toolchain, prepared.fps)
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
		status := "подготовлена"
		if cache.events[len(cache.events)-1].hit {
			status = "из кэша"
		}
		if err := out(toolrt.Str(shot.Value("id")) + " " + status); err != nil {
			return nil, err
		}
	}
	result, err := assemble(ctx, root, cache, shots, prepared, project, inputs, toolrt.Str(videoName), registryDigest, toolchain)
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
	return toolcli.Record(
		"status", "passed", "video_sha256", result.Value("video_sha256"), "shots", toolrt.NewInt(int64(len(shots))),
		"video", toolrt.NewInt(video), "cards", toolrt.NewInt(cards), "keyframes", toolrt.NewInt(keyframes),
		"segments_created", toolrt.NewInt(created), "segments_reused", toolrt.NewInt(reused), "seconds", elapsed,
	), nil
}

// assemble — вторая половина build(): склейка во временной папке кэша, проверки результата и
// неизменности входов, публикация трёх файлов в latest. Возвращает записанный манифест.
func assemble(ctx context.Context, root string, cache *artifactCache, shots []*toolrt.Dict, prepared *plan, project *toolrt.Dict,
	inputs *toolrt.Dict, videoName, registryDigest, toolchain string) (*toolrt.Dict, error) {
	base := toolrt.JoinPath(root, "plan/animatic")
	if err := os.MkdirAll(cache.directory, 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, cache.directory)
	}
	// До успешного завершения кодирования и проверок прежний latest остаётся доступным.
	// Временные файлы и кэш не являются дополнительными версиями.
	work, err := os.MkdirTemp(cache.directory, "build-")
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, cache.directory)
	}
	defer os.RemoveAll(work)
	listing := toolrt.JoinPath(work, "concat.txt")
	var concat strings.Builder
	for _, part := range parts(cache) {
		concat.WriteString("file '" + strings.ReplaceAll(part, "'", `'\''`) + "'\n")
	}
	if err := writeText(listing, concat.String()); err != nil {
		return nil, err
	}
	// Спецсимволы названия не должны менять структуру FFmetadata.
	title := metadataSpecial.ReplaceAllString(toolrt.Str(project.Value("name"))+" — текущий аниматик", `\$1`)
	chapters := []string{";FFMETADATA1", "title=" + title}
	for _, shot := range shots {
		start, err := frame(shot.Value("start"), prepared.fps)
		if err != nil {
			return nil, err
		}
		end, err := frame(shot.Value("end"), prepared.fps)
		if err != nil {
			return nil, err
		}
		chapters = append(chapters, "[CHAPTER]", "TIMEBASE=1/"+strconv.FormatInt(prepared.fps, 10), "START="+start.String(), "END="+end.String(), "title="+toolrt.Str(shot.Value("id")))
	}
	metadata := toolrt.JoinPath(work, "chapters.ffmeta")
	if err := writeText(metadata, strings.Join(chapters, "\n")+"\n"); err != nil {
		return nil, err
	}
	video := toolrt.JoinPath(work, videoName)
	track := toolrt.JoinPath(root, prepared.track)
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
	if err := checkResult(info, v, a, shots, prepared.fps); err != nil {
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
	text, err := toolrt.DumpsJSON(manifest, toolrt.Indented)
	if err != nil {
		return nil, err
	}
	if err := writeText(toolrt.JoinPath(work, "manifest.json"), text+"\n"); err != nil {
		return nil, err
	}
	if err := writeText(toolrt.JoinPath(work, "README.md"), readme(videoName)); err != nil {
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

// checkResult — проверки готового MP4: 1920×1080, частота проекта, число кадров до конца последнего
// плана на кадровой сетке, по главе на план, стерео 44,1 кГц и звук песни до её конца
// (расхождение не больше 3 мс).
func checkResult(info, v, a any, shots []*toolrt.Dict, fps int64) error {
	end, err := frame(shots[len(shots)-1].Value("end"), fps)
	if err != nil {
		return err
	}
	ok, err := videoMatches(v, end, fps)
	if err != nil {
		return err
	}
	if ok {
		chapters, err := item(info, "chapters")
		if err != nil {
			return err
		}
		list, err := toolrt.Iter(chapters)
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
		ok = toolrt.Equal(channels, toolrt.NewInt(2))
	}
	if ok {
		rate, err := item(a, "sample_rate")
		if err != nil {
			return err
		}
		ok = toolrt.Equal(rate, "44100")
	}
	if !ok {
		return toolrt.New(toolrt.ValueError, textResultInvalid)
	}
	duration, err := item(a, "duration")
	if err != nil {
		return err
	}
	audio, err := toolrt.NewDecimal(duration)
	if err != nil {
		return err
	}
	last, err := toolrt.NewDecimal(shots[len(shots)-1].Value("end"))
	if err != nil {
		return err
	}
	difference, err := audio.Sub(last)
	if err != nil {
		return err
	}
	limit, _ := toolrt.NewDecimal(".003")
	if order, err := difference.Abs().Cmp(limit); err != nil {
		return err
	} else if order > 0 {
		return toolrt.New(toolrt.ValueError, textAudioChanged)
	}
	return nil
}

// checkInputs — входы не изменились за время кодирования: выбранные клипы и карточки, источники
// карточек, реестр, песня и значимые поля проекта (настройки генерации в них не входят).
func checkInputs(root string, shots []*toolrt.Dict, prepared *plan, registryDigest string, inputs *toolrt.Dict) error {
	for _, shot := range shots {
		digest, err := sha(toolrt.JoinPath(root, toolrt.Str(shot.Value("path"))))
		if err != nil {
			return err
		}
		changed := !toolrt.Equal(digest, shot.Value("sha256"))
		if !changed && shot.Value("media") == "keyframes" {
			last, err := sha(toolrt.JoinPath(root, toolrt.Str(shot.Value("path_last"))))
			if err != nil {
				return err
			}
			changed = !toolrt.Equal(last, shot.Value("sha256_last"))
		}
		if changed {
			return toolrt.New(toolrt.ValueError, textInputChanged)
		}
	}
	for _, shot := range shots {
		sources, _ := shot.Value("card_sources").(*toolrt.Dict)
		for _, name := range sources.Keys() {
			path, err := local(root, name)
			if err != nil {
				return err
			}
			digest, err := sha(path)
			if err != nil {
				return err
			}
			if !toolrt.Equal(digest, sources.Value(name)) {
				return toolrt.New(toolrt.ValueError, textCardSourceChanged)
			}
		}
	}
	if digest, err := sha(toolrt.JoinPath(root, "plan/scenes.json")); err != nil {
		return err
	} else if digest != registryDigest {
		return toolrt.New(toolrt.ValueError, textRegistryChanged)
	}
	if digest, err := sha(toolrt.JoinPath(root, prepared.track)); err != nil {
		return err
	} else if digest != prepared.trackSHA {
		return toolrt.New(toolrt.ValueError, textTrackChanged)
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
	if !toolrt.Equal(current, inputs) {
		return toolrt.New(toolrt.ValueError, textProjectChanged)
	}
	return nil
}

// manifestOf — манифест latest/manifest.json; порядок полей зафиксирован эталоном.
func manifestOf(v, a any, shots []*toolrt.Dict, prepared *plan, inputs *toolrt.Dict, videoName, registryDigest, toolchain, video string) (*toolrt.Dict, error) {
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
	hashes := toolrt.NewDict()
	for _, shot := range shots {
		hashes.Set(toolrt.Str(shot.Value("path")), shot.Value("sha256"))
	}
	for _, shot := range shots {
		if shot.Value("media") == "keyframes" {
			hashes.Set(toolrt.Str(shot.Value("path_last")), shot.Value("sha256_last"))
		}
	}
	hashes.Set(prepared.track, prepared.trackSHA)
	for _, shot := range shots {
		sources, _ := shot.Value("card_sources").(*toolrt.Dict)
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
	return toolcli.Record(
		"schema_version", toolrt.NewInt(1), "version", "latest", "path_base", "project_root",
		"resolution", []any{toolrt.NewInt(1920), toolrt.NewInt(1080)}, "fps", toolrt.NewInt(prepared.fps),
		"total_frames", total, "video_duration", videoDuration, "source_audio", prepared.track,
		"source_audio_sha256", prepared.trackSHA, "source_audio_duration", audioDuration,
		"scene_registry_sha256", registryDigest, "project_inputs", inputs, "shots", list, "source_hashes", hashes,
		"video_file", videoName, "toolchain_sha256", hex.EncodeToString(toolchainSum[:]), "video_sha256", videoSHA,
	), nil
}

// floatItem — значение container по ключу key как float64 (toolrt.Float).
func floatItem(container any, key string) (float64, error) {
	value, err := item(container, key)
	if err != nil {
		return 0, err
	}
	return toolrt.Float(value)
}

// publish — перенос трёх файлов готовой сборки в latest, удаление index.html и
// прежнего MP4 из манифеста при смене имени. Список склейки и описание глав остаются во временной
// папке. Прежний манифест читается до переноса: повреждённый JSON останавливает публикацию.
func publish(base, work, videoName string) error {
	latest := toolrt.JoinPath(base, "latest")
	if err := os.Mkdir(latest, 0o777); err != nil && !(os.IsExist(err) && toolrt.IsDir(latest)) {
		return toolrt.OSErrorFrom(err, latest)
	}
	previousManifest := toolrt.JoinPath(latest, "manifest.json")
	var previous any
	if toolrt.IsFile(previousManifest) {
		value, err := toolrt.LoadJSONFile(previousManifest)
		if err != nil {
			return err
		}
		if previous, err = get(value, "video_file", nil); err != nil {
			return err
		}
	}
	for _, name := range []string{videoName, "manifest.json", "README.md"} {
		from, to := toolrt.JoinPath(work, name), toolrt.JoinPath(latest, name)
		if err := os.Rename(from, to); err != nil {
			return toolrt.OSErrorFrom(err, from)
		}
	}
	// index.html не входит в сборку; если он лежит в latest, убираем его после успешной проверки.
	if err := unlinkMissingOK(toolrt.JoinPath(latest, "index.html")); err != nil {
		return err
	}
	// При смене настроенного имени прежний результат не становится архивом. Удаляем только
	// известный MP4 из манифеста, после публикации новой сборки.
	if toolrt.Truthy(previous) && !toolrt.Equal(previous, videoName) {
		name, ok := previous.(string)
		if !ok {
			return toolrt.Raise(toolrt.TypeError, "путь должен быть строкой, получено: %s", toolrt.TypeName(previous))
		}
		if toolrt.PathName(name) == name && strings.HasSuffix(name, ".mp4") {
			if err := unlinkMissingOK(toolrt.JoinPath(latest, name)); err != nil {
				return err
			}
		}
	}
	return nil
}

// unlinkMissingOK удаляет файл; отсутствующий файл не ошибка, каталог — OSError EISDIR.
func unlinkMissingOK(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		if toolrt.IsDir(path) {
			return toolrt.OSErrorFrom(syscall.EISDIR, path)
		}
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}

// Parser — разбор аргументов инструмента build_animatic.
var Parser = toolrt.ArgParser{
	Prog:        "build_animatic",
	Description: "Детерминированная сборка единственного latest; @link README.md",
	Flags: []toolrt.Flag{
		{Name: "--plan-only", Help: "Проверить входы без записи и кодирования."},
		{Name: "--from", Value: true, Metavar: "ПЛАН", Help: "Первый план фрагмента для просмотра (вместе с --to)."},
		{Name: "--to", Value: true, Metavar: "ПЛАН", Help: "Последний план фрагмента для просмотра (вместе с --from)."},
	},
}

// Run — инструмент build_animatic на разрешённом корне проекта: сборка (или --plan-only),
// обновление текстовых представлений после сборки и отчёт JSON; с --from/--to — только фрагмент
// для просмотра (BuildFragment), представления проекта при этом не пишутся. ValueError, KeyError и OSError —
// текст в stderr с кодом 1 (строки готовности фрагментов остаются в stdout); прочие исключения —
// необработанная ошибка «Ошибка: текст».
func Run(ctx context.Context, root string, args []string) toolcli.Output {
	parsed, exit := toolcli.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &toolcli.Printer{}
	planOnly := parsed.Bools["--plan-only"]
	fail := func(err error) toolcli.Output {
		if toolrt.IsAny(err, toolrt.ValueError, toolrt.KeyError, toolrt.OSError) {
			return printer.Fail(err.Error())
		}
		return printer.Crash(err)
	}
	from, to := parsed.Values["--from"], parsed.Values["--to"]
	fragment := len(from) > 0 || len(to) > 0
	var report *toolrt.Dict
	var err error
	switch {
	case fragment && (len(from) == 0 || len(to) == 0):
		return printer.Fail(textFragmentRange)
	case fragment && planOnly:
		return printer.Fail(textFragmentOnly)
	case fragment:
		report, err = BuildFragment(ctx, root, from[0], to[0], printer.Print)
	default:
		report, err = Build(ctx, root, planOnly, printer.Print)
	}
	if err != nil {
		return fail(err)
	}
	if !planOnly && !fragment {
		if err := writeDocuments(root); err != nil {
			return fail(err)
		}
	}
	text, err := toolcli.JSON(report)
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
		path := toolrt.JoinPath(root, document.Path)
		if toolrt.Exists(path) {
			current, err := toolrt.ReadText(path)
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
