package speech

import (
	"os"
	"path/filepath"
	"testing"
)

// writeProject — проект с реестром одного плана и путём песни audio.
func writeProject(t *testing.T, audio string, withTrack bool) string {
	t.Helper()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	registry := `{"fps":24,"audio":{"path":"` + audio + `"},"scenes":[{"id":"M01","start_frame":24,"end_frame_exclusive":72}]}`
	if err := os.WriteFile(filepath.Join(project, "plan", "scenes.json"), []byte(registry), 0o644); err != nil {
		t.Fatal(err)
	}
	if withTrack {
		if err := os.MkdirAll(filepath.Join(project, "source"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(project, "source", "track.mp3"), []byte("mp3"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return project
}

// Речевой план называет песню реестра для прослушивания границ; отсутствующий файл и путь за
// пределы проекта дают null, остальные поля плана от этого не зависят.
func TestPlanForTrack(t *testing.T) {
	project := writeProject(t, "source/track.mp3", true)
	plan, err := PlanFor(project, "M01", Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Track == nil || *plan.Track != filepath.Join(project, "source", "track.mp3") {
		t.Fatalf("трек %v", plan.Track)
	}
	if plan.Window != (Interval{Start: 1, End: 3}) || plan.Proposed == nil || *plan.Proposed != (Interval{Start: 1, End: 3}) {
		t.Fatalf("окно %v, предложение %v", plan.Window, plan.Proposed)
	}
	for _, audio := range []string{"source/track.mp3", "../track.mp3", "/abs/track.mp3", ""} {
		withTrack := audio != "source/track.mp3"
		if plan, err := PlanFor(writeProject(t, audio, withTrack), "M01", Limits{}); err != nil || plan.Track != nil {
			t.Fatalf("%q: трек %v, ошибка %v", audio, plan.Track, err)
		}
	}
}
