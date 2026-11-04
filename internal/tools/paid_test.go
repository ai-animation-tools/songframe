package tools_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/mediatest"
	"songframe-go/internal/tools"
)

// TestPaidAttemptTools — media_request и cost_check подключены к реестру; вход к провайдеру
// (login, auth-status) выполняется без проекта, остальные действия без проекта — NO_PROJECT и код 2.
func TestPaidAttemptTools(t *testing.T) {
	if !tools.Available("media_request") || !tools.Available("cost_check") {
		t.Fatal("инструменты платной попытки не зарегистрированы")
	}
	result, err := tools.Run("", "media_request", []string{"login", "--provider", "nope"})
	if err != nil || result.Code == nil || *result.Code != 1 ||
		result.Stderr != "Для провайдера генерации 'nope' нет адаптера: укажите provider подключённого сервиса.\n" {
		t.Fatalf("login без проекта: %+v, %v", result, err)
	}
	for _, args := range [][]string{{"status", "--work-dir", "x"}, {"check", "--work-dir", "x"}} {
		name := "media_request"
		if args[0] == "check" {
			name = "cost_check"
		}
		result, err := tools.Run("", name, args)
		if err != nil || result.Code == nil || *result.Code != 2 {
			t.Fatalf("%s без проекта: %+v, %v", name, result, err)
		}
	}
}

// TestPaidAttemptStateDir — cost_check learn пишет наблюдение в каталог состояния Go-профиля
// (LocalDir), а не в SONGFRAME_LOCAL_DIR Electron; отменённый запуск возвращает Code nil.
func TestPaidAttemptStateDir(t *testing.T) {
	project := t.TempDir()
	work := filepath.Join(project, "plan", "batches", "M32-attempt-01", "request")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		filepath.Join(work, "request.json"):    `{"schema_version": 1, "kind": "video", "provider": "test", "model": "m", "parameters": {"duration": 5, "resolution": "1080p"}, "outputs": 1}`,
		filepath.Join(work, "attempt.json"):    `{"status": "downloaded", "credits_consumed": 40}`,
		filepath.Join(project, "pricing.json"): `{"schema_version": 1, "models": {}, "observed": []}`,
	}
	for path, text := range files {
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	service, err := mediatest.New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Register()()
	state := t.TempDir()
	saved := tools.LocalDir
	tools.LocalDir = func() (string, error) { return state, nil }
	defer func() { tools.LocalDir = saved }()
	result, err := tools.Run(project, "cost_check", []string{"learn", "--work-dir", work, "--pricing", filepath.Join(project, "pricing.json")})
	if err != nil || result.Code == nil || *result.Code != 0 {
		t.Fatalf("cost_check learn: %+v, %q, %v", result, result.Stderr, err)
	}
	if _, err := os.Stat(filepath.Join(state, "providers", "test", "pricing-observations.json")); err != nil {
		t.Fatalf("наблюдение не записано в каталог состояния: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err = tools.RunContext(ctx, project, "media_request", []string{"status", "--work-dir", work})
	if err != nil || result.Code != nil {
		t.Fatalf("отменённый запуск: %+v, %v", result, err)
	}
}
