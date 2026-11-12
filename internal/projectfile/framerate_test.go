package projectfile

import (
	"os"
	"path/filepath"
	"testing"
)

// TestFrameRate — частота кадров проекта: допустимые значения читаются, отсутствующая, дробная и
// неподдерживаемая — ошибка без догадки; ExpectedFPS без маркера берёт допустимую частоту документа.
func TestFrameRate(t *testing.T) {
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(text string) {
		if err := os.WriteFile(File(project), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got := ExpectedFPS(project, 25.0); got != 25 {
		t.Fatalf("без маркера %v", got)
	}
	if got := ExpectedFPS(project, 12.0); got != 0 {
		t.Fatalf("без маркера с неверной частотой %v", got)
	}
	for _, item := range []struct {
		text string
		want int
	}{{`{"fps": 24}`, 24}, {`{"fps": 25}`, 25}, {`{"fps": 30}`, 30}, {`{"fps": 30.5}`, 0}, {`{"fps": 60}`, 0}, {`{"name": "x"}`, 0}, {`{"fps": "30"}`, 0}} {
		write(item.text)
		got, err := FrameRate(project)
		if got != item.want || (item.want == 0) != (err != nil) {
			t.Fatalf("%s: %d %v", item.text, got, err)
		}
	}
	write(`{"fps": 24}`)
	if got := ExpectedFPS(project, 30.0); got != 24 {
		t.Fatalf("частота проекта важнее документа: %v", got)
	}
}
