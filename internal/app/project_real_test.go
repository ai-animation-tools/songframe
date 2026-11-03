package app

import (
	"os"
	"testing"

	"songframe-go/internal/golden"
)

// TestProjectServiceOpenRealClips открывает настоящие клипы из SONGFRAME_GOLDEN_REAL (вне Git):
// статус совпадает с эталоном Electron, а дерево клипа до и после равно дайджесту manifest.
// Без переменной окружения тест пропускается.
func TestProjectServiceOpenRealClips(t *testing.T) {
	for _, real := range golden.RealProjects(t) {
		t.Run(real.Name, func(t *testing.T) {
			path := real.Project
			before, err := golden.TreeDigest(path)
			if err != nil {
				t.Fatal(err)
			}
			value, err := NewProjectService(&registrySpy{}, t.TempDir()).Open(path)
			if err != nil {
				t.Fatal(err)
			}
			want, _ := os.ReadFile(real.Dir + "/expected-status.json")
			golden.AssertValue(t, want, value, path)
			if after, _ := golden.TreeDigest(path); after != before || after != real.Manifest.TreeSHA256 {
				t.Fatal("дерево клипа изменилось")
			}
			t.Logf("%s: %s %d/%d", real.Name, value.State, value.Checks.ShotsDone, value.Checks.ShotsTotal)
		})
	}
}
