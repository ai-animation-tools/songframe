package shotworkflow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/image/bmp"
	"golang.org/x/image/tiff"
	"golang.org/x/image/webp"

	"songframe/internal/mediaadapters"
	"songframe/internal/toolrt"
)

// Image-ветка: платная опора готовится зафиксированной попыткой media_request (request.json,
// attempt.json) внутри пакета. Инструмент только читает попытку и её оригиналы, проверяет SHA
// запроса и входов и ведёт историю image_requests в workflow.json; отправку и получение
// выполняют media_request и приложение.

// is — value == text для значения JSON без паники на несравнимых типах.
func is(value any, text string) bool {
	s, ok := value.(string)
	return ok && s == text
}

// asDict — значение-словарь; иначе AttributeError с именем вызванного метода (get/update).
func asDict(value any, method string) (*toolrt.Dict, error) {
	dict, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, toolrt.Raise(toolrt.AttributeError, "'%s' object has no attribute '%s'", toolrt.TypeName(value), method)
	}
	return dict, nil
}

// encoded — канонические байты JSON попытки, как requestsnapshot.Encoded (ключи по возрастанию,
// отступ два пробела, без NaN, перевод строки в конце), по которым считается request_sha256.
func encoded(value any) ([]byte, error) {
	text, err := toolrt.DumpsJSON(value, toolrt.DumpOptions{Indent: 2, Pretty: true, SortKeys: true, RejectNaN: true})
	if err != nil {
		return nil, err
	}
	return toolrt.EncodeUTF8(text + "\n")
}

// inside — обычный файл внутри папки попытки после разыменования ссылок.
func inside(directory string, name any) (string, error) {
	joined, err := pathPart(directory, name)
	if err != nil {
		return "", err
	}
	path := toolrt.ResolvePath(joined)
	if !toolrt.IsRelativeTo(path, toolrt.ResolvePath(directory)) || !toolrt.IsFile(path) {
		return "", valueError("Нет локального файла подготовленной попытки.")
	}
	return path, nil
}

// loadAttempt читает попытку с проверкой входов: запрос подключённого провайдера, attempt.json с
// SHA канонических байтов запроса и неизменные промпт и входы. Узкая локальная копия чтения
// попытки: запись и отправка принадлежат media_request. Файлы читаются как UTF-8 на любой ОС:
// с кодировкой локали на Windows SHA запроса с кириллицей не совпал бы.
func loadAttempt(directory string) (*toolrt.Dict, *toolrt.Dict, error) {
	path, err := inside(directory, "request.json")
	if err != nil {
		return nil, nil, err
	}
	value, err := toolrt.LoadJSONFile(path)
	if err != nil {
		return nil, nil, err
	}
	request, err := asDict(value, "get")
	if err != nil {
		return nil, nil, err
	}
	if !mediaadapters.Known(request.Value("provider")) {
		return nil, nil, valueError("В подготовленном запросе нет provider подключённого адаптера генерации.")
	}
	if path, err = inside(directory, "attempt.json"); err != nil {
		return nil, nil, err
	}
	stateValue, err := toolrt.LoadJSONFile(path)
	if err != nil {
		return nil, nil, err
	}
	data, err := encoded(request)
	if err != nil {
		return nil, nil, err
	}
	digest := sha256.Sum256(data)
	expected, err := item(stateValue, "request_sha256")
	if err != nil {
		return nil, nil, err
	}
	if !is(expected, hex.EncodeToString(digest[:])) {
		return nil, nil, valueError("Подготовленный запрос изменён; нужна новая попытка и новое согласование.")
	}
	prompt, err := item(request, "prompt")
	if err != nil {
		return nil, nil, err
	}
	inputs, err := item(request, "inputs")
	if err != nil {
		return nil, nil, err
	}
	rest, err := toolrt.Iter(inputs)
	if err != nil {
		return nil, nil, toolrt.Raise(toolrt.TypeError, "Value after * must be an iterable, not %s", toolrt.TypeName(inputs))
	}
	for _, entry := range append([]any{prompt}, rest...) {
		name, err := item(entry, "path")
		if err != nil {
			return nil, nil, err
		}
		file, err := inside(directory, name)
		if err != nil {
			return nil, nil, err
		}
		actual, err := sha(file)
		if err != nil {
			return nil, nil, err
		}
		want, err := item(entry, "sha256")
		if err != nil {
			return nil, nil, err
		}
		if !is(want, actual) {
			return nil, nil, valueError("Промпт или вход изменён; отправка запрещена.")
		}
	}
	state, err := asDict(stateValue, "get")
	if err != nil {
		return nil, nil, err
	}
	return request, state, nil
}

var sha256Text = regexp.MustCompile(`^[a-f0-9]{64}$`)

// imageHistory — image_requests попытки (по умолчанию пустой список): список словарей, иначе ValueError.
func imageHistory(data *toolrt.Dict) ([]any, error) {
	value, _ := get(data, "image_requests", []any{})
	history, ok := value.([]any)
	if !ok {
		return nil, valueError("Повреждена история запросов изображений.")
	}
	for _, entry := range history {
		if _, isDict := entry.(*toolrt.Dict); !isDict {
			return nil, valueError("Повреждена история запросов изображений.")
		}
	}
	return history, nil
}

// historyEntry — первая запись истории с request_dir, равным name; нет — nil.
func historyEntry(history []any, name any) *toolrt.Dict {
	for _, entry := range history {
		dict := entry.(*toolrt.Dict)
		if toolrt.Equal(dict.Value("request_dir"), name) {
			return dict
		}
	}
	return nil
}

// imageAttempt — зафиксированная попытка kind=image
// этого плана внутри пакета. Без requestDir — активная попытка, которая обязана совпасть с
// записью истории (SHA запроса, опора, провайдер).
func imageAttempt(directory string, data *toolrt.Dict, requestDir *string) (string, *toolrt.Dict, *toolrt.Dict, error) {
	var name any
	if requestDir != nil {
		name = *requestDir
	} else {
		name = data.Value("image_request_dir")
	}
	text, ok := name.(string)
	if !ok || text == "" || filepath.IsAbs(text) || strings.HasPrefix(text, "/") {
		return "", nil, nil, valueError("Для изображения нужен относительный путь подготовленного запроса.")
	}
	path := toolrt.ResolvePath(toolrt.JoinPath(directory, text))
	if path == directory || !toolrt.IsRelativeTo(path, directory) {
		return "", nil, nil, valueError("Запрос изображения должен лежать внутри рабочего пакета.")
	}
	request, attempt, err := loadAttempt(path)
	if err != nil {
		return "", nil, nil, err
	}
	if !is(request.Value("kind"), "image") {
		return "", nil, nil, valueError("Нужен подготовленный запрос kind=image.")
	}
	if shot := request.Value("shot"); shot != nil && !toolrt.Equal(shot, data.Value("shot")) {
		return "", nil, nil, valueError("Запрос изображения относится к другому плану.")
	}
	expected := attempt.Value("request_sha256")
	if !attempt.Has("request_sha256") {
		expected = ""
	}
	if !sha256Text.MatchString(toolrt.Str(expected)) {
		return "", nil, nil, valueError("Нет SHA подготовленного запроса изображения.")
	}
	history, err := imageHistory(data)
	if err != nil {
		return "", nil, nil, err
	}
	if requestDir == nil {
		entry := historyEntry(history, text)
		provider, err := item(request, "provider")
		if err != nil {
			return "", nil, nil, err
		}
		if entry == nil || entry.Len() == 0 || !toolrt.Equal(entry.Value("request_sha256"), expected) ||
			!toolrt.Equal(entry.Value("frame_id"), data.Value("image_frame_id")) || !toolrt.Equal(entry.Value("provider"), provider) {
			return "", nil, nil, valueError("Активный запрос не совпадает с историей изображений.")
		}
	}
	return path, request, attempt, nil
}

// imageDownloads — только зарегистрированные оригиналы
// попытки с тем же размером; посторонний файл кандидатом не становится.
func imageDownloads(directory string, attempt *toolrt.Dict) ([]string, error) {
	downloads, ok := attempt.Value("downloads").([]any)
	if !ok || len(downloads) == 0 {
		return nil, valueError("У изображения нет сохранённых результатов.")
	}
	paths := []string{}
	for _, entry := range downloads {
		dict, isDict := entry.(*toolrt.Dict)
		name, isString := dict.Value("path").(string)
		if !isDict || !isString || filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
			return nil, valueError("Повреждён список результатов изображения.")
		}
		path := toolrt.ResolvePath(toolrt.JoinPath(directory, name))
		info, err := os.Stat(path)
		if !toolrt.IsRelativeTo(path, directory) || err != nil || !info.Mode().IsRegular() || !toolrt.Equal(toolrt.NewInt(info.Size()), dict.Value("bytes")) {
			return nil, valueError("Сохранённый оригинал отсутствует или изменён.")
		}
		paths = append(paths, path)
	}
	return paths, nil
}

// frameCode — код опоры «K» и ровно две десятичные цифры (любые цифры Unicode).
func frameCode(value string) bool {
	runes := []rune(value)
	return len(runes) == 3 && runes[0] == 'K' && unicode.Is(unicode.Nd, runes[1]) && unicode.Is(unicode.Nd, runes[2])
}

// setImageRequest назначает prepared-попытку kind=image
// непринятой опоре, дополняет историю и выставляет вопрос send/park/revise. Неизвестная или
// невыбранная прежняя отправка блокирует переключение: продолжение — resume той же попытки.
func (t *workflowTool) setImageRequest(dirArg, frameID, requestDir string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	if stage := data.Value("stage"); !is(stage, "description_review") && !is(stage, "keyframes_review") && !is(stage, "image_request_choice") && !is(stage, revision) {
		return nil, valueError("Сначала завершите текущую отправку и выберите её результат.")
	}
	// Отдельный факт принятия описания не теряется после send/выбора первой опоры.
	if data.Value("description_approved") != true {
		return nil, valueError("Сначала утвердите описание перед подготовкой изображения.")
	}
	frame, err := findKeyframe(data, frameID)
	if err != nil {
		return nil, err
	}
	frames, err := item(data, "approved_frames")
	if err != nil {
		return nil, err
	}
	if !frameCode(frameID) || frame == nil || toolrt.Truthy(frame.Value("approved")) {
		return nil, valueError("Нужна существующая непринятая опора Kxx.")
	}
	if approved, err := toolrt.Contains(frames, frameID); err != nil || approved {
		if err != nil {
			return nil, err
		}
		return nil, valueError("Нужна существующая непринятая опора Kxx.")
	}
	if pending := data.Value("pending_decision"); toolrt.Truthy(pending) {
		stage, err := get(pending, "stage", nil)
		if err != nil {
			return nil, err
		}
		if !is(stage, "image_request_choice") {
			return nil, valueError("Сначала ответьте на текущий вопрос производства.")
		}
	}
	// Не теряем оплаченную или неизвестную отправку при выборе следующей опоры.
	if active := data.Value("image_request_dir"); toolrt.Truthy(active) {
		previousDir, _, previous, err := imageAttempt(directory, data, nil)
		if err != nil {
			return nil, err
		}
		if !is(previous.Value("status"), "prepared") || toolrt.Truthy(previous.Value("generation_id")) {
			if !is(previous.Value("status"), "downloaded") {
				return nil, valueError("Предыдущая отправка не выбрана; продолжите её без повторного submit.")
			}
			history, _ := imageHistory(data)
			record := historyEntry(history, active)
			originals, err := imageDownloads(previousDir, previous)
			if err != nil {
				return nil, err
			}
			// Выбор оригинала переживает исправление описания и сброс candidate path.
			selected, ok := record.Value("selected_sha256").(string)
			matched := false
			if ok && sha256Text.MatchString(selected) {
				for _, original := range originals {
					digest, err := sha(original)
					if err != nil {
						return nil, err
					}
					if digest == selected {
						matched = true
						break
					}
				}
			}
			if !matched {
				return nil, valueError("Хеш выбора не совпадает с сохранённым оригиналом предыдущей отправки.")
			}
		}
	}
	path, request, attempt, err := imageAttempt(directory, data, &requestDir)
	if err != nil {
		return nil, err
	}
	name, _ := toolrt.RelativeTo(path, directory)
	if !is(attempt.Value("status"), "prepared") || toolrt.Truthy(attempt.Value("generation_id")) || toolrt.Truthy(attempt.Value("downloads")) {
		return nil, valueError("Запрос уже отправлялся: используйте resume, не новую отправку.")
	}
	history, err := imageHistory(data)
	if err != nil {
		return nil, err
	}
	provider, err := item(request, "provider")
	if err != nil {
		return nil, err
	}
	entry := record("frame_id", frameID, "request_dir", name, "request_sha256", attempt.Value("request_sha256"), "provider", provider)
	previousEntry := historyEntry(history, name)
	if previousEntry != nil && previousEntry.Len() > 0 {
		for _, key := range entry.Keys() {
			if !toolrt.Equal(previousEntry.Value(key), entry.Value(key)) {
				return nil, valueError("Историю запроса изображения нельзя переписать.")
			}
		}
	} else {
		history = append(history, entry)
	}
	data.Set("image_requests", history)
	data.Set("image_request_dir", name)
	data.Set("image_frame_id", frameID)
	data.Set("description_approved", true)
	data.Set("stage", "image_request_choice")
	data.Set("wait_reason", nil)
	if _, err := save(directory, data); err != nil {
		return nil, err
	}
	return t.ask(dirArg, "image_request_choice", nil, nil, nil)
}

// imageFormat — формат изображения по сигнатуре после полного декодирования. Ошибка — файл не
// изображение известного формата или повреждён. Кроме PNG, JPEG и WebP распознаются GIF, BMP и
// TIFF, чтобы на них срабатывала проверка расширения; остальные форматы считаются
// нераспознанными (текст отказа другой, файлы не меняются в обоих случаях).
func imageFormat(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	type decoder struct {
		format string
		match  func([]byte) bool
		decode func(*bytes.Reader) (image.Image, error)
	}
	decoders := []decoder{
		{"PNG", func(b []byte) bool { return bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) }, func(r *bytes.Reader) (image.Image, error) { return png.Decode(r) }},
		{"JPEG", func(b []byte) bool { return bytes.HasPrefix(b, []byte("\xff\xd8\xff")) }, func(r *bytes.Reader) (image.Image, error) { return jpeg.Decode(r) }},
		{"WEBP", func(b []byte) bool { return len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" }, func(r *bytes.Reader) (image.Image, error) { return webp.Decode(r) }},
		{"GIF", func(b []byte) bool {
			return bytes.HasPrefix(b, []byte("GIF87a")) || bytes.HasPrefix(b, []byte("GIF89a"))
		}, func(r *bytes.Reader) (image.Image, error) { return gif.Decode(r) }},
		{"BMP", func(b []byte) bool { return bytes.HasPrefix(b, []byte("BM")) }, func(r *bytes.Reader) (image.Image, error) { return bmp.Decode(r) }},
		{"TIFF", func(b []byte) bool {
			return bytes.HasPrefix(b, []byte("II*\x00")) || bytes.HasPrefix(b, []byte("MM\x00*"))
		}, func(r *bytes.Reader) (image.Image, error) { return tiff.Decode(r) }},
	}
	for _, item := range decoders {
		if item.match(data) {
			if _, err := item.decode(bytes.NewReader(data)); err != nil {
				return "", err
			}
			return item.format, nil
		}
	}
	return "", os.ErrInvalid
}

// selectImage — выбранный пользователем оригинал активной downloaded-попытки
// копируется без перекодировки в keyframes/Kxx.ext непринятым кандидатом; запись истории получает
// selected_sha256 и selected_at. Оригиналы и принятые опоры не перезаписываются.
func (t *workflowTool) selectImage(dirArg, file string) (*toolrt.Dict, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return nil, err
	}
	data, err := load(directory)
	if err != nil {
		return nil, err
	}
	if !is(data.Value("stage"), "image_downloaded") {
		return nil, valueError("Сначала дождитесь image_downloaded текущей попытки.")
	}
	requestDir, _, attempt, err := imageAttempt(directory, data, nil)
	if err != nil {
		return nil, err
	}
	if !is(attempt.Value("status"), "downloaded") {
		return nil, valueError("Попытка изображения ещё не downloaded.")
	}
	source := toolrt.ResolvePath(file)
	if !filepath.IsAbs(file) {
		source = toolrt.ResolvePath(toolrt.JoinPath(directory, file))
	}
	downloads, err := imageDownloads(requestDir, attempt)
	if err != nil {
		return nil, err
	}
	if !contains(downloads, source) {
		return nil, valueError("Выберите файл из downloads активной попытки изображения.")
	}
	format, err := imageFormat(source)
	if err != nil {
		return nil, valueError("Нужен настоящий PNG, JPEG или WebP; для проверки требуется Pillow.")
	}
	suffix := strings.ToLower(toolrt.PathSuffix(source))
	allowed := map[string][]string{"PNG": {".png"}, "JPEG": {".jpg", ".jpeg"}, "WEBP": {".webp"}}
	if !contains(allowed[format], suffix) {
		return nil, valueError("Расширение оригинала не соответствует формату PNG, JPEG или WebP.")
	}
	frame, err := findKeyframe(data, data.Value("image_frame_id"))
	if err != nil {
		return nil, err
	}
	frames, err := approvedFrames(data)
	if err != nil {
		return nil, err
	}
	if frame == nil || toolrt.Truthy(frame.Value("approved")) || frames.Has(toolrt.Str(frame.Value("id"))) {
		return nil, valueError("Принятую или отсутствующую опору нельзя заменять.")
	}
	folder := toolrt.JoinPath(directory, "keyframes")
	target := toolrt.JoinPath(folder, toolrt.Str(frame.Value("id"))+suffix)
	if err := mkdir(folder); err != nil {
		return nil, err
	}
	destination := toolrt.ResolvePath(target)
	history, _ := imageHistory(data)
	requestDirs := []string{}
	for _, entry := range history {
		path, err := pathPart(directory, entry.(*toolrt.Dict).Value("request_dir"))
		if err != nil {
			return nil, err
		}
		requestDirs = append(requestDirs, path)
	}
	if video := data.Value("request_dir"); toolrt.Truthy(video) {
		path, err := pathPart(directory, video)
		if err != nil {
			return nil, err
		}
		requestDirs = append(requestDirs, path)
	}
	protected := !toolrt.IsRelativeTo(destination, directory)
	for _, path := range requestDirs {
		protected = protected || toolrt.IsRelativeTo(destination, toolrt.ResolvePath(path))
	}
	if protected {
		return nil, valueError("Копия кандидата не должна заменять оригиналы запросов.")
	}
	items, _ := keyframes(data)
	for _, entry := range items {
		keyframe := entry.(*toolrt.Dict)
		if toolrt.Truthy(keyframe.Value("approved")) && toolrt.Truthy(keyframe.Value("path")) {
			path, err := pathPart(directory, keyframe.Value("path"))
			if err != nil {
				return nil, err
			}
			if toolrt.ResolvePath(path) == destination {
				return nil, valueError("Путь кандидата занят принятой опорой.")
			}
		}
	}
	digest, err := sha(source)
	if err != nil {
		return nil, err
	}
	if targetInfo, err := os.Stat(target); err == nil {
		if sourceInfo, err := os.Stat(source); err == nil && os.SameFile(targetInfo, sourceInfo) {
			return nil, valueError("Кандидат должен быть отдельной копией оригинала.")
		}
	}
	if err := copyFile(source, target); err != nil {
		return nil, err
	}
	if copied, err := sha(target); err != nil || copied != digest {
		if err != nil {
			return nil, err
		}
		return nil, valueError("Изображение изменилось при копировании кандидата.")
	}
	// Это подтверждение выбора сохранённого оригинала, а не художественное принятие опоры.
	selected := historyEntry(history, data.Value("image_request_dir"))
	selected.Set("selected_sha256", digest)
	selected.Set("selected_at", Now())
	relative, _ := toolrt.RelativeTo(target, directory)
	frame.Set("path", relative)
	frame.Set("sha256", digest)
	frame.Set("approved", false)
	frames.Delete(toolrt.Str(frame.Value("id")))
	data.Set("stage", "keyframes_review")
	data.Set("pending_decision", nil)
	data.Set("decision", nil)
	data.Set("wait_reason", nil)
	return save(directory, data)
}
