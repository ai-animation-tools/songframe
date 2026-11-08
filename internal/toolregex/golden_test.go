package toolregex_test

import (
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolregex"
	"songframe/internal/toolrt"
)

// TestRegexGolden сверяет движок с эталоном cases.json на шаблонах инструментов проверок и схем
// проекта: границы совпадений в кодовых точках и значения групп для Search, MatchString, FullMatch
// и FindAll, с IgnoreCase и без.
func TestRegexGolden(t *testing.T) {
	cases := golden.ValueFile(t, "tool-regex", "cases.json").([]any)
	if len(cases) == 0 {
		t.Fatal("эталон регулярных выражений: нет случаев")
	}
	for _, item := range cases {
		c := item.(*toolrt.Dict)
		name, pattern, text := c.Value("name").(string), c.Value("pattern").(string), c.Value("text").(string)
		var flags toolregex.Flags
		if c.Value("ignoreCase") == true {
			flags = toolregex.IgnoreCase
		}
		regex := toolregex.MustCompile(pattern, flags)
		var found []toolregex.Match
		switch call := c.Value("call"); call {
		case "finditer":
			found = regex.FindAll(text)
		case "search", "match", "fullmatch":
			run := map[any]func(string) (toolregex.Match, bool){"search": regex.Search, "match": regex.MatchString, "fullmatch": regex.FullMatch}[call]
			if match, ok := run(text); ok {
				found = []toolregex.Match{match}
			}
		default:
			t.Fatalf("%s: неизвестный вызов %v", name, call)
		}
		got := []any{}
		for _, match := range found {
			got = append(got, []any{toolrt.NewInt(int64(match.Start())), toolrt.NewInt(int64(match.End())), match.Groups()})
		}
		want, err := toolrt.DumpsJSON(c.Value("expected"), toolrt.DumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		have, err := toolrt.DumpsJSON(got, toolrt.DumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if have != want {
			t.Errorf("%s: %q на %q\n--- ожидалось %s\n--- получено  %s", name, pattern, text, want, have)
		}
	}
}
