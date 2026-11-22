package exportbundle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/filedigest"
	"songframe/internal/shoteffects"
)

// fakeEffect — свежий эффект «зерно» плана shot без рендера: ролик — произвольные байты, рецепт
// совпадает с комплектом, поэтому shoteffects.MontageVideo выбирает его.
func fakeEffect(t *testing.T, root, shot string) string {
	t.Helper()
	var kit struct {
		AcceptedEdit struct {
			Video struct {
				Path   string `json:"path"`
				SHA256 string `json:"sha256"`
			} `json:"video"`
			FPS    int64 `json:"fps"`
			Frames int   `json:"frames"`
		} `json:"accepted_edit"`
	}
	data, err := os.ReadFile(filepath.Join(root, "assets", "shots", shot, "manifest.json"))
	if err == nil {
		err = json.Unmarshal(data, &kit)
	}
	if err != nil {
		t.Fatal(err)
	}
	steps, err := shoteffects.Apply(root, shot, []shoteffects.Step{{Effect: "grain"}})
	if err != nil {
		t.Fatal(err)
	}
	video := []byte("ролик с эффектом " + shot)
	sum := sha256.Sum256(video)
	digest := hex.EncodeToString(sum[:])
	output := "assets/effects/" + shot + "/video-" + digest[:12] + ".mp4"
	recipe := shoteffects.Recipe{
		SchemaVersion: shoteffects.SchemaVersion, Shot: shot,
		Source: shoteffects.File{Path: "assets/shots/" + shot + "/" + kit.AcceptedEdit.Video.Path, SHA256: kit.AcceptedEdit.Video.SHA256},
		Steps:  steps, FPS: kit.AcceptedEdit.FPS, Frames: kit.AcceptedEdit.Frames, FFmpeg: "test",
		Output: shoteffects.File{Path: output, SHA256: digest},
	}
	if data, err = json.Marshal(recipe); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "assets", "effects", shot), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(output)), video, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "effects", shot, "recipe.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if selected, err := shoteffects.MontageVideo(root, shot); err != nil || !selected.Effect {
		t.Fatalf("эффект не свеж: %+v, %v", selected, err)
	}
	return output
}

// TestEffectShot — план со свежим эффектом идёт в пакет роликом с эффектом (и копией с тем же
// SHA-256), README объясняет признак effect; без эффекта строка прежняя.
func TestEffectShot(t *testing.T) {
	project := filepath.Join(t.TempDir(), "project")
	copyProject(t, project)
	output := fakeEffect(t, project, "M01")
	out := filepath.Join(t.TempDir(), "out")
	if result := Run(context.Background(), project, []string{"--out", out, "--copy"}); result.Code != 0 {
		t.Fatalf("сборка пакета: %s %s", result.Stdout, result.Stderr)
	}
	var bundle struct {
		Shots []map[string]any `json:"shots"`
	}
	data, err := os.ReadFile(filepath.Join(out, "bundle.json"))
	if err == nil {
		err = json.Unmarshal(data, &bundle)
	}
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, row := range bundle.Shots {
		switch row["shot"] {
		case "M01":
			seen++
			clip, _ := row["accepted_clip"].(string)
			if row["effect"] != true || !strings.HasSuffix(clip, filepath.Base(output)) {
				t.Fatalf("M01: %v", row)
			}
			if digest, _ := filedigest.File(filepath.Join(out, filepath.FromSlash(clip))); digest != row["accepted_sha256"] {
				t.Fatalf("копия ролика с эффектом: %s, в таблице %v", digest, row["accepted_sha256"])
			}
		case "M02":
			seen++
			if _, marked := row["effect"]; marked || strings.Contains(row["accepted_clip"].(string), "effects") {
				t.Fatalf("M02 без эффекта: %v", row)
			}
		}
	}
	if seen != 2 {
		t.Fatalf("планы пакета: %v", bundle.Shots)
	}
	readme, err := os.ReadFile(filepath.Join(out, "README.md"))
	if err != nil || !strings.Contains(string(readme), "`effect: true`") {
		t.Fatalf("README без пояснения эффекта: %v", err)
	}
}
