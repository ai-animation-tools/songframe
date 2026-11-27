package savedlooks

import (
	"slices"
	"testing"
)

func TestMarks(t *testing.T) {
	text := "The man [@hero] walks to the boy [@boy_1]; the man [@hero] stops. [@Герой] [@]"
	if got := Codes(text); !slices.Equal(got, []string{"hero", "boy_1", "Герой", ""}) {
		t.Fatalf("коды: %q", got)
	}
	for code, want := range map[string]bool{"hero": true, "boy_1": true, "Герой": false, "": false, "1boy": false} {
		if ValidCode(code) != want {
			t.Fatalf("ValidCode(%q) != %v", code, want)
		}
	}
	replaced := Replace("The man [@hero] and [@boy].", func(code string) string { return "<" + code + ">" })
	if replaced != "The man <hero> and <boy>." {
		t.Fatalf("замена: %q", replaced)
	}
}

func TestBroken(t *testing.T) {
	cases := map[string]string{
		"The man [@hero] stands.":               "",
		"Без меток [а] и @ отдельно.":           "",
		"The man [@hero ] stands.":              "[@hero ] stands.",
		"The man [ @hero] stands.":              "[ @hero] stands.",
		"The man [@hero stands.\nNext.":         "[@hero stands.",
		"Long [@hero_with_a_very_long_code ok]": "[@hero_with_a_very_long_",
	}
	for input, want := range cases {
		if got := Broken(input); got != want {
			t.Errorf("Broken(%q) = %q, нужно %q", input, got, want)
		}
	}
}

func TestStrip(t *testing.T) {
	cases := map[string]string{
		"The man [@hero] stands.":          "The man stands.",
		"The man [@hero], tired.":          "The man, tired.",
		"[@hero] walks.\n[@boy] runs.":     "walks.\nruns.",
		"Two [@a] [@b] heroes.":            "Two heroes.",
		"Line one.\nThe boy [@boy]\nNext.": "Line one.\nThe boy\nNext.",
	}
	for input, want := range cases {
		if got := Strip(input); got != want {
			t.Errorf("Strip(%q) = %q, нужно %q", input, got, want)
		}
	}
}
