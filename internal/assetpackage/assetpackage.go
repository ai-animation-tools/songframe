// Package assetpackage проверяет комплект принятого ассета и разрешает его файлы.
// Комплект assets/shots/<план>/manifest.json сохраняет оригинал генерации, принятый
// монтаж, промпт, входы и рецепт воспроизведения; проверка сверяет технический контракт, SHA-256
// файлов и длину монтажа с окном плана в реестре. Replay (replay.go) воспроизводит принятый
// монтаж в новый файл вне assets для verify_asset_replay. Проверка только читает файлы; ошибки —
// исключения Python (pycompat) с фиксированными текстами: инструменты печатают их как есть, а
// эталоны check-assets и verify-asset-replay сверяют вывод.
package assetpackage

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/sceneregistry"
)

// sha256Hex — re.fullmatch(r"[0-9a-f]{64}").
var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// imageSuffixes — допустимые расширения общего референса из source.
var imageSuffixes = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true}

// Тексты отказов; их показывают инструменты, формулировки зафиксированы эталонами.
const (
	textOutsideAsset  = "Файл комплекта находится вне папки ассета."
	textUnknownRoot   = "Неизвестный корень файла комплекта."
	textOutsideSource = "Общий референс находится вне source."
	textSourceImage   = "Общий референс должен быть изображением из source."
	textSchema        = "Неизвестная схема комплекта ассета."
	textOtherShot     = "Комплект относится к другому плану."
	textDerivedScene  = "В производном комплекте нужен source_scene_sha256: SHA постановки источника либо null для неизвестной версии."
	textDerivedVideo  = "В производном комплекте нужен source_accepted_video_sha256 выбранного клипа источника."
	textRepeatShape   = "Повтор задаётся целыми full_cycles, tail_frames и cycle_frames."
	textRepeatLength  = "Число циклов и хвост повтора расходятся с длиной принятого монтажа."
	textSameFiles     = "Оригинал и принятый монтаж должны быть разными файлами."
	textNoInputs      = "В комплекте отсутствуют кадры или промпт генерации."
	textNoRequest     = "В комплекте нет технического снимка запроса generation-request.json."
	textNoAudio       = "В комплекте липсинка отсутствует входное аудио."
	textNoReplay      = "Не сохранены параметры воспроизведения принятого монтажа."
	textDuration      = "Длительность принятого монтажа расходится с числом кадров."
	textStageLength   = "Повтор фильтров даёт другую длину монтажа."
	textSharedOnly    = "Общими могут быть только входные изображения и референсы подготовки."
	textStageInput    = "Не сохранён вход или фильтр этапа воспроизведения."
)

// item — package[key] с исключением Python.
func item(container any, key string) (any, error) { return pycompat.Item(container, key) }

// pathClass — имя класса пути для текста TypeError оператора `/`.
func pathClass() string {
	if os.PathSeparator == '\\' {
		return "WindowsPath"
	}
	return "PosixPath"
}

// LocalFile — путь файла name внутри папки комплекта после resolve().
func LocalFile(directory string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", pathClass(), pycompat.TypeName(name))
	}
	path := pycompat.ResolvePath(pycompat.JoinPath(directory, text))
	if !pycompat.IsRelativeTo(path, pycompat.ResolvePath(directory)) {
		return "", pycompat.New(pycompat.ValueError, textOutsideAsset)
	}
	return path, nil
}

// descriptorFile — файл описателя item: локальный файл комплекта либо общий референс
// из source проекта (без абсолютного пути, «..» и выхода по ссылке; только изображения).
func descriptorFile(directory string, descriptor *pycompat.Dict, root string) (string, error) {
	scope, _ := pycompat.DictGet(descriptor, "root", "asset")
	path, err := item(descriptor, "path")
	if err != nil {
		return "", err
	}
	if pycompat.Equal(scope, "asset") {
		return LocalFile(directory, path)
	}
	if !pycompat.Equal(scope, "source") {
		return "", pycompat.New(pycompat.ValueError, textUnknownRoot)
	}
	base := pycompat.ResolvePath(pycompat.JoinPath(root, "source"))
	name, ok := path.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "argument should be a str or an os.PathLike object where __fspath__ returns a str, not '%s'", pycompat.TypeName(path))
	}
	source := pycompat.ResolvePath(pycompat.JoinPath(base, name))
	parent := false
	for _, part := range strings.FieldsFunc(name, func(r rune) bool { return r == '/' || r == os.PathSeparator }) {
		parent = parent || part == ".."
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") || parent || !pycompat.IsRelativeTo(source, base) {
		return "", pycompat.New(pycompat.ValueError, textOutsideSource)
	}
	if !imageSuffixes[strings.ToLower(pycompat.PathSuffix(source))] {
		return "", pycompat.New(pycompat.ValueError, textSourceImage)
	}
	return source, nil
}

// Descriptors — все словари с path и sha256 внутри value в порядке обхода (сам словарь, затем
// его значения), вложенные — тоже.
func Descriptors(value any, visit func(*pycompat.Dict) error) error {
	switch node := value.(type) {
	case *pycompat.Dict:
		if node.Has("path") && node.Has("sha256") {
			if err := visit(node); err != nil {
				return err
			}
		}
		for _, key := range node.Keys() {
			if err := Descriptors(node.Value(key), visit); err != nil {
				return err
			}
		}
	case []any:
		for _, element := range node {
			if err := Descriptors(element, visit); err != nil {
				return err
			}
		}
	}
	return nil
}

// FileSHA256 — SHA-256 файла потоком. Ошибка открытия — OSError.
func FileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", pycompat.OSErrorFrom(err, path)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", pycompat.OSErrorFrom(err, path)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// lessEqual — a <= b по правилам Python (TypeError для нечисел).
func lessEqual(a, b any) (bool, error) { return pycompat.LessEqual(a, b) }

// checkRepeat — проверка необязательного accepted_edit.repeat.
func checkRepeat(edit *pycompat.Dict, repeat any) error {
	block, ok := repeat.(*pycompat.Dict)
	keys := []string{"full_cycles", "tail_frames", "cycle_frames"}
	if ok && block.Len() == 3 {
		for _, key := range keys {
			ok = ok && block.Has(key) && pycompat.IsExactInt(block.Value(key))
		}
	} else {
		ok = false
	}
	if !ok {
		return pycompat.New(pycompat.ValueError, textRepeatShape)
	}
	full := block.Value("full_cycles").(pycompat.Int).Big()
	tail := block.Value("tail_frames").(pycompat.Int).Big()
	cycle := block.Value("cycle_frames").(pycompat.Int).Big()
	if full.Sign() < 0 || cycle.Sign() <= 0 || tail.Sign() < 0 || tail.Cmp(cycle) >= 0 {
		return pycompat.New(pycompat.ValueError, textRepeatLength)
	}
	frames, err := item(edit, "frames")
	if err != nil {
		return err
	}
	total := pycompat.IntFromBig(new(big.Int).Add(new(big.Int).Mul(full, cycle), tail))
	if !pycompat.Equal(total, frames) {
		return pycompat.New(pycompat.ValueError, textRepeatLength)
	}
	return nil
}

// ValidatePackage — проверенный комплект path или исключение.
// shotID пустой — без сверки кода плана; root — корень проекта, от которого разрешаются общие
// референсы source.
func ValidatePackage(path, shotID, root string) (*pycompat.Dict, error) {
	text, err := pycompat.ReadText(path)
	if err != nil {
		return nil, err
	}
	value, err := pycompat.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	// Выбор комплекта в assets уже означает одобрение. Здесь проверяется только технический
	// контракт, необходимый для сохранности и повторения монтажа.
	schema, err := item(value, "schema_version")
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(schema, pycompat.NewInt(1)) {
		return nil, pycompat.New(pycompat.ValueError, textSchema)
	}
	if shotID != "" {
		shot, err := item(value, "shot")
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(shot, shotID) {
			return nil, pycompat.New(pycompat.ValueError, textOtherShot)
		}
	}
	generationValue, err := item(value, "generation")
	if err != nil {
		return nil, err
	}
	editValue, err := item(value, "accepted_edit")
	if err != nil {
		return nil, err
	}
	document := value.(*pycompat.Dict)
	if kind := document.Value("kind"); pycompat.Equal(kind, "derived_video") {
		sourceScene, err := pycompat.DictGet(generationValue, "source_scene_sha256", nil)
		if err != nil {
			return nil, err
		}
		sourceVideo, _ := pycompat.DictGet(generationValue, "source_accepted_video_sha256", nil)
		generation := generationValue.(*pycompat.Dict)
		text, isString := sourceScene.(string)
		if !generation.Has("source_scene_sha256") || (sourceScene != nil && (!isString || !sha256Hex.MatchString(text))) {
			return nil, pycompat.New(pycompat.ValueError, textDerivedScene)
		}
		if video, isString := sourceVideo.(string); !isString || !sha256Hex.MatchString(video) {
			return nil, pycompat.New(pycompat.ValueError, textDerivedVideo)
		}
	}
	repeat, err := pycompat.DictGet(editValue, "repeat", nil)
	if err != nil {
		return nil, err
	}
	edit := editValue.(*pycompat.Dict)
	if repeat != nil {
		if err := checkRepeat(edit, repeat); err != nil {
			return nil, err
		}
	}
	original, err := item(generationValue, "original")
	if err != nil {
		return nil, err
	}
	originalPath, err := item(original, "path")
	if err != nil {
		return nil, err
	}
	video, err := item(edit, "video")
	if err != nil {
		return nil, err
	}
	videoPath, err := item(video, "path")
	if err != nil {
		return nil, err
	}
	if pycompat.Equal(originalPath, videoPath) {
		return nil, pycompat.New(pycompat.ValueError, textSameFiles)
	}
	inputs, err := item(generationValue, "inputs")
	if err != nil {
		return nil, err
	}
	if !pycompat.Truthy(inputs) {
		return nil, pycompat.New(pycompat.ValueError, textNoInputs)
	}
	prompt, err := item(generationValue, "prompt")
	if err != nil {
		return nil, err
	}
	if !pycompat.Truthy(prompt) {
		return nil, pycompat.New(pycompat.ValueError, textNoInputs)
	}
	// Снимок запроса обязателен: провайдер, модель, параметры и ID либо явная причина его отсутствия.
	generation := generationValue.(*pycompat.Dict)
	request, isDict := generation.Value("request").(*pycompat.Dict)
	if !isDict {
		return nil, pycompat.New(pycompat.ValueError, textNoRequest)
	}
	if !pycompat.Truthy(request.Value("path")) {
		return nil, pycompat.New(pycompat.ValueError, textNoRequest)
	}
	lipsync, err := item(generation, "lipsync")
	if err != nil {
		return nil, err
	}
	if pycompat.Truthy(lipsync) && !pycompat.Truthy(generation.Value("audio")) {
		return nil, pycompat.New(pycompat.ValueError, textNoAudio)
	}
	fps, err := item(edit, "fps")
	if err != nil {
		return nil, err
	}
	if bad, err := lessEqual(fps, pycompat.NewInt(0)); err != nil || bad {
		if err != nil {
			return nil, err
		}
		return nil, pycompat.New(pycompat.ValueError, textNoReplay)
	}
	frames, err := item(edit, "frames")
	if err != nil {
		return nil, err
	}
	if bad, err := lessEqual(frames, pycompat.NewInt(0)); err != nil || bad {
		if err != nil {
			return nil, err
		}
		return nil, pycompat.New(pycompat.ValueError, textNoReplay)
	}
	rebuild, err := item(edit, "rebuild")
	if err != nil {
		return nil, err
	}
	stagesValue, err := item(rebuild, "stages")
	if err != nil {
		return nil, err
	}
	if !pycompat.Truthy(stagesValue) {
		return nil, pycompat.New(pycompat.ValueError, textNoReplay)
	}
	duration, err := item(edit, "duration_seconds")
	if err != nil {
		return nil, err
	}
	quotient, err := pycompat.TrueDiv(frames, fps)
	if err != nil {
		return nil, err
	}
	difference, err := pycompat.Sub(duration, quotient)
	if err != nil {
		return nil, err
	}
	if math.Abs(difference.(float64)) > 1e-8 {
		return nil, pycompat.New(pycompat.ValueError, textDuration)
	}
	last, err := pycompat.GetItem(stagesValue, pycompat.NewInt(-1))
	if err != nil {
		return nil, err
	}
	lastFrames, err := item(last, "frames")
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(lastFrames, frames) {
		return nil, pycompat.New(pycompat.ValueError, textStageLength)
	}
	// Общими могут быть входные изображения и референсы подготовки. Оригинал, монтаж, промпт и
	// WAV принадлежат конкретной сцене и остаются локальными. Сравнение — по идентичности объекта.
	shared := map[*pycompat.Dict]bool{}
	addShared := func(value any) error {
		elements, err := pycompat.Iter(value)
		if err != nil {
			return pycompat.Raise(pycompat.TypeError, "Value after * must be an iterable, not %s", pycompat.TypeName(value))
		}
		for _, element := range elements {
			if descriptor, ok := element.(*pycompat.Dict); ok {
				shared[descriptor] = true
			}
		}
		return nil
	}
	if err := addShared(inputs); err != nil {
		return nil, err
	}
	auxiliary, _ := pycompat.DictGet(generation, "auxiliary_references", []any{})
	if err := addShared(auxiliary); err != nil {
		return nil, err
	}
	preparation, _ := pycompat.DictGet(generation, "preparation", pycompat.NewDict())
	files, err := pycompat.DictGet(preparation, "files", []any{})
	if err != nil {
		return nil, err
	}
	if err := addShared(files); err != nil {
		return nil, err
	}
	directory := filepath.Dir(path)
	shotValue := document.Value("shot")
	registered := map[[2]string]bool{}
	err = Descriptors(document, func(descriptor *pycompat.Dict) error {
		scope, _ := pycompat.DictGet(descriptor, "root", "asset")
		if pycompat.Equal(scope, "source") && !shared[descriptor] {
			return pycompat.New(pycompat.ValueError, textSharedOnly)
		}
		source, err := descriptorFile(directory, descriptor, root)
		if err != nil {
			return err
		}
		changed := !pycompat.IsFile(source)
		if !changed {
			digest, err := FileSHA256(source)
			if err != nil {
				return err
			}
			changed = !pycompat.Equal(digest, descriptor.Value("sha256"))
		}
		if changed {
			shot, err := item(document, "shot")
			if err != nil {
				return err
			}
			return pycompat.New(pycompat.ValueError, pycompat.Str(shot)+": изменился файл комплекта "+pycompat.Str(descriptor.Value("path")))
		}
		registered[[2]string{pycompat.Str(scope), descriptor.Value("path").(string)}] = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	stages, err := pycompat.Iter(stagesValue)
	if err != nil {
		return nil, err
	}
	for _, stage := range stages {
		input, err := item(stage, "input")
		if err != nil {
			return nil, err
		}
		source, err := LocalFile(directory, input)
		if err != nil {
			return nil, err
		}
		bad := !registered[[2]string{"asset", input.(string)}] || !pycompat.IsFile(source)
		if !bad {
			filter, err := item(stage, "filter")
			if err != nil {
				return nil, err
			}
			bad = !pycompat.Truthy(filter)
		}
		if !bad {
			stageFrames, err := item(stage, "frames")
			if err != nil {
				return nil, err
			}
			if bad, err = lessEqual(stageFrames, pycompat.NewInt(0)); err != nil {
				return nil, err
			}
		}
		if bad {
			return nil, pycompat.New(pycompat.ValueError, textStageInput)
		}
	}
	// Даже внутренне согласованный комплект может иметь длину другого окна. Сверяем только JSON
	// реестра, без анализа медиа.
	registry, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	shot, err := item(document, "shot")
	if err != nil {
		return nil, err
	}
	scenes, _ := pycompat.Iter(registry.Value("scenes"))
	var scene *pycompat.Dict
	for _, candidate := range scenes {
		if entry := candidate.(*pycompat.Dict); pycompat.Equal(entry.Value("id"), shot) {
			scene = entry
			break
		}
	}
	if scene == nil {
		return nil, pycompat.New(pycompat.ValueError, pycompat.Str(shotValue)+": ассет отсутствует в реестре сцен.")
	}
	if !pycompat.Equal(fps, registry.Value("fps")) {
		return nil, pycompat.New(pycompat.ValueError, pycompat.Str(shot)+": FPS принятого клипа расходится с реестром сцен.")
	}
	window, err := pycompat.Sub(scene.Value("end_frame_exclusive"), scene.Value("start_frame"))
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(frames, window) {
		return nil, pycompat.New(pycompat.ValueError, pycompat.Str(shot)+": длина принятого клипа расходится с монтажным окном.")
	}
	return document, nil
}

// DescriptorFile — descriptorFile для других инструментов (regenerate_shot):
// файл описателя комплекта в его папке либо общий референс из source проекта.
func DescriptorFile(directory string, descriptor *pycompat.Dict, root string) (string, error) {
	return descriptorFile(directory, descriptor, root)
}
