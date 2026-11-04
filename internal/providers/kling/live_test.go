package kling

import (
	"context"
	"fmt"
	"os"
	"testing"

	"songframe-go/internal/providers/kling/mcp"
)

// TestLiveFree — ручная живая проверка бесплатных операций против настоящего сервиса; по
// умолчанию пропускается. Запуск из отдельного профиля:
//
//	SONGFRAME_KLING_LIVE_STATE=<каталог профиля> go test -v -run TestLiveFree ./internal/providers/kling/
//
// Токены пишутся и читаются только в <каталог профиля>/providers/kling/credentials.json; файлы
// официальных программ не используются. Адрес сервиса — SONGFRAME_KLING_BASE_URL (по умолчанию
// https://kling.ai). Без сохранённого входа или с SONGFRAME_KLING_LIVE_LOGIN=1 сначала выполняется
// вход: адрес авторизации печатается в stderr, его открывает пользователь. Затем auth status,
// account и capabilities обоих видов — без загрузки опор и без генерации; Submit/Poll здесь не
// вызываются.
func TestLiveFree(t *testing.T) {
	state := os.Getenv("SONGFRAME_KLING_LIVE_STATE")
	if state == "" {
		t.Skip("живая проверка: задайте SONGFRAME_KLING_LIVE_STATE")
	}
	adapter := New(state)
	ctx := context.Background()
	if adapter.Client.ReadCredentials() == nil || os.Getenv("SONGFRAME_KLING_LIVE_LOGIN") == "1" {
		result := adapter.Login(ctx, mcp.LoginOptions{Report: func(line string) { fmt.Fprintln(os.Stderr, line) }})
		t.Logf("login: %s", dumps(t, result))
		if result.Value("ok") != true {
			t.Fatal("вход не выполнен")
		}
	}
	status := adapter.AuthStatus(ctx, mcp.CallTimeout)
	t.Logf("auth_status: %s", dumps(t, status))
	if status.Value("status") != "authenticated" {
		t.Fatal("вход не подтверждён")
	}
	account, err := adapter.Account(ctx, mcp.CallTimeout)
	if err != nil {
		t.Fatalf("account: %v", err)
	}
	t.Logf("account: %s", dumps(t, account))
	for _, kind := range []string{"image", "video"} {
		report, err := adapter.Capabilities(ctx, kind, mcp.CallTimeout)
		if err != nil {
			t.Fatalf("capabilities %s: %v", kind, err)
		}
		t.Logf("capabilities %s: %s", kind, dumps(t, report))
	}
}
