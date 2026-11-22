package buildreview

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/filedigest"
	"songframe/internal/golden"
	"songframe/internal/shoteffects"
	"songframe/internal/toolrt"
)

// TestEffectShot — проба стыка берёт план со свежим эффектом роликом эффекта, а устаревший
// эффект — принятым видео комплекта.
func TestEffectShot(t *testing.T) {
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skipf("нет %s в PATH", name)
		}
	}
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(root, os.DirFS(filepath.Join(base, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	// Ролик эффекта — копия принятого видео под своим именем: проба читает его как обычное видео.
	clean := filepath.Join(root, "assets", "shots", "M01", "video.mp4")
	digest, _ := filedigest.File(clean)
	data, err := os.ReadFile(clean)
	if err != nil {
		t.Fatal(err)
	}
	steps, err := shoteffects.Apply(root, "M01", []shoteffects.Step{{Effect: "grain"}})
	if err != nil {
		t.Fatal(err)
	}
	output := "assets/effects/M01/video-" + digest[:12] + ".mp4"
	recipe := shoteffects.Recipe{
		SchemaVersion: shoteffects.SchemaVersion, Shot: "M01",
		Source: shoteffects.File{Path: "assets/shots/M01/video.mp4", SHA256: digest},
		Steps:  steps, FPS: 30, Frames: 240, FFmpeg: "test",
		Output: shoteffects.File{Path: output, SHA256: digest},
	}
	encoded, _ := json.Marshal(recipe)
	if err := os.MkdirAll(filepath.Join(root, "assets", "effects", "M01"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(output)), data, 0o644); err != nil {
		t.Fatal(err)
	}
	recipePath := filepath.Join(root, "assets", "effects", "M01", "recipe.json")
	if err := os.WriteFile(recipePath, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	input := func() string {
		t.Helper()
		spec, err := toolrt.LoadsJSON(`{"schema_version": 1, "shots": [{"scene": "M01"}]}`)
		if err != nil {
			t.Fatal(err)
		}
		prepared, err := Prepare(context.Background(), spec, root)
		if err != nil {
			t.Fatal(err)
		}
		text, err := toolrt.DumpsJSON(prepared, toolrt.DumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		return text
	}
	if text := input(); !strings.Contains(text, "assets/effects/M01/video-") {
		t.Fatalf("проба без ролика эффекта: %s", text)
	}
	// Эффект устарел (другая версия параметров) — проба берёт принятое видео.
	recipe.Steps[0].Params["amount"] = 0.1
	encoded, _ = json.Marshal(recipe)
	if err := os.WriteFile(recipePath, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	if text := input(); strings.Contains(text, "assets/effects") || !strings.Contains(text, "assets/shots/M01/video.mp4") {
		t.Fatalf("проба с устаревшим эффектом: %s", text)
	}
}
