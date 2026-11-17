package sources

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"songframe/internal/dynvalue"
)

// Подписи изображений референса — то, как изображение называет человек и агент. Карточка кастинга
// подписывает чипы изображений тем же правилом (castImageOptions в
// frontend/src/renderer/pages/CastPage/helpers.ts), а проверка сценария передаёт подпись агенту,
// чтобы отчёт называл изображение так же, как его видно на странице «Кастинг». При изменении
// правила правятся оба места.

// referenceViews — подписи видов (projectDataTexts.referenceViews в
// frontend/src/shared/texts/project-data.ts); совпадение проверяет тест пакета.
var referenceViews = map[string]string{
	"full":  "В полный рост",
	"face":  "Лицо",
	"front": "Спереди",
	"side":  "Сбоку",
	"back":  "Сзади",
	"top":   "Сверху",
	"other": "Другое",
}

// noteLabelMax — наибольшая длина начала заметки в подписи, в символах.
const noteLabelMax = 40

// NoteLabel — начало заметки для подписи: первая фраза, не длиннее noteLabelMax символов и обрезанная
// по слову. Заметки бывают абзацами, а подпись должна умещаться в чип.
func NoteLabel(note string) string {
	first := strings.TrimSpace(note)
	if index := strings.IndexAny(first, ".!?\n"); index >= 0 {
		first = strings.TrimSpace(first[:index])
	}
	if utf8.RuneCountInString(first) <= noteLabelMax {
		return first
	}
	cut := string([]rune(first)[:noteLabelMax])
	if space := strings.LastIndex(cut, " "); space > 0 {
		cut = cut[:space]
	}
	return strings.TrimSpace(strings.TrimRight(cut, ",;:—- "))
}

// FileLabels — подписи файлов одного референса в порядке files: одно изображение — имя; несколько —
// «имя — вид»; при совпадении вида — «имя — начало заметки»; оставшиеся совпадения получают номер
// файла в референсе. Путей в подписи нет: человек их не видит.
func FileLabels(name string, files []any) []string {
	labels := make([]string, len(files))
	if len(files) == 1 {
		labels[0] = name
		return labels
	}
	for index, file := range files {
		view := referenceViews[text(dynvalue.Get(file, "view"))]
		if view == "" {
			view = referenceViews["other"]
		}
		labels[index] = name + " — " + view
	}
	counts := countLabels(labels)
	for index, file := range files {
		if note := NoteLabel(text(dynvalue.Get(file, "note"))); counts[labels[index]] > 1 && note != "" {
			labels[index] = name + " — " + note
		}
	}
	counts = countLabels(labels)
	for index := range labels {
		if counts[labels[index]] > 1 {
			labels[index] = fmt.Sprintf("%s (%d)", labels[index], index+1)
		}
	}
	return labels
}

// FileInfo — подпись и заметка файла описи по пути внутри source/.
type FileInfo struct{ Label, Note string }

// ManifestFiles — подписи и заметки всех файлов референсов описи по пути. Опись nil даёт пустой
// словарь: изображения вне описи подписывают сами потребители.
func ManifestFiles(manifest any) map[string]FileInfo {
	result := map[string]FileInfo{}
	references, _ := dynvalue.AsArray(dynvalue.Get(manifest, "references"))
	for _, reference := range references {
		name := strings.TrimSpace(text(dynvalue.Get(reference, "name")))
		if name == "" {
			name = text(dynvalue.Get(reference, "id"))
		}
		files, _ := dynvalue.AsArray(dynvalue.Get(reference, "files"))
		for index, label := range FileLabels(name, files) {
			path := text(dynvalue.Get(files[index], "path"))
			result[path] = FileInfo{Label: label, Note: strings.TrimSpace(text(dynvalue.Get(files[index], "note")))}
		}
	}
	return result
}

// text — строковое значение поля или пустая строка: в описи необязательные поля бывают null.
func text(value any) string {
	if item, ok := value.(string); ok {
		return item
	}
	return ""
}

// countLabels — сколько раз встречается каждая подпись.
func countLabels(labels []string) map[string]int {
	counts := map[string]int{}
	for _, label := range labels {
		counts[label]++
	}
	return counts
}
