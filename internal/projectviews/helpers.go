package projectviews

import (
	"strings"

	"songframe-go/internal/pycompat"
)

// Операции над значениями из JSON с семантикой Python: представления строятся из полей реестра и
// манифестов без предварительной проверки типов, поэтому неверные данные дают исключение Python
// (KeyError, TypeError, AttributeError): его текст входит в вывод, проверяемый эталонами scene-views.

// get — container[key].
func get(container any, key string) (any, error) { return pycompat.GetItem(container, key) }

// getPath — container[k1][k2]…: первая отсутствующая ступень даёт исключение.
func getPath(container any, keys ...string) (any, error) {
	current := container
	for _, key := range keys {
		value, err := pycompat.GetItem(current, key)
		if err != nil {
			return nil, err
		}
		current = value
	}
	return current, nil
}

// concat — левоассоциативное a + b + … строк: нестроковый операнд — TypeError конкатенации.
func concat(parts ...any) (string, error) {
	var result any = ""
	for _, part := range parts {
		value, err := pycompat.Add(result, part)
		if err != nil {
			return "", err
		}
		result = value
	}
	return result.(string), nil
}

// join — sep.join(items): нестроковый элемент — TypeError с номером элемента, как у str.join.
func join(separator string, items []any) (string, error) {
	parts := make([]string, len(items))
	for index, item := range items {
		text, ok := item.(string)
		if !ok {
			return "", pycompat.Raise(pycompat.TypeError, "sequence item %d: expected str instance, %s found", index, pycompat.TypeName(item))
		}
		parts[index] = text
	}
	return strings.Join(parts, separator), nil
}

// lower — str.lower() значения: у не-строки нет метода (AttributeError).
func lower(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'lower'", pycompat.TypeName(value))
	}
	return strings.ToLower(text), nil
}

// Cell — cell(text): значение строкой str(), последовательности пробельных символов Unicode
// (\s+ регулярного выражения Python) — один пробел, «|» экранирована, края без пробелов. Ячейка
// таблицы Markdown не разрывается текстом поля.
func Cell(value any) string {
	var builder strings.Builder
	space := false
	for _, r := range pycompat.Runes(pycompat.Str(value)) {
		if pycompat.IsSpace(r) {
			space = true
			continue
		}
		if space {
			builder.WriteByte(' ')
			space = false
		}
		builder.WriteString(pycompat.FromRunes([]rune{r}))
	}
	if space {
		builder.WriteByte(' ')
	}
	return pycompat.Strip(strings.ReplaceAll(builder.String(), "|", "\\|"))
}

// DerivedLabel — derived_label(scene, separator): пометка «из Mxx» у плана из материала другого
// плана; у обычного плана пусто.
func DerivedLabel(scene *pycompat.Dict, separator string) (string, error) {
	source := scene.Value("derived_from")
	if !pycompat.Truthy(source) {
		return "", nil
	}
	shot, err := get(source, "shot")
	if err != nil {
		return "", err
	}
	return separator + "из " + pycompat.Str(shot), nil
}

// dictGet — value.get(key, fallback) (AttributeError у не-словаря).
func dictGet(value any, key string, fallback any) (any, error) {
	return pycompat.DictGet(value, key, fallback)
}

// items — value.items() словаря: у не-словаря нет метода (AttributeError).
func items(value any) (*pycompat.Dict, error) {
	dict, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'items'", pycompat.TypeName(value))
	}
	return dict, nil
}

// rstripLines — "\n".join(line.rstrip() for line in text.splitlines()).rstrip() + "\n": обрезка
// пробелов в конце строк по всем разделителям строк Python и один перевод строки в конце.
func rstripLines(text string) string {
	lines := pycompat.SplitLines(text)
	for index, line := range lines {
		lines[index] = strings.TrimRightFunc(line, pycompat.IsSpace)
	}
	return strings.TrimRightFunc(strings.Join(lines, "\n"), pycompat.IsSpace) + "\n"
}
