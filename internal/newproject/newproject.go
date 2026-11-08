// Package newproject создаёт папку клипа из встроенного шаблона: проверка формы «Новый проект»
// (validateNewProject оригинала), копирование шаблона с подстановкой плейсхолдеров (copyTemplate)
// и необязательный git init. Открытие созданного проекта и история остаются у сервиса проектов.
//
// Результат совпадает с Electron-оригиналом байт в байт (эталоны testdata/golden/project-create):
// те же файлы, те же подстановки и те же тексты проблем. Отличие устройства — шаблон собирается
// во временной соседней папке и переносится на место одним rename, поэтому сбой посередине
// копирования не оставляет полупустой проект на выбранном пути.
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
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/process"
)

// Тексты проблем projectsTexts.main оригинала: форма показывает их пользователю как есть.
const (
	nameRequired         = "Укажите название проекта."
	pathRequired         = "Укажите полный путь к папке проекта."
	absolutePathRequired = "Путь должен быть абсолютным."
	targetExists         = "Папка уже существует: выберите новый путь или откройте её как существующий проект."
	invalidAnimaticName  = "Имя MP4: латиница, цифры, точка, дефис, подчёркивание и расширение .mp4."
)

func parentMissing(path string) string {
	return "Родительская папка не существует: " + path
}

// GitFailedFile — служебный файл, который оригинал оставляет в проекте, если git есть, но init не удался.
const GitFailedFile = "GIT-INIT-FAILED.txt"

// Input — CreateProjectInput контракта: название, абсолютный путь новой папки и необязательное имя MP4.
type Input struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// AnimaticVideo — имя MP4 полного аниматика; пустое или отсутствующее выводится из названия.
	AnimaticVideo *string `json:"animaticVideo,omitempty"`
}

// animaticPattern — допустимое явное имя MP4 в форме создания (регистр расширения важен).
var animaticPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+\.mp4$`)

// slugPattern заменяет всё, кроме латиницы и цифр, дефисом, как /[^a-z0-9]+/g оригинала.
var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

// DefaultAnimaticName — имя MP4 аниматика из названия: латиница, цифры и дефисы; для названия
// без латиницы и цифр остаётся animatic.mp4. Нижний регистр повторяет String.toLowerCase.
func DefaultAnimaticName(name string) string {
	slug := strings.Trim(slugPattern.ReplaceAllString(jsLower(name), "-"), "-")
	if slug == "" {
		return "animatic.mp4"
	}
	return slug + "-animatic.mp4"
}

// jsLower — String.prototype.toLowerCase. Единственное отличие strings.ToLower в значимой для
// slug области — «İ» (U+0130): JS даёт «i» с комбинирующей точкой, то есть i и дефис в slug.
func jsLower(text string) string {
	return strings.ToLower(strings.ReplaceAll(text, "İ", "i̇"))
}

// Validate — validateNewProject: список проблем формы в порядке оригинала; пустой — можно создавать.
// Функция только читает файловую систему (существование цели и родителя).
func Validate(input Input) []string {
	problems := []string{}
	if jscompat.Trim(input.Name) == "" {
		problems = append(problems, nameRequired)
	}
	switch {
	case jscompat.Trim(input.Path) == "":
		problems = append(problems, pathRequired)
	case !jscompat.IsAbs(input.Path):
		problems = append(problems, absolutePathRequired)
	default:
		target := jscompat.Resolve("", input.Path)
		if jscompat.Exists(target) {
			problems = append(problems, targetExists)
		}
		parent := filepath.Dir(target)
		if info, err := os.Stat(parent); err != nil || !info.IsDir() {
			problems = append(problems, parentMissing(parent))
		}
	}
	if input.AnimaticVideo != nil {
		if video := jscompat.Trim(*input.AnimaticVideo); video != "" && !animaticPattern.MatchString(video) {
			problems = append(problems, invalidAnimaticName)
		}
	}
	return problems
}

// Create проверяет ввод, копирует шаблон в новую папку и, если в системе есть git, делает её
// репозиторием (git init -q). Возвращает абсолютный путь проекта; открывает его вызывающий.
//
// Ошибка проверки — проблемы формы через пробел, как Error(problems.join(' ')) оригинала;
// в этом случае ничего не создаётся. Отсутствие git не ошибка; другой сбой git init записывается
// в GIT-INIT-FAILED.txt внутри проекта и тоже не отменяет создание.
func Create(ctx context.Context, template fs.FS, input Input) (string, error) {
	if problems := Validate(input); len(problems) > 0 {
		return "", errors.New(strings.Join(problems, " "))
	}
	target := jscompat.Resolve("", input.Path)
	name := jscompat.Trim(input.Name)
	video := ""
	if input.AnimaticVideo != nil {
		video = jscompat.Trim(*input.AnimaticVideo)
	}
	if video == "" {
		video = DefaultAnimaticName(name)
	}
	if err := materialize(template, target, Placeholders{"project_name": name, "animatic_video": video}); err != nil {
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
	if jscompat.Exists(target) {
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

// initGit — spawnSync('git', ['init', '-q', target]) оригинала. Git необязателен: если программы нет,
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
	// Служебная заметка в папке проекта, как у оригинала; создание проекта при этом не отменяется.
	_ = os.WriteFile(filepath.Join(target, GitFailedFile), []byte("git init не удался: "+reason+"\n"), 0o666)
}

// Placeholders — значения {{ключ}} шаблона: project_name и animatic_video.
type Placeholders map[string]string

// placeholderPattern — {{ ключ }} с необязательными пробелами; ключ из строчной латиницы и «_».
var placeholderPattern = regexp.MustCompile(`\{\{\s*([a-z_]+)\s*\}\}`)

// textExtensions — файлы, в которых выполняется подстановка; имя без расширения (.gitignore)
// сравнивается целиком, как extname(name) || name в оригинале.
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

// isText повторяет выбор оригинала: расширение Node (extname) или всё имя для «.gitignore».
func isText(name string) bool {
	extension := jsExtname(name)
	if extension == "" {
		extension = name
	}
	return textExtensions[extension]
}

// jsExtname — path.extname для имени файла: точка в начале имени расширением не считается.
func jsExtname(name string) string {
	index := strings.LastIndex(name, ".")
	if index <= 0 {
		return ""
	}
	return name[index:]
}

// CopyTemplate рекурсивно копирует дерево шаблона в target (папка создаётся при необходимости):
// текстовые файлы проходят подстановку, остальные копируются байт в байт. Значения не экранируются
// для JSON, как в оригинале: название с кавычкой даёт нечитаемый plan/project.json.
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
			data = []byte(RenderPlaceholders(jscompat.DecodeUTF8(data), values))
		}
		// writeFileSync/copyFileSync оригинала создают файл 0666 с учётом umask.
		return os.WriteFile(destination, data, 0o666)
	})
}
