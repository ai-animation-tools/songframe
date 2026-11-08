// Package resources встраивает в бинарник ресурсы, которые приложение читает во время работы.
// Сейчас это шаблон проекта (templates/project) и шрифты карточек аниматика (fonts): создание
// клипа и рендер карточек не зависят от соседнего репозитория, корня комплекса, каталога
// установки и системных шрифтов ОС. Владельцы и происхождение файлов описаны в README.md
// этого каталога.
package resources

import (
	"embed"
	"io/fs"
	"path"
)

// templates хранит шаблон вместе со служебными .gitignore и .gitkeep: префикс all: включает
// файлы, начинающиеся с точки, иначе пустые папки шаблона пропали бы из нового проекта.
//
//go:embed all:templates/project
var templates embed.FS

// ProjectTemplate возвращает дерево шаблона проекта с корнем в templates/project.
// Содержимое неизменяемо (embed); изменение контракта хранения вносится в шаблон вместе с кодом
// и эталонами.
func ProjectTemplate() fs.FS {
	tree, err := fs.Sub(templates, "templates/project")
	if err != nil {
		// Путь задан директивой embed выше: ошибка означает сломанную сборку, а не данные пользователя.
		panic(err)
	}
	return tree
}

// fonts хранит шрифты DejaVu Sans (обычный и полужирный) с лицензией fonts/LICENSE. Их рисует
// пакет internal/animaticcards: ширины строк и переносы карточек зависят от метрик именно этих
// файлов, поэтому системный шрифт не подставляется.
//
//go:embed fonts
var fonts embed.FS

// Имена встроенных шрифтов для Font.
const (
	FontDejaVuSans     = "DejaVuSans.ttf"
	FontDejaVuSansBold = "DejaVuSans-Bold.ttf"
)

// Font возвращает байты встроенного шрифта по имени файла в fonts/ (FontDejaVuSans,
// FontDejaVuSansBold). Срез общий для всех вызовов и не должен изменяться. Неизвестное имя —
// ошибка fs.ErrNotExist.
func Font(name string) ([]byte, error) {
	return fonts.ReadFile(path.Join("fonts", name))
}

// skills хранит промпты агента: тексты, которые приложение вкладывает в задания агента в режиме
// предложения. Владелец — этот каталог; правки промптов вносятся здесь вместе с эталонами
// промптов заданий.
//
//go:embed skills
var skills embed.FS

// Имена встроенных скиллов для Skill.
const (
	SkillScenario    = "ai-clip-scenario"
	SkillVideoReview = "ai-clip-video-review"
	SkillScene       = "ai-clip-scene"
)

// SkillFile возвращает файл встроенного скилла по пути от его папки (SKILL.md или
// references/<имя>.md) — для скиллов с дополнительными справками (ai-clip-scene). Нет файла —
// ошибка fs.ErrNotExist.
func SkillFile(name, file string) (string, error) {
	data, err := skills.ReadFile(path.Join("skills", name, file))
	return string(data), err
}

// Skill возвращает SKILL.md встроенного скилла по имени папки (SkillScenario). Промпт встроен в
// бинарник и не зависит от каталога установки. Неизвестное имя — ошибка fs.ErrNotExist.
func Skill(name string) (string, error) {
	data, err := skills.ReadFile(path.Join("skills", name, "SKILL.md"))
	return string(data), err
}

// providers хранит документы провайдеров медиа: один документ на вид медиа и провайдера,
// providers/<вид>/<id>.md. Их раздел «Указания агенту» слой провайдеров (internal/providers)
// вкладывает в промпт задания.
//
//go:embed providers
var providers embed.FS

// ProviderDoc возвращает документ провайдера id вида медиа kind (image, video). Документа нет —
// ошибка fs.ErrNotExist.
func ProviderDoc(kind, id string) ([]byte, error) {
	return providers.ReadFile(path.Join("providers", kind, id+".md"))
}
