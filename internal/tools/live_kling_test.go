package tools

import (
	"context"
	"os"
	"strings"
	"testing"

	"songframe/internal/mediaadapters"
)

// TestLiveKlingFree — ручная живая проверка цепочки media_request → таблица адаптеров → клиент
// Kling на сохранённом входе; по умолчанию пропускается. Только бесплатные действия: статус входа
// и, если задан проект, возможности моделей. Опоры не загружаются, генерация не создаётся.
//
//	SONGFRAME_KLING_LIVE_STATE=<профиль со входом> [SONGFRAME_KLING_LIVE_PROJECT=<клип>] \
//	go test -v -run TestLiveKlingFree ./internal/tools/
func TestLiveKlingFree(t *testing.T) {
	state := os.Getenv("SONGFRAME_KLING_LIVE_STATE")
	if state == "" {
		t.Skip("живая проверка: задайте SONGFRAME_KLING_LIVE_STATE")
	}
	previous := mediaadapters.StateDir
	mediaadapters.StateDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { mediaadapters.StateDir = previous })
	run := func(project string, args ...string) Result {
		t.Helper()
		result, err := RunContext(context.Background(), project, "media_request", args)
		if err != nil {
			t.Fatal(err)
		}
		if result.Code == nil || *result.Code != 0 {
			t.Fatalf("%s: код %v\n%s\n%s", strings.Join(args, " "), result.Code, result.Stdout, result.Stderr)
		}
		return result
	}
	status := run("", "auth-status", "--provider", "kling", "--json")
	t.Logf("auth-status: %s", status.Stdout)
	if !strings.Contains(status.Stdout, "authenticated") {
		t.Fatal("вход не подтверждён")
	}
	if project := os.Getenv("SONGFRAME_KLING_LIVE_PROJECT"); project != "" {
		report := run(project, "capabilities", "--provider", "kling", "--kind", "video", "--json")
		t.Logf("capabilities video: %d байт", len(report.Stdout))
		if !strings.Contains(report.Stdout, "image_to_video") {
			t.Fatal("в отчёте нет image_to_video")
		}
	}
}
