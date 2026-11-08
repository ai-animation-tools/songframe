package dynvalue

import (
	"math"
	"testing"
)

// TestNumberToString — раскладка кратчайшей записи: обычная и экспоненциальная, -0, особые значения.
func TestNumberToString(t *testing.T) {
	cases := map[float64]string{
		0: "0", math.Copysign(0, -1): "0", 1: "1", -1.5: "-1.5", 0.1: "0.1", 1e21: "1e+21", 1e20: "100000000000000000000",
		1.5e-7: "1.5e-7", 0.000001: "0.000001", 123456789.125: "123456789.125", 30.040816: "30.040816", 2e-7: "2e-7",
	}
	for value, want := range cases {
		if got := NumberToString(value); got != want {
			t.Errorf("%v: %q, ожидалось %q", value, got, want)
		}
	}
	if NumberToString(math.NaN()) != "NaN" || NumberToString(math.Inf(-1)) != "-Infinity" {
		t.Error("особые значения")
	}
}

// TestParseOrderAndStringify — порядок свойств, повтор ключа, переполнение числа и формы Stringify.
func TestParseOrderAndStringify(t *testing.T) {
	value, err := Parse([]byte(`{"b":1,"2":"x","a":[1,null,"<&>"],"1":true,"b":2,"e":1e400}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := Stringify(value); got != `{"1":true,"2":"x","b":2,"a":[1,null,"<&>"],"e":null}` {
		t.Fatalf("stringify: %s", got)
	}
	if _, err := Parse([]byte(`{"a":1} x`)); err == nil {
		t.Fatal("лишние данные приняты")
	}
	if _, err := Parse([]byte("\xef\xbb\xbf{}")); err == nil {
		t.Fatal("BOM принят, а разбор должен его отвергать")
	}
	if got := StringifyIndent(value, "  "); got != "{\n  \"1\": true,\n  \"2\": \"x\",\n  \"b\": 2,\n  \"a\": [\n    1,\n    null,\n    \"<&>\"\n  ],\n  \"e\": null\n}" {
		t.Fatalf("indent: %s", got)
	}
	if StringifyIndent(&Array{}, "  ") != "[]" || StringifyIndent(NewObject(), "  ") != "{}" {
		t.Fatal("пустые коллекции")
	}
}

// TestConversions — ToString, ToNumber, Trim, тексты TypeError и порядок LessUTF16.
func TestConversions(t *testing.T) {
	array := &Array{Items: []any{1.0, nil, "a", Undefined}}
	if ToString(array) != "1,,a," || ToString(NewObject()) != "[object Object]" || ToString(nil) != "null" {
		t.Fatal("ToString")
	}
	if ToNumber(" 12 ") != 12 || !math.IsNaN(ToNumber("inf")) || ToNumber("0x10") != 16 || ToNumber("") != 0 || ToNumber(&Array{Items: []any{5.0}}) != 5 {
		t.Fatal("ToNumber")
	}
	if Trim("\xef\xbb\xbf x ") != "x" || Trim("\u0085x") != "\u0085x" {
		t.Fatal("Trim")
	}
	if _, err := PathArg("path", Undefined); err == nil || err.Error() != `The "path" argument must be of type string. Received undefined` {
		t.Fatalf("PathArg: %v", err)
	}
	if _, err := PathArg("path", 5.0); err.Error() != `The "path" argument must be of type string. Received type number (5)` {
		t.Fatalf("PathArg: %v", err)
	}
	if _, err := Prop(nil, "id"); err.Error() != "Cannot read properties of null (reading 'id')" {
		t.Fatal("Prop")
	}
	if !LessUTF16("￿", "\U0001F600") == true {
		// U+1F600 кодируется суррогатами 0xD83D…: в UTF-16 он меньше U+FFFF.
	}
	if LessUTF16("￿", "\U0001F600") {
		t.Fatal("LessUTF16 сравнивает байты UTF-8")
	}
}
