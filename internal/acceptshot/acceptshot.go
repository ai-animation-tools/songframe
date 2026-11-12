// Package acceptshot принимает генерацию плана: инструмент accept_shot собирает комплект
// assets/shots/Mxx по контракту assets. Режим --full копирует скачанный оригинал, уже
// совпадающий с окном плана и шкалой 30 кадров/с, побайтово; --cut НАЧАЛО:КОНЕЦ и --review
// (рецепт пробы build_review) с --speed, --hold-first и --hold-last рендерят участок FFmpeg по
// фильтру, который считает buildreview.Prepare для одного плана. Рядом сохраняются входы, промпт,
// снимок запроса, индекс подготовки и манифест с параметрами обработки; затем записывается
// отпечаток приёмки, комплект проверяется validate_package, наблюдается расход, обновляются
// представления и (с --clean) удаляются рабочие пакеты плана и использованная проба.
//
// ffprobe и ffmpeg ищутся через internal/mediacmd (пара компонентов приложения или имена в PATH);
// без них приёмка завершается общей ошибкой медиа (FileNotFoundError). Опция --preparation есть
// только в справке: приложение её не передаёт, и разбор её не поддерживает.
package acceptshot

import (
	"context"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"songframe/internal/assetpackage"
	"songframe/internal/buildreview"
	"songframe/internal/checkworkspace"
	"songframe/internal/costcheck"
	"songframe/internal/mediacmd"
	"songframe/internal/sceneregistry"
	"songframe/internal/sceneviews"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Now — время UTC для имени папки прежнего комплекта (подменяется в тестах).
var Now = func() time.Time { return time.Now().UTC() }

// Тексты отказов и примечаний манифеста; их видит пользователь, формулировки зафиксированы
// эталоном testdata/golden/production-tools.
const (
	audioPolicy = "Звук генератора сохранён в оригинале; в монтаже используется непрерывная исходная песня."
	rebuildNote = "Принятые байты восстанавливаются копированием video; повтор фильтров сохраняет монтаж, " +
		"но не обещает побайтово одинаковое перекодирование."
	textHidden     = "Ошибка файлов попытки или медиа; сырой вывод скрыт."
	textSourceMiss = "Укажите пакет (--package) или папку попытки (--work-dir)."
	textCutMissing = "Укажите участок: --review или --cut НАЧАЛО:КОНЕЦ на сетке 30 кадров/с."
	textCutFormat  = "Участок задаётся как НАЧАЛО:КОНЕЦ."
	textBadEdit    = "Принятый монтаж имеет неверный формат или число кадров."
)

// roleLabels — подписи ролей опорных кадров в манифесте комплекта.
var roleLabels = map[string]string{"first": "Первый кадр", "last": "Последний кадр", "middle": "Промежуточный кадр"}

// Parser — разбор аргументов accept_shot общим toolrt.ArgParser. Он знает одну
// необязательную группу: ею служит группа режима (--review | --cut | --full); группа источника,
// обязательность обеих групп и type=int удержаний проверяются в Run, usage и справка заданы
// готовым текстом. --preparation приложение не передаёт, и он не разбирается.
var Parser = toolrt.ArgParser{
	Prog:        "accept_shot",
	Description: "Перенос принятой генерации в комплект assets по контракту; @link README.md",
	Flags: []toolrt.Flag{
		{Name: "--package", Value: true, Help: "Папка пакета shot_workflow с workflow.json"},
		{Name: "--work-dir", Value: true, Help: "Папка попытки media_request с request.json и attempt.json"},
		{Name: "--review", Value: true, Help: "JSON рецепта пробы build_review с этим планом"},
		{Name: "--cut", Value: true, Metavar: "НАЧАЛО:КОНЕЦ", Help: "Участок оригинала на сетке 30 кадров/с, конец исключительно"},
		{Name: "--full", Help: "Оригинал уже совпадает с окном и FPS: побайтовая копия"},
		{Name: "--speed", Value: true},
		{Name: "--hold-first", Value: true},
		{Name: "--hold-last", Value: true},
		{Name: "--audio", Value: true, Help: "speech.wav для речевого плана"},
		{Name: "--audio-recipe", Value: true, Help: "audio-recipe.json к WAV"},
		{Name: "--clean", Help: "После проверки удалить все пакеты плана в plan/batches, переданный пакет очереди, пробу и пустые папки проб"},
		{Name: "--no-views", Help: "Не обновлять представления"},
		{Name: "--replace", Help: "Заменить уже принятый комплект: прежний переезжает в assets/replaced/Mxx/<время>"},
	},
	Positionals: []toolrt.Positional{{Name: "shot"}},
	Exclusive:   []string{"--review", "--cut", "--full"},
}

// usage и help — готовые тексты строки использования и справки (обязательные группы в круглых
// скобках и --preparation), зафиксированные эталоном testdata/golden/production-tools: общий
// ArgParser такие группы не печатает.
const usage = "использование: accept_shot [-h] (--package PACKAGE | --work-dir WORK_DIR)\n" +
	"                           (--review REVIEW | --cut НАЧАЛО:КОНЕЦ | --full)\n" +
	"                           [--speed SPEED] [--hold-first HOLD_FIRST]\n" +
	"                           [--hold-last HOLD_LAST] [--audio AUDIO]\n" +
	"                           [--audio-recipe AUDIO_RECIPE]\n" +
	"                           [--preparation [PREPARATION ...]] [--clean]\n" +
	"                           [--no-views] [--replace]\n" +
	"                           shot\n"

const help = usage + `
Перенос принятой генерации в комплект assets по контракту; @link README.md

аргументы:
  shot

параметры:
  -h, --help            показать справку и выйти
  --package PACKAGE     Папка пакета shot_workflow с workflow.json
  --work-dir WORK_DIR   Папка попытки media_request с request.json и
                        attempt.json
  --review REVIEW       JSON рецепта пробы build_review с этим планом
  --cut НАЧАЛО:КОНЕЦ    Участок оригинала на сетке 30 кадров/с, конец
                        исключительно
  --full                Оригинал уже совпадает с окном и FPS: побайтовая копия
  --speed SPEED
  --hold-first HOLD_FIRST
  --hold-last HOLD_LAST
  --audio AUDIO         speech.wav для речевого плана
  --audio-recipe AUDIO_RECIPE
                        audio-recipe.json к WAV
  --preparation [PREPARATION ...]
                        Дополнительные файлы подготовки: промпты кадров,
                        промежуточные изображения
  --clean               После проверки удалить все пакеты плана в
                        plan/batches, переданный пакет очереди, пробу и пустые
                        папки проб
  --no-views            Не обновлять представления
  --replace             Заменить уже принятый комплект: прежний переезжает в
                        assets/replaced/Mxx/<время>
`

// argError — отказ разбора аргументов: строка использования, «accept_shot: ошибка: …» и код 2.
func argError(message string) toolcli.Output {
	return toolcli.Output{Code: 2, Stderr: toolrt.TextMode(usage + "accept_shot: ошибка: " + message + "\n")}
}

func valueError(message string) error { return toolrt.New(toolrt.ValueError, message) }

func dict(value any) *toolrt.Dict {
	result, _ := value.(*toolrt.Dict)
	return result
}

// descriptor — {"path", "sha256", "bytes"} файла name в папке directory.
func descriptor(directory, name string) (*toolrt.Dict, error) {
	path := toolrt.JoinPath(directory, name)
	digest, err := assetpackage.FileSHA256(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, path)
	}
	return toolcli.Record("path", name, "sha256", digest, "bytes", toolrt.NewInt(info.Size())), nil
}

// copyFile копирует содержимое файла source в target (права 0644, без метаданных).
func copyFile(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	return nil
}

// writeJSON записывает JSON с отступом 2, без экранирования не-ASCII и с переводом строки в конце.
func writeJSON(path string, value any) error {
	text, err := toolrt.DumpsJSON(value, toolrt.Indented)
	if err != nil {
		return err
	}
	data, err := toolrt.EncodeUTF8(text + "\n")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}

// loadJSON читает и разбирает JSON-файл общим toolrt.LoadJSONFile.
func loadJSON(path string) (any, error) { return toolrt.LoadJSONFile(path) }

// run — run(args) build_animatic (общий mediacmd.AnimaticRun).
func run(ctx context.Context, program string, args ...string) ([]byte, error) {
	return mediacmd.AnimaticRun(ctx, program, args...)
}

// probe — probe(path) build_animatic (общий mediacmd.AnimaticProbe).
func probe(ctx context.Context, path string) (*toolrt.Dict, error) {
	return mediacmd.AnimaticProbe(ctx, path)
}

// attemptData — разрешённый источник приёмки: пакет, папка попытки, запрос, состояние и workflow.
type attemptData struct {
	packageDir, workDir string
	request, attempt    *toolrt.Dict
	workflow            *toolrt.Dict
}

// absolute — путь относительно корня проекта, разрешённый до реального.
func absolute(root, path string) string {
	if !filepath.IsAbs(path) {
		path = toolrt.JoinPath(root, path)
	}
	return toolrt.ResolvePath(path)
}

// resolvePackage — папка попытки с request.json и attempt.json; из пакета shot_workflow
// берётся request_dir.
func resolvePackage(packageDir, workDir, root string) (attemptData, error) {
	result := attemptData{}
	if packageDir != "" {
		result.packageDir = absolute(root, packageDir)
		value, err := loadJSON(toolrt.JoinPath(result.packageDir, "workflow.json"))
		if err != nil {
			return result, err
		}
		result.workflow = dict(value)
		if result.workflow == nil {
			return result, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(value))
		}
		directory, _ := toolrt.DictGet(result.workflow, "request_dir", "request")
		name, ok := directory.(string)
		if !ok {
			return result, toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(directory))
		}
		workDir = toolrt.JoinPath(result.packageDir, name)
	}
	if workDir == "" {
		return result, valueError(textSourceMiss)
	}
	result.workDir = absolute(root, workDir)
	request, err := loadJSON(toolrt.JoinPath(result.workDir, "request.json"))
	if err != nil {
		return result, err
	}
	attempt, err := loadJSON(toolrt.JoinPath(result.workDir, "attempt.json"))
	if err != nil {
		return result, err
	}
	result.attempt = dict(attempt)
	if result.attempt == nil {
		return result, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(attempt))
	}
	if !toolrt.Equal(result.attempt.Value("status"), "downloaded") || !toolrt.Truthy(result.attempt.Value("downloads")) {
		return result, valueError("Попытка не в состоянии downloaded: принимать нечего.")
	}
	result.request = dict(request)
	if result.request == nil {
		return result, valueError("request.json должен быть объектом.")
	}
	return result, nil
}

// nonEmpty — непустая после strip строка.
func nonEmpty(value any) bool {
	text, ok := value.(string)
	return ok && toolrt.Strip(text) != ""
}

// frozenRequestFiles — нужные приёмке файлы запроса до staging: промпт и входы внутри папки попытки.
func frozenRequestFiles(request *toolrt.Dict, workDir string) (string, []string, error) {
	prompt := dict(request.Value("prompt"))
	if prompt == nil || !nonEmpty(prompt.Value("path")) || !nonEmpty(prompt.Value("sha256")) {
		return "", nil, valueError("request.json: поле prompt должно быть объектом с path и sha256.")
	}
	inputs, ok := request.Value("inputs").([]any)
	if !ok {
		return "", nil, valueError("request.json: поле inputs должно быть списком объектов с path.")
	}
	local := func(name any, field string) (string, error) {
		text, ok := name.(string)
		if !ok || toolrt.Strip(text) == "" {
			return "", valueError("request.json: поле " + field + " должно содержать непустой относительный путь.")
		}
		outside := valueError("request.json: поле " + field + " должно задавать путь внутри папки попытки.")
		if filepath.IsAbs(text) || strings.HasPrefix(text, `\`) || (len(text) > 1 && text[1] == ':') {
			return "", outside
		}
		for _, part := range strings.FieldsFunc(text, func(r rune) bool { return r == '/' || r == '\\' }) {
			if part == ".." {
				return "", outside
			}
		}
		path := toolrt.ResolvePath(toolrt.JoinPath(workDir, text))
		if !toolrt.IsRelativeTo(path, toolrt.ResolvePath(workDir)) {
			return "", outside
		}
		if !toolrt.IsFile(path) {
			return "", valueError("request.json: файл для " + field + " не найден: " + filepath.ToSlash(filepath.Clean(text)) + ".")
		}
		return path, nil
	}
	promptFile, err := local(prompt.Value("path"), "prompt.path")
	if err != nil {
		return "", nil, err
	}
	files := []string{}
	for index, raw := range inputs {
		item := dict(raw)
		if item == nil {
			return "", nil, valueError("request.json: inputs[" + strconv.Itoa(index) + "] должен быть объектом с path.")
		}
		file, err := local(item.Value("path"), "inputs["+strconv.Itoa(index)+"].path")
		if err != nil {
			return "", nil, err
		}
		files = append(files, file)
	}
	return promptFile, files, nil
}

// Options — параметры Accept. Режим — Full либо участок: Review (путь рецепта пробы) или Cut
// (НАЧАЛО и КОНЕЦ на сетке 30 кадров/с) со Speed (десятичная строка, как --speed; «1» — без
// изменения скорости) и удержаниями.
type Options struct {
	Package, WorkDir   string
	Full               bool
	Review             *string
	Cut                *[2]toolrt.Int
	Speed              string
	HoldFirst          toolrt.Int
	HoldLast           toolrt.Int
	Audio, AudioRecipe string
	Clean, Replace     bool
	UpdateViews        bool
	// LocalDir — каталог состояния для наблюдения расхода.
	LocalDir string
}

// editPlan — параметры обработки принятого участка: рецепт одного плана build_review либо
// фиксированный план полной копии.
type editPlan struct {
	filter              string
	frames              toolrt.Int
	start, end, motion  *big.Int
	holdFirst, holdLast *big.Int
	speed               string
	intervalSeconds     []any
	durationChange      float64
}

// fullPlan — план режима --full: оригинал целиком, без скорости и удержаний.
func fullPlan(frames toolrt.Int, fps int64) editPlan {
	count := frames.Big()
	rate := strconv.FormatInt(fps, 10)
	return editPlan{
		filter: "fps=" + rate + ",trim=start_frame=0:end_frame=" + frames.String() + ",setpts=N/(" + rate + "*TB),setsar=1",
		frames: frames, start: big.NewInt(0), end: count, motion: count, holdFirst: big.NewInt(0), holdLast: big.NewInt(0),
		speed: "1", intervalSeconds: []any{0.0, intFloat(count) / float64(fps)},
	}
}

// intFloat — число кадров как float64 (ближайшее представимое); деление на fps после него даёт
// секунды, зафиксированные эталоном.
func intFloat(value *big.Int) float64 {
	result, _ := new(big.Float).SetInt(value).Float64()
	return result
}

// toInt — целое из значения JSON рецепта или аргумента: целое и bool как есть, float с
// отбрасыванием дробной части (NaN — ValueError, бесконечность — OverflowError), строка — по
// синтаксису десятичного целого toolrt.ParseIntText (иначе ValueError «не целое число: …»),
// прочее — TypeError. Тексты отказов зафиксированы эталоном.
func toInt(value any) (*big.Int, error) {
	switch item := value.(type) {
	case toolrt.Int:
		return item.Big(), nil
	case bool:
		if item {
			return big.NewInt(1), nil
		}
		return big.NewInt(0), nil
	case float64:
		if math.IsNaN(item) {
			return nil, toolrt.Raise(toolrt.ValueError, "NaN нельзя преобразовать в целое число")
		}
		if math.IsInf(item, 0) {
			return nil, toolrt.Raise(toolrt.OverflowError, "бесконечность нельзя преобразовать в целое число")
		}
		result, _ := new(big.Float).SetFloat64(math.Trunc(item)).Int(nil)
		return result, nil
	case string:
		parsed, ok := toolrt.ParseIntText(item)
		if !ok {
			return nil, toolrt.Raise(toolrt.ValueError, "не целое число: %s", toolrt.Repr(item))
		}
		return parsed.Big(), nil
	}
	return nil, toolrt.Raise(toolrt.TypeError, "ожидается число или строка, получено: %s", toolrt.TypeName(value))
}

// planEdit — параметры обрезки из рецепта пробы (того же оригинала) или аргументов; фильтр и длительности
// считает buildreview.Prepare по спецификации из одного плана с явным path оригинала. Участок с
// удержаниями обязан дать ровно окно плана.
func planEdit(ctx context.Context, shot, original string, frames toolrt.Int, root string, options Options) (editPlan, error) {
	var cut [2]any
	var speed, holdFirst, holdLast any = options.Speed, options.HoldFirst, options.HoldLast
	if options.Cut != nil {
		cut = [2]any{options.Cut[0], options.Cut[1]}
	}
	if options.Review != nil {
		document, err := loadJSON(*options.Review)
		if err != nil {
			return editPlan{}, err
		}
		shots, err := toolrt.DictGet(document, "shots", []any{})
		if err != nil {
			return editPlan{}, err
		}
		list, err := toolrt.Iter(shots)
		if err != nil {
			return editPlan{}, err
		}
		var item any
		for _, candidate := range list {
			id, err := toolrt.DictGet(candidate, "id", nil)
			if err != nil {
				return editPlan{}, err
			}
			if toolrt.Equal(id, shot) {
				item = candidate
				break
			}
		}
		if item == nil {
			return editPlan{}, valueError(shot + ": в рецепте пробы нет этого плана.")
		}
		other := valueError(shot + ": проба собрана не из этого оригинала.")
		kind, _ := toolrt.DictGet(item, "kind", nil)
		if !toolrt.Equal(kind, "video") {
			return editPlan{}, other
		}
		pathValue, err := toolrt.Item(item, "path")
		if err != nil {
			return editPlan{}, err
		}
		path, ok := pathValue.(string)
		if !ok {
			return editPlan{}, toolrt.Raise(toolrt.TypeError, "путь должен быть строкой, получено: %s", toolrt.TypeName(pathValue))
		}
		recipeDigest, err := assetpackage.FileSHA256(path)
		if err != nil {
			return editPlan{}, err
		}
		originalDigest, err := assetpackage.FileSHA256(original)
		if err != nil {
			return editPlan{}, err
		}
		if recipeDigest != originalDigest {
			return editPlan{}, other
		}
		for index, key := range []string{"source_start_frame", "source_end_frame_exclusive"} {
			if cut[index], err = toolrt.Item(item, key); err != nil {
				return editPlan{}, err
			}
		}
		speed, _ = toolrt.DictGet(item, "speed", "1")
		holdFirst, _ = toolrt.DictGet(item, "hold_first_frames", toolrt.NewInt(0))
		holdLast, _ = toolrt.DictGet(item, "hold_last_frames", toolrt.NewInt(0))
	} else if options.Cut == nil {
		return editPlan{}, valueError(textCutMissing)
	}
	values := make([]*big.Int, 4)
	for index, raw := range []any{cut[0], cut[1], holdFirst, holdLast} {
		value, err := toInt(raw)
		if err != nil {
			return editPlan{}, err
		}
		values[index] = value
	}
	spec := toolcli.Record("schema_version", toolrt.NewInt(1), "shots", []any{toolcli.Record(
		"scene", shot,
		"path", original,
		"kind", "video",
		"source_start_frame", toolrt.IntFromBig(values[0]),
		"source_end_frame_exclusive", toolrt.IntFromBig(values[1]),
		"speed", toolrt.Str(speed),
		"hold_first_frames", toolrt.IntFromBig(values[2]),
		"hold_last_frames", toolrt.IntFromBig(values[3]),
	)})
	prepared, err := buildreview.Prepare(ctx, spec, root)
	if err != nil {
		return editPlan{}, err
	}
	item := prepared.Value("shots").([]any)[0].(*toolrt.Dict)
	count := item.Value("frames").(toolrt.Int)
	if !toolrt.Equal(count, frames) {
		return editPlan{}, valueError("Участок с удержаниями даёт " + count.String() + " кадров, а окно плана — " + frames.String() + ".")
	}
	number := func(key string) *big.Int { return item.Value(key).(toolrt.Int).Big() }
	return editPlan{
		filter: item.Value("filter").(string), frames: count,
		start: number("source_start_frame"), end: number("source_end_frame_exclusive"), motion: number("motion_frames"),
		holdFirst: number("hold_first_frames"), holdLast: number("hold_last_frames"),
		speed: item.Value("speed").(string), intervalSeconds: item.Value("source_interval_seconds").([]any),
		durationChange: item.Value("duration_change_seconds").(float64),
	}, nil
}

// renderEdit — участок оригинала по фильтру плана кодируется параметрами ENCODE build_animatic
// без звука ровно в frames кадров; результат обязан быть 1920×1080 с частотой проекта fps.
func renderEdit(ctx context.Context, original, filter string, frames toolrt.Int, target string, fps int64) error {
	args := append([]string{"-v", "error", "-nostdin", "-n", "-threads", "2", "-i", original, "-map", "0:v:0", "-vf", filter},
		mediacmd.Encode(fps)...)
	args = append(args, "-frames:v", frames.String(), target)
	if _, err := run(ctx, mediacmd.FFmpeg(), args...); err != nil {
		return err
	}
	probed, err := probe(ctx, target)
	if err != nil {
		return err
	}
	streams, _ := probed.Value("streams").([]any)
	for _, raw := range streams {
		stream := dict(raw)
		if stream == nil || !toolrt.Equal(stream.Value("codec_type"), "video") {
			continue
		}
		values := make([]any, 4)
		for index, key := range []string{"width", "height", "r_frame_rate", "nb_frames"} {
			if values[index], err = toolrt.Item(stream, key); err != nil {
				return err
			}
		}
		count, err := toInt(values[3])
		if err != nil {
			return err
		}
		if !toolrt.Equal(values[0], toolrt.NewInt(1920)) || !toolrt.Equal(values[1], toolrt.NewInt(1080)) ||
			!toolrt.Equal(values[2], strconv.FormatInt(fps, 10)+"/1") || count.Cmp(frames.Big()) != 0 {
			return valueError(textBadEdit)
		}
		return nil
	}
	return toolrt.New("StopIteration", "")
}

// acceptanceFingerprint — отпечаток постановки, по которой сделан комплект (scene_sha256 пакета),
// и текущий отпечаток плана.
func acceptanceFingerprint(registry *toolrt.Dict, shot string, workflow *toolrt.Dict, root string) (string, string, error) {
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return "", "", err
	}
	current, err := sceneregistry.SceneFingerprint(registry, shot, initial)
	if err != nil {
		return "", "", err
	}
	var saved any
	if workflow != nil {
		saved = workflow.Value("scene_sha256")
	}
	if saved == nil {
		return current, current, nil
	}
	text, ok := saved.(string)
	if !ok || !sceneregistry.SHA256.MatchString(text) {
		return "", "", valueError(shot + ": scene_sha256 в workflow.json пакета должен состоять из 64 hex-символов.")
	}
	return text, current, nil
}

// retireKit — прежний комплект целиком переезжает в assets/replaced/Mxx/<время>: оплаченные
// оригиналы и манифест не удаляются.
func retireKit(root, shot string) (string, error) {
	current := toolrt.JoinPath(root, "assets", "shots", shot)
	archive := toolrt.JoinPath(root, "assets", "replaced", shot, Now().Format("20060102T150405Z"))
	if toolrt.Exists(archive) {
		relative, _ := toolrt.RelativeTo(archive, root)
		return "", valueError(shot + ": папка " + relative + " уже существует.")
	}
	if err := os.MkdirAll(filepath.Dir(archive), 0o755); err != nil {
		return "", toolrt.OSErrorFrom(err, filepath.Dir(archive))
	}
	if err := os.Rename(current, archive); err != nil {
		return "", toolrt.OSErrorFrom(err, current)
	}
	return archive, nil
}

// cleanWork — после проверки комплекта удаляет переданный пакет, все пакеты плана в plan/batches и
// опустевшие папки проб; assets, очередь других планов и чужие пакеты не трогает.
func cleanWork(root, shot, packageDir, workDir string, review *string) ([]any, error) {
	root = toolrt.ResolvePath(root)
	retained := checkworkspace.RetainedMontageFolders(root)
	batches := toolrt.ResolvePath(toolrt.JoinPath(root, "plan", "batches"))
	awaiting := toolrt.ResolvePath(toolrt.JoinPath(root, "plan", "awaiting"))
	removed := []any{}
	removeDir := func(folder string) (bool, error) {
		folder = toolrt.ResolvePath(folder)
		for item := range retained {
			if folder == item || toolrt.IsRelativeTo(folder, item) || toolrt.IsRelativeTo(item, folder) {
				return false, nil
			}
		}
		if toolrt.Exists(folder) && folder != batches && folder != awaiting &&
			(toolrt.IsRelativeTo(folder, batches) || toolrt.IsRelativeTo(folder, awaiting)) {
			if err := os.RemoveAll(folder); err != nil {
				return false, toolrt.OSErrorFrom(err, folder)
			}
			relative, _ := toolrt.RelativeTo(folder, root)
			removed = append(removed, relative)
			return true, nil
		}
		return false, nil
	}
	for _, folder := range []string{packageDir, workDir} {
		if folder == "" {
			continue
		}
		done, err := removeDir(folder)
		if err != nil {
			return nil, err
		}
		if done {
			break
		}
	}
	// Использованная проба: её MP4 и рецепт внутри plan/batches, если папка не хранится монтажом.
	if review != nil {
		for _, extra := range []string{*review, toolrt.WithSuffix(*review, ".mp4")} {
			resolved := toolrt.ResolvePath(extra)
			kept := false
			for item := range retained {
				kept = kept || toolrt.IsRelativeTo(resolved, item)
			}
			if toolrt.Exists(extra) && toolrt.IsRelativeTo(resolved, batches) && !kept {
				if err := os.Remove(extra); err != nil {
					return nil, toolrt.OSErrorFrom(err, extra)
				}
				relative, _ := toolrt.RelativeTo(toolrt.ResolvePath(extra), root)
				removed = append(removed, relative)
			}
		}
	}
	// Остальные пакеты и пробы, все планы которых уже приняты: проба с незавершённым соседом остаётся.
	accepted := toolrt.NewSet()
	for _, manifest := range toolrt.Glob(toolrt.JoinPath(root, "assets", "shots"), "M*/manifest.json") {
		_ = accepted.Add(toolrt.PathName(filepath.Dir(manifest)))
	}
	_ = accepted.Add(shot)
	folders := func() []string {
		if !toolrt.IsDir(batches) {
			return nil
		}
		items, _ := toolrt.IterDir(batches)
		sort.Strings(items)
		return items
	}
	for _, folder := range folders() {
		if !toolrt.IsDir(folder) {
			continue
		}
		owners, err := checkworkspace.PackageOwners(folder)
		if err != nil {
			return nil, err
		}
		if owners.Len() > 0 && owners.SubsetOf(accepted) && (owners.Contains(shot) || strings.HasPrefix(toolrt.PathName(folder), shot+"-")) {
			if _, err := removeDir(folder); err != nil {
				return nil, err
			}
		}
	}
	// Пустые папки проб: файлы уже удалены, папка не нужна.
	for _, folder := range folders() {
		if !toolrt.IsDir(folder) {
			continue
		}
		if entries, err := os.ReadDir(folder); err == nil && len(entries) == 0 {
			if err := os.Remove(folder); err != nil {
				return nil, toolrt.OSErrorFrom(err, folder)
			}
			relative, _ := toolrt.RelativeTo(folder, root)
			removed = append(removed, relative)
		}
	}
	return removed, nil
}

// Accept собирает комплект assets/shots/<shot> из скачанного оригинала — полной копией
// (Full) или рендером участка (Review/Cut со скоростью и удержаниями).
func Accept(ctx context.Context, root, shot string, options Options) (*toolrt.Dict, error) {
	root = toolrt.ResolvePath(root)
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	if err := sceneregistry.SameFPS(root, registry); err != nil {
		return nil, err
	}
	var scene *toolrt.Dict
	scenes, _ := registry.Value("scenes").([]any)
	for _, raw := range scenes {
		if item := dict(raw); item != nil && toolrt.Equal(item.Value("id"), shot) {
			scene = item
			break
		}
	}
	if scene == nil {
		return nil, valueError(shot + ": план отсутствует в реестре сцен.")
	}
	end, err := toolrt.Item(scene, "end_frame_exclusive")
	if err != nil {
		return nil, err
	}
	start, err := toolrt.Item(scene, "start_frame")
	if err != nil {
		return nil, err
	}
	difference, err := toolrt.Sub(end, start)
	if err != nil {
		return nil, err
	}
	frames64, err := strconv.ParseInt(toolrt.Str(difference), 10, 64)
	if err != nil {
		return nil, toolrt.Raise(toolrt.TypeError, "число кадров плана должно быть целым")
	}
	frames := toolrt.NewInt(frames64)
	data, err := resolvePackage(options.Package, options.WorkDir, root)
	if err != nil {
		return nil, err
	}
	promptFile, inputFiles, err := frozenRequestFiles(data.request, data.workDir)
	if err != nil {
		return nil, err
	}
	request, attempt := data.request, data.attempt
	if !nonEmpty(request.Value("provider")) {
		return nil, valueError("В сохранённом запросе не указан провайдер.")
	}
	if requestShot := request.Value("shot"); (requestShot != nil && !toolrt.Equal(requestShot, shot)) || !toolrt.Equal(request.Value("kind"), "video") {
		return nil, valueError("Пакет относится к другому плану или не является видеозапросом.")
	}
	target := toolrt.JoinPath(root, "assets", "shots", shot)
	if toolrt.Exists(target) && !options.Replace {
		return nil, valueError(shot + ": комплект уже есть в assets; замена выбранной версии — отдельное решение (--replace).")
	}
	downloads, _ := attempt.Value("downloads").([]any)
	firstPath, err := toolrt.Item(dict(downloads[0]), "path")
	if err != nil {
		return nil, err
	}
	original := toolrt.JoinPath(data.workDir, toolrt.Str(firstPath))
	if !toolrt.IsFile(original) {
		return nil, valueError("Скачанный оригинал не найден в попытке.")
	}
	// Своё видео плана сделано вне приложения без среза речи: даже у речевого плана в комплекте нет
	// speech.wav, а generation.lipsync говорит, что видео не получено липсинком по срезу.
	ownVideo := toolrt.Equal(request.Value("own_video"), true)
	lipsync := toolrt.Truthy(scene.Value("lipsync")) && !ownVideo
	if ownVideo {
		options.Audio, options.AudioRecipe = "", ""
	}
	if lipsync && options.Audio == "" {
		return nil, valueError(shot + ": речевой план требует --audio с точным WAV липсинка.")
	}
	sceneDigest, currentDigest, err := acceptanceFingerprint(registry, shot, data.workflow, root)
	if err != nil {
		return nil, err
	}
	// Повреждённый статус производства обнаруживается до переноса: комплект без записи отпечатка был бы устаревшим.
	status, err := sceneregistry.ReadProductionStatus(root)
	if err != nil {
		return nil, err
	}
	if _, err := sceneregistry.AcceptedFingerprints(status); err != nil {
		return nil, err
	}
	staging := toolrt.JoinPath(filepath.Dir(target), ".accept-"+shot)
	if toolrt.Exists(staging) {
		if err := os.RemoveAll(staging); err != nil {
			return nil, toolrt.OSErrorFrom(err, staging)
		}
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return nil, toolrt.OSErrorFrom(err, staging)
	}
	video, replaced, err := buildKit(ctx, root, shot, frames, sceneregistry.FPS(registry.Value("fps")), staging, target, original, promptFile, inputFiles, data, lipsync, options)
	if err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	// Сразу после переноса: комплект без отпечатка считается принятым по прежней постановке (stale).
	if err := sceneregistry.WriteAcceptedFingerprints(root, toolcli.Record(shot, sceneDigest), true); err != nil {
		return nil, err
	}
	if _, err := assetpackage.ValidatePackage(toolrt.JoinPath(target, "manifest.json"), shot, root); err != nil {
		return nil, err
	}
	relativeTarget, _ := toolrt.RelativeTo(target, root)
	var replacedValue any
	if replaced != "" {
		replacedValue, _ = toolrt.RelativeTo(replaced, root)
	}
	warnings := []any{}
	result := toolcli.Record("shot", shot, "target", relativeTarget, "frames", frames, "video_sha256", video.Value("sha256"),
		"scene_sha256", sceneDigest, "replaced", replacedValue, "observed_credits", nil, "cleaned", []any{}, "warnings", warnings)
	if sceneDigest != currentDigest {
		warnings = append(warnings, shot+": постановка плана изменилась после подготовки пакета; комплект принят по прежней постановке "+
			"и требует нового производства.")
	}
	if attempt.Value("credits_consumed") != nil {
		// Комплект уже перенесён: сбой записи наблюдения цены не отменяет приёмку, а возвращается предупреждением.
		learned, err := costcheck.Learn(root, data.workDir, "", options.LocalDir)
		var credits any
		if err == nil {
			credits, err = toolrt.Item(learned, "credits")
		}
		switch {
		case err == nil:
			result.Set("observed_credits", credits)
		case toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError, toolrt.TypeError):
			// Предупреждение несёт текст ошибки, а не внутренний вид исключения.
			warnings = append(warnings, "Наблюдение расхода не записано: "+err.Error())
		default:
			return nil, err
		}
	}
	result.Set("warnings", warnings)
	if options.UpdateViews {
		views := sceneviews.Run(root, []string{})
		if views.Code != 0 {
			return nil, toolrt.New("CalledProcessError", "команда завершилась с кодом "+strconv.Itoa(views.Code)+": update_scene_views")
		}
	}
	if options.Clean {
		cleaned, err := cleanWork(root, shot, data.packageDir, data.workDir, options.Review)
		if err != nil {
			return nil, err
		}
		result.Set("cleaned", cleaned)
	}
	return result, nil
}

// buildKit собирает комплект в staging и переносит его на место target
// (прежний комплект уходит в assets/replaced). Возвращает описатель video и путь прежнего комплекта.
func buildKit(ctx context.Context, root, shot string, frames toolrt.Int, fps int64, staging, target, original, promptFile string,
	inputFiles []string, data attemptData, lipsync bool, options Options) (*toolrt.Dict, string, error) {
	request, attempt, workflow := data.request, data.attempt, data.workflow
	count, _ := strconv.ParseInt(frames.String(), 10, 64)
	if err := copyFile(original, toolrt.JoinPath(staging, "original.mp4")); err != nil {
		return nil, "", err
	}
	probed, err := probe(ctx, toolrt.JoinPath(staging, "original.mp4"))
	if err != nil {
		return nil, "", err
	}
	var media *toolrt.Dict
	streams, _ := probed.Value("streams").([]any)
	for _, raw := range streams {
		if stream := dict(raw); stream != nil && toolrt.Equal(stream.Value("codec_type"), "video") {
			media = stream
			break
		}
	}
	if media == nil {
		return nil, "", toolrt.New("StopIteration", "")
	}
	originalMedia := toolrt.NewDict()
	for _, key := range []string{"width", "height", "r_frame_rate", "duration", "nb_frames"} {
		if value, ok := media.Get(key); ok {
			originalMedia.Set(key, value)
		}
	}
	// Одинаковые байты входов хранятся одним файлом с несколькими ролями по контракту assets.
	inputs := []any{}
	names := map[string]string{}
	order := 0
	requestInputs := request.Value("inputs").([]any)
	for index, source := range inputFiles {
		item := dict(requestInputs[index])
		digest, err := assetpackage.FileSHA256(source)
		if err != nil {
			return nil, "", err
		}
		if _, ok := names[digest]; !ok {
			order++
			names[digest] = "generation-input-" + strconv.Itoa(order) + strings.ToLower(toolrt.PathSuffix(source))
			if err := copyFile(source, toolrt.JoinPath(staging, names[digest])); err != nil {
				return nil, "", err
			}
		}
		entry, err := descriptor(staging, names[digest])
		if err != nil {
			return nil, "", err
		}
		slot := item.Value("slot")
		if !toolrt.Truthy(slot) {
			slot = item.Value("flag")
		}
		role := item.Value("role")
		label, known := roleLabels[toolrt.Str(role)]
		_, isString := role.(string)
		switch {
		case known && isString:
			role = label
		case !toolrt.Truthy(role):
			role = "Вход генерации"
		}
		entry.Set("slot", slot)
		entry.Set("role", role)
		inputs = append(inputs, entry)
	}
	if err := copyFile(promptFile, toolrt.JoinPath(staging, "generation-prompt.txt")); err != nil {
		return nil, "", err
	}
	var audioEntry any
	if options.Audio != "" {
		if err := copyFile(options.Audio, toolrt.JoinPath(staging, "speech.wav")); err != nil {
			return nil, "", err
		}
		if audioEntry, err = descriptor(staging, "speech.wav"); err != nil {
			return nil, "", err
		}
		if options.AudioRecipe != "" {
			if err := copyFile(options.AudioRecipe, toolrt.JoinPath(staging, "audio-recipe.json")); err != nil {
				return nil, "", err
			}
		}
	}
	// grid — частота шкалы проекта в записи ffprobe (r_frame_rate).
	grid := strconv.FormatInt(fps, 10) + "/1"
	var plan editPlan
	if options.Full {
		nbFrames, _ := strconv.ParseInt(toolrt.Str(originalMedia.Value("nb_frames")), 10, 64)
		if !originalMedia.Has("nb_frames") {
			nbFrames = 0
		}
		// Целиком без перекодирования принимается только ролик в кадре проекта: другой размер
		// (например, видео, созданное вне приложения) приводится к 1920×1080 участком.
		if !toolrt.Equal(originalMedia.Value("r_frame_rate"), grid) || nbFrames != count ||
			!toolrt.Equal(originalMedia.Value("width"), toolrt.NewInt(1920)) || !toolrt.Equal(originalMedia.Value("height"), toolrt.NewInt(1080)) {
			return nil, "", valueError("Полный оригинал не совпадает с окном, кадром 1920×1080 и FPS; задайте участок.")
		}
		if err := copyFile(toolrt.JoinPath(staging, "original.mp4"), toolrt.JoinPath(staging, "video.mp4")); err != nil {
			return nil, "", err
		}
		plan = fullPlan(frames, fps)
	} else {
		if plan, err = planEdit(ctx, shot, toolrt.JoinPath(staging, "original.mp4"), frames, root, options); err != nil {
			return nil, "", err
		}
		if err := renderEdit(ctx, toolrt.JoinPath(staging, "original.mp4"), plan.filter, frames, toolrt.JoinPath(staging, "video.mp4"), fps); err != nil {
			return nil, "", err
		}
	}
	speedValue, err := toolrt.NewDecimal(plan.speed)
	if err != nil {
		return nil, "", err
	}
	selectedValue, err := toolrt.NewDecimal(toolrt.IntFromBig(new(big.Int).Sub(plan.end, plan.start)))
	if err != nil {
		return nil, "", err
	}
	if selectedValue, err = selectedValue.Div(toolrt.DecimalInt(fps)); err != nil {
		return nil, "", err
	}
	factor, _ := strconv.ParseFloat(speedValue.FormatF(), 64)
	selected, _ := strconv.ParseFloat(selectedValue.FormatF(), 64)
	ratio, _ := new(big.Rat).SetString(speedValue.FormatF())
	video, err := descriptor(staging, "video.mp4")
	if err != nil {
		return nil, "", err
	}
	originalDesc, err := descriptor(staging, "original.mp4")
	if err != nil {
		return nil, "", err
	}
	promptDesc, err := descriptor(staging, "generation-prompt.txt")
	if err != nil {
		return nil, "", err
	}
	snapshotInputs := []any{}
	for _, raw := range inputs {
		item := raw.(*toolrt.Dict)
		snapshotInputs = append(snapshotInputs, toolcli.Record("slot", item.Value("slot"), "role", item.Value("role"), "path", item.Value("path"), "sha256", item.Value("sha256")))
	}
	snapshot := toolrt.NewDict()
	for _, key := range []string{"provider", "command", "model"} {
		value, err := toolrt.Item(request, key)
		if err != nil {
			return nil, "", err
		}
		if key == "provider" {
			snapshot.Set("schema_version", toolrt.NewInt(1))
			snapshot.Set("shot", shot)
		}
		// Снимок сохраняет исполнителя исходного запроса, чтобы повтор сравнивал его с выбором проекта.
		snapshot.Set(key, value)
	}
	parameters, _ := toolrt.DictGet(request, "parameters", toolrt.NewDict())
	outputs, _ := toolrt.DictGet(request, "outputs", toolrt.NewInt(1))
	snapshot.Set("parameters", parameters)
	snapshot.Set("outputs", outputs)
	snapshot.Set("request_sha256", attempt.Value("request_sha256"))
	snapshot.Set("inputs", snapshotInputs)
	snapshot.Set("prompt", "generation-prompt.txt")
	snapshot.Set("prompt_sha256", promptDesc.Value("sha256"))
	snapshot.Set("generation_id", attempt.Value("generation_id"))
	snapshot.Set("service_status", attempt.Value("service_status"))
	snapshot.Set("path_base", "asset_directory")
	if generation, ok := attempt.Value("manual_generation").(*toolrt.Dict); ok {
		// Видео создано вне приложения: снимок хранит, откуда оно и что записал пользователь.
		snapshot.Set("provenance", "Видео создано вне приложения: "+toolrt.Str(generation.Value("source"))+".")
		snapshot.Set("manual_generation", generation)
	} else if toolrt.Truthy(attempt.Value("manual_result")) {
		snapshot.Set("provenance", "Исход отправки остался неизвестен; оригинал загружен пользователем из истории генераций сервиса, "+
			"ID задания неизвестен.")
	}
	if err := writeJSON(toolrt.JoinPath(staging, "generation-request.json"), snapshot); err != nil {
		return nil, "", err
	}
	generationInputs := []any{}
	for _, raw := range inputs {
		item := raw.(*toolrt.Dict)
		generationInputs = append(generationInputs, toolcli.Record("path", item.Value("path"), "sha256", item.Value("sha256"),
			"bytes", item.Value("bytes"), "slot", item.Value("slot"), "role", "Переданный кадр генерации"))
	}
	notes := []any{}
	if workflow != nil && toolrt.Truthy(workflow.Value("mode")) {
		notes = append(notes, "Режим согласования: "+toolrt.Str(workflow.Value("mode")))
	}
	prep := toolcli.Record("schema_version", toolrt.NewInt(1), "shot", shot, "path_base", "asset_directory",
		"generation_inputs", generationInputs, "frame_prompts", []any{}, "references", []any{}, "notes", notes,
		"reproduction_note", "Точные байты кадров сохранены. Повтор генерации по промпту не гарантирует тех же пикселей.")
	if err := writeJSON(toolrt.JoinPath(staging, "preparation.json"), prep); err != nil {
		return nil, "", err
	}
	unique := toolrt.NewDict()
	for _, raw := range inputs {
		item := raw.(*toolrt.Dict)
		unique.Set(toolrt.Str(item.Value("path")), toolcli.Record("path", item.Value("path"), "sha256", item.Value("sha256"), "bytes", item.Value("bytes")))
	}
	files := []any{}
	for _, key := range unique.Keys() {
		files = append(files, unique.Value(key))
	}
	files = append(files, promptDesc, originalDesc)
	requestDesc, err := descriptor(staging, "generation-request.json")
	if err != nil {
		return nil, "", err
	}
	prepDesc, err := descriptor(staging, "preparation.json")
	if err != nil {
		return nil, "", err
	}
	versionOutput, err := run(ctx, mediacmd.FFmpeg(), "-version")
	if err != nil {
		return nil, "", err
	}
	versionText, err := toolrt.DecodeUTF8(versionOutput)
	if err != nil {
		return nil, "", err
	}
	lines := toolrt.SplitLines(versionText)
	if len(lines) == 0 {
		return nil, "", toolrt.New(toolrt.IndexError, "индекс за пределами списка")
	}
	sourceFPS := originalMedia.Value("r_frame_rate")
	conversion := "Исходная частота кадров совпадает со шкалой."
	if !toolrt.Equal(sourceFPS, grid) {
		conversion = "Выбор кадров без интерполяции движения."
	}
	manifest := toolcli.Record(
		"schema_version", toolrt.NewInt(1),
		"shot", shot,
		"kind", "generated_video",
		"generation", toolcli.Record(
			"source_shot", shot,
			"original", originalDesc,
			"original_media", originalMedia,
			"prompt", promptDesc,
			"request", requestDesc,
			"generation_id", attempt.Value("generation_id"),
			"inputs", inputs,
			"lipsync", lipsync,
			"audio", audioEntry,
			"auxiliary_references", []any{},
			"preparation", toolcli.Record("index", prepDesc, "files", files),
		),
		"accepted_edit", toolcli.Record(
			"video", video,
			"fps", toolrt.NewInt(fps),
			"frames", frames,
			"duration_seconds", float64(count)/float64(fps),
			"source_interval_seconds", plan.intervalSeconds,
			"source_interval_end_exclusive", true,
			"source_frame_grid_fps", toolrt.NewInt(fps),
			"still_source_time_seconds", nil,
			"speed", toolcli.Record(
				"factor", factor,
				"ratio", ratio.RatString(),
				"selected_source_seconds", selected,
				"motion_output_seconds", intFloat(plan.motion)/float64(fps),
				"duration_change_seconds", plan.durationChange,
			),
			"hold_first_seconds", intFloat(plan.holdFirst)/float64(fps),
			"hold_last_seconds", intFloat(plan.holdLast)/float64(fps),
			"audio_policy", audioPolicy,
			"montage_source", video,
			"rebuild", toolcli.Record(
				"stages", []any{toolcli.Record("input", "original.mp4", "filter", plan.filter, "frames", frames)},
				"source", originalDesc,
				"ffmpeg_version", lines[0],
				"note", rebuildNote,
			),
			"source_frame_interval_exclusive", []any{toolrt.IntFromBig(plan.start), toolrt.IntFromBig(plan.end)},
			"source_fps", sourceFPS,
			"fps_conversion", conversion,
		),
	)
	// Своё видео плана: входов и промпта у генерации нет, комплект отмечает это явно.
	if toolrt.Equal(request.Value("own_video"), true) {
		manifest.Value("generation").(*toolrt.Dict).Set("own_video", true)
	}
	if err := writeJSON(toolrt.JoinPath(staging, "manifest.json"), manifest); err != nil {
		return nil, "", err
	}
	replaced := ""
	if toolrt.Exists(target) {
		if replaced, err = retireKit(root, shot); err != nil {
			return nil, "", err
		}
	}
	if err := os.Rename(staging, target); err != nil {
		return nil, "", toolrt.OSErrorFrom(err, staging)
	}
	return video, replaced, nil
}

// sourceOrder — имена опций группы источника (--package, --work-dir) в порядке появления в
// аргументах (с сокращёнными префиксами и «=значение»), для текста конфликта взаимоисключающих опций.
func sourceOrder(args []string) []string {
	order := []string{}
	for _, arg := range args {
		if arg == "--" {
			break
		}
		name, _, _ := strings.Cut(arg, "=")
		if len(name) <= 2 || !strings.HasPrefix(name, "--") {
			continue
		}
		for _, flag := range []string{"--package", "--work-dir"} {
			if strings.HasPrefix(flag, name) {
				order = append(order, flag)
			}
		}
	}
	return order
}

// Run — инструмент accept_shot на разрешённом корне проекта: разбор аргументов с группами
// источника и режима, участок --cut, приёмка и печать итога JSON.
func Run(ctx context.Context, root string, args []string, localDir string) toolcli.Output {
	parsed, exit := Parser.ParseArgs(args)
	if exit != nil {
		if exit.Code == 0 {
			return toolcli.Output{Code: 0, Stdout: toolrt.TextMode(help)}
		}
		return toolcli.Output{Code: exit.Code, Stderr: toolrt.TextMode(strings.Replace(exit.Stderr, Parser.Usage(), usage, 1))}
	}
	value := func(name string) string {
		if values := parsed.Values[name]; len(values) > 0 {
			return values[0]
		}
		return ""
	}
	present := func(name string) bool { _, ok := parsed.Values[name]; return ok }
	holds := map[string]toolrt.Int{"--hold-first": toolrt.NewInt(0), "--hold-last": toolrt.NewInt(0)}
	for _, name := range []string{"--hold-first", "--hold-last"} {
		if !present(name) {
			continue
		}
		number, ok := toolrt.ParseIntText(value(name))
		if !ok {
			return argError("аргумент " + name + ": не целое число: " + toolrt.Repr(value(name)))
		}
		holds[name] = number
	}
	if order := sourceOrder(args); present("--package") && present("--work-dir") && len(order) > 1 {
		second := order[len(order)-1]
		first := "--package"
		if second == "--package" {
			first = "--work-dir"
		}
		return argError("аргумент " + second + ": нельзя вместе с " + first)
	}
	if !present("--package") && !present("--work-dir") {
		return argError("нужен один из аргументов: --package --work-dir")
	}
	if !present("--review") && !present("--cut") && !parsed.Bools["--full"] {
		return argError("нужен один из аргументов: --review --cut --full")
	}
	printer := &toolcli.Printer{}
	options := Options{
		Package: value("--package"), WorkDir: value("--work-dir"), Full: parsed.Bools["--full"], Speed: value("--speed"),
		HoldFirst: holds["--hold-first"], HoldLast: holds["--hold-last"], Audio: value("--audio"),
		AudioRecipe: value("--audio-recipe"), Clean: parsed.Bools["--clean"], Replace: parsed.Bools["--replace"],
		UpdateViews: !parsed.Bools["--no-views"], LocalDir: localDir,
	}
	if !present("--speed") {
		options.Speed = "1"
	}
	if present("--review") {
		review := value("--review")
		options.Review = &review
	}
	result, err := func() (*toolrt.Dict, error) {
		// Пустой --cut означает отсутствие участка (проверка на истинность, как if args.cut).
		if text := value("--cut"); text != "" {
			parts := strings.Split(text, ":")
			numbers := []toolrt.Int{}
			for _, part := range parts {
				number, ok := toolrt.ParseIntText(part)
				if !ok {
					return nil, toolrt.Raise(toolrt.ValueError, "не целое число: %s", toolrt.Repr(part))
				}
				numbers = append(numbers, number)
			}
			if len(numbers) != 2 {
				return nil, valueError(textCutFormat)
			}
			options.Cut = &[2]toolrt.Int{numbers[0], numbers[1]}
		}
		return Accept(ctx, root, value("shot"), options)
	}()
	if err != nil {
		switch {
		case toolrt.Is(err, toolrt.ValueError) && !toolrt.Is(err, toolrt.JSONDecodeError):
			return printer.Fail(err.Error())
		case toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError, toolrt.TypeError, "StopIteration"):
			return printer.Fail(textHidden)
		default:
			return printer.Crash(err)
		}
	}
	text, err := toolcli.JSON(result)
	if err != nil {
		return printer.Crash(err)
	}
	if err := printer.Print(text); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}
