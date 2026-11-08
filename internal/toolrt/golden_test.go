package toolrt_test

import (
	"encoding/hex"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolrt"
)

// TestJSONGolden сверяет модель значений с эталоном cases.json: разбор JSON (значения и тексты
// JSONDecodeError), запись JSON в форматах инструментов, repr, строгое декодирование UTF-8 и
// разбор дробного числа из строки.
func TestJSONGolden(t *testing.T) {
	cases, ok := golden.ValueFile(t, "tool-json", "cases.json").([]any)
	if !ok || len(cases) == 0 {
		t.Fatal("эталон JSON: нет случаев")
	}
	for _, item := range cases {
		item := item.(*toolrt.Dict)
		name := golden.ValueString(t, item, "name")
		input := golden.ValueString(t, item, "input")
		expected := item.Value("expected").(*toolrt.Dict)
		t.Run(name, func(t *testing.T) {
			switch call := golden.ValueString(t, item, "call"); call {
			case "loads":
				checkLoads(t, input, expected)
			case "decode":
				data, err := hex.DecodeString(input)
				if err != nil {
					t.Fatal(err)
				}
				text, err := toolrt.DecodeUTF8(data)
				checkText(t, expected, "text", text, err)
			case "float":
				value, err := toolrt.FloatFromString(input)
				checkText(t, expected, "repr", toolrt.FloatRepr(value), err)
			case "repr":
				value, err := toolrt.LoadsJSON(input)
				if err != nil {
					t.Fatal(err)
				}
				checkText(t, expected, "repr", toolrt.Repr(value), nil)
			default:
				t.Fatalf("неизвестный вызов %s", call)
			}
		})
	}
}

// checkText сверяет строковый результат key либо исключение {type, message}.
func checkText(t *testing.T, expected *toolrt.Dict, key, got string, err error) {
	t.Helper()
	if failure, ok := expected.Value("error").(*toolrt.Dict); ok {
		exception, isException := err.(*toolrt.Exception)
		if !isException || exception.Type != failure.Value("type") || exception.Message != failure.Value("message") {
			t.Fatalf("ожидалось %s: %s, получено %v (%q)", failure.Value("type"), failure.Value("message"), err, got)
		}
		return
	}
	if err != nil {
		t.Fatalf("ожидалось %q, получено исключение %v", expected.Value(key), err)
	}
	if want := golden.ValueString(t, expected, key); got != want {
		t.Fatalf("ожидалось %q, получено %q", want, got)
	}
}

// checkLoads сверяет разбор и все форматы сериализации разобранного значения.
func checkLoads(t *testing.T, input string, expected *toolrt.Dict) {
	t.Helper()
	value, err := toolrt.LoadsJSON(input)
	if expected.Has("error") {
		checkText(t, expected, "", "", err)
		return
	}
	if err != nil {
		t.Fatalf("неожиданная ошибка разбора: %v", err)
	}
	formats := []struct {
		key     string
		options toolrt.DumpOptions
	}{
		{"indent", toolrt.Indented},
		{"compact", toolrt.DumpOptions{}},
		{"canonical", toolrt.DumpOptions{SortKeys: true, Compact: true}},
		{"ascii", toolrt.DumpOptions{EnsureASCII: true}},
	}
	for _, format := range formats {
		text, err := toolrt.DumpsJSON(value, format.options)
		if err != nil {
			t.Fatalf("%s: %v", format.key, err)
		}
		if want := golden.ValueString(t, expected, format.key); text != want {
			t.Errorf("%s:\n  ожидалось %q\n  получено  %q", format.key, want, text)
		}
	}
	if want := golden.ValueString(t, expected, "repr"); toolrt.Repr(value) != want {
		t.Errorf("repr:\n  ожидалось %q\n  получено  %q", want, toolrt.Repr(value))
	}
	_, err = toolrt.EncodeIndented(value)
	if expected.Value("encodable") == true {
		if err != nil {
			t.Errorf("запись: неожиданная ошибка %v", err)
		}
	} else if err == nil || err.Error() != expected.Value("encodeError") {
		t.Errorf("запись: ожидалось %v, получено %v", expected.Value("encodeError"), err)
	}
}
