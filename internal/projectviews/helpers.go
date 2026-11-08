package projectviews

import (
	"strings"

	"songframe/internal/toolrt"
)

// Операции над значениями toolrt из JSON: представления строятся из полей реестра и манифестов
// без предварительной проверки типов, поэтому неверные данные дают исключение toolrt (KeyError,
// TypeError, AttributeError): его текст входит в вывод, проверяемый эталонами scene-views.

// get — значение ключа (toolrt.GetItem): отсутствующий ключ — KeyError, не-контейнер — TypeError.
func get(container any, key string) (any, error) { return toolrt.GetItem(container, key) }

// getPath — значение по цепочке ключей: первая отсутствующая ступень даёт исключение.
func getPath(container any, keys ...string) (any, error) {
	current := container
	for _, key := range keys {
		value, err := toolrt.GetItem(current, key)
		if err != nil {
			return nil, err
		}
		current = value
	}
	return current, nil
}

// concat — сложение строк слева направо (toolrt.Add): нестроковый операнд — TypeError конкатенации.
func concat(parts ...any) (string, error) {
	var result any = ""
	for _, part := range parts {
		value, err := toolrt.Add(result, part)
		if err != nil {
			return "", err
		}
		result = value
	}
	return result.(string), nil
}

// join — строки items через separator: нестроковый элемент — TypeError с номером элемента.
func join(separator string, items []any) (string, error) {
	parts := make([]string, len(items))
	for index, item := range items {
		text, ok := item.(string)
		if !ok {
			return "", toolrt.Raise(toolrt.TypeError, "элемент %d: ожидается строка, получено: %s", index, toolrt.TypeName(item))
		}
		parts[index] = text
	}
	return strings.Join(parts, separator), nil
}

// lower — строка в нижнем регистре; не-строка — AttributeError «ожидается строка».
func lower(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.AttributeError, "ожидается строка, получено: %s", toolrt.TypeName(value))
	}
	return strings.ToLower(text), nil
}

// Cell — значение ячейкой таблицы Markdown: строковая запись toolrt.Str, каждая серия пробельных
// символов Unicode (toolrt.IsSpace) — один пробел, «|» экранирована, края без пробелов. Ячейка
// не разрывается текстом поля.
func Cell(value any) string {
	var builder strings.Builder
	space := false
	for _, r := range toolrt.Runes(toolrt.Str(value)) {
		if toolrt.IsSpace(r) {
			space = true
			continue
		}
		if space {
			builder.WriteByte(' ')
			space = false
		}
		builder.WriteString(toolrt.FromRunes([]rune{r}))
	}
	if space {
		builder.WriteByte(' ')
	}
	return toolrt.Strip(strings.ReplaceAll(builder.String(), "|", "\\|"))
}

// DerivedLabel — пометка «из Mxx» после separator у плана из материала другого плана; у
// обычного плана пусто.
func DerivedLabel(scene *toolrt.Dict, separator string) (string, error) {
	source := scene.Value("derived_from")
	if !toolrt.Truthy(source) {
		return "", nil
	}
	shot, err := get(source, "shot")
	if err != nil {
		return "", err
	}
	return separator + "из " + toolrt.Str(shot), nil
}

// dictGet — значение ключа словаря или fallback (toolrt.DictGet); не-словарь — AttributeError.
func dictGet(value any, key string, fallback any) (any, error) {
	return toolrt.DictGet(value, key, fallback)
}

// items — значение как словарь для обхода пар; не-словарь — AttributeError «ожидается объект».
func items(value any) (*toolrt.Dict, error) {
	dict, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(value))
	}
	return dict, nil
}

// rstripLines — текст без пробельных символов в конце каждой строки и в конце текста, строки
// разделены по всем разделителям строк Unicode (toolrt.SplitLines) и соединены «\n», в конце —
// один перевод строки.
func rstripLines(text string) string {
	lines := toolrt.SplitLines(text)
	for index, line := range lines {
		lines[index] = strings.TrimRightFunc(line, toolrt.IsSpace)
	}
	return strings.TrimRightFunc(strings.Join(lines, "\n"), toolrt.IsSpace) + "\n"
}
