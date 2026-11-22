package buildanimatic_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/animatic"
	"songframe/internal/buildanimatic"
	"songframe/internal/golden"
	"songframe/internal/sceneviews"
	"songframe/internal/shoteffects"
)

// baseProject — копия входного клипа эталона сборки аниматика (внешний тестовый пакет: animatic
// импортирует buildanimatic через реестр инструментов).
func baseProject(t *testing.T) string {
	t.Helper()
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skipf("нет %s в PATH", name)
		}
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(project, os.DirFS(filepath.Join(root, "build-animatic", "base"))); err != nil {
		t.Fatal(err)
	}
	return project
}

// TestShotEffect — свежий эффект плана входит в аниматик вместо принятого видео: появление эффекта
// делает прежнюю сборку устаревшей, новая сборка берёт ролик с эффектом и снова свежа; снятый
// эффект возвращает принятое видео.
func TestShotEffect(t *testing.T) {
	project := baseProject(t)
	ctx := context.Background()
	build := func() {
		t.Helper()
		if output := buildanimatic.Run(ctx, project, nil); output.Code != 0 {
			t.Fatalf("сборка: %s %s", output.Stdout, output.Stderr)
		}
		// Ссылку на текущую сборку ставит сервис страницы «Аниматик» после задания.
		path := filepath.Join(project, "plan", "production-status.json")
		var status map[string]any
		data, err := os.ReadFile(path)
		if err == nil {
			err = json.Unmarshal(data, &status)
		}
		if err != nil {
			t.Fatal(err)
		}
		status["current_animatic"] = "plan/animatic/latest/manifest.json"
		status["current_animatic_status"] = "review"
		if data, err = json.MarshalIndent(status, "", "  "); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fresh := func(want bool) {
		t.Helper()
		state, err := animatic.Inspect(project)
		if err != nil {
			t.Fatal(err)
		}
		if state.Fresh != want {
			t.Fatalf("свежесть %v, ждали %v: %v", state.Fresh, want, state.Problems)
		}
		// ROADMAP.md судит о свежести так же, как страница «Аниматик».
		if output := sceneviews.Run(project, nil); output.Code != 0 {
			t.Fatalf("представления: %s %s", output.Stdout, output.Stderr)
		}
		roadmap, err := os.ReadFile(filepath.Join(project, "ROADMAP.md"))
		if err != nil {
			t.Fatal(err)
		}
		if stale := strings.Contains(string(roadmap), "Сборка устарела относительно исходников"); stale == want {
			t.Fatalf("ROADMAP.md: устаревшая сборка %v, ждали свежесть %v", stale, want)
		}
	}
	shotPath := func() string {
		t.Helper()
		var manifest struct {
			Shots []struct {
				ID   string `json:"id"`
				Path string `json:"path"`
			} `json:"shots"`
		}
		data, err := os.ReadFile(filepath.Join(project, "plan", "animatic", "latest", "manifest.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			t.Fatal(err)
		}
		for _, shot := range manifest.Shots {
			if shot.ID == "M01" {
				return shot.Path
			}
		}
		t.Fatal("нет M01 в сборке")
		return ""
	}
	build()
	fresh(true)
	if path := shotPath(); path != "assets/shots/M01/accepted-edit.mp4" {
		t.Fatalf("без эффекта: %s", path)
	}
	if _, err := shoteffects.Render(ctx, project, "M01", []shoteffects.Step{{Effect: "grain"}}, nil); err != nil {
		t.Fatal(err)
	}
	fresh(false)
	build()
	fresh(true)
	if path := shotPath(); !strings.HasPrefix(path, "assets/effects/M01/video-") {
		t.Fatalf("с эффектом: %s", path)
	}
	if err := shoteffects.Remove(project, "M01"); err != nil {
		t.Fatal(err)
	}
	fresh(false)
}
