// Package projectgit — точки сохранения проекта клипа в Git: статус несохранённого по разделам
// приложения, коммит всех изменений («Сохранить точку»), автоматическая точка перед крупной
// операцией, история точек, возврат раздела-источника к точке и сравнение сценария с ней.
//
// Git для приложения необязателен. Функции работают, только если папка проекта — корень
// репозитория (не вложенная папка чужого репозитория): иначе Status сообщает недоступность,
// а Checkpoint ничего не делает. Remote, push/pull, ветки и слияния пакет не трогает: отправку
// копии делает сам Git (например, хук пользователя после коммита).
//
// Git запускается через общий process.Run без shell; окружение наследуется, поэтому действуют
// глобальные настройки пользователя (автор коммитов, Git LFS). Вызовы для одного процесса
// приложения сериализованы мьютексом: два коммита подряд не спорят за index.lock.
package projectgit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"songframe/internal/process"
)

// Section — раздел приложения, к которому относится изменённый файл проекта. Значения — стабильные
// ID контракта window.api; подписи разделов принадлежат фронтенду (тексты навигации).
type Section = string

const (
	SectionProject    Section = "project"
	SectionSources    Section = "sources"
	SectionTiming     Section = "timing"
	SectionCast       Section = "cast"
	SectionScenario   Section = "scenario"
	SectionProduction Section = "production"
	SectionScenes     Section = "scenes"
	SectionMontage    Section = "montage"
	SectionAnimatic   Section = "animatic"
	SectionPrompts    Section = "prompts"
	SectionViews      Section = "views"
	SectionOther      Section = "other"
)

// sectionOrder — порядок разделов в ответах: как в навигации приложения, производные и прочее
// в конце. По нему же frontend составляет подпись точки.
var sectionOrder = []Section{
	SectionProject, SectionSources, SectionTiming, SectionCast, SectionScenario, SectionProduction,
	SectionScenes, SectionMontage, SectionAnimatic, SectionPrompts, SectionViews, SectionOther,
}

// sectionRule — путь проекта (файл или папка с завершающим «/») и его раздел. Правила проверяются
// по порядку, поэтому частные пути (производные файлы внутри папки раздела) стоят раньше общих.
type sectionRule struct {
	prefix  string
	section Section
}

// sectionRules следуют таблице источников README шаблона проекта: источник сведений определяет
// страницу-владельца. Производные представления (карточки, списки, ROADMAP, читаемая разметка)
// собраны в отдельный раздел: их пересобирает приложение, вручную их не правят.
var sectionRules = []sectionRule{
	{"plan/project.json", SectionProject},
	{"source/", SectionSources},
	{"plan/audio/timing.md", SectionViews},
	{"plan/audio/", SectionTiming},
	{"plan/cast.json", SectionCast},
	{"plan/treatment.json", SectionScenario},
	{"plan/scenes.json", SectionScenario},
	{"plan/scenario-workflow.json", SectionScenario},
	{"plan/batches/", SectionProduction},
	{"plan/awaiting/", SectionProduction},
	{"plan/production-status.json", SectionProduction},
	{"plan/spend.json", SectionProduction},
	{"plan/reference-images/", SectionProduction},
	{"assets/", SectionScenes},
	{"plan/derived/", SectionScenes},
	{"plan/derived-history/", SectionScenes},
	{"plan/montage/", SectionMontage},
	{"plan/montage-history/", SectionMontage},
	{"plan/animatic/cards/", SectionViews},
	{"plan/animatic/", SectionAnimatic},
	{"plan/prompt-log/", SectionPrompts},
	{"ROADMAP.md", SectionViews},
	{"plan/edit-list.md", SectionViews},
	{"plan/storyboard.md", SectionViews},
	{"plan/context/", SectionViews},
}

// SectionOf — раздел файла по пути относительно папки проекта (разделитель «/»).
func SectionOf(path string) Section {
	for _, rule := range sectionRules {
		if strings.HasSuffix(rule.prefix, "/") && strings.HasPrefix(path, rule.prefix) || path == rule.prefix {
			return rule.section
		}
	}
	return SectionOther
}

// sectionsOf — разделы набора путей без повторов, в порядке sectionOrder.
func sectionsOf(paths []string) []Section {
	seen := map[Section]bool{}
	for _, path := range paths {
		seen[SectionOf(path)] = true
	}
	result := []Section{}
	for _, section := range sectionOrder {
		if seen[section] {
			result = append(result, section)
		}
	}
	return result
}

// Point — точка сохранения (коммит). Date — время автора в RFC 3339, Sections — разделы,
// которые точка изменила относительно предыдущей (у первой — всё её содержимое).
type Point struct {
	ID       string    `json:"id"`
	Date     string    `json:"date"`
	Message  string    `json:"message"`
	Sections []Section `json:"sections"`
}

// Status — состояние Git проекта для страницы «Проект». Available=false — блок истории не
// показывается (Git не найден или папка не корень репозитория). Sections — разделы
// несохранённых изменений, ChangedFiles — их число. Head — последняя точка (nil в репозитории
// без коммитов). AutoError — почему не создалась последняя автоматическая точка; пусто, если
// с тех пор точка сохранилась.
type Status struct {
	Available    bool      `json:"available"`
	Sections     []Section `json:"sections"`
	ChangedFiles int       `json:"changedFiles"`
	Head         *Point    `json:"head"`
	AutoError    string    `json:"autoError"`
}

// gitTimeout ограничивает одну команду Git: статус и коммит больших медиа через LFS занимают
// секунды, зависание (например, ожидание ввода) не должно держать операцию приложения.
const gitTimeout = 10 * time.Minute

var (
	// mu сериализует команды Git этого процесса: коммит, возврат и статус не пересекаются.
	mu sync.Mutex
	// autoErrors — ошибка последней автоматической точки по пути проекта; очищается успешным
	// сохранением. Живёт в памяти процесса: после перезапуска приложение о ней не помнит.
	autoErrors = map[string]string{}
	// lookPath подменяется в тестах, чтобы проверить работу без Git.
	lookPath = exec.LookPath
)

// gitPath — исполняемый файл Git или пусто, если его нет.
func gitPath() string {
	path, err := lookPath("git")
	if err != nil {
		return ""
	}
	return path
}

// run выполняет git с аргументами в папке проекта и возвращает stdout. Ошибку дополняет хвостом
// stderr: так пользователь видит причину Git, а не только код выхода. GIT_TERMINAL_PROMPT=0
// запрещает Git ждать ввода логина. WaitDelay короткий: фоновые процессы хуков пользователя
// (например, отправка копии после коммита) не должны держать операцию до своего конца.
func run(ctx context.Context, project string, args ...string) ([]byte, error) {
	git := gitPath()
	if git == "" {
		return nil, errors.New(textGitMissing)
	}
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	result, err := process.Run(ctx, process.Command{
		Path: git, Args: append([]string{"-c", "core.quotepath=off"}, args...), Dir: project, Env: env, Name: "git",
		Timeout: gitTimeout, StdoutLimit: 64 << 20, StderrLimit: 64 << 10, WaitDelay: 2 * time.Second,
	})
	if err != nil {
		reason := strings.TrimSpace(string(result.Stderr))
		if reason == "" {
			reason = err.Error()
		}
		return result.Stdout, fmt.Errorf(textGitFailed, args[0], reason)
	}
	return result.Stdout, nil
}

// repository проверяет, что Git есть и папка проекта — корень репозитория. Сравниваются пути
// после разрешения символьных ссылок: проект, открытый через ссылку, остаётся тем же репозиторием.
func repository(ctx context.Context, project string) bool {
	if gitPath() == "" {
		return false
	}
	out, err := run(ctx, project, "rev-parse", "--show-toplevel")
	if err != nil {
		return false
	}
	top, err := filepath.EvalSymlinks(strings.TrimSpace(string(out)))
	if err != nil {
		return false
	}
	root, err := filepath.EvalSymlinks(project)
	return err == nil && filepath.Clean(top) == filepath.Clean(root)
}

// changedPaths — пути изменённых, новых и удалённых файлов рабочей папки (с учётом .gitignore).
// Переименование даёт оба пути. Формат porcelain v1 с -z не зависит от языка Git.
func changedPaths(ctx context.Context, project string) ([]string, error) {
	out, err := run(ctx, project, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	paths := []string{}
	fields := strings.Split(string(out), "\x00")
	for index := 0; index < len(fields); index++ {
		entry := fields[index]
		if len(entry) < 4 {
			continue
		}
		paths = append(paths, entry[3:])
		// У переименования (R/C) следующий элемент -z — прежний путь.
		if entry[0] == 'R' || entry[0] == 'C' {
			index++
			if index < len(fields) && fields[index] != "" {
				paths = append(paths, fields[index])
			}
		}
	}
	return paths, nil
}

// GetStatus — состояние Git проекта. Недоступный Git — Status{Available:false} без ошибки:
// это штатное состояние проекта без репозитория.
func GetStatus(ctx context.Context, project string) (Status, error) {
	mu.Lock()
	defer mu.Unlock()
	return status(ctx, project)
}

func status(ctx context.Context, project string) (Status, error) {
	result := Status{Sections: []Section{}}
	if !repository(ctx, project) {
		return result, nil
	}
	result.Available = true
	paths, err := changedPaths(ctx, project)
	if err != nil {
		return result, err
	}
	result.Sections, result.ChangedFiles = sectionsOf(paths), len(paths)
	points, err := history(ctx, project, 1)
	if err != nil {
		return result, err
	}
	if len(points) > 0 {
		result.Head = &points[0]
	}
	result.AutoError = autoErrors[key(project)]
	return result, nil
}

// key — ключ проекта в autoErrors: один и тот же проект, открытый по разным записям пути.
func key(project string) string {
	if resolved, err := filepath.EvalSymlinks(project); err == nil {
		return resolved
	}
	return filepath.Clean(project)
}

// Save — «Сохранить точку»: коммит всех изменений рабочей папки с подписью message. Без
// изменений коммит не создаётся (не ошибка). Подпись обязательна. Перед коммитом проверяется,
// что Git знает автора и что для проекта с LFS установлен git-lfs: иначе понятная ошибка вместо
// сообщения Git на языке системы. Хуки пользователя выполняются как при обычном коммите.
func Save(ctx context.Context, project, message string) (Status, error) {
	mu.Lock()
	defer mu.Unlock()
	if err := save(ctx, project, message); err != nil {
		return Status{}, err
	}
	return status(ctx, project)
}

func save(ctx context.Context, project, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		return errors.New(textMessageRequired)
	}
	if !repository(ctx, project) {
		return errors.New(textNotRepository)
	}
	paths, err := changedPaths(ctx, project)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		delete(autoErrors, key(project))
		return nil
	}
	if err := ready(ctx, project); err != nil {
		return err
	}
	if _, err := run(ctx, project, "add", "--all", "--", "."); err != nil {
		return err
	}
	if _, err := run(ctx, project, "commit", "--quiet", "--message", message); err != nil {
		return err
	}
	delete(autoErrors, key(project))
	return nil
}

// ready проверяет условия коммита, о которых Git сообщает непонятно: автор и git-lfs.
// `git var GIT_AUTHOR_IDENT` завершается ошибкой, если имя или почта не заданы.
func ready(ctx context.Context, project string) error {
	if _, err := run(ctx, project, "var", "GIT_AUTHOR_IDENT"); err != nil {
		return errors.New(textAuthorMissing)
	}
	attributes, err := os.ReadFile(filepath.Join(project, ".gitattributes"))
	if err == nil && bytes.Contains(attributes, []byte("filter=lfs")) {
		if _, err := lookPath("git-lfs"); err != nil {
			return errors.New(textLFSMissing)
		}
	}
	return nil
}

// Operation — крупная операция, перед которой приложение само сохраняет точку. Значения — ID
// контракта (frontend передаёт свои операции, например пересчёт границ); подпись коммита
// составляет Go, она попадает в историю Git, а не в интерфейс.
type Operation = string

const (
	OperationScenarioApply     Operation = "scenarioApply"
	OperationRecalculateBounds Operation = "recalculateBounds"
	OperationProductionApply   Operation = "productionApply"
	OperationMontageApply      Operation = "montageApply"
	OperationDerivedAccept     Operation = "derivedAccept"
	OperationShotAccept        Operation = "shotAccept"
	OperationTimingAlign       Operation = "timingAlign"
	OperationRestore           Operation = "restore"
)

// operationTexts — подписи автоматических точек: «Автоматическая точка перед …».
var operationTexts = map[Operation]string{
	OperationScenarioApply:     "применением сценария",
	OperationRecalculateBounds: "пересчётом границ планов",
	OperationProductionApply:   "применением изменений плана в производстве",
	OperationMontageApply:      "применением монтажа",
	OperationDerivedAccept:     "приёмкой производного плана",
	OperationShotAccept:        "приёмкой плана",
	OperationTimingAlign:       "автоматической разметкой трека",
	OperationRestore:           "возвратом раздела к точке",
}

// Checkpoint — автоматическая точка перед операцией: если проект — репозиторий и в нём есть
// несохранённые изменения, они коммитятся с подписью операции. Без Git, вне корня репозитория
// и без изменений ничего не делает. Ошибка возвращается вызывающему и запоминается для статуса
// («последняя автоматическая точка не создана»); вызывающая операция решает сама, продолжать ли.
func Checkpoint(ctx context.Context, project string, operation Operation) error {
	text, ok := operationTexts[operation]
	if !ok {
		return fmt.Errorf(textUnknownOperation, operation)
	}
	mu.Lock()
	defer mu.Unlock()
	return checkpoint(ctx, project, text)
}

func checkpoint(ctx context.Context, project, text string) error {
	if !repository(ctx, project) {
		return nil
	}
	paths, err := changedPaths(ctx, project)
	if err == nil && len(paths) == 0 {
		return nil
	}
	if err == nil {
		err = save(ctx, project, textAutoMessage+text)
	}
	if err != nil {
		autoErrors[key(project)] = fmt.Sprintf(textAutoFailed, text, err.Error())
	}
	return err
}

// Before — автоматическая точка для операций приложения, которые не должны срываться из-за Git:
// ошибка только запоминается для статуса (её покажет страница «Проект»), операция продолжается.
// Так сбой Git (например, не задан автор) не блокирует работу над клипом.
func Before(ctx context.Context, project string, operation Operation) {
	_ = Checkpoint(ctx, project, operation)
}

// recordSeparator и fieldSeparator разделяют записи и поля в выводе git log; в подписях коммитов
// эти управляющие символы не встречаются.
const (
	recordSeparator = "\x1e"
	fieldSeparator  = "\x1f"
)

// History — последние limit точек от новых к старым. Без Git или вне корня — пустой список.
func History(ctx context.Context, project string, limit int) ([]Point, error) {
	mu.Lock()
	defer mu.Unlock()
	if !repository(ctx, project) {
		return []Point{}, nil
	}
	return history(ctx, project, limit)
}

func history(ctx context.Context, project string, limit int) ([]Point, error) {
	if _, err := run(ctx, project, "rev-parse", "--verify", "--quiet", "HEAD"); err != nil {
		return []Point{}, nil
	}
	format := "--format=" + recordSeparator + "%H" + fieldSeparator + "%aI" + fieldSeparator + "%s" + fieldSeparator
	out, err := run(ctx, project, "log", fmt.Sprintf("-n%d", limit), format, "--name-only", "--root", "--no-renames")
	if err != nil {
		return nil, err
	}
	points := []Point{}
	for _, record := range strings.Split(string(out), recordSeparator) {
		parts := strings.SplitN(record, fieldSeparator, 4)
		if len(parts) < 4 {
			continue
		}
		files := []string{}
		for _, line := range strings.Split(parts[3], "\n") {
			if line = strings.TrimSpace(line); line != "" {
				files = append(files, line)
			}
		}
		points = append(points, Point{ID: parts[0], Date: parts[1], Message: parts[2], Sections: sectionsOf(files)})
	}
	return points, nil
}
