// Package assetpackage проверяет комплект принятого ассета и разрешает его файлы.
// Комплект assets/shots/<план>/manifest.json сохраняет оригинал генерации, принятый
// монтаж, промпт, входы и рецепт воспроизведения; проверка сверяет технический контракт, SHA-256
// файлов и длину монтажа с окном плана в реестре. Replay (replay.go) воспроизводит принятый
// монтаж в новый файл вне assets для verify_asset_replay. Проверка только читает файлы; ошибки —
// исключения toolrt с фиксированными текстами: инструменты печатают их как есть, а
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

	"songframe/internal/filedigest"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolrt"
)

// sha256Hex — SHA-256 целиком: ровно 64 строчные шестнадцатеричные цифры.
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

// item — значение комплекта по ключу key; отсутствие ключа — исключение toolrt.Item.
func item(container any, key string) (any, error) { return toolrt.Item(container, key) }

// LocalFile — разрешённый абсолютный путь файла name внутри папки комплекта.
func LocalFile(directory string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(name))
	}
	path := toolrt.ResolvePath(toolrt.JoinPath(directory, text))
	if !toolrt.IsRelativeTo(path, toolrt.ResolvePath(directory)) {
		return "", toolrt.New(toolrt.ValueError, textOutsideAsset)
	}
	return path, nil
}

// descriptorFile — файл описателя item: локальный файл комплекта либо общий референс
// из source проекта (без абсолютного пути, «..» и выхода по ссылке; только изображения).
func descriptorFile(directory string, descriptor *toolrt.Dict, root string) (string, error) {
	scope, _ := toolrt.DictGet(descriptor, "root", "asset")
	path, err := item(descriptor, "path")
	if err != nil {
		return "", err
	}
	if toolrt.Equal(scope, "asset") {
		return LocalFile(directory, path)
	}
	if !toolrt.Equal(scope, "source") {
		return "", toolrt.New(toolrt.ValueError, textUnknownRoot)
	}
	base := toolrt.ResolvePath(toolrt.JoinPath(root, "source"))
	name, ok := path.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "путь должен быть строкой, получено: %s", toolrt.TypeName(path))
	}
	source := toolrt.ResolvePath(toolrt.JoinPath(base, name))
	parent := false
	for _, part := range strings.FieldsFunc(name, func(r rune) bool { return r == '/' || r == os.PathSeparator }) {
		parent = parent || part == ".."
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") || parent || !toolrt.IsRelativeTo(source, base) {
		return "", toolrt.New(toolrt.ValueError, textOutsideSource)
	}
	if !imageSuffixes[strings.ToLower(toolrt.PathSuffix(source))] {
		return "", toolrt.New(toolrt.ValueError, textSourceImage)
	}
	return source, nil
}

// Descriptors — все словари с path и sha256 внутри value в порядке обхода (сам словарь, затем
// его значения), вложенные — тоже.
func Descriptors(value any, visit func(*toolrt.Dict) error) error {
	switch node := value.(type) {
	case *toolrt.Dict:
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

// ProjectPath — путь файла path для сообщений: относительно корня проекта root через «/», а если
// файл вне root — как есть.
func ProjectPath(path, root string) string {
	relative, err := toolrt.RelativeTo(path, root)
	if err != nil {
		return path
	}
	return filepath.ToSlash(relative)
}

// FileSHA256 — SHA-256 файла потоком. Ошибка открытия — OSError.
func FileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", toolrt.OSErrorFrom(err, path)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", toolrt.OSErrorFrom(err, path)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// lessEqual — сравнение a <= b значений toolrt.LessEqual (TypeError для нечисел).
func lessEqual(a, b any) (bool, error) { return toolrt.LessEqual(a, b) }

// checkRepeat — проверка необязательного accepted_edit.repeat.
func checkRepeat(edit *toolrt.Dict, repeat any) error {
	block, ok := repeat.(*toolrt.Dict)
	keys := []string{"full_cycles", "tail_frames", "cycle_frames"}
	if ok && block.Len() == 3 {
		for _, key := range keys {
			ok = ok && block.Has(key) && toolrt.IsExactInt(block.Value(key))
		}
	} else {
		ok = false
	}
	if !ok {
		return toolrt.New(toolrt.ValueError, textRepeatShape)
	}
	full := block.Value("full_cycles").(toolrt.Int).Big()
	tail := block.Value("tail_frames").(toolrt.Int).Big()
	cycle := block.Value("cycle_frames").(toolrt.Int).Big()
	if full.Sign() < 0 || cycle.Sign() <= 0 || tail.Sign() < 0 || tail.Cmp(cycle) >= 0 {
		return toolrt.New(toolrt.ValueError, textRepeatLength)
	}
	frames, err := item(edit, "frames")
	if err != nil {
		return err
	}
	total := toolrt.IntFromBig(new(big.Int).Add(new(big.Int).Mul(full, cycle), tail))
	if !toolrt.Equal(total, frames) {
		return toolrt.New(toolrt.ValueError, textRepeatLength)
	}
	return nil
}

// ValidatePackage — проверенный комплект path или исключение.
// shotID пустой — без сверки кода плана; root — корень проекта, от которого разрешаются общие
// референсы source.
func ValidatePackage(path, shotID, root string) (*toolrt.Dict, error) {
	text, err := toolrt.ReadText(path)
	if err != nil {
		return nil, err
	}
	value, err := toolrt.LoadsJSON(text)
	if err != nil {
		return nil, err
	}
	// Выбор комплекта в assets уже означает одобрение. Здесь проверяется только технический
	// контракт, необходимый для сохранности и повторения монтажа.
	schema, err := item(value, "schema_version")
	if err != nil {
		return nil, err
	}
	if !toolrt.Equal(schema, toolrt.NewInt(1)) {
		return nil, toolrt.New(toolrt.ValueError, textSchema)
	}
	if shotID != "" {
		shot, err := item(value, "shot")
		if err != nil {
			return nil, err
		}
		if !toolrt.Equal(shot, shotID) {
			return nil, toolrt.New(toolrt.ValueError, textOtherShot)
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
	document := value.(*toolrt.Dict)
	if kind := document.Value("kind"); toolrt.Equal(kind, "derived_video") {
		sourceScene, err := toolrt.DictGet(generationValue, "source_scene_sha256", nil)
		if err != nil {
			return nil, err
		}
		sourceVideo, _ := toolrt.DictGet(generationValue, "source_accepted_video_sha256", nil)
		generation := generationValue.(*toolrt.Dict)
		text, isString := sourceScene.(string)
		if !generation.Has("source_scene_sha256") || (sourceScene != nil && (!isString || !sha256Hex.MatchString(text))) {
			return nil, toolrt.New(toolrt.ValueError, textDerivedScene)
		}
		if video, isString := sourceVideo.(string); !isString || !sha256Hex.MatchString(video) {
			return nil, toolrt.New(toolrt.ValueError, textDerivedVideo)
		}
	}
	repeat, err := toolrt.DictGet(editValue, "repeat", nil)
	if err != nil {
		return nil, err
	}
	edit := editValue.(*toolrt.Dict)
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
	if toolrt.Equal(originalPath, videoPath) {
		return nil, toolrt.New(toolrt.ValueError, textSameFiles)
	}
	inputs, err := item(generationValue, "inputs")
	if err != nil {
		return nil, err
	}
	// Своё видео плана сделано вне приложения без входов генерации.
	if !toolrt.Truthy(inputs) && !toolrt.Equal(generationValue.(*toolrt.Dict).Value("own_video"), true) {
		return nil, toolrt.New(toolrt.ValueError, textNoInputs)
	}
	prompt, err := item(generationValue, "prompt")
	if err != nil {
		return nil, err
	}
	if !toolrt.Truthy(prompt) {
		return nil, toolrt.New(toolrt.ValueError, textNoInputs)
	}
	// Снимок запроса обязателен: провайдер, модель, параметры и ID либо явная причина его отсутствия.
	generation := generationValue.(*toolrt.Dict)
	request, isDict := generation.Value("request").(*toolrt.Dict)
	if !isDict {
		return nil, toolrt.New(toolrt.ValueError, textNoRequest)
	}
	if !toolrt.Truthy(request.Value("path")) {
		return nil, toolrt.New(toolrt.ValueError, textNoRequest)
	}
	lipsync, err := item(generation, "lipsync")
	if err != nil {
		return nil, err
	}
	if toolrt.Truthy(lipsync) && !toolrt.Truthy(generation.Value("audio")) {
		return nil, toolrt.New(toolrt.ValueError, textNoAudio)
	}
	fps, err := item(edit, "fps")
	if err != nil {
		return nil, err
	}
	if bad, err := lessEqual(fps, toolrt.NewInt(0)); err != nil || bad {
		if err != nil {
			return nil, err
		}
		return nil, toolrt.New(toolrt.ValueError, textNoReplay)
	}
	frames, err := item(edit, "frames")
	if err != nil {
		return nil, err
	}
	if bad, err := lessEqual(frames, toolrt.NewInt(0)); err != nil || bad {
		if err != nil {
			return nil, err
		}
		return nil, toolrt.New(toolrt.ValueError, textNoReplay)
	}
	rebuild, err := item(edit, "rebuild")
	if err != nil {
		return nil, err
	}
	stagesValue, err := item(rebuild, "stages")
	if err != nil {
		return nil, err
	}
	if !toolrt.Truthy(stagesValue) {
		return nil, toolrt.New(toolrt.ValueError, textNoReplay)
	}
	duration, err := item(edit, "duration_seconds")
	if err != nil {
		return nil, err
	}
	quotient, err := toolrt.TrueDiv(frames, fps)
	if err != nil {
		return nil, err
	}
	difference, err := toolrt.Sub(duration, quotient)
	if err != nil {
		return nil, err
	}
	if math.Abs(difference.(float64)) > 1e-8 {
		return nil, toolrt.New(toolrt.ValueError, textDuration)
	}
	last, err := toolrt.GetItem(stagesValue, toolrt.NewInt(-1))
	if err != nil {
		return nil, err
	}
	lastFrames, err := item(last, "frames")
	if err != nil {
		return nil, err
	}
	if !toolrt.Equal(lastFrames, frames) {
		return nil, toolrt.New(toolrt.ValueError, textStageLength)
	}
	// Общими могут быть входные изображения и референсы подготовки. Оригинал, монтаж, промпт и
	// WAV принадлежат конкретной сцене и остаются локальными. Сравнение — по идентичности объекта.
	shared := map[*toolrt.Dict]bool{}
	addShared := func(value any) error {
		elements, err := toolrt.Iter(value)
		if err != nil {
			return toolrt.Raise(toolrt.TypeError, "нельзя перебрать: %s", toolrt.TypeName(value))
		}
		for _, element := range elements {
			if descriptor, ok := element.(*toolrt.Dict); ok {
				shared[descriptor] = true
			}
		}
		return nil
	}
	if err := addShared(inputs); err != nil {
		return nil, err
	}
	auxiliary, _ := toolrt.DictGet(generation, "auxiliary_references", []any{})
	if err := addShared(auxiliary); err != nil {
		return nil, err
	}
	preparation, _ := toolrt.DictGet(generation, "preparation", toolrt.NewDict())
	files, err := toolrt.DictGet(preparation, "files", []any{})
	if err != nil {
		return nil, err
	}
	if err := addShared(files); err != nil {
		return nil, err
	}
	directory := filepath.Dir(path)
	shotValue := document.Value("shot")
	registered := map[[2]string]bool{}
	err = Descriptors(document, func(descriptor *toolrt.Dict) error {
		scope, _ := toolrt.DictGet(descriptor, "root", "asset")
		if toolrt.Equal(scope, "source") && !shared[descriptor] {
			return toolrt.New(toolrt.ValueError, textSharedOnly)
		}
		source, err := descriptorFile(directory, descriptor, root)
		if err != nil {
			return err
		}
		changed := !toolrt.IsFile(source)
		if !changed {
			digest, err := FileSHA256(source)
			if err != nil {
				return err
			}
			changed = !toolrt.Equal(digest, descriptor.Value("sha256"))
		}
		if changed {
			// Указатель Git LFS вместо медиа — не правка комплекта, а незагруженное содержимое клона.
			if text, ok := filedigest.LFSPointerProblem(source, ProjectPath(source, root)); ok {
				return toolrt.New(toolrt.ValueError, text)
			}
			shot, err := item(document, "shot")
			if err != nil {
				return err
			}
			return toolrt.New(toolrt.ValueError, toolrt.Str(shot)+": изменился файл комплекта "+toolrt.Str(descriptor.Value("path")))
		}
		registered[[2]string{toolrt.Str(scope), descriptor.Value("path").(string)}] = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	stages, err := toolrt.Iter(stagesValue)
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
		bad := !registered[[2]string{"asset", input.(string)}] || !toolrt.IsFile(source)
		if !bad {
			filter, err := item(stage, "filter")
			if err != nil {
				return nil, err
			}
			bad = !toolrt.Truthy(filter)
		}
		if !bad {
			stageFrames, err := item(stage, "frames")
			if err != nil {
				return nil, err
			}
			if bad, err = lessEqual(stageFrames, toolrt.NewInt(0)); err != nil {
				return nil, err
			}
		}
		if bad {
			return nil, toolrt.New(toolrt.ValueError, textStageInput)
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
	scenes, _ := toolrt.Iter(registry.Value("scenes"))
	var scene *toolrt.Dict
	for _, candidate := range scenes {
		if entry := candidate.(*toolrt.Dict); toolrt.Equal(entry.Value("id"), shot) {
			scene = entry
			break
		}
	}
	if scene == nil {
		return nil, toolrt.New(toolrt.ValueError, toolrt.Str(shotValue)+": ассет отсутствует в реестре планов.")
	}
	if !toolrt.Equal(fps, registry.Value("fps")) {
		return nil, toolrt.New(toolrt.ValueError, toolrt.Str(shot)+": FPS принятого клипа расходится с реестром планов.")
	}
	window, err := toolrt.Sub(scene.Value("end_frame_exclusive"), scene.Value("start_frame"))
	if err != nil {
		return nil, err
	}
	if !toolrt.Equal(frames, window) {
		return nil, toolrt.New(toolrt.ValueError, toolrt.Str(shot)+": длина принятого клипа расходится с монтажным окном.")
	}
	return document, nil
}

// DescriptorFile — descriptorFile для других инструментов (regenerate_shot):
// файл описателя комплекта в его папке либо общий референс из source проекта.
func DescriptorFile(directory string, descriptor *toolrt.Dict, root string) (string, error) {
	return descriptorFile(directory, descriptor, root)
}
