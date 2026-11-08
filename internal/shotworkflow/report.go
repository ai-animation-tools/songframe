package shotworkflow

import (
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"songframe/internal/shotstatus"
	"songframe/internal/toolrt"
)

// hints — подсказка «Дальше» таблицы для каждого этапа.
var hints = map[string]string{
	"image_request_choice": "покажите image request SHA и cost_check; каждую отправку подтвердите отдельно",
	"image_submitted":      "продолжите ту же попытку: media_request resume, не submit",
	"image_downloaded":     "пользователь выбирает оригинал: select-image --file ПУТЬ",
	"description_review":   "согласуйте описание, затем plan-keyframes и approve",
	"keyframes_review":     "примите опоры: approve ID ПУТЬ; затем approve-prompt",
	"prompt_review":        "после принятия промпта подготовьте запрос: media_request prepare, затем set-stage request_choice --request-dir",
	"request_choice":       "покажите таблицу запроса и cost_check; «отправить» — submit, «сохранить» — park",
	"ready":                "пакет ждёт в очереди; продолжение — кнопками на странице «Производство»",
	revision:               "исправьте затронутые опоры или промпт",
	"submitted":            "ожидайте результат: media_request resume",
	"downloaded":           "покажите результат; решение пользователя",
	"edit_review":          "уточните монтажный участок, затем accept_shot",
	"accepted":             "перенесите комплект в assets и очистите пакет",
}

// problems — проблемы пакета: изменённая постановка, отсутствующие или изменённые
// принятые опоры и промпт, папка запроса без request.json, ошибка запроса изображения.
// Ошибки чтения реестра (OSError) не перехватываются: это сбой проекта, а не проблема пакета.
func (t *workflowTool) problems(directory string, data *toolrt.Dict) ([]string, error) {
	issues := []string{}
	shot, err := item(data, "shot")
	if err != nil {
		return nil, err
	}
	registry, _, err := t.sceneOf(shot)
	if err == nil {
		digest, ferr := t.fingerprint(registry, shot.(string))
		if ferr != nil {
			err = ferr
		} else if !toolrt.Equal(digest, data.Value("scene_sha256")) {
			issues = append(issues, "постановка или унаследованное состояние изменились после подготовки: пересогласуйте пакет")
		}
	}
	if err != nil {
		if !toolrt.Is(err, toolrt.ValueError) {
			return nil, err
		}
		issues = append(issues, err.Error())
	}
	items, err := keyframes(data)
	if err != nil {
		return nil, err
	}
	for _, entry := range items {
		approved, err := get(entry, "approved", nil)
		if err != nil {
			return nil, err
		}
		if !toolrt.Truthy(approved) {
			continue
		}
		keyframe := entry.(*toolrt.Dict)
		name, err := item(keyframe, "path")
		if err != nil {
			return nil, err
		}
		path, err := pathPart(directory, name)
		if err != nil {
			return nil, err
		}
		id := toolrt.Str(keyframe.Value("id"))
		if !toolrt.IsFile(path) {
			issues = append(issues, id+": файл опоры отсутствует")
		} else if digest, err := sha(path); err != nil {
			return nil, err
		} else if !toolrt.Equal(digest, keyframe.Value("sha256")) {
			issues = append(issues, id+": байты опоры изменились после принятия")
		}
	}
	prompt, err := get(data, "prompt", toolrt.NewDict())
	if err != nil {
		return nil, err
	}
	approved, err := get(prompt, "approved", nil)
	if err != nil {
		return nil, err
	}
	if toolrt.Truthy(approved) {
		name, err := item(prompt, "path")
		if err != nil {
			return nil, err
		}
		path, err := pathPart(directory, name)
		if err != nil {
			return nil, err
		}
		ok, err := sameDigest(path, data.Value("approved_prompt_sha256"))
		if err != nil {
			return nil, err
		}
		if !ok {
			issues = append(issues, "промпт изменён или удалён после принятия")
		}
	}
	if request := data.Value("request_dir"); toolrt.Truthy(request) {
		path, err := pathPart(directory, request)
		if err != nil {
			return nil, err
		}
		if !toolrt.IsFile(toolrt.JoinPath(path, "request.json")) {
			issues = append(issues, "папка запроса не содержит request.json")
		}
	}
	if toolrt.Truthy(data.Value("image_request_dir")) {
		if _, _, _, err := imageAttempt(directory, data, nil); err != nil {
			if !expected(err) {
				return nil, err
			}
			issues = append(issues, "запрос изображения: "+err.Error())
		}
	}
	return issues, nil
}

// expected — ожидаемый отказ: ValueError, OSError, KeyError или TypeError; ошибки Go вне модели — OSError.
func expected(err error) bool {
	if _, isToolError := err.(*toolrt.Exception); !isToolError {
		return true
	}
	return toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError, toolrt.TypeError)
}

// reportInfo — результат report: словарь для --json и проблемы для check.
type reportInfo struct {
	dict     *toolrt.Dict
	problems []string
}

// report — сводка пакета для show/check (JSON и таблица).
func (t *workflowTool) report(dirArg string) (reportInfo, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return reportInfo{}, err
	}
	data, err := load(directory)
	if err != nil {
		return reportInfo{}, err
	}
	var attempt any
	if request := data.Value("request_dir"); toolrt.Truthy(request) {
		folder, err := pathPart(directory, request)
		if err != nil {
			return reportInfo{}, err
		}
		path := toolrt.JoinPath(folder, "attempt.json")
		if toolrt.IsFile(path) {
			if attempt, err = toolrt.LoadJSONFile(path); err != nil {
				return reportInfo{}, err
			}
		}
	}
	var imageStatus any
	if toolrt.Truthy(data.Value("image_request_dir")) {
		if _, _, state, err := imageAttempt(directory, data, nil); err == nil {
			imageStatus = state.Value("status")
		} else if !expected(err) {
			return reportInfo{}, err
		}
	}
	stage := toolrt.Str(data.Value("stage"))
	label, ok := shotstatus.StageLabel(stage)
	if !ok {
		label = stage
	}
	var attemptStatus any
	if dict, ok := attempt.(*toolrt.Dict); ok {
		attemptStatus = dict.Value("status")
	}
	history, _ := get(data, "image_requests", []any{})
	issues, err := t.problems(directory, data)
	if err != nil {
		return reportInfo{}, err
	}
	keyframesValue, _ := item(data, "keyframes")
	info := record(
		"directory", directory,
		"shot", data.Value("shot"),
		"mode", data.Value("mode"),
		"stage", data.Value("stage"),
		"stage_label", label,
		"wait_reason", data.Value("wait_reason"),
		"batch", data.Value("batch"),
		"current_keyframe", data.Value("current_keyframe"),
		"timing", data.Value("timing"),
		"keyframes", keyframesValue,
		"prompt", data.Value("prompt"),
		"request_dir", data.Value("request_dir"),
		"attempt_status", attemptStatus,
		"image_request_dir", data.Value("image_request_dir"),
		"image_frame_id", data.Value("image_frame_id"),
		"image_requests", history,
		"image_attempt_status", imageStatus,
		"description_approved", data.Value("description_approved") == true,
		"keyframe_notes", data.Value("keyframe_notes"),
		"pending_decision", data.Value("pending_decision"),
		"decision", data.Value("decision"),
		"problems", stringsToValues(issues),
		"next_action", hints[stage],
	)
	return reportInfo{dict: info, problems: issues}, nil
}

func stringsToValues(items []string) []any {
	result := make([]any, len(items))
	for index, text := range items {
		result[index] = text
	}
	return result
}

// park — самодостаточный пакет без проблем переносится в
// plan/awaiting/<план>; видео-пакет — с подготовленным запросом (этап ready), image-пакет —
// с prepared-попыткой изображения (этап сохраняется).
func (t *workflowTool) park(dirArg, waitReason string) (string, error) {
	directory, err := t.packageDir(dirArg, true)
	if err != nil {
		return "", err
	}
	data, err := load(directory)
	if err != nil {
		return "", err
	}
	if !contains(shotstatus.WaitReasons, waitReason) {
		return "", valueError("Неизвестная причина ожидания: " + waitReason)
	}
	issues, err := t.problems(directory, data)
	if err != nil {
		return "", err
	}
	if len(issues) > 0 {
		return "", valueError("Пакет не готов к переносу: " + strings.Join(issues, "; "))
	}
	stage := toolrt.Str(data.Value("stage"))
	imageOnly := stage == "image_request_choice" && toolrt.Truthy(data.Value("image_request_dir"))
	if imageOnly {
		_, _, attempt, err := imageAttempt(directory, data, nil)
		if err != nil {
			return "", err
		}
		if !is(attempt.Value("status"), "prepared") || toolrt.Truthy(attempt.Value("generation_id")) {
			return "", valueError("Отправленную image-попытку продолжайте через resume.")
		}
	} else if !toolrt.Truthy(data.Value("request_dir")) {
		return "", valueError("В очередь переносится пакет с подготовленным запросом: укажите request_dir через set-stage.")
	}
	shot := toolrt.Str(data.Value("shot"))
	target := toolrt.JoinPath(toolrt.ResolvePath(t.root), "plan/awaiting", shot)
	if _, err := os.Lstat(target); err == nil {
		return "", valueError("Пакет " + shot + " уже есть в очереди; сначала прочитайте и решите его судьбу.")
	}
	if !imageOnly && stage != "ready" && stage != revision {
		data.Set("stage", "ready")
	}
	data.Set("wait_reason", waitReason)
	if _, err := save(directory, data); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return "", toolrt.OSErrorFrom(err, filepath.Dir(target))
	}
	if err := move(directory, target); err != nil {
		return "", err
	}
	return target, nil
}

// move — перемещение каталога: переименование, а между файловыми системами — копия с правами и
// удаление источника.
func move(source, target string) error {
	err := os.Rename(source, target)
	if err == nil {
		return nil
	}
	var linkErr *os.LinkError
	if !errors.As(err, &linkErr) || !errors.Is(linkErr.Err, syscall.EXDEV) {
		return toolrt.OSErrorFrom(err, source)
	}
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(source, path)
		destination := filepath.Join(target, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(destination, info.Mode().Perm())
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.WriteFile(destination, data, info.Mode().Perm()); err != nil {
			return err
		}
		return os.Chtimes(destination, info.ModTime(), info.ModTime())
	})
	if err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	if err := os.RemoveAll(source); err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	return nil
}

// formatG — запись числа в формате «g» (6 значащих цифр, без хвостовых нулей; целые и bool
// приводятся к float); строка — ValueError, прочие типы — TypeError.
func formatG(value any) (string, error) {
	var number float64
	switch item := value.(type) {
	case float64:
		number = item
	case toolrt.Int, bool:
		converted, err := toolrt.Float(item)
		if err != nil {
			return "", err
		}
		number = converted
	case string:
		return "", valueError("Unknown format code 'g' for object of type 'str'")
	default:
		return "", toolrt.Raise(toolrt.TypeError, "unsupported format string passed to %s.__format__", toolrt.TypeName(value))
	}
	switch {
	case math.IsNaN(number):
		return "nan", nil
	case math.IsInf(number, 1):
		return "inf", nil
	case math.IsInf(number, -1):
		return "-inf", nil
	}
	return strconv.FormatFloat(number, 'g', 6, 64), nil
}

// table — таблица пакета для человека.
func table(info reportInfo) (string, error) {
	data := info.dict
	header := "План " + toolrt.Str(data.Value("shot")) + " · режим " + toolrt.Str(data.Value("mode")) + " · этап: " + toolrt.Str(data.Value("stage_label")) + " (`" + toolrt.Str(data.Value("stage")) + "`)"
	if batch := data.Value("batch"); toolrt.Truthy(batch) {
		header += " · партия " + toolrt.Str(batch)
	}
	lines := []string{header}
	if reason := data.Value("wait_reason"); toolrt.Truthy(reason) {
		label := toolrt.Str(reason)
		if text, ok := reason.(string); ok {
			if found, ok := shotstatus.WaitLabel(text); ok {
				label = found
			}
		}
		lines = append(lines, "Причина ожидания: "+label)
	}
	timing := data.Value("timing")
	if !toolrt.Truthy(timing) {
		timing = toolrt.NewDict()
	}
	window, err := get(timing, "window_seconds", nil)
	if err != nil {
		return "", err
	}
	frames, _ := get(timing, "frames", nil)
	request, _ := get(timing, "request_seconds", nil)
	requestText := "не задан"
	if toolrt.Truthy(request) {
		requestText = toolrt.Str(request)
	}
	lines = append(lines, "Окно "+toolrt.Str(window)+" с ("+toolrt.Str(frames)+" кадров), запрос "+requestText+" с")
	items, err := toolrt.Iter(data.Value("keyframes"))
	if err != nil {
		return "", err
	}
	if len(items) > 0 {
		lines = append(lines, "", "| Опора | Роль | Время, с | Принята | Файл |", "| --- | --- | --- | --- | --- |")
		for _, entry := range items {
			keyframe, err := asDict(entry, "get")
			if err != nil {
				return "", err
			}
			id, err := item(keyframe, "id")
			if err != nil {
				return "", err
			}
			role, err := item(keyframe, "role")
			if err != nil {
				return "", err
			}
			seconds, err := item(keyframe, "time_seconds")
			if err != nil {
				return "", err
			}
			time, err := formatG(seconds)
			if err != nil {
				return "", err
			}
			approved := "нет"
			if toolrt.Truthy(keyframe.Value("approved")) {
				approved = "да"
			}
			path := "—"
			if value := keyframe.Value("path"); toolrt.Truthy(value) {
				path = toolrt.Str(value)
			}
			lines = append(lines, "| "+toolrt.Str(id)+" | "+toolrt.Str(role)+" | "+time+" | "+approved+" | "+path+" |")
		}
	}
	notes := []*toolrt.Dict{}
	allNotes, _ := data.Value("keyframe_notes").([]any)
	for _, entry := range allNotes {
		note := entry.(*toolrt.Dict)
		if toolrt.Truthy(note.Value("active")) {
			notes = append(notes, note)
		}
	}
	if len(notes) > 0 {
		scopes := map[string]string{"frame": "только эта опора", "following": "эта и следующие"}
		lines = append(lines, "", "Активные замечания к опорам:")
		for _, note := range notes {
			scope := toolrt.Str(note.Value("scope"))
			if text, ok := note.Value("scope").(string); ok {
				if found, ok := scopes[text]; ok {
					scope = found
				}
			}
			frame := "все опоры"
			if value := note.Value("frame"); toolrt.Truthy(value) {
				frame = toolrt.Str(value)
			}
			id, err := item(note, "id")
			if err != nil {
				return "", err
			}
			text, err := item(note, "note")
			if err != nil {
				return "", err
			}
			lines = append(lines, "- №"+toolrt.Str(id)+" "+frame+" ("+scope+"): "+toolrt.Str(text))
		}
	}
	prompt := data.Value("prompt")
	if !toolrt.Truthy(prompt) {
		prompt = toolrt.NewDict()
	}
	promptApproved, err := get(prompt, "approved", nil)
	if err != nil {
		return "", err
	}
	promptLine := "Промпт: не принят"
	if toolrt.Truthy(promptApproved) {
		promptLine = "Промпт: принят"
	}
	if chars, _ := get(prompt, "chars", nil); toolrt.Truthy(chars) {
		promptLine += ", " + toolrt.Str(chars) + " символов"
	}
	lines = append(lines, "", promptLine)
	if request := data.Value("request_dir"); toolrt.Truthy(request) {
		line := "Запрос: " + toolrt.Str(request)
		if status := data.Value("attempt_status"); toolrt.Truthy(status) {
			line += ", состояние попытки " + toolrt.Str(status)
		}
		lines = append(lines, line)
	}
	if image := data.Value("image_request_dir"); toolrt.Truthy(image) {
		lines = append(lines, "Запрос опоры "+toolrt.Str(data.Value("image_frame_id"))+": "+toolrt.Str(image)+", состояние "+toolrt.Str(data.Value("image_attempt_status")))
	}
	for _, issue := range info.problems {
		lines = append(lines, "Проблема: "+issue)
	}
	lines = append(lines, "Дальше: "+toolrt.Str(data.Value("next_action")))
	return strings.Join(lines, "\n"), nil
}
