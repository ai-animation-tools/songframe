package pyre_test

import (
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
)

// TestPythonReGolden сверяет движок с модулем re CPython 3.12 на шаблонах инструментов проверок и
// схем проекта (эталон python-re/cases.json): границы совпадений в кодовых точках и значения групп
// для search, match, fullmatch и finditer, с re.I и без.
func TestPythonReGolden(t *testing.T) {
	cases := golden.PyFile(t, "python-re", "cases.json").([]any)
	if len(cases) == 0 {
		t.Fatal("нет случаев python-re")
	}
	for _, item := range cases {
		c := item.(*pycompat.Dict)
		name, pattern, text := c.Value("name").(string), c.Value("pattern").(string), c.Value("text").(string)
		var flags pyre.Flags
		if c.Value("ignoreCase") == true {
			flags = pyre.IgnoreCase
		}
		regex := pyre.MustCompile(pattern, flags)
		var found []pyre.Match
		switch call := c.Value("call"); call {
		case "finditer":
			found = regex.FindAll(text)
		case "search", "match", "fullmatch":
			run := map[any]func(string) (pyre.Match, bool){"search": regex.Search, "match": regex.MatchString, "fullmatch": regex.FullMatch}[call]
			if match, ok := run(text); ok {
				found = []pyre.Match{match}
			}
		default:
			t.Fatalf("%s: неизвестный вызов %v", name, call)
		}
		got := []any{}
		for _, match := range found {
			got = append(got, []any{pycompat.NewInt(int64(match.Start())), pycompat.NewInt(int64(match.End())), match.Groups()})
		}
		want, err := pycompat.DumpsJSON(c.Value("expected"), pycompat.DumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		have, err := pycompat.DumpsJSON(got, pycompat.DumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if have != want {
			t.Errorf("%s: %q на %q\n--- ожидалось %s\n--- получено  %s", name, pattern, text, want, have)
		}
	}
}
