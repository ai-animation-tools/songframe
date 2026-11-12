// Package newproject создаёт папку клипа из встроенного шаблона: проверка формы «Новый проект»,
// копирование шаблона с подстановкой плейсхолдеров и необязательный git init. Открытие созданного
// проекта и история остаются у сервиса проектов.
//
// Файлы, подстановки и тексты проблем зафиксированы эталонами testdata/golden/project-create.
// Шаблон собирается во временной соседней папке и переносится на место одним rename, поэтому сбой
// посередине копирования не оставляет полупустой проект на выбранном пути.
package newproject

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"songframe/internal/projectfile"
	"strconv"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/process"
)

// Тексты проблем projectsTexts.main (frontend/src/shared/texts/projects.ts): форма показывает их
// пользователю как есть.
const (
	nameRequired         = "Укажите название проекта."
	pathRequired         = "Укажите полный путь к папке проекта."
	absolutePathRequired = "Путь должен быть абсолютным."
	targetExists         = "Папка уже существует: выберите новый путь или откройте её как существующий проект."
	invalidAnimaticName  = "Имя MP4: латиница, цифры, точка, дефис, подчёркивание и расширение .mp4."
	invalidFrameRate     = "Частота кадров проекта: 24, 25 или 30 кадров/с."
)

func parentMissing(path string) string {
	return "Родительская папка не существует: " + path
}

// GitFailedFile — служебный файл, который остаётся в проекте, если git есть, но init не удался.
const GitFailedFile = "GIT-INIT-FAILED.txt"

// Input — CreateProjectInput контракта: название, абсолютный путь новой папки и необязательное имя MP4.
type Input struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// AnimaticVideo — имя MP4 полного аниматика; пустое или отсутствующее выводится из названия.
	AnimaticVideo *string `json:"animaticVideo,omitempty"`
	// FPS — частота кадров проекта (projectfile.FrameRates); 0 или отсутствие — DefaultFrameRate.
	// После создания не меняется: на ней строятся границы планов, монтаж и экспорт.
	FPS int `json:"fps,omitempty"`
}

// animaticPattern — допустимое явное имя MP4 в форме создания (регистр расширения важен).
var animaticPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+\.mp4$`)

// slugPattern — каждая серия символов, кроме латиницы и цифр, заменяется одним дефисом.
var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

// DefaultAnimaticName — имя MP4 аниматика из названия: латиница, цифры и дефисы; для названия
// без латиницы и цифр остаётся animatic.mp4. Нижний регистр (lowerName) совпадает с подсказкой
// формы в frontend/src/renderer/pages/NewProjectPage/helpers.ts.
func DefaultAnimaticName(name string) string {
	slug := strings.Trim(slugPattern.ReplaceAllString(lowerName(name), "-"), "-")
	if slug == "" {
		return "animatic.mp4"
	}
	return slug + "-animatic.mp4"
}

// lowerName — нижний регистр по полным правилам Unicode, как toLowerCase формы. Единственное
// отличие strings.ToLower в значимой для slug области — «İ» (U+0130): полное правило даёт «i» с
// комбинирующей точкой, то есть i и дефис в slug.
func lowerName(text string) string {
	return strings.ToLower(strings.ReplaceAll(text, "İ", "i̇"))
}

// Validate — список проблем формы в порядке эталонов project-validate-new; пустой — можно создавать.
// Функция только читает файловую систему (существование цели и родителя).
func Validate(input Input) []string {
	problems := []string{}
	if dynvalue.Trim(input.Name) == "" {
		problems = append(problems, nameRequired)
	}
	switch {
	case dynvalue.Trim(input.Path) == "":
		problems = append(problems, pathRequired)
	case !dynvalue.IsAbs(input.Path):
		problems = append(problems, absolutePathRequired)
	default:
		target := dynvalue.Resolve("", input.Path)
		if dynvalue.Exists(target) {
			problems = append(problems, targetExists)
		}
		parent := filepath.Dir(target)
		if info, err := os.Stat(parent); err != nil || !info.IsDir() {
			problems = append(problems, parentMissing(parent))
		}
	}
	if input.AnimaticVideo != nil {
		if video := dynvalue.Trim(*input.AnimaticVideo); video != "" && !animaticPattern.MatchString(video) {
			problems = append(problems, invalidAnimaticName)
		}
	}
	if input.FPS != 0 && !projectfile.ValidFrameRate(input.FPS) {
		problems = append(problems, invalidFrameRate)
	}
	return problems
}

// Create проверяет ввод, копирует шаблон в новую папку и, если в системе есть git, делает её
// репозиторием (git init -q). Возвращает абсолютный путь проекта; открывает его вызывающий.
//
// Ошибка проверки — проблемы формы через пробел; в этом случае ничего не создаётся. Отсутствие
// git не ошибка; другой сбой git init записывается в GIT-INIT-FAILED.txt внутри проекта и тоже не
// отменяет создание.
func Create(ctx context.Context, template fs.FS, input Input) (string, error) {
	if problems := Validate(input); len(problems) > 0 {
		return "", errors.New(strings.Join(problems, " "))
	}
	target := dynvalue.Resolve("", input.Path)
	name := dynvalue.Trim(input.Name)
	video := ""
	if input.AnimaticVideo != nil {
		video = dynvalue.Trim(*input.AnimaticVideo)
	}
	if video == "" {
		video = DefaultAnimaticName(name)
	}
	fps := input.FPS
	if fps == 0 {
		fps = projectfile.DefaultFrameRate
	}
	values := Placeholders{"project_name": name, "animatic_video": video, "fps": strconv.Itoa(fps)}
	if err := materialize(template, target, values); err != nil {
		return "", err
	}
	initGit(ctx, target)
	return target, nil
}

// materialize собирает шаблон во временной папке рядом с целью и переносит её на место.
// Временная папка в том же родителе — тот же том, поэтому rename атомарен; при любой ошибке
// она удаляется, а выбранный путь остаётся свободным для повторной попытки.
func materialize(template fs.FS, target string, values Placeholders) error {
	staging, err := stagingDir(target)
	if err != nil {
		return fmt.Errorf("не удалось подготовить папку проекта %s: %w", target, err)
	}
	defer os.RemoveAll(staging)
	if err := CopyTemplate(template, staging, values); err != nil {
		return err
	}
	// Цель могли занять, пока шаблон копировался: rename поверх пустой папки в Linux удался бы молча.
	if dynvalue.Exists(target) {
		return errors.New(targetExists)
	}
	if err := os.Rename(staging, target); err != nil {
		return fmt.Errorf("не удалось создать папку проекта %s: %w", target, err)
	}
	return nil
}

// stagingDir создаёт скрытую соседнюю папку с правами 0777 с учётом umask, как mkdirSync
// (os.MkdirTemp дал бы 0700, и новый проект получил бы непривычные права).
func stagingDir(target string) (string, error) {
	suffix := make([]byte, 8)
	for attempt := 0; ; attempt++ {
		if _, err := rand.Read(suffix); err != nil {
			return "", err
		}
		path := filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+".songframe-new-"+hex.EncodeToString(suffix))
		err := os.Mkdir(path, 0o777)
		if err == nil || !errors.Is(err, fs.ErrExist) || attempt == 3 {
			return path, err
		}
	}
}

// initGit выполняет git init -q в папке проекта. Git необязателен: если программы нет,
// проект остаётся обычной папкой. Запуск идёт через общий process.Run (без консоли в Windows).
func initGit(ctx context.Context, target string) {
	git, err := exec.LookPath("git")
	if err != nil {
		return
	}
	result, err := process.Run(ctx, process.Command{Path: git, Args: []string{"init", "-q", target}, Name: "git", StderrLimit: 64 << 10})
	if err == nil {
		return
	}
	var start *process.StartError
	if errors.As(err, &start) && errors.Is(start.Err, fs.ErrNotExist) {
		return
	}
	reason := string(result.Stderr)
	if reason == "" {
		reason = err.Error()
	}
	if reason == "" {
		reason = "неизвестная ошибка"
	}
	// Служебная заметка в папке проекта; создание проекта при этом не отменяется.
	_ = os.WriteFile(filepath.Join(target, GitFailedFile), []byte("git init не удался: "+reason+"\n"), 0o666)
}

// Placeholders — значения {{ключ}} шаблона: project_name, animatic_video и fps.
type Placeholders map[string]string

// placeholderPattern — {{ ключ }} с необязательными пробелами; ключ из строчной латиницы и «_».
var placeholderPattern = regexp.MustCompile(`\{\{\s*([a-z_]+)\s*\}\}`)

// textExtensions — файлы, в которых выполняется подстановка; имя без расширения (.gitignore)
// сравнивается целиком.
var textExtensions = map[string]bool{".md": true, ".json": true, ".txt": true, ".gitignore": true, ".gitkeep": true, ".yml": true, ".yaml": true}

// RenderPlaceholders подставляет известные ключи за один проход; неизвестные плейсхолдеры и
// фигурные скобки внутри подставленных значений остаются как есть.
func RenderPlaceholders(text string, values Placeholders) string {
	return placeholderPattern.ReplaceAllStringFunc(text, func(match string) string {
		key := placeholderPattern.FindStringSubmatch(match)[1]
		if value, ok := values[key]; ok {
			return value
		}
		return match
	})
}

// isText выбирает файлы для подстановки: по расширению (fileExtension) или по всему имени, если
// расширения нет, как у «.gitignore».
func isText(name string) bool {
	extension := fileExtension(name)
	if extension == "" {
		extension = name
	}
	return textExtensions[extension]
}

// fileExtension — расширение имени файла с точкой; точка в начале имени расширением не считается,
// имя без точки даёт пустую строку.
func fileExtension(name string) string {
	index := strings.LastIndex(name, ".")
	if index <= 0 {
		return ""
	}
	return name[index:]
}

// CopyTemplate рекурсивно копирует дерево шаблона в target (папка создаётся при необходимости):
// текстовые файлы проходят подстановку, остальные копируются байт в байт. Значения не экранируются
// для JSON: название с кавычкой даёт нечитаемый plan/project.json.
func CopyTemplate(template fs.FS, target string, values Placeholders) error {
	return fs.WalkDir(template, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("Шаблон проекта не найден: %s: %w", name, err)
		}
		destination := filepath.Join(target, filepath.FromSlash(name))
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o777)
		}
		data, err := fs.ReadFile(template, name)
		if err != nil {
			return err
		}
		if isText(path.Base(name)) {
			data = []byte(RenderPlaceholders(dynvalue.DecodeUTF8(data), values))
		}
		// Новый файл создаётся с правами 0666 с учётом umask.
		return os.WriteFile(destination, data, 0o666)
	})
}
