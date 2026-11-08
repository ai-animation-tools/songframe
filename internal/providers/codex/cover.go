package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"songframe/internal/agents"
	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/providers/agentexec"
)

// Инструкция встроенному image_gen — протокол этого адаптера, а не текст интерфейса; строки
// зафиксированы побайтно эталоном cover-runner.
const (
	referencePrompt         = "Создай одно изображение референса по пользовательскому описанию из дополнительного контекста. "
	referenceGuidance       = "referenceImages — явно выбранные пользователем опоры запроса. Сначала просмотри все эти файлы и передай их встроенному image_gen как изображения-референсы. Сохрани внешность, узнаваемые черты и конструкцию целевого объекта; назначение дополнительных опор и нужные изменения бери из userPrompt. Следуй общему визуальному стилю клипа из userPrompt; меняй только то, что явно попросил пользователь. Не заменяй опоры посторонними персонажами и не создавай новый дизайн без просьбы. "
	coverReferenceGuidance  = "referenceImages — явно выбранные пользователем опоры обложки. Сначала просмотри все файлы и передай их встроенному image_gen как изображения-референсы. Сохрани узнаваемую внешность персонажей и особенности объектов; композицию обложки строй по userPrompt. "
	coverPrompt             = "Создай одну квадратную обложку по пользовательскому описанию из дополнительного контекста. "
	imagePrompt             = "Обязательно используй встроенный инструмент image_gen, создай настоящее изображение и сохрани один результат в текущей рабочей папке. " + "Разрешены PNG, JPEG и WebP; расширение обязано соответствовать реальному формату. " + "Не используй внешние сервисы генерации, API-ключи, программную отрисовку, SVG, заглушки, имитацию или сторонние генераторы. " + "Если встроенный image_gen недоступен, заверши задачу с объяснением ошибки. " + "Не изменяй исходный проект и не выполняй commit/push. Финальный ответ — ровно один JSON без Markdown: {\"path\":\"cover.png\"}. " + "Для JPEG или WebP укажи соответствующее имя созданного файла."
	textImageGenUnavailable = "Агент не смог создать обложку. Проверьте доступность встроенного image_gen."
)

// coverTexts — тексты исполнителя по назначению: обложка (sourcesTexts.main) или референс
// (referenceGenerationMessages поверх них).
type coverTexts struct{ stopped, title, pathMissing, resultInvalid string }

var (
	textsCover     = coverTexts{"Генерация обложки остановлена.", "Обложка проекта", "Агент не вернул путь к созданной обложке.", "Агент вернул неверный результат обложки. Ожидается JSON с одним полем path."}
	textsReference = coverTexts{"Генерация референса остановлена.", "Изображение референса проекта", "Агент не вернул путь к созданному референсу.", "Агент вернул неверный результат референса. Ожидается JSON с одним полем path."}
)

// textContextTooLarge — referenceGenerationMessages.referenceContextTooLarge.
const textContextTooLarge = "Контекст изображения превышает 256 КБ. Сократите описание, идею или текст песни перед подготовкой."

// CoverInput и PurposeReference — общий контракт исполнителя обложки.
type CoverInput = agentexec.CoverInput

// PurposeReference — назначение «референс проекта».
const PurposeReference = agentexec.PurposeReference

var _ agentexec.CoverRunner = CoverRunner{}

// CoverManager — часть менеджера агентов, нужная исполнителю.
type CoverManager interface {
	StartImages(input agents.StartInput, workDir string, config agents.Settings) (agents.Job, error)
	Get(id string) (agents.Job, bool)
	OnEvent(listener func(agents.Event)) (unsubscribe func())
	ShutdownAndWait(ctx context.Context) error
}

// CoverRunner — исполнитель обложки и референса Codex: встроенный image_gen агента в отдельном
// временном проекте.
type CoverRunner struct {
	// Config — программа-агент и модель, закреплённые при подготовке.
	Config agents.Settings
	// NewManager — менеджер заданий временного проекта; nil — agents.NewManager на настройках
	// этого проекта. Тесты подменяют его.
	NewManager func(settings *agents.SettingsStore) CoverManager
}

// textsFor — тексты исполнителя по назначению.
func textsFor(input CoverInput) coverTexts {
	if input.Purpose == PurposeReference {
		return textsReference
	}
	return textsCover
}

// referencePath — путь опоры для агента относительно рабочей папки: файл внутри неё остаётся на
// месте, внешний получает имя references/NN<расширение>.
func referencePath(workDir string, image mediaapi.ReferenceImage, index int) string {
	local := dynvalue.Relative(workDir, image.Path)
	if dynvalue.IsAbs(local) || local == ".." || strings.HasPrefix(local, "../") || strings.HasPrefix(local, `..\`) {
		return fmt.Sprintf("references/%02d%s", index+1, strings.ToLower(filepath.Ext(image.Path)))
	}
	return strings.ReplaceAll(local, `\`, "/")
}

// encodeContext — JSON дополнительного контекста {userPrompt, referenceImages?}; предел
// TextLimit проверяется именно для stdin-JSON: экранирование и подписи тоже занимают бюджет.
func encodeContext(prompt string, images []mediaapi.ReferenceImage) (string, error) {
	context := dynvalue.NewObject()
	context.Set("userPrompt", prompt)
	if len(images) > 0 {
		items := make([]any, len(images))
		for index, image := range images {
			item := dynvalue.NewObject()
			item.Set("path", image.Path)
			item.Set("label", image.Label)
			item.Set("sha256", image.SHA256)
			item.Set("bytes", float64(image.Bytes))
			items[index] = item
		}
		context.Set("referenceImages", &dynvalue.Array{Items: items})
	}
	text := dynvalue.Stringify(context)
	if len(text) > agents.TextLimit {
		return "", errors.New(textContextTooLarge)
	}
	return text, nil
}

// ValidateInput проверяет транспорт до выдачи SHA и токена согласования: опоры не изменились, а
// контекст укладывается в предел задания агента.
func (r CoverRunner) ValidateInput(input CoverInput) error {
	images, err := mediafile.CheckedReferences(input.References)
	if err != nil {
		return err
	}
	for index := range images {
		images[index].Path = referencePath(input.WorkDir, images[index], index)
	}
	_, err = encodeContext(input.Prompt, images)
	return err
}

// Prompt — фиксированная инструкция агенту по назначению и наличию опор.
func Prompt(purpose string, references bool) string {
	prompt := coverPrompt
	guidance := coverReferenceGuidance
	if purpose == PurposeReference {
		prompt, guidance = referencePrompt, referenceGuidance
	}
	if references {
		prompt += guidance
	}
	return prompt + imagePrompt
}

// Run создаёт одно изображение и возвращает путь результата из финального ответа агента
// ({"path": …} относительно рабочей папки). Даже при прямом вызове агент получает только
// проверенные копии опор внутри своей папки (только для чтения). Отмена ctx останавливает
// менеджер временного проекта; менеджер закрывается в любом исходе.
func (r CoverRunner) Run(ctx context.Context, input CoverInput) (string, error) {
	texts := textsFor(input)
	if ctx.Err() != nil {
		return "", errors.New(texts.stopped)
	}
	checked, err := mediafile.CheckedReferences(input.References)
	if err != nil {
		return "", err
	}
	images := make([]mediaapi.ReferenceImage, len(checked))
	for index, image := range checked {
		path := referencePath(input.WorkDir, image, index)
		target := filepath.Join(input.WorkDir, path)
		if target != image.Path {
			if err := copyReadOnly(image.Path, target); err != nil {
				return "", err
			}
		}
		image.Path = path
		images[index] = image
	}
	copies := make([]mediaapi.ReferenceImage, len(images))
	for index, image := range images {
		image.Path = filepath.Join(input.WorkDir, image.Path)
		copies[index] = image
	}
	if _, err := mediafile.CheckedReferences(copies); err != nil {
		return "", err
	}
	root := filepath.Dir(filepath.Dir(input.WorkDir))
	settings := agents.NewSettingsStore(root)
	if err := os.MkdirAll(filepath.Join(root, "plan"), 0o777); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(root, "plan", "project.json"), []byte("{}"), 0o666); err != nil {
		return "", err
	}
	var manager CoverManager
	if r.NewManager != nil {
		manager = r.NewManager(settings)
	} else {
		manager = agents.NewManager(settings, agents.Options{})
	}
	defer func() { _ = manager.ShutdownAndWait(context.Background()) }()
	stop := context.AfterFunc(ctx, func() { _ = manager.ShutdownAndWait(context.Background()) })
	defer stop()
	encoded, err := encodeContext(input.Prompt, images)
	if err != nil {
		return "", err
	}
	finished := make(chan agents.Job, 1)
	var jobID string
	check := func() {
		if jobID == "" {
			return
		}
		if job, ok := manager.Get(jobID); ok && job.Status != agents.StatusRunning {
			select {
			case finished <- job:
			default:
			}
		}
	}
	unsubscribe := manager.OnEvent(func(agents.Event) { check() })
	defer unsubscribe()
	job, err := manager.StartImages(agents.StartInput{
		Project: root, Task: texts.title, Prompt: Prompt(input.Purpose, len(images) > 0), Context: encoded,
	}, input.WorkDir, r.Config)
	if err != nil {
		return "", err
	}
	jobID = job.ID
	check()
	var completed agents.Job
	select {
	case completed = <-finished:
	case <-ctx.Done():
		// Остановленный менеджер завершает задание; ждём событие его итога.
		completed = waitFinished(manager, jobID, finished)
	}
	if ctx.Err() != nil {
		return "", errors.New(texts.stopped)
	}
	if completed.Status != agents.StatusCompleted || completed.ExitCode == nil || *completed.ExitCode != 0 {
		if completed.Message != "" {
			return "", errors.New(completed.Message)
		}
		return "", errors.New(textImageGenUnavailable)
	}
	value, err := dynvalue.Parse([]byte(completed.Result))
	if err != nil {
		return "", errors.New(texts.pathMissing)
	}
	response, ok := value.(*dynvalue.Object)
	path, isString := dynvalue.Get(value, "path").(string)
	if !ok || response.Len() != 1 || !isString {
		return "", errors.New(texts.resultInvalid)
	}
	return path, nil
}

// waitFinished ждёт завершения задания после остановки менеджера (не дольше 10 с).
func waitFinished(manager CoverManager, id string, finished <-chan agents.Job) agents.Job {
	deadline := time.After(10 * time.Second)
	for {
		select {
		case job := <-finished:
			return job
		case <-deadline:
			job, _ := manager.Get(id)
			return job
		case <-time.After(50 * time.Millisecond):
			if job, ok := manager.Get(id); ok && job.Status != agents.StatusRunning {
				return job
			}
		}
	}
}

// copyReadOnly копирует опору в рабочую папку агента и делает копию только для чтения.
func copyReadOnly(source, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.WriteFile(target, data, 0o666); err != nil {
		return err
	}
	return os.Chmod(target, 0o444)
}
