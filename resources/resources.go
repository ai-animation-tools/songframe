// Package resources встраивает в бинарник ресурсы, которые приложение читает во время работы.
// Сейчас это шаблон проекта (templates/project): создание клипа не зависит от соседнего
// репозитория, корня комплекса или каталога установки. Владельцы и происхождение файлов
// описаны в README.md этого каталога.
package resources

import (
	"embed"
	"io/fs"
)

// templates хранит шаблон вместе со служебными .gitignore и .gitkeep: префикс all: включает
// файлы, начинающиеся с точки, иначе пустые папки шаблона пропали бы из нового проекта.
//
//go:embed all:templates/project
var templates embed.FS

// ProjectTemplate возвращает дерево шаблона проекта с корнем в templates/project.
// Содержимое неизменяемо и совпадает с templates/project оригинала на 634fd94.
func ProjectTemplate() fs.FS {
	tree, err := fs.Sub(templates, "templates/project")
	if err != nil {
		// Путь задан директивой embed выше: ошибка означает сломанную сборку, а не данные пользователя.
		panic(err)
	}
	return tree
}
