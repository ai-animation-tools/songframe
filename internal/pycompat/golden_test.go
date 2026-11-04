package pycompat_test

import (
	"encoding/hex"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/pycompat"
)

// TestPythonJSONGolden сверяет модель Python с эталоном python-json/cases.json, снятым с
// CPython 3.12 оригинала: json.loads (значения и тексты JSONDecodeError), json.dumps в форматах
// инструментов, repr, bytes.decode("utf-8") и float(str).
func TestPythonJSONGolden(t *testing.T) {
	cases, ok := golden.PyFile(t, "python-json", "cases.json").([]any)
	if !ok || len(cases) == 0 {
		t.Fatal("python-json/cases.json: нет случаев")
	}
	for _, item := range cases {
		item := item.(*pycompat.Dict)
		name := golden.PyString(t, item, "name")
		input := golden.PyString(t, item, "input")
		expected := item.Value("expected").(*pycompat.Dict)
		t.Run(name, func(t *testing.T) {
			switch call := golden.PyString(t, item, "call"); call {
			case "loads":
				checkLoads(t, input, expected)
			case "decode":
				data, err := hex.DecodeString(input)
				if err != nil {
					t.Fatal(err)
				}
				text, err := pycompat.DecodeUTF8(data)
				checkText(t, expected, "text", text, err)
			case "float":
				value, err := pycompat.FloatFromString(input)
				checkText(t, expected, "repr", pycompat.FloatRepr(value), err)
			case "repr":
				value, err := pycompat.LoadsJSON(input)
				if err != nil {
					t.Fatal(err)
				}
				checkText(t, expected, "repr", pycompat.Repr(value), nil)
			default:
				t.Fatalf("неизвестный вызов %s", call)
			}
		})
	}
}

// checkText сверяет строковый результат key либо исключение {type, message}.
func checkText(t *testing.T, expected *pycompat.Dict, key, got string, err error) {
	t.Helper()
	if failure, ok := expected.Value("error").(*pycompat.Dict); ok {
		exception, isPython := err.(*pycompat.Exception)
		if !isPython || exception.Type != failure.Value("type") || exception.Message != failure.Value("message") {
			t.Fatalf("ожидалось %s: %s, получено %v (%q)", failure.Value("type"), failure.Value("message"), err, got)
		}
		return
	}
	if err != nil {
		t.Fatalf("ожидалось %q, получено исключение %v", expected.Value(key), err)
	}
	if want := golden.PyString(t, expected, key); got != want {
		t.Fatalf("ожидалось %q, получено %q", want, got)
	}
}

// checkLoads сверяет разбор и все форматы сериализации разобранного значения.
func checkLoads(t *testing.T, input string, expected *pycompat.Dict) {
	t.Helper()
	value, err := pycompat.LoadsJSON(input)
	if expected.Has("error") {
		checkText(t, expected, "", "", err)
		return
	}
	if err != nil {
		t.Fatalf("неожиданная ошибка разбора: %v", err)
	}
	formats := []struct {
		key     string
		options pycompat.DumpOptions
	}{
		{"indent", pycompat.Indented},
		{"compact", pycompat.DumpOptions{}},
		{"canonical", pycompat.DumpOptions{SortKeys: true, Compact: true}},
		{"ascii", pycompat.DumpOptions{EnsureASCII: true}},
	}
	for _, format := range formats {
		text, err := pycompat.DumpsJSON(value, format.options)
		if err != nil {
			t.Fatalf("%s: %v", format.key, err)
		}
		if want := golden.PyString(t, expected, format.key); text != want {
			t.Errorf("%s:\n  ожидалось %q\n  получено  %q", format.key, want, text)
		}
	}
	if want := golden.PyString(t, expected, "repr"); pycompat.Repr(value) != want {
		t.Errorf("repr:\n  ожидалось %q\n  получено  %q", want, pycompat.Repr(value))
	}
	_, err = pycompat.EncodeIndented(value)
	if expected.Value("encodable") == true {
		if err != nil {
			t.Errorf("запись: неожиданная ошибка %v", err)
		}
	} else if err == nil || err.Error() != expected.Value("encodeError") {
		t.Errorf("запись: ожидалось %v, получено %v", expected.Value("encodeError"), err)
	}
}
