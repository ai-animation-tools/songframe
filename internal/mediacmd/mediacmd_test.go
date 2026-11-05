package mediacmd

import (
	"context"
	"path/filepath"
	"testing"

	"songframe-go/internal/pycompat"
)

// TestTail — хвост считается в кодовых точках после замены неверного UTF-8.
func TestTail(t *testing.T) {
	if got := Tail([]byte("абв\xffгд"), 3); got != "�гд" {
		t.Fatalf("хвост %q", got)
	}
	if got := Tail([]byte("ab"), 10); got != "ab" {
		t.Fatalf("короткий хвост %q", got)
	}
}

// TestRunMissingProgram — незапустившаяся программа даёт FileNotFoundError subprocess, а
// AnimaticRun не превращает её в ValueError.
func TestRunMissingProgram(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "ffmpeg")
	_, err := AnimaticRun(context.Background(), missing, "-version")
	if !pycompat.Is(err, pycompat.FileNotFoundError) || err.Error() != "[Errno 2] No such file or directory: "+pycompat.Repr(missing) {
		t.Fatalf("ошибка %v", err)
	}
}

// TestProgramsFallback — пустые пути менеджера компонентов дают имена для поиска в PATH.
func TestProgramsFallback(t *testing.T) {
	saved := Programs
	t.Cleanup(func() { Programs = saved })
	Programs = func() (string, string) { return "", "/opt/ffprobe" }
	if FFmpeg() != "ffmpeg" || FFprobe() != "/opt/ffprobe" {
		t.Fatalf("программы %s %s", FFmpeg(), FFprobe())
	}
}
