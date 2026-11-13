package agents

import "testing"

// TestAccountVersionAtLeast закрепляет порог get_usage Claude (2.1.273): старшая версия
// сравнивается первой, поэтому 3.0.0 не считается ниже 2.1.x, а 2.0.300 — не выше 2.1.273.
func TestAccountVersionAtLeast(t *testing.T) {
	for _, item := range []struct {
		version string
		want    bool
	}{
		{"2.1.273", true},
		{"2.1.300", true},
		{"2.2.0", true},
		{"3.0.0", true},
		{"10.0.0", true},
		{"2.1.272", false},
		{"2.0.300", false},
		{"1.9.999", false},
		{"", false},
		{"2.1", false},
		{"v2.1.273", false},
	} {
		if got := versionAtLeast(item.version, 2, 1, 273); got != item.want {
			t.Errorf("versionAtLeast(%q, 2.1.273) = %v, ожидалось %v", item.version, got, item.want)
		}
	}
}
