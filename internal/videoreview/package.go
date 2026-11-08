package videoreview

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
)

// Чтение пакета производства в объёме, нужном проверке видео: кадры-опоры, этап, зафиксированный
// запрос, скачанные файлы, признак resultToken, описание и промпты. Правила чтения те же, что у
// production.ReadPackage. Повреждённые значения (нестроковые пути, неверные массивы) возвращаются
// ошибкой с текстом в формате JS (jscompat); она становится причиной недоступности проверки.

// keyframe — опора пакета (PackageKeyframe): исходные значения workflow.json без проверки типов.
type keyframe struct {
	id, role, timeSeconds any
	// imagePath — join(пакет, path), если файл существует; пусто — файла нет.
	imagePath string
	approved  bool
}

// packageView — поля PackageView, которые читает проверка видео.
type packageView struct {
	shot  string
	stage string
	// timing — workflow.timing ?? null.
	timing    any
	keyframes []keyframe
	// description — description.md или nil.
	description any
	// promptText — текст редактируемого видеопромпта пакета (pkg.prompt?.text) или Undefined.
	promptText any
	// request — активный зафиксированный запрос; nil, если его нет или request.json не читается.
	request *packageRequest
	// resultToken — токен результата вычислился без ошибки: скачанные файлы, request.json
	// и attempt.json — обычные файлы внутри папки запроса.
	resultToken bool
}

// packageRequest — часть PackageView.request.
type packageRequest struct {
	dir  string
	kind any
	// promptText — зафиксированный промпт запроса или nil.
	promptText any
	// downloads — существующие скачанные файлы без повторов.
	downloads []string
}

var originalName = regexp.MustCompile(`^original(-\d+)?\.(mp4|png|jpg|webp)$`)

// readJSON — разобранный JSON файла; nil при отсутствии файла и любой ошибке разбора.
func readJSON(path string) any {
	value, ok := jscompat.ReadJSONFile(path)
	if !ok {
		return nil
	}
	return value
}

// join — путь value внутри base; нестроковый value — TypeError в формате Node (jscompat).
func join(base string, value any) (string, error) {
	text, err := jscompat.PathArg("path", value)
	if err != nil {
		return "", err
	}
	return filepath.Join(base, filepath.FromSlash(text)), nil
}

// readText — текст файла в UTF-8 с заменой неверных байтов.
func readText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", jscompat.FsError("open", path, err)
	}
	return jscompat.DecodeUTF8(data), nil
}

// readPackage — срез readPackage(project, dir). nil, nil — в папке нет workflow.json со строковым shot.
func readPackage(dir string) (*packageView, error) {
	workflow := readJSON(filepath.Join(dir, "workflow.json"))
	shot, ok := jscompat.Get(workflow, "shot").(string)
	if !jscompat.Truthy(workflow) || !ok {
		return nil, nil
	}
	view := &packageView{shot: shot, timing: jscompat.Coalesce(jscompat.Get(workflow, "timing"), nil), description: nil, promptText: jscompat.Undefined}
	frames, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(workflow, "keyframes"), &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "(workflow.keyframes ?? []).map is not a function"}
	}
	for _, raw := range frames {
		id, err := jscompat.Prop(raw, "id")
		if err != nil {
			return nil, err
		}
		frame := keyframe{id: id, role: jscompat.Get(raw, "role"), timeSeconds: jscompat.Get(raw, "time_seconds"), approved: jscompat.Truthy(jscompat.Get(raw, "approved"))}
		if path := jscompat.Get(raw, "path"); jscompat.Truthy(path) {
			file, err := join(dir, path)
			if err != nil {
				return nil, err
			}
			if jscompat.Exists(file) {
				frame.imagePath = file
			}
		}
		view.keyframes = append(view.keyframes, frame)
	}
	promptPath, err := join(dir, jscompat.Coalesce(jscompat.GetPath(workflow, "prompt", "path"), "video-prompt.txt"))
	if err != nil {
		return nil, err
	}
	if jscompat.Exists(promptPath) {
		text, err := readText(promptPath)
		if err != nil {
			return nil, err
		}
		view.promptText = text
	}
	stage, ok := jscompat.Get(workflow, "stage").(string)
	if !ok {
		return nil, &jscompat.TypeError{Message: "workflow.stage.startsWith is not a function"}
	}
	view.stage = stage
	active := jscompat.Get(workflow, "request_dir")
	if strings.HasPrefix(stage, "image_") {
		active = jscompat.Get(workflow, "image_request_dir")
	}
	if jscompat.Truthy(active) {
		if view.request, err = readRequest(dir, active); err != nil {
			return nil, err
		}
	}
	descriptionPath := filepath.Join(dir, "description.md")
	if jscompat.Exists(descriptionPath) {
		text, err := readText(descriptionPath)
		if err != nil {
			return nil, err
		}
		view.description = text
	}
	if view.request != nil && len(view.request.downloads) > 0 {
		view.resultToken = resultFilesValid(view.request.dir, view.request.downloads)
	}
	return view, nil
}

// readRequest читает активный запрос пакета: request.json, attempt.json, зафиксированный промпт и
// скачанные оригиналы (из attempt.downloads и файлов original*.ext папки запроса).
func readRequest(dir string, active any) (*packageRequest, error) {
	requestDir, err := join(dir, active)
	if err != nil {
		return nil, err
	}
	frozen := readJSON(filepath.Join(requestDir, "request.json"))
	if !jscompat.Truthy(frozen) {
		return nil, nil
	}
	attempt := readJSON(filepath.Join(requestDir, "attempt.json"))
	prompt := jscompat.Get(frozen, "prompt")
	if _, isString := prompt.(string); !isString {
		prompt = jscompat.Coalesce(jscompat.Get(prompt, "path"), "prompt.txt")
	}
	promptPath, err := join(requestDir, prompt)
	if err != nil {
		return nil, err
	}
	var downloads []string
	list, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(attempt, "downloads"), &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "(attempt?.downloads ?? []).map is not a function"}
	}
	for _, item := range list {
		path, err := jscompat.Prop(item, "path")
		if err != nil {
			return nil, err
		}
		if jscompat.Truthy(path) {
			file, err := join(requestDir, path)
			if err != nil {
				return nil, err
			}
			downloads = append(downloads, file)
		}
	}
	if jscompat.Exists(requestDir) {
		entries, err := jscompat.ReadDir(requestDir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if originalName.MatchString(entry.Name()) {
				downloads = append(downloads, filepath.Join(requestDir, entry.Name()))
			}
		}
	}
	// Нестроковый путь во входах запроса — TypeError, как и при чтении пакета производства.
	inputs, ok := jscompat.AsArray(jscompat.Coalesce(jscompat.Get(frozen, "inputs"), &jscompat.Array{}))
	if !ok {
		return nil, &jscompat.TypeError{Message: "(frozen.inputs ?? []).map is not a function"}
	}
	for _, input := range inputs {
		path, err := jscompat.Prop(input, "path")
		if err != nil {
			return nil, err
		}
		if _, err := join(requestDir, path); err != nil {
			return nil, err
		}
	}
	request := &packageRequest{dir: requestDir, kind: jscompat.Coalesce(jscompat.Get(frozen, "kind"), "video"), promptText: nil, downloads: []string{}}
	if jscompat.Exists(promptPath) {
		text, err := readText(promptPath)
		if err != nil {
			return nil, err
		}
		request.promptText = text
	}
	seen := map[string]bool{}
	for _, file := range downloads {
		if !seen[file] && jscompat.Exists(file) {
			request.downloads = append(request.downloads, file)
		}
		seen[file] = true
	}
	return request, nil
}

// within — `file.startsWith(resolve(root) + sep)`.
func within(root, file string) bool {
	return strings.HasPrefix(filepath.Clean(file), filepath.Clean(root)+string(filepath.Separator))
}

// resultFilesValid — условия packageResultToken: request.json, attempt.json и скачанные файлы лежат
// внутри папки запроса и являются обычными файлами (lstat, без ссылок).
func resultFilesValid(requestDir string, downloads []string) bool {
	paths := append([]string{filepath.Join(requestDir, "request.json"), filepath.Join(requestDir, "attempt.json")}, downloads...)
	for _, path := range paths {
		info, err := os.Lstat(path)
		if !within(requestDir, path) || err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}
