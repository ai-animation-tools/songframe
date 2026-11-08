// Package builtoutput задаёт границы удаления готовых результатов: удалять можно только обычные
// папки и файлы непосредственно в plan/batches выбранного проекта.
// Каждый участок пути проверяется lstat: символическая ссылка на папку не должна выводить удаление
// к исходникам или в другой проект. Пакет только проверяет путь, ничего не удаляет.
//
// Потребители: удаление пакета для монтажёра (production.removeBundle) и проб стыков (checks.removeReview).
package builtoutput

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Kind — что ожидается по пути.
type Kind string

const (
	// Directory — папка plan/batches/<имя>.
	Directory Kind = "directory"
	// File — файл plan/batches/<имя>/<файл>.
	File Kind = "file"
)

// Тексты отказов удаления.
const (
	textAbsolutePathRequired = "Укажите абсолютный путь собранного результата."
	textOutsideBatches       = "Удалять можно только собранные результаты внутри plan/batches выбранного проекта."
	textMissingOrLink        = "Результат отсутствует или путь содержит символическую ссылку. Обновите список."
	textDirectoryMissing     = "Папка собранного результата отсутствует. Обновите список."
	textFileRequired         = "Собранный результат должен быть обычным файлом."
)

// Checked возвращает абсолютный нормализованный путь результата или понятную ошибку. Папка —
// ровно plan/batches/<имя>, файл — plan/batches/<имя>/<файл>.
func Checked(project, path string, kind Kind) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New(textAbsolutePathRequired)
	}
	root, err := filepath.Abs(project)
	if err != nil {
		return "", err
	}
	target := filepath.Clean(path)
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return "", errors.New(textOutsideBatches)
	}
	parts := strings.Split(relative, string(filepath.Separator))
	want := 3
	if kind == File {
		want = 4
	}
	if len(parts) != want || parts[0] != "plan" || parts[1] != "batches" {
		return "", errors.New(textOutsideBatches)
	}
	current := root
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New(textMissingOrLink)
		}
		if index < len(parts)-1 || kind == Directory {
			if !info.IsDir() {
				return "", errors.New(textDirectoryMissing)
			}
		} else if !info.Mode().IsRegular() {
			return "", errors.New(textFileRequired)
		}
	}
	return target, nil
}
