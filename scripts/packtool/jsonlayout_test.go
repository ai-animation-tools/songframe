package main

import "testing"

// Раскладка JSON квитанций и уведомлений закреплена побайтно: отступы, разделители,
// экранирование управляющих символов и не-ASCII, кратчайшая запись float и порядок ключей
// (исходный или по алфавиту).
func TestEncodeJSONLayout(t *testing.T) {
	source := "{\"b\":[],\"a\":{},\"ключ\":\"é\\u2028<>&\\u007f\\u0001\\b\\f\\n\\r\\t\\\"\\\\😀\",\"n\":[1,-0,1.5,100.0,1e16,1e-5,null,true,false],\"z\":{\"y\":[{\"x\":1}]}}"
	value, err := decodeOrdered([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name     string
		options  jsonOptions
		expected string
	}{
		{"отступ, исходный порядок", jsonOptions{indent: 2},
			"{\n  \"b\": [],\n  \"a\": {},\n  \"ключ\": \"é\u2028<>&\x7f\\u0001\\b\\f\\n\\r\\t\\\"\\\\😀\",\n  \"n\": [\n    1,\n    0,\n    1.5,\n    100.0,\n    1e+16,\n    1e-05,\n    null,\n    true,\n    false\n  ],\n  \"z\": {\n    \"y\": [\n      {\n        \"x\": 1\n      }\n    ]\n  }\n}"},
		{"отступ, ASCII, по алфавиту", jsonOptions{indent: 2, ensureASCII: true, sortKeys: true},
			"{\n  \"a\": {},\n  \"b\": [],\n  \"n\": [\n    1,\n    0,\n    1.5,\n    100.0,\n    1e+16,\n    1e-05,\n    null,\n    true,\n    false\n  ],\n  \"z\": {\n    \"y\": [\n      {\n        \"x\": 1\n      }\n    ]\n  },\n  \"\\u043a\\u043b\\u044e\\u0447\": \"\\u00e9\\u2028<>&\\u007f\\u0001\\b\\f\\n\\r\\t\\\"\\\\\\ud83d\\ude00\"\n}"},
		{"одна строка", jsonOptions{indent: -1},
			"{\"b\": [], \"a\": {}, \"ключ\": \"é\u2028<>&\x7f\\u0001\\b\\f\\n\\r\\t\\\"\\\\😀\", \"n\": [1, 0, 1.5, 100.0, 1e+16, 1e-05, null, true, false], \"z\": {\"y\": [{\"x\": 1}]}}"},
	} {
		if got := string(encodeJSON(value, tc.options)); got != tc.expected {
			t.Errorf("%s:\n%s\nожидалось:\n%s", tc.name, got, tc.expected)
		}
	}
}

// Повторный ключ заменяет значение на месте первого появления.
func TestDecodeOrderedDuplicateKey(t *testing.T) {
	value, err := decodeOrdered([]byte(`{"a":1,"b":2,"a":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(encodeJSON(value, jsonOptions{indent: -1})); got != `{"a": 3, "b": 2}` {
		t.Fatal(got)
	}
}
