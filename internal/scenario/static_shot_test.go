package scenario

import (
	"strings"
	"testing"

	"songframe/internal/dynvalue"
)

// TestStaticShotProblems — план из опор не сочетается с липсинком и производным планом;
// отсутствующее поле и false — обычный план.
func TestStaticShotProblems(t *testing.T) {
	scene := func(fields map[string]any) any {
		object := dynvalue.NewObject()
		for key, value := range fields {
			object.Set(key, value)
		}
		return object
	}
	cases := []struct {
		name   string
		fields map[string]any
		want   string
	}{
		{"нет поля", map[string]any{"lipsync": true}, ""},
		{"false", map[string]any{"static_shot": false, "lipsync": true}, ""},
		{"из опор", map[string]any{"static_shot": true, "lipsync": false}, ""},
		{"не логическое", map[string]any{"static_shot": "да"}, "true или false"},
		{"с липсинком", map[string]any{"static_shot": true, "lipsync": true}, "липсинком"},
		{"производный", map[string]any{"static_shot": true, "lipsync": false, "derived_from": scene(map[string]any{"shot": "M01"})}, "производный план"},
	}
	for _, c := range cases {
		problems := staticShotProblems("M02", scene(c.fields))
		got := strings.Join(problems, " ")
		if c.want == "" && len(problems) != 0 || c.want != "" && (len(problems) != 1 || !strings.Contains(got, c.want) || !strings.HasPrefix(got, "M02: ")) {
			t.Errorf("%s: %q", c.name, got)
		}
	}
}
