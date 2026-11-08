package videoreview

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/dynvalue"
)

// Чтение пакета производства в объёме, нужном проверке видео: кадры-опоры, этап, зафиксированный
// запрос, скачанные файлы, признак resultToken, описание и промпты. Правила чтения те же, что у
// production.ReadPackage. Повреждённые значения (нестроковые пути, неверные массивы) возвращаются
// ошибкой с текстом исключения dynvalue; она становится причиной недоступности проверки.

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
	// promptText — текст редактируемого видеопромпта пакета (prompt.text) или Undefined.
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
	value, ok := dynvalue.ReadJSONFile(path)
	if !ok {
		return nil
	}
	return value
}

// join — путь value внутри base; нестроковый value — TypeError dynvalue.PathArg.
func join(base string, value any) (string, error) {
	text, err := dynvalue.PathArg("path", value)
	if err != nil {
		return "", err
	}
	return filepath.Join(base, filepath.FromSlash(text)), nil
}

// readText — текст файла в UTF-8 с заменой неверных байтов.
func readText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", dynvalue.FsError("open", path, err)
	}
	return dynvalue.DecodeUTF8(data), nil
}

// readPackage — срез readPackage(project, dir). nil, nil — в папке нет workflow.json со строковым shot.
func readPackage(dir string) (*packageView, error) {
	workflow := readJSON(filepath.Join(dir, "workflow.json"))
	shot, ok := dynvalue.Get(workflow, "shot").(string)
	if !dynvalue.Truthy(workflow) || !ok {
		return nil, nil
	}
	view := &packageView{shot: shot, timing: dynvalue.Coalesce(dynvalue.Get(workflow, "timing"), nil), description: nil, promptText: dynvalue.Undefined}
	frames, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(workflow, "keyframes"), &dynvalue.Array{}))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "(workflow.keyframes ?? []).map is not a function"}
	}
	for _, raw := range frames {
		id, err := dynvalue.Prop(raw, "id")
		if err != nil {
			return nil, err
		}
		frame := keyframe{id: id, role: dynvalue.Get(raw, "role"), timeSeconds: dynvalue.Get(raw, "time_seconds"), approved: dynvalue.Truthy(dynvalue.Get(raw, "approved"))}
		if path := dynvalue.Get(raw, "path"); dynvalue.Truthy(path) {
			file, err := join(dir, path)
			if err != nil {
				return nil, err
			}
			if dynvalue.Exists(file) {
				frame.imagePath = file
			}
		}
		view.keyframes = append(view.keyframes, frame)
	}
	promptPath, err := join(dir, dynvalue.Coalesce(dynvalue.GetPath(workflow, "prompt", "path"), "video-prompt.txt"))
	if err != nil {
		return nil, err
	}
	if dynvalue.Exists(promptPath) {
		text, err := readText(promptPath)
		if err != nil {
			return nil, err
		}
		view.promptText = text
	}
	stage, ok := dynvalue.Get(workflow, "stage").(string)
	if !ok {
		return nil, &dynvalue.TypeError{Message: "workflow.stage.startsWith is not a function"}
	}
	view.stage = stage
	active := dynvalue.Get(workflow, "request_dir")
	if strings.HasPrefix(stage, "image_") {
		active = dynvalue.Get(workflow, "image_request_dir")
	}
	if dynvalue.Truthy(active) {
		if view.request, err = readRequest(dir, active); err != nil {
			return nil, err
		}
	}
	descriptionPath := filepath.Join(dir, "description.md")
	if dynvalue.Exists(descriptionPath) {
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
	if !dynvalue.Truthy(frozen) {
		return nil, nil
	}
	attempt := readJSON(filepath.Join(requestDir, "attempt.json"))
	prompt := dynvalue.Get(frozen, "prompt")
	if _, isString := prompt.(string); !isString {
		prompt = dynvalue.Coalesce(dynvalue.Get(prompt, "path"), "prompt.txt")
	}
	promptPath, err := join(requestDir, prompt)
	if err != nil {
		return nil, err
	}
	var downloads []string
	list, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(attempt, "downloads"), &dynvalue.Array{}))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "(attempt?.downloads ?? []).map is not a function"}
	}
	for _, item := range list {
		path, err := dynvalue.Prop(item, "path")
		if err != nil {
			return nil, err
		}
		if dynvalue.Truthy(path) {
			file, err := join(requestDir, path)
			if err != nil {
				return nil, err
			}
			downloads = append(downloads, file)
		}
	}
	if dynvalue.Exists(requestDir) {
		entries, err := dynvalue.ReadDir(requestDir)
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
	inputs, ok := dynvalue.AsArray(dynvalue.Coalesce(dynvalue.Get(frozen, "inputs"), &dynvalue.Array{}))
	if !ok {
		return nil, &dynvalue.TypeError{Message: "(frozen.inputs ?? []).map is not a function"}
	}
	for _, input := range inputs {
		path, err := dynvalue.Prop(input, "path")
		if err != nil {
			return nil, err
		}
		if _, err := join(requestDir, path); err != nil {
			return nil, err
		}
	}
	request := &packageRequest{dir: requestDir, kind: dynvalue.Coalesce(dynvalue.Get(frozen, "kind"), "video"), promptText: nil, downloads: []string{}}
	if dynvalue.Exists(promptPath) {
		text, err := readText(promptPath)
		if err != nil {
			return nil, err
		}
		request.promptText = text
	}
	seen := map[string]bool{}
	for _, file := range downloads {
		if !seen[file] && dynvalue.Exists(file) {
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
