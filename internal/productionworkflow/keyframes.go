package productionworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
	"songframe/internal/providers/agentexec"
)

// frameID — ID опоры K01…K99.
var frameID = regexp.MustCompile(`^K\d{2}$`)

// sha256Hex — SHA-256 в hex, как записывает job.json.
var sha256Hex = regexp.MustCompile(`^[a-f0-9]{64}$`)

// ImageJobsFolder — каталог рабочих папок заданий опор внутри каталога состояния. Менеджер
// агентов разрешает программе-агенту запись только в подпапки этого каталога (StartImages).
const ImageJobsFolder = "image-jobs"

// ImageAgents — часть менеджера агентов, которая запускает задание кандидатов изображений
// (agents.Manager.StartImages): программа и модель задаются провайдером изображений, запись
// разрешена только в рабочей папке задания.
type ImageAgents interface {
	StartImages(input agents.StartInput, workDir string, config agents.Settings) (agents.Job, error)
}

// KeyframeImages — опоры провайдера-агента.
// Программа-агент пишет только кандидатов в рабочую папку <LocalDir>/image-jobs/<UUID>; регистрация
// и принятие принадлежат производственному проходу. Рабочая папка хранит закреплённые копии
// референсов (только чтение) и job.json — связь задания с согласованным SHA запроса, по которой
// результат собирается и после перезапуска приложения. Второго журнала нет.
//
// Реализует agentexec.Images для исполнителей провайдеров-агентов (internal/providers/codex).
// Состояния в памяти нет: методы безопасны для конкурентного вызова, если LocalDir общий только
// для одного приложения.
type KeyframeImages struct {
	// LocalDir — каталог состояния приложения.
	LocalDir string
	// Agents — менеджер агентов (StartImages).
	Agents ImageAgents
	// ValidateImage — дополнительная проверка кандидата декодированием изображения;
	// nil — только заголовок формата.
	ValidateImage func(path string) bool
}

var _ agentexec.Images = (*KeyframeImages)(nil)

// imagesInput — вход job.json: исходный файл, его закреплённая копия в рабочей папке и SHA-256.
type imagesInput struct {
	Path   string `json:"path"`
	Copy   string `json:"copy"`
	SHA256 string `json:"sha256"`
}

// base — реальный путь каталога заданий опор; создаётся при необходимости. Каталог
// разыменовывается один раз: кандидат принимается только при совпадении пути с реальным, и без
// этого символическая ссылка в пути каталога состояния (например, ~/.config на другом диске)
// отклоняла бы каждого кандидата.
func (k *KeyframeImages) base(create bool) (string, error) {
	base := filepath.Join(k.LocalDir, ImageJobsFolder)
	if create {
		if err := os.MkdirAll(base, 0o777); err != nil {
			return "", err
		}
	} else if !dynvalue.Exists(base) {
		return "", nil
	}
	return dynvalue.Realpath(base)
}

// Start готовит рабочую папку задания (копии референсов и утверждённых опор
// только для чтения), запускает программу-агента провайдера и записывает job.json. Референсы — файлы
// изображений внутри проекта (каждый копируется один раз), утверждённые опоры — изображения пакета.
// Ошибка запуска оставляет рабочую папку без job.json: собрать её нельзя.
func (k *KeyframeImages) Start(input mediaapi.ImagesInput, request agentexec.ImagesRequest) (agents.Job, error) {
	project, err := dynvalue.Realpath(input.Project)
	if err != nil {
		return agents.Job{}, err
	}
	if len(input.Frames) == 0 || slices.ContainsFunc(input.Frames, func(frame mediaapi.FramePrompt) bool {
		return !frameID.MatchString(frame.ID) || dynvalue.Trim(frame.Prompt) == ""
	}) {
		return agents.Job{}, errors.New(textFrameDescriptionsRequired)
	}
	base, err := k.base(true)
	if err != nil {
		return agents.Job{}, err
	}
	directory := filepath.Join(base, randomUUID())
	if err := os.MkdirAll(directory, 0o777); err != nil {
		return agents.Job{}, err
	}
	inputs := []imagesInput{}
	copies := map[string]string{}
	frames := make([]any, len(input.Frames))
	for index, frame := range input.Frames {
		references := make([]any, len(frame.ReferencePaths))
		for position, path := range frame.ReferencePaths {
			source := dynvalue.Resolve(project, path)
			real, err := dynvalue.Realpath(source)
			if err != nil {
				return agents.Job{}, err
			}
			local := dynvalue.Relative(project, real)
			if dynvalue.IsAbs(local) || strings.HasPrefix(local, "..") || !mediafile.IsImage(source) {
				return agents.Job{}, errors.New(textReferenceUnavailable(path))
			}
			name, seen := copies[source]
			if !seen {
				name = "reference-" + twoDigits(len(copies)+1) + extname(source)
				digest, err := pinCopy(source, filepath.Join(directory, name))
				if err != nil {
					return agents.Job{}, err
				}
				copies[source] = name
				inputs = append(inputs, imagesInput{Path: source, Copy: name, SHA256: digest})
			}
			references[position] = name
		}
		item := dynvalue.NewObject()
		item.Set("id", frame.ID)
		item.Set("role", frame.Role)
		item.Set("timeSeconds", frame.TimeSeconds)
		item.Set("prompt", frame.Prompt)
		item.Set("referencePaths", &dynvalue.Array{Items: references})
		frames[index] = item
	}
	// Утверждённые опоры пакета копируются рядом с референсами: следующий кадр согласуется с ними.
	approved := []any{}
	if input.ApprovedFrames != nil {
		for _, frame := range *input.ApprovedFrames {
			if !frameID.MatchString(frame.ID) || !mediafile.IsImage(frame.Path) {
				return agents.Job{}, errors.New(textApprovedFrameUnavailable(frame.ID))
			}
			name := "approved-" + frame.ID + extname(frame.Path)
			digest, err := pinCopy(frame.Path, filepath.Join(directory, name))
			if err != nil {
				return agents.Job{}, err
			}
			inputs = append(inputs, imagesInput{Path: frame.Path, Copy: name, SHA256: digest})
			item := dynvalue.NewObject()
			item.Set("id", frame.ID)
			item.Set("role", frame.Role)
			item.Set("path", name)
			approved = append(approved, item)
		}
	}
	notes := []any{}
	if input.Notes != nil {
		for _, note := range *input.Notes {
			if text := dynvalue.Trim(note); text != "" {
				notes = append(notes, text)
			}
		}
	}
	ids := make([]string, len(input.Frames))
	for index, frame := range input.Frames {
		ids[index] = frame.ID
	}
	context := dynvalue.NewObject()
	context.Set("stage", "frames")
	context.Set("shot", input.Shot)
	context.Set("frames", &dynvalue.Array{Items: frames})
	if len(approved) > 0 {
		context.Set("approvedFrames", &dynvalue.Array{Items: approved})
	}
	if len(notes) > 0 {
		context.Set("notes", &dynvalue.Array{Items: notes})
	}
	job, err := k.Agents.StartImages(agents.StartInput{
		Project: project,
		Task:    textImagesJobTitle(input.Shot, strings.Join(ids, ", "), providers.Title(request.Provider, generationProviderFallback)),
		Prompt:  textImagesPrompt(len(approved) > 0, len(notes) > 0),
		Context: dynvalue.Stringify(context),
		Place:   &agents.Place{Page: "production", Shot: input.Shot},
	}, directory, request.Agent)
	if err != nil {
		return agents.Job{}, err
	}
	record := dynvalue.NewObject()
	record.Set("schemaVersion", float64(1))
	record.Set("jobId", job.ID)
	record.Set("project", project)
	record.Set("provider", request.Provider)
	record.Set("requestSha", request.RequestSha)
	record.Set("ids", stringsArray(ids))
	items := make([]any, len(inputs))
	for index, item := range inputs {
		object := dynvalue.NewObject()
		object.Set("path", item.Path)
		object.Set("copy", item.Copy)
		object.Set("sha256", item.SHA256)
		items[index] = object
	}
	record.Set("inputs", &dynvalue.Array{Items: items})
	return job, writeJSON(filepath.Join(directory, "job.json"), record)
}

// pinCopy копирует файл в рабочую папку задания с правами только на чтение и возвращает SHA-256
// исходника: программа-агент не должна менять закреплённые входы.
func pinCopy(source, target string) (string, error) {
	data, err := os.ReadFile(source)
	if err != nil {
		return "", dynvalue.FsError("open", source, err)
	}
	if err := os.WriteFile(target, data, 0o666); err != nil {
		return "", err
	}
	if err := os.Chmod(target, 0o444); err != nil {
		return "", err
	}
	return fileSHA(source)
}

// fileSHA — SHA-256 содержимого файла.
func fileSHA(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", dynvalue.FsError("open", path, err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// extname — расширение имени в нижнем регистре: у имени из одной точки в начале
// (.png) расширения нет.
func extname(path string) string {
	name := filepath.Base(path)
	index := strings.LastIndex(name, ".")
	if index <= 0 {
		return ""
	}
	return strings.ToLower(name[index:])
}

// jobRecord — job.json задания job: рабочая папка и разобранная запись. found=false — такой
// записи нет (повреждённые и чужие записи пропускаются).
func (k *KeyframeImages) jobRecord(job agents.Job) (directory string, record any, found bool, err error) {
	base, err := k.base(false)
	if err != nil || base == "" {
		return "", nil, false, err
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return "", nil, false, nil
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		directory := filepath.Join(base, entry.Name())
		value, err := readJSON(filepath.Join(directory, "job.json"))
		if err != nil || !dynvalue.IsRecord(value) && !dynvalue.IsArray(value) {
			continue
		}
		if dynvalue.Get(value, "jobId") != job.ID {
			continue
		}
		return directory, value, true, nil
	}
	return "", nil, false, nil
}

// Collect возвращает кандидатов завершённого задания job в порядке согласованных опор.
// Проверяются целостность записи и закреплённых входов, контракт
// ответа программы и каждый файл: обычное изображение внутри рабочей папки (не ссылка, не копия
// входа), расширение по фактическому формату, ровно согласованные опоры. Ответ не JSON —
// textImagesFileListMissing, отсутствующий файл кандидата — textImagesFrameImageRequired.
// requestSha записи отдельно не сверяется: единственный путь сбора (CollectJob исполнителя) берёт
// ожидаемый SHA из этой же записи.
func (k *KeyframeImages) Collect(job agents.Job) ([]mediaapi.FrameCandidate, error) {
	if job.Status != "completed" || job.ExitCode == nil || *job.ExitCode != 0 {
		return nil, errors.New(textImagesJobIncomplete)
	}
	directory, record, found, err := k.jobRecord(job)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errors.New(textImagesWorkDirUnavailable)
	}
	provider, _ := dynvalue.Get(record, "provider").(string)
	info, known := mediaproviders.Lookup(provider)
	ids, idsOK := dynvalue.AsArray(dynvalue.Get(record, "ids"))
	inputs, inputsOK := dynvalue.AsArray(dynvalue.Get(record, "inputs"))
	// Задание выполнила программа-агент провайдера из записи: её название и показывается в ошибках.
	if dynvalue.Get(record, "schemaVersion") != float64(1) || dynvalue.Get(record, "project") != job.Project ||
		!known || !slices.Contains(info.Kinds, mediaproviders.Image) || info.Executor != job.Provider || !idsOK || !inputsOK {
		return nil, errors.New(textImagesJobRecordCorrupt)
	}
	title := providers.Title(provider, generationProviderFallback)
	copies := []string{}
	for _, item := range inputs {
		path, _ := dynvalue.Get(item, "path").(string)
		copy, _ := dynvalue.Get(item, "copy").(string)
		expected := dynvalue.Get(item, "sha256")
		copies = append(copies, copy)
		if !matchesFile(path, expected) || !matchesFile(filepath.Join(directory, copy), expected) {
			return nil, errors.New(textImagesReferencesChanged)
		}
	}
	parsed, err := dynvalue.Parse([]byte(job.Result))
	if err != nil {
		return nil, errors.New(textImagesFileListMissing(title))
	}
	response, ok := parsed.(*dynvalue.Object)
	if !ok {
		return nil, errors.New(textImagesFileListMissing(title))
	}
	images, imagesOK := dynvalue.AsArray(response.Value("images"))
	if response.Value("schemaVersion") != float64(1) || response.Value("stage") != "frames" || keys(response, "schemaVersion", "stage", "images") != nil || !imagesOK {
		return nil, errors.New(textImagesResultInvalid)
	}
	candidates := make([]mediaapi.FrameCandidate, 0, len(images))
	for _, value := range images {
		item, isObject := value.(*dynvalue.Object)
		if !isObject {
			return nil, errors.New(textImagesFrameEntryInvalid)
		}
		id, idOK := item.Value("id").(string)
		path, pathOK := item.Value("path").(string)
		if !idOK || !pathOK || keys(item, "id", "path") != nil {
			return nil, errors.New(textImagesFramePathInvalid)
		}
		file := dynvalue.Resolve(directory, path)
		if !k.candidateFile(directory, file, path, copies) {
			return nil, errors.New(textImagesFrameImageRequired(id))
		}
		if !mediafile.ExtensionMatches(file) {
			return nil, errors.New(textImagesFrameExtensionMismatch(id))
		}
		candidates = append(candidates, mediaapi.FrameCandidate{ID: id, Path: file})
	}
	unique := map[string]bool{}
	for _, candidate := range candidates {
		unique[candidate.ID] = true
	}
	expected := []string{}
	for _, id := range ids {
		text, _ := id.(string)
		expected = append(expected, text)
	}
	if len(candidates) != len(ids) || len(unique) != len(ids) || slices.ContainsFunc(candidates, func(candidate mediaapi.FrameCandidate) bool {
		return !slices.Contains(expected, candidate.ID)
	}) {
		return nil, errors.New(textImagesFramesIncomplete(title))
	}
	result := make([]mediaapi.FrameCandidate, len(expected))
	for index, id := range expected {
		position := slices.IndexFunc(candidates, func(candidate mediaapi.FrameCandidate) bool { return candidate.ID == id })
		result[index] = candidates[position]
	}
	return result, nil
}

// candidateFile — кандидат file (path из ответа) — обычный файл изображения прямо в рабочей папке:
// не копия входа, не абсолютный путь и не выход наружу, не ссылка и не путь через ссылку.
func (k *KeyframeImages) candidateFile(directory, file, path string, copies []string) bool {
	local := dynvalue.Relative(directory, file)
	if slices.Contains(copies, local) || dynvalue.IsAbs(path) || strings.HasPrefix(local, "..") || dynvalue.IsAbs(local) {
		return false
	}
	info, err := os.Lstat(file)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	if real, err := dynvalue.Realpath(file); err != nil || real != file {
		return false
	}
	return mediafile.IsImage(file) && (k.ValidateImage == nil || k.ValidateImage(file))
}

// matchesFile — файл есть и его SHA-256 равен expected.
func matchesFile(path string, expected any) bool {
	if path == "" || !dynvalue.Exists(path) {
		return false
	}
	digest, err := fileSHA(path)
	return err == nil && digest == expected
}

// RequestSha возвращает SHA согласованного запроса задания job из его job.json.
// После перезапуска связь задания с запросом восстанавливается из той же записи.
func (k *KeyframeImages) RequestSha(job agents.Job) (string, error) {
	_, record, found, err := k.jobRecord(job)
	if err != nil {
		return "", err
	}
	if !found {
		return "", errors.New(textImagesWorkDirUnavailable)
	}
	if dynvalue.Get(record, "schemaVersion") != float64(1) || dynvalue.Get(record, "project") != job.Project {
		return "", errors.New(textImagesJobRecordCorrupt)
	}
	sha, ok := dynvalue.Get(record, "requestSha").(string)
	if !ok || !sha256Hex.MatchString(sha) {
		return "", errors.New(textImagesRequestHashCorrupt)
	}
	return sha, nil
}
