package golden

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/toolrt"
)

// Эталоны инструментов на модели значений toolrt (эталон самой модели, scene-registry,
// scene-scaffold): ожидаемые значения записаны строками JSON в формате toolrt.DumpsJSON, а
// исключения — парой {type, message}. Такие файлы читаются разбором toolrt, а не encoding/json:
// он сохраняет различие целых и дробных, порядок ключей и одиночные суррогаты (\uD800), которые
// есть во входах.

// ValueFile читает JSON-файл домена (например, scene-registry/cases.json) моделью значений toolrt.
func ValueFile(t testing.TB, domain, name string) any {
	t.Helper()
	return parseValueFile(t, filepath.Join(mustRoot(t), domain, name))
}

// ReadValue читает JSON-файл случая (expected.json, case.json) моделью значений toolrt.
func (c Case) ReadValue(t testing.TB, name string) *toolrt.Dict {
	t.Helper()
	value, ok := parseValueFile(t, filepath.Join(c.Dir, name)).(*toolrt.Dict)
	if !ok {
		t.Fatalf("случай %s/%s: %s не объект", c.Domain, c.Name, name)
	}
	return value
}

// parseValueFile читает файл эталона и разбирает его toolrt.LoadsJSON; ошибка — сбой теста.
func parseValueFile(t testing.TB, path string) any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	value, err := toolrt.LoadsJSON(string(data))
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return value
}

// ValueString — строковое поле эталона; отсутствие или другой тип — ошибка теста.
func ValueString(t testing.TB, value any, key string) string {
	t.Helper()
	item, ok := value.(*toolrt.Dict).Value(key).(string)
	if !ok {
		t.Fatalf("поле %s эталона не строка: %s", key, toolrt.Repr(value.(*toolrt.Dict).Value(key)))
	}
	return item
}

// ParseValue разбирает JSON-текст входа эталона (аргументы записаны строками JSON).
func ParseValue(t testing.TB, text string) any {
	t.Helper()
	value, err := toolrt.LoadsJSON(text)
	if err != nil {
		t.Fatalf("вход эталона: %v", err)
	}
	return value
}

// ParseDict — ParseValue для входа-объекта; JSON null даёт nil.
func ParseDict(t testing.TB, text string) *toolrt.Dict {
	t.Helper()
	value := ParseValue(t, text)
	if value == nil {
		return nil
	}
	dict, ok := value.(*toolrt.Dict)
	if !ok {
		t.Fatalf("вход эталона не объект: %s", text)
	}
	return dict
}

// AssertOutcome сверяет исход вызова с эталоном {result: dumps} или {error: {type, message}}.
// Результат сериализуется toolrt.DumpsJSON с параметрами по умолчанию. root, если не пуст,
// заменяется маркером <project> в тексте результата и сообщения.
func AssertOutcome(t testing.TB, label string, want any, got any, err error, root string) {
	t.Helper()
	expected, ok := want.(*toolrt.Dict)
	if !ok {
		t.Fatalf("%s: эталон исхода не объект", label)
	}
	normalize := func(text string) string {
		if root == "" {
			return text
		}
		return strings.ReplaceAll(text, root, ProjectMarker)
	}
	if failure, ok := expected.Value("error").(*toolrt.Dict); ok {
		wantType, wantMessage := failure.Value("type").(string), failure.Value("message").(string)
		if err == nil {
			text, _ := toolrt.DumpsJSON(got, toolrt.DumpOptions{})
			t.Errorf("%s: ожидалось %s: %s, получено значение %s", label, wantType, wantMessage, text)
			return
		}
		gotType := "Go"
		if exception, ok := err.(*toolrt.Exception); ok {
			gotType = exception.Type
		}
		if gotType != wantType || normalize(err.Error()) != wantMessage {
			t.Errorf("%s: исключение\n  ожидалось %s: %s\n  получено  %s: %s", label, wantType, wantMessage, gotType, normalize(err.Error()))
		}
		return
	}
	wantResult := ValueString(t, expected, "result")
	if err != nil {
		t.Errorf("%s: ожидалось %s, получено исключение %v", label, wantResult, err)
		return
	}
	text, dumpErr := toolrt.DumpsJSON(got, toolrt.DumpOptions{})
	if dumpErr != nil {
		t.Errorf("%s: сериализация результата: %v", label, dumpErr)
		return
	}
	if normalize(text) != wantResult {
		t.Errorf("%s:\n  ожидалось %s\n  получено  %s", label, wantResult, normalize(text))
	}
}
