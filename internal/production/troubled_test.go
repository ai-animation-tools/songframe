package production

import "testing"

// TestTroubledState — план без комплекта: устаревший после правки постановки пакет даёт «попытка устарела»,
// любая другая проблема пакета — «проблема», даже рядом с устаревшим.
func TestTroubledState(t *testing.T) {
	outdated := &PackageView{Problems: []string{SceneChanged}}
	broken := &PackageView{Problems: []string{"workflow.json не читается."}}
	clean := &PackageView{Problems: []string{}}
	cases := []struct {
		name     string
		packages []*PackageView
		want     string
	}{
		{"без пакетов", nil, ""},
		{"без проблем", []*PackageView{clean}, ""},
		{"устарел", []*PackageView{clean, outdated}, StateOutdated},
		{"повреждён", []*PackageView{broken}, StateUnknown},
		{"устарел и повреждён", []*PackageView{outdated, broken}, StateUnknown},
	}
	for _, item := range cases {
		if got := troubledState(item.packages); got != item.want {
			t.Errorf("%s: %q, ожидалось %q", item.name, got, item.want)
		}
	}
}
