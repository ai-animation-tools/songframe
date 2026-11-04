// Package acceptshot — перенос tools/accept_shot/accept_shot.py: перенос принятой генерации в
// комплект assets/shots/Mxx по контракту assets. Перенесён режим --full: скачанный оригинал уже
// совпадает с окном плана и шкалой 30 кадров/с и копируется побайтово, рядом сохраняются входы,
// промпт, снимок запроса, индекс подготовки и манифест; затем записывается отпечаток приёмки,
// комплект проверяется validate_package, наблюдается расход, обновляются представления и (с
// --clean) удаляются рабочие пакеты плана.
//
// Участок оригинала (--cut/--review), скорость и удержания требуют рендера FFmpeg и рецепта пробы
// build_review; этот конвейер переносит этап 46, поэтому такие режимы отказывают текстом
// «не перенесено» до любых записей. ffprobe и ffmpeg ищутся как в оригинале — по имени в PATH
// (приложение может подставить пути компонентов); без них приёмка завершается общей ошибкой
// медиа, как FileNotFoundError оригинала.
package acceptshot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"songframe-go/internal/assetpackage"
	"songframe-go/internal/checkworkspace"
	"songframe-go/internal/costcheck"
	"songframe-go/internal/process"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
	"songframe-go/internal/sceneviews"
)

// Programs — пути FFmpeg и ffprobe: приложение подставляет пару менеджера компонентов, пустой
// путь — голое имя, которое ищется в PATH общим запуском процессов, как в оригинале.
var Programs = func() (ffmpeg, ffprobe string) { return "", "" }

// programs — пара программ с заменой пустых путей именами.
func programs() (string, string) {
	ffmpeg, ffprobe := Programs()
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	if ffprobe == "" {
		ffprobe = "ffprobe"
	}
	return ffmpeg, ffprobe
}

// Now — время UTC для имени папки прежнего комплекта (подменяется в тестах).
var Now = func() time.Time { return time.Now().UTC() }

// fps — шкала монтажа.
const fps = 30

// Тексты оригинала.
const (
	audioPolicy = "Звук генератора сохранён в оригинале; в монтаже используется непрерывная исходная песня."
	rebuildNote = "Принятые байты восстанавливаются копированием video; повтор фильтров сохраняет монтаж, " +
		"но не обещает побайтово одинаковое перекодирование."
	textHidden      = "Ошибка файлов попытки или медиа; сырой вывод скрыт."
	textNotMigrated = "Приёмка участка, скорости и удержаний ещё не перенесена в Go-версию SongFrame: нужен медиаконвейер этапа 46."
	textEditMissing = "Укажите режим приёмки: --review, --cut НАЧАЛО:КОНЕЦ или --full."
	textSourceMiss  = "Укажите пакет (--package) или папку попытки (--work-dir)."
)

// roleLabels — ROLE_LABELS оригинала.
var roleLabels = map[string]string{"first": "Первый кадр", "last": "Последний кадр", "middle": "Промежуточный кадр"}

// Parser — argparse accept_shot.py. Взаимоисключающие обязательные группы источника и режима
// проверяются в Run; --preparation приложение не передаёт, и он не перенесён.
var Parser = pycompat.ArgParser{
	Prog:        "accept_shot.py",
	Description: "Перенос принятой генерации в комплект assets по контракту; @link README.md",
	Flags: []pycompat.Flag{
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
	Positionals: []pycompat.Positional{{Name: "shot"}},
}

func valueError(message string) error { return pycompat.New(pycompat.ValueError, message) }

func dict(value any) *pycompat.Dict {
	result, _ := value.(*pycompat.Dict)
	return result
}

// descriptor — {"path", "sha256", "bytes"} файла name в папке directory.
func descriptor(directory, name string) (*pycompat.Dict, error) {
	path := pycompat.JoinPath(directory, name)
	digest, err := assetpackage.FileSHA256(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, pycompat.OSErrorFrom(err, path)
	}
	return pytool.Record("path", name, "sha256", digest, "bytes", pycompat.NewInt(info.Size())), nil
}

// copyFile — shutil.copyfile.
func copyFile(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return pycompat.OSErrorFrom(err, target)
	}
	return nil
}

// writeJSON — write_text(json.dumps(indent=2, ensure_ascii=False) + "\n").
func writeJSON(path string, value any) error {
	text, err := pycompat.DumpsJSON(value, pycompat.Indented)
	if err != nil {
		return err
	}
	data, err := pycompat.EncodeUTF8(text + "\n")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return pycompat.OSErrorFrom(err, path)
	}
	return nil
}

// loadJSON — json.loads(path.read_text()).
func loadJSON(path string) (any, error) { return pycompat.LoadJSONFile(path) }

// run — run(args) build_animatic: ненулевой код — ValueError с хвостом stderr, программа не
// найдена — FileNotFoundError.
func run(ctx context.Context, program string, args ...string) ([]byte, error) {
	// JSON ffprobe и строка версии — килобайты; хвост stderr нужен только для текста ошибки.
	result, err := process.Run(ctx, process.Command{Path: program, Args: args, StdoutLimit: 16 << 20, StderrLimit: 64 << 10})
	if err != nil {
		var start *process.StartError
		if errors.As(err, &start) {
			return nil, pycompat.New(pycompat.FileNotFoundError, "[Errno 2] No such file or directory: "+pycompat.Repr(program))
		}
		var exit *process.ExitError
		if errors.As(err, &exit) {
			stderr := []rune(strings.ToValidUTF8(string(result.Stderr), "�"))
			if len(stderr) > 1200 {
				stderr = stderr[len(stderr)-1200:]
			}
			return nil, valueError("Команда обработки медиа завершилась с ошибкой: " + string(stderr))
		}
		return nil, err
	}
	return result.Stdout, nil
}

// probe — probe(path) build_animatic: JSON ffprobe потоков, формата и глав.
func probe(ctx context.Context, path string) (*pycompat.Dict, error) {
	_, ffprobe := programs()
	data, err := run(ctx, ffprobe, "-v", "error", "-show_streams", "-show_format", "-show_chapters", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	text, err := pycompat.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	value, err := pycompat.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	return dict(value), nil
}

// attemptData — resolve_package: пакет, папка попытки, запрос, состояние и workflow.
type attemptData struct {
	packageDir, workDir string
	request, attempt    *pycompat.Dict
	workflow            *pycompat.Dict
}

// absolute — путь относительно корня проекта, разрешённый до реального.
func absolute(root, path string) string {
	if !filepath.IsAbs(path) {
		path = pycompat.JoinPath(root, path)
	}
	return pycompat.ResolvePath(path)
}

// resolvePackage — папка попытки с request.json и attempt.json; из пакета shot_workflow
// берётся request_dir.
func resolvePackage(packageDir, workDir, root string) (attemptData, error) {
	result := attemptData{}
	if packageDir != "" {
		result.packageDir = absolute(root, packageDir)
		value, err := loadJSON(pycompat.JoinPath(result.packageDir, "workflow.json"))
		if err != nil {
			return result, err
		}
		result.workflow = dict(value)
		if result.workflow == nil {
			return result, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'get'", pycompat.TypeName(value))
		}
		directory, _ := pycompat.DictGet(result.workflow, "request_dir", "request")
		name, ok := directory.(string)
		if !ok {
			return result, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(directory))
		}
		workDir = pycompat.JoinPath(result.packageDir, name)
	}
	if workDir == "" {
		return result, valueError(textSourceMiss)
	}
	result.workDir = absolute(root, workDir)
	request, err := loadJSON(pycompat.JoinPath(result.workDir, "request.json"))
	if err != nil {
		return result, err
	}
	attempt, err := loadJSON(pycompat.JoinPath(result.workDir, "attempt.json"))
	if err != nil {
		return result, err
	}
	result.attempt = dict(attempt)
	if result.attempt == nil {
		return result, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'get'", pycompat.TypeName(attempt))
	}
	if !pycompat.Equal(result.attempt.Value("status"), "downloaded") || !pycompat.Truthy(result.attempt.Value("downloads")) {
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
	return ok && pycompat.Strip(text) != ""
}

// frozenRequestFiles — нужные приёмке файлы запроса до staging: промпт и входы внутри папки попытки.
func frozenRequestFiles(request *pycompat.Dict, workDir string) (string, []string, error) {
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
		if !ok || pycompat.Strip(text) == "" {
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
		path := pycompat.ResolvePath(pycompat.JoinPath(workDir, text))
		if !pycompat.IsRelativeTo(path, pycompat.ResolvePath(workDir)) {
			return "", outside
		}
		if !pycompat.IsFile(path) {
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

// Options — параметры accept() перенесённого режима.
type Options struct {
	Package, WorkDir   string
	Full               bool
	Audio, AudioRecipe string
	Clean, Replace     bool
	UpdateViews        bool
	// LocalDir — каталог состояния для наблюдения расхода.
	LocalDir string
}

// acceptanceFingerprint — отпечаток постановки, по которой сделан комплект (scene_sha256 пакета),
// и текущий отпечаток плана.
func acceptanceFingerprint(registry *pycompat.Dict, shot string, workflow *pycompat.Dict, root string) (string, string, error) {
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
	current := pycompat.JoinPath(root, "assets", "shots", shot)
	archive := pycompat.JoinPath(root, "assets", "replaced", shot, Now().Format("20060102T150405Z"))
	if pycompat.Exists(archive) {
		relative, _ := pycompat.RelativeTo(archive, root)
		return "", valueError(shot + ": папка " + relative + " уже существует.")
	}
	if err := os.MkdirAll(filepath.Dir(archive), 0o755); err != nil {
		return "", pycompat.OSErrorFrom(err, filepath.Dir(archive))
	}
	if err := os.Rename(current, archive); err != nil {
		return "", pycompat.OSErrorFrom(err, current)
	}
	return archive, nil
}

// cleanWork — после проверки комплекта удаляет переданный пакет, все пакеты плана в plan/batches и
// опустевшие папки проб; assets, очередь других планов и чужие пакеты не трогает.
func cleanWork(root, shot, packageDir, workDir string) ([]any, error) {
	root = pycompat.ResolvePath(root)
	retained := checkworkspace.RetainedMontageFolders(root)
	batches := pycompat.ResolvePath(pycompat.JoinPath(root, "plan", "batches"))
	awaiting := pycompat.ResolvePath(pycompat.JoinPath(root, "plan", "awaiting"))
	removed := []any{}
	removeDir := func(folder string) (bool, error) {
		folder = pycompat.ResolvePath(folder)
		for item := range retained {
			if folder == item || pycompat.IsRelativeTo(folder, item) || pycompat.IsRelativeTo(item, folder) {
				return false, nil
			}
		}
		if pycompat.Exists(folder) && folder != batches && folder != awaiting &&
			(pycompat.IsRelativeTo(folder, batches) || pycompat.IsRelativeTo(folder, awaiting)) {
			if err := os.RemoveAll(folder); err != nil {
				return false, pycompat.OSErrorFrom(err, folder)
			}
			relative, _ := pycompat.RelativeTo(folder, root)
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
	// Остальные пакеты и пробы, все планы которых уже приняты: проба с незавершённым соседом остаётся.
	accepted := pycompat.NewSet()
	for _, manifest := range pycompat.Glob(pycompat.JoinPath(root, "assets", "shots"), "M*/manifest.json") {
		_ = accepted.Add(pycompat.PathName(filepath.Dir(manifest)))
	}
	_ = accepted.Add(shot)
	folders := func() []string {
		if !pycompat.IsDir(batches) {
			return nil
		}
		items, _ := pycompat.IterDir(batches)
		sort.Strings(items)
		return items
	}
	for _, folder := range folders() {
		if !pycompat.IsDir(folder) {
			continue
		}
		owners, err := checkworkspace.PackageOwners(folder)
		if err != nil {
			return nil, err
		}
		if owners.Len() > 0 && owners.SubsetOf(accepted) && (owners.Contains(shot) || strings.HasPrefix(pycompat.PathName(folder), shot+"-")) {
			if _, err := removeDir(folder); err != nil {
				return nil, err
			}
		}
	}
	// Пустые папки проб: файлы уже удалены, папка не нужна.
	for _, folder := range folders() {
		if !pycompat.IsDir(folder) {
			continue
		}
		if entries, err := os.ReadDir(folder); err == nil && len(entries) == 0 {
			if err := os.Remove(folder); err != nil {
				return nil, pycompat.OSErrorFrom(err, folder)
			}
			relative, _ := pycompat.RelativeTo(folder, root)
			removed = append(removed, relative)
		}
	}
	return removed, nil
}

// Accept — accept(shot, …) в режиме full: комплект assets/shots/<shot> из скачанного оригинала.
func Accept(ctx context.Context, root, shot string, options Options) (*pycompat.Dict, error) {
	root = pycompat.ResolvePath(root)
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	var scene *pycompat.Dict
	scenes, _ := registry.Value("scenes").([]any)
	for _, raw := range scenes {
		if item := dict(raw); item != nil && pycompat.Equal(item.Value("id"), shot) {
			scene = item
			break
		}
	}
	if scene == nil {
		return nil, valueError(shot + ": план отсутствует в реестре сцен.")
	}
	end, err := pycompat.Item(scene, "end_frame_exclusive")
	if err != nil {
		return nil, err
	}
	start, err := pycompat.Item(scene, "start_frame")
	if err != nil {
		return nil, err
	}
	difference, err := pycompat.Sub(end, start)
	if err != nil {
		return nil, err
	}
	frames64, err := strconv.ParseInt(pycompat.Str(difference), 10, 64)
	if err != nil {
		return nil, pycompat.Raise(pycompat.TypeError, "frames must be an integer")
	}
	frames := pycompat.NewInt(frames64)
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
	if requestShot := request.Value("shot"); (requestShot != nil && !pycompat.Equal(requestShot, shot)) || !pycompat.Equal(request.Value("kind"), "video") {
		return nil, valueError("Пакет относится к другому плану или не является видеозапросом.")
	}
	target := pycompat.JoinPath(root, "assets", "shots", shot)
	if pycompat.Exists(target) && !options.Replace {
		return nil, valueError(shot + ": комплект уже есть в assets; замена выбранной версии — отдельное решение (--replace).")
	}
	downloads, _ := attempt.Value("downloads").([]any)
	firstPath, err := pycompat.Item(dict(downloads[0]), "path")
	if err != nil {
		return nil, err
	}
	original := pycompat.JoinPath(data.workDir, pycompat.Str(firstPath))
	if !pycompat.IsFile(original) {
		return nil, valueError("Скачанный оригинал не найден в попытке.")
	}
	lipsync := pycompat.Truthy(scene.Value("lipsync"))
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
	staging := pycompat.JoinPath(filepath.Dir(target), ".accept-"+shot)
	if pycompat.Exists(staging) {
		if err := os.RemoveAll(staging); err != nil {
			return nil, pycompat.OSErrorFrom(err, staging)
		}
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return nil, pycompat.OSErrorFrom(err, staging)
	}
	video, replaced, err := buildKit(ctx, root, shot, frames, staging, target, original, promptFile, inputFiles, data, lipsync, options)
	if err != nil {
		_ = os.RemoveAll(staging)
		return nil, err
	}
	// Сразу после переноса: комплект без отпечатка считается принятым по прежней постановке (stale).
	if err := sceneregistry.WriteAcceptedFingerprints(root, pytool.Record(shot, sceneDigest), true); err != nil {
		return nil, err
	}
	if _, err := assetpackage.ValidatePackage(pycompat.JoinPath(target, "manifest.json"), shot, root); err != nil {
		return nil, err
	}
	relativeTarget, _ := pycompat.RelativeTo(target, root)
	var replacedValue any
	if replaced != "" {
		replacedValue, _ = pycompat.RelativeTo(replaced, root)
	}
	warnings := []any{}
	result := pytool.Record("shot", shot, "target", relativeTarget, "frames", frames, "video_sha256", video.Value("sha256"),
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
			credits, err = pycompat.Item(learned, "credits")
		}
		switch {
		case err == nil:
			result.Set("observed_credits", credits)
		case pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError):
			warnings = append(warnings, "Наблюдение расхода не записано: "+err.Error())
		case pycompat.IsAny(err, pycompat.KeyError, pycompat.TypeError):
			var exception *pycompat.Exception
			errors.As(err, &exception)
			warnings = append(warnings, "Наблюдение расхода не записано: "+exception.Type)
		default:
			return nil, err
		}
	}
	result.Set("warnings", warnings)
	if options.UpdateViews {
		views := sceneviews.Run(root, []string{})
		if views.Code != 0 {
			return nil, pycompat.New("CalledProcessError", "Command 'update_scene_views' returned non-zero exit status "+strconv.Itoa(views.Code)+".")
		}
	}
	if options.Clean {
		cleaned, err := cleanWork(root, shot, data.packageDir, data.workDir)
		if err != nil {
			return nil, err
		}
		result.Set("cleaned", cleaned)
	}
	return result, nil
}

// buildKit — тело try оригинала: собирает комплект в staging и переносит его на место target
// (прежний комплект уходит в assets/replaced). Возвращает описатель video и путь прежнего комплекта.
func buildKit(ctx context.Context, root, shot string, frames pycompat.Int, staging, target, original, promptFile string,
	inputFiles []string, data attemptData, lipsync bool, options Options) (*pycompat.Dict, string, error) {
	request, attempt, workflow := data.request, data.attempt, data.workflow
	count, _ := strconv.ParseInt(frames.String(), 10, 64)
	if err := copyFile(original, pycompat.JoinPath(staging, "original.mp4")); err != nil {
		return nil, "", err
	}
	probed, err := probe(ctx, pycompat.JoinPath(staging, "original.mp4"))
	if err != nil {
		return nil, "", err
	}
	var media *pycompat.Dict
	streams, _ := probed.Value("streams").([]any)
	for _, raw := range streams {
		if stream := dict(raw); stream != nil && pycompat.Equal(stream.Value("codec_type"), "video") {
			media = stream
			break
		}
	}
	if media == nil {
		return nil, "", pycompat.New("StopIteration", "")
	}
	originalMedia := pycompat.NewDict()
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
			names[digest] = "generation-input-" + strconv.Itoa(order) + strings.ToLower(pycompat.PathSuffix(source))
			if err := copyFile(source, pycompat.JoinPath(staging, names[digest])); err != nil {
				return nil, "", err
			}
		}
		entry, err := descriptor(staging, names[digest])
		if err != nil {
			return nil, "", err
		}
		slot := item.Value("slot")
		if !pycompat.Truthy(slot) {
			slot = item.Value("flag")
		}
		role := item.Value("role")
		label, known := roleLabels[pycompat.Str(role)]
		_, isString := role.(string)
		switch {
		case known && isString:
			role = label
		case !pycompat.Truthy(role):
			role = "Вход генерации"
		}
		entry.Set("slot", slot)
		entry.Set("role", role)
		inputs = append(inputs, entry)
	}
	if err := copyFile(promptFile, pycompat.JoinPath(staging, "generation-prompt.txt")); err != nil {
		return nil, "", err
	}
	var audioEntry any
	if options.Audio != "" {
		if err := copyFile(options.Audio, pycompat.JoinPath(staging, "speech.wav")); err != nil {
			return nil, "", err
		}
		if audioEntry, err = descriptor(staging, "speech.wav"); err != nil {
			return nil, "", err
		}
		if options.AudioRecipe != "" {
			if err := copyFile(options.AudioRecipe, pycompat.JoinPath(staging, "audio-recipe.json")); err != nil {
				return nil, "", err
			}
		}
	}
	nbFrames, _ := strconv.ParseInt(pycompat.Str(originalMedia.Value("nb_frames")), 10, 64)
	if !originalMedia.Has("nb_frames") {
		nbFrames = 0
	}
	if !pycompat.Equal(originalMedia.Value("r_frame_rate"), "30/1") || nbFrames != count {
		return nil, "", valueError("Полный оригинал не совпадает с окном и FPS; задайте участок.")
	}
	if err := copyFile(pycompat.JoinPath(staging, "original.mp4"), pycompat.JoinPath(staging, "video.mp4")); err != nil {
		return nil, "", err
	}
	filter := "fps=30,trim=start_frame=0:end_frame=" + frames.String() + ",setpts=N/(30*TB),setsar=1"
	seconds := float64(count) / fps
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
		item := raw.(*pycompat.Dict)
		snapshotInputs = append(snapshotInputs, pytool.Record("slot", item.Value("slot"), "role", item.Value("role"), "path", item.Value("path"), "sha256", item.Value("sha256")))
	}
	snapshot := pycompat.NewDict()
	for _, key := range []string{"provider", "command", "model"} {
		value, err := pycompat.Item(request, key)
		if err != nil {
			return nil, "", err
		}
		if key == "provider" {
			snapshot.Set("schema_version", pycompat.NewInt(1))
			snapshot.Set("shot", shot)
		}
		// Снимок сохраняет исполнителя исходного запроса, чтобы повтор сравнивал его с выбором проекта.
		snapshot.Set(key, value)
	}
	parameters, _ := pycompat.DictGet(request, "parameters", pycompat.NewDict())
	outputs, _ := pycompat.DictGet(request, "outputs", pycompat.NewInt(1))
	snapshot.Set("parameters", parameters)
	snapshot.Set("outputs", outputs)
	snapshot.Set("request_sha256", attempt.Value("request_sha256"))
	snapshot.Set("inputs", snapshotInputs)
	snapshot.Set("prompt", "generation-prompt.txt")
	snapshot.Set("prompt_sha256", promptDesc.Value("sha256"))
	snapshot.Set("generation_id", attempt.Value("generation_id"))
	snapshot.Set("service_status", attempt.Value("service_status"))
	snapshot.Set("path_base", "asset_directory")
	if pycompat.Truthy(attempt.Value("manual_result")) {
		snapshot.Set("provenance", "Исход отправки остался неизвестен; оригинал загружен пользователем из истории генераций сервиса, "+
			"ID задания неизвестен.")
	}
	if err := writeJSON(pycompat.JoinPath(staging, "generation-request.json"), snapshot); err != nil {
		return nil, "", err
	}
	generationInputs := []any{}
	for _, raw := range inputs {
		item := raw.(*pycompat.Dict)
		generationInputs = append(generationInputs, pytool.Record("path", item.Value("path"), "sha256", item.Value("sha256"),
			"bytes", item.Value("bytes"), "slot", item.Value("slot"), "role", "Переданный кадр генерации"))
	}
	notes := []any{}
	if workflow != nil && pycompat.Truthy(workflow.Value("mode")) {
		notes = append(notes, "Режим согласования: "+pycompat.Str(workflow.Value("mode")))
	}
	prep := pytool.Record("schema_version", pycompat.NewInt(1), "shot", shot, "path_base", "asset_directory",
		"generation_inputs", generationInputs, "frame_prompts", []any{}, "references", []any{}, "notes", notes,
		"reproduction_note", "Точные байты кадров сохранены. Повтор генерации по промпту не гарантирует тех же пикселей.")
	if err := writeJSON(pycompat.JoinPath(staging, "preparation.json"), prep); err != nil {
		return nil, "", err
	}
	unique := pycompat.NewDict()
	for _, raw := range inputs {
		item := raw.(*pycompat.Dict)
		unique.Set(pycompat.Str(item.Value("path")), pytool.Record("path", item.Value("path"), "sha256", item.Value("sha256"), "bytes", item.Value("bytes")))
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
	ffmpeg, _ := programs()
	versionOutput, err := run(ctx, ffmpeg, "-version")
	if err != nil {
		return nil, "", err
	}
	versionText, err := pycompat.DecodeUTF8(versionOutput)
	if err != nil {
		return nil, "", err
	}
	lines := pycompat.SplitLines(versionText)
	if len(lines) == 0 {
		return nil, "", pycompat.New(pycompat.IndexError, "list index out of range")
	}
	sourceFPS := originalMedia.Value("r_frame_rate")
	conversion := "Исходная частота кадров совпадает со шкалой."
	if !pycompat.Equal(sourceFPS, "30/1") {
		conversion = "Выбор кадров без интерполяции движения."
	}
	manifest := pytool.Record(
		"schema_version", pycompat.NewInt(1),
		"shot", shot,
		"kind", "generated_video",
		"generation", pytool.Record(
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
			"preparation", pytool.Record("index", prepDesc, "files", files),
		),
		"accepted_edit", pytool.Record(
			"video", video,
			"fps", pycompat.NewInt(fps),
			"frames", frames,
			"duration_seconds", seconds,
			"source_interval_seconds", []any{0.0, seconds},
			"source_interval_end_exclusive", true,
			"source_frame_grid_fps", pycompat.NewInt(fps),
			"still_source_time_seconds", nil,
			"speed", pytool.Record(
				"factor", 1.0,
				"ratio", "1",
				"selected_source_seconds", seconds,
				"motion_output_seconds", seconds,
				"duration_change_seconds", 0.0,
			),
			"hold_first_seconds", 0.0,
			"hold_last_seconds", 0.0,
			"audio_policy", audioPolicy,
			"montage_source", video,
			"rebuild", pytool.Record(
				"stages", []any{pytool.Record("input", "original.mp4", "filter", filter, "frames", frames)},
				"source", originalDesc,
				"ffmpeg_version", lines[0],
				"note", rebuildNote,
			),
			"source_frame_interval_exclusive", []any{pycompat.NewInt(0), frames},
			"source_fps", sourceFPS,
			"fps_conversion", conversion,
		),
	)
	if err := writeJSON(pycompat.JoinPath(staging, "manifest.json"), manifest); err != nil {
		return nil, "", err
	}
	replaced := ""
	if pycompat.Exists(target) {
		if replaced, err = retireKit(root, shot); err != nil {
			return nil, "", err
		}
	}
	if err := os.Rename(staging, target); err != nil {
		return nil, "", pycompat.OSErrorFrom(err, staging)
	}
	return video, replaced, nil
}

// Run — main() accept_shot.py на разрешённом корне проекта. Перенесён режим --full; --cut и
// --review отказывают текстом «не перенесено» до любых записей.
func Run(ctx context.Context, root string, args []string, localDir string) pytool.Output {
	parsed, exit := pytool.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	value := func(name string) string {
		if values := parsed.Values[name]; len(values) > 0 {
			return values[0]
		}
		return ""
	}
	printer := &pytool.Printer{}
	if (value("--package") == "") == (value("--work-dir") == "") {
		return printer.Fail(textSourceMiss)
	}
	edits := 0
	for _, present := range []bool{value("--review") != "", value("--cut") != "", parsed.Bools["--full"]} {
		if present {
			edits++
		}
	}
	if edits != 1 {
		return printer.Fail(textEditMissing)
	}
	if !parsed.Bools["--full"] {
		return printer.Fail(textNotMigrated)
	}
	result, err := Accept(ctx, root, value("shot"), Options{
		Package: value("--package"), WorkDir: value("--work-dir"), Full: true, Audio: value("--audio"),
		AudioRecipe: value("--audio-recipe"), Clean: parsed.Bools["--clean"], Replace: parsed.Bools["--replace"],
		UpdateViews: !parsed.Bools["--no-views"], LocalDir: localDir,
	})
	if err != nil {
		switch {
		case pycompat.Is(err, pycompat.ValueError) && !pycompat.Is(err, pycompat.JSONDecodeError):
			return printer.Fail(err.Error())
		case pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError, pycompat.TypeError, "StopIteration"):
			return printer.Fail(textHidden)
		default:
			return printer.Crash(err)
		}
	}
	text, err := pytool.JSON(result)
	if err != nil {
		return printer.Crash(err)
	}
	if err := printer.Print(text); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}
