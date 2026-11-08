package productionworkflow

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
)

// Распознавание оплаты пакета. Неопознанная оплата тоже
// считается оплатой: платные попытки никогда не откатываются и не заменяются. Исключения задают
// только проверенные папки image-попыток из истории workflow.json (ImageRoots).

var (
	// paidOriginal — сохранённый оригинал платной попытки.
	paidOriginal = regexp.MustCompile(`(?i)^original(?:-\d+)?\.(mp4|png|jpe?g|webp)$`)
	// videoOriginal — оригинал видео внутри image-попытки.
	videoOriginal  = regexp.MustCompile(`(?i)^original(?:-\d+)?\.mp4$`)
	frameIDPattern = regexp.MustCompile(`^K\d{2}$`)
	sha256Pattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	// videoStages — этапы пакета после отправки видео.
	videoStages = []string{"submitted", "downloaded", "edit_review", "accepted"}
	// imageCommands — команды запроса изображения image-попытки.
	imageCommands = []string{"text_to_image", "image_to_image"}
	// imageAttemptStatuses — статусы attempt.json image-попытки, которые допускает история.
	imageAttemptStatuses = []string{"prepared", "submitting", "submission_unknown", "submitted", "running", "downloading", "download_pending",
		"outputs_pending", "watermark_free_pending", "downloaded", "failed"}
)

// ImageRoot — проверенная image-попытка пакета: папка от пакета, SHA-256 зафиксированного запроса
// и опора. Оригиналы изображений в ней не мешают Apply описания или промпта (журнал замены пакета
// защищает их, journal.go).
type ImageRoot struct {
	RequestDir    string
	RequestSha256 string
	FrameID       string
}

// packageWorkflow читает workflow.json пакета; {} без файла,
// повреждённый документ или не объект — ошибка.
func packageWorkflow(directory string) (*jscompat.Object, error) {
	path := filepath.Join(directory, "workflow.json")
	if !jscompat.Exists(path) {
		return jscompat.NewObject(), nil
	}
	value, err := readJSON(path)
	if err != nil {
		return nil, err
	}
	workflow, ok := value.(*jscompat.Object)
	if !ok {
		return nil, errors.New(textWorkflowCorrupt)
	}
	return workflow, nil
}

// nested — path совпадает с parent или лежит внутри него.
func nested(path, parent string) bool {
	return path == parent || strings.HasPrefix(path, parent+string(os.PathSeparator))
}

// attemptsPaid сообщает, что в каталоге или его подкаталогах есть оригинал платной
// попытки либо attempt.json не в состоянии prepared без generation_id (неразборчивый — тоже
// оплата). Каталоги excluded пропускаются.
func attemptsPaid(directory string, excluded []string) (bool, error) {
	if !jscompat.Exists(directory) || slices.Contains(excluded, directory) {
		return false, nil
	}
	entries, err := jscompat.ReadDir(directory)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if paidOriginal.MatchString(entry.Name()) {
			return true, nil
		}
	}
	if path := filepath.Join(directory, "attempt.json"); jscompat.Exists(path) {
		attempt, err := readJSON(path)
		if err != nil || !jscompat.IsRecord(attempt) || jscompat.Get(attempt, "status") != "prepared" || jscompat.Truthy(jscompat.Get(attempt, "generation_id")) {
			return true, nil
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		paid, err := attemptsPaid(filepath.Join(directory, entry.Name()), excluded)
		if err != nil || paid {
			return paid, err
		}
	}
	return false, nil
}

// ImageRoots возвращает проверенные image-попытки из истории image_requests
// workflow.json пакета directory. Запись истории должна указывать на существующую папку внутри
// пакета без ссылок, не пересекаться с другими и с video request_dir, совпадать по SHA и виду
// запроса и не содержать видео или вложенной неизвестной оплаты. Любое нарушение — ошибка с
// текстом применения предложения. workflow nil — прочитать workflow.json.
func ImageRoots(directory string, workflow *jscompat.Object) ([]ImageRoot, error) {
	if workflow == nil {
		var err error
		if workflow, err = packageWorkflow(directory); err != nil {
			return nil, err
		}
	}
	roots := []ImageRoot{}
	history := workflow.Value("image_requests")
	if history == jscompat.Undefined {
		if jscompat.Truthy(workflow.Value("image_request_dir")) {
			return nil, errors.New(textActiveImageHistoryMissing)
		}
		return roots, nil
	}
	items, ok := jscompat.AsArray(history)
	if !ok {
		return nil, errors.New(textImageHistoryCorrupt)
	}
	for _, item := range items {
		frame, frameOK := jscompat.Get(item, "frame_id").(string)
		requestDir, dirOK := jscompat.Get(item, "request_dir").(string)
		sha, shaOK := jscompat.Get(item, "request_sha256").(string)
		if !jscompat.IsRecord(item) || !paidProvider(jscompat.Get(item, "provider")) || !frameOK || !frameIDPattern.MatchString(frame) || !dirOK ||
			requestDir == "" || jscompat.IsAbs(requestDir) || !shaOK || !sha256Pattern.MatchString(sha) {
			return nil, errors.New(textImageHistoryEntryInvalid)
		}
		path := jscompat.Resolve(directory, requestDir)
		local := jscompat.Relative(directory, path)
		if local == "" || local == ".." || strings.HasPrefix(local, ".."+string(os.PathSeparator)) || jscompat.IsAbs(local) || !jscompat.Exists(path) {
			return nil, errors.New(textImageFolderUnavailable)
		}
		if real, err := jscompat.Realpath(path); err != nil || real != path {
			return nil, errors.New(textImageFolderUnavailable)
		}
		for _, root := range roots {
			other := jscompat.Resolve(directory, root.RequestDir)
			if nested(path, other) || nested(other, path) {
				return nil, errors.New(textImageFoldersOverlap)
			}
		}
		if video, isString := workflow.Value("request_dir").(string); isString && jscompat.Resolve(directory, video) == path {
			return nil, errors.New(textImageReplacesVideoRequest)
		}
		requestPath := filepath.Join(path, "request.json")
		requestBytes, err := os.ReadFile(requestPath)
		if err != nil {
			return nil, jscompat.FsError("open", requestPath, err)
		}
		request, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(requestBytes)))
		if err != nil {
			return nil, err
		}
		attemptPath := filepath.Join(path, "attempt.json")
		if err := jscompat.ReadFileCheck(attemptPath); err != nil {
			return nil, err
		}
		attempt, err := readJSON(attemptPath)
		if err != nil {
			return nil, err
		}
		command, _ := jscompat.Get(request, "command").(string)
		status, _ := jscompat.Get(attempt, "status").(string)
		if !jscompat.IsRecord(request) || jscompat.Get(request, "kind") != "image" || !slices.Contains(imageCommands, command) || !jscompat.IsRecord(attempt) ||
			!slices.Contains(imageAttemptStatuses, status) || jscompat.Get(attempt, "request_sha256") != sha || digestHex(requestBytes) != sha {
			return nil, errors.New(textImageHashOrKindMismatch)
		}
		entries, err := jscompat.ReadDir(path)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if videoOriginal.MatchString(entry.Name()) {
				return nil, errors.New(textImageContainsVideoOrPaidRequ)
			}
			if entry.IsDir() {
				paid, err := attemptsPaid(filepath.Join(path, entry.Name()), nil)
				if err != nil {
					return nil, err
				}
				if paid {
					return nil, errors.New(textImageContainsVideoOrPaidRequ)
				}
			}
		}
		roots = append(roots, ImageRoot{RequestDir: local, RequestSha256: sha, FrameID: frame})
	}
	return roots, nil
}

// paidProvider — isPaidMediaProvider: провайдер реестра с платным исполнителем.
func paidProvider(value any) bool {
	id, ok := mediaproviders.Normalize(value)
	if !ok {
		return false
	}
	info, _ := mediaproviders.Lookup(id)
	return info.Paid
}

// PackageVideoPaid сообщает, что пакет уже отправлял видео (этап после
// отправки) или содержит неопознанную оплату вне проверенных image-попыток. Ошибка проверки —
// тоже оплата: продолжение такого пакета возможно только новой попыткой.
func PackageVideoPaid(directory string) bool {
	if !jscompat.Exists(directory) {
		return false
	}
	workflow, err := packageWorkflow(directory)
	if err != nil {
		return true
	}
	if slices.Contains(videoStages, jscompat.ToString(workflow.Value("stage"))) {
		return true
	}
	roots, err := ImageRoots(directory, workflow)
	if err != nil {
		return true
	}
	excluded := make([]string, len(roots))
	for index, root := range roots {
		excluded[index] = jscompat.Resolve(directory, root.RequestDir)
	}
	paid, err := attemptsPaid(directory, excluded)
	return err != nil || paid
}
