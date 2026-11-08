package golden

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/pycompat"
)

// Эталоны инструментов в семантике Python 3.12 (домены python-json, scene-registry,
// scene-scaffold): ожидаемые значения записаны строками json.dumps, а исключения — парой
// {type, message}. Такие файлы читаются разбором pycompat, а не encoding/json: он сохраняет
// различие int/float, порядок ключей и одиночные суррогаты (\uD800), которые есть во входах.

// PyFile читает JSON-файл домена (например, scene-registry/cases.json) моделью значений Python.
func PyFile(t testing.TB, domain, name string) any {
	t.Helper()
	return parsePy(t, filepath.Join(mustRoot(t), domain, name))
}

// PyRead читает JSON-файл случая (expected.json, case.json) моделью значений Python.
func (c Case) PyRead(t testing.TB, name string) *pycompat.Dict {
	t.Helper()
	value, ok := parsePy(t, filepath.Join(c.Dir, name)).(*pycompat.Dict)
	if !ok {
		t.Fatalf("случай %s/%s: %s не объект", c.Domain, c.Name, name)
	}
	return value
}

func parsePy(t testing.TB, path string) any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	value, err := pycompat.LoadsJSON(string(data))
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return value
}

// PyString — строковое поле эталона; отсутствие или другой тип — ошибка теста.
func PyString(t testing.TB, value any, key string) string {
	t.Helper()
	item, ok := value.(*pycompat.Dict).Value(key).(string)
	if !ok {
		t.Fatalf("поле %s эталона не строка: %s", key, pycompat.Repr(value.(*pycompat.Dict).Value(key)))
	}
	return item
}

// PyParse разбирает JSON-текст входа эталона (аргументы записаны строками json.dumps).
func PyParse(t testing.TB, text string) any {
	t.Helper()
	value, err := pycompat.LoadsJSON(text)
	if err != nil {
		t.Fatalf("вход эталона: %v", err)
	}
	return value
}

// PyDict — PyParse для входа-объекта; JSON null даёт nil (None).
func PyDict(t testing.TB, text string) *pycompat.Dict {
	t.Helper()
	value := PyParse(t, text)
	if value == nil {
		return nil
	}
	dict, ok := value.(*pycompat.Dict)
	if !ok {
		t.Fatalf("вход эталона не объект: %s", text)
	}
	return dict
}

// AssertOutcome сверяет исход вызова с эталоном {result: dumps} или {error: {type, message}}.
// Результат сериализуется как json.dumps(ensure_ascii=False) Python. root, если не пуст, заменяется
// маркером <project> в тексте результата и сообщения.
func AssertOutcome(t testing.TB, label string, want any, got any, err error, root string) {
	t.Helper()
	expected, ok := want.(*pycompat.Dict)
	if !ok {
		t.Fatalf("%s: эталон исхода не объект", label)
	}
	normalize := func(text string) string {
		if root == "" {
			return text
		}
		return strings.ReplaceAll(text, root, ProjectMarker)
	}
	if failure, ok := expected.Value("error").(*pycompat.Dict); ok {
		wantType, wantMessage := failure.Value("type").(string), failure.Value("message").(string)
		if err == nil {
			text, _ := pycompat.DumpsJSON(got, pycompat.DumpOptions{})
			t.Errorf("%s: ожидалось %s: %s, получено значение %s", label, wantType, wantMessage, text)
			return
		}
		gotType := "Go"
		if exception, ok := err.(*pycompat.Exception); ok {
			gotType = exception.Type
		}
		if gotType != wantType || normalize(err.Error()) != wantMessage {
			t.Errorf("%s: исключение\n  ожидалось %s: %s\n  получено  %s: %s", label, wantType, wantMessage, gotType, normalize(err.Error()))
		}
		return
	}
	wantResult := PyString(t, expected, "result")
	if err != nil {
		t.Errorf("%s: ожидалось %s, получено исключение %v", label, wantResult, err)
		return
	}
	text, dumpErr := pycompat.DumpsJSON(got, pycompat.DumpOptions{})
	if dumpErr != nil {
		t.Errorf("%s: сериализация результата: %v", label, dumpErr)
		return
	}
	if normalize(text) != wantResult {
		t.Errorf("%s:\n  ожидалось %s\n  получено  %s", label, wantResult, normalize(text))
	}
}
