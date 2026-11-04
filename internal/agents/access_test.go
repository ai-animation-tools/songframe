package agents

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"songframe-go/internal/mediaproviders"
)

// ai.access: явный выбор до диагностики, независимость агента и провайдеров медиа, повторная
// проверка выбора после асинхронной диагностики (сценарии ai-access.test.ts оригинала).

func accessFixture(t *testing.T, agent *Settings) (*AccessChecker, string, *int) {
	t.Helper()
	local := t.TempDir()
	if agent != nil {
		data, _ := json.Marshal(map[string]any{"agent": agent})
		writeTestFile(t, filepath.Join(local, SettingsFile), data)
	}
	calls := 0
	checker := &AccessChecker{
		Settings: NewSettingsStore(local),
		Check: func(_ context.Context, config Settings) (CheckResult, error) {
			calls++
			if config.Provider == Claude {
				return CheckResult{Availability: Available, Authorization: Unauthenticated, Message: "Войдите."}, nil
			}
			return CheckResult{Availability: Available, Authorization: Authenticated, Message: "ok " + config.Model}, nil
		},
	}
	return checker, local, &calls
}

func pointer(text string) *string { return &text }

func TestAccessSelection(t *testing.T) {
	checker, _, calls := accessFixture(t, nil)
	access, err := checker.GetAccess(t.Context(), nil, "")
	if err != nil || access.Agent.Selected || access.Agent.Message != textAgentRequired || access.Image.Message != textMediaImageRequired || access.Video.Message != textMediaVideoRequired || *calls != 0 {
		t.Fatalf("без выбора: %+v %v", access, err)
	}
	if ActionProblem(access, KindAgent) != textAgentRequired || checker.AssertSelection(nil, KindAgent) == nil {
		t.Fatal("агент не выбран")
	}

	restore := mediaproviders.Register("test", mediaproviders.Info{Title: "Тест", Kinds: []string{mediaproviders.Video}})
	defer restore()
	checker, _, calls = accessFixture(t, &Settings{Provider: Codex, Model: "m"})
	project := testProject(t, `{"generation":{"image":{"provider":"codex","provider_selected":true},"video":{"provider":"test","provider_selected":true}}}`)
	access, err = checker.GetAccess(t.Context(), &project, "")
	if err != nil || !access.Agent.Available || access.Agent.Message != "ok m" || !access.Image.Available || access.Image.Message != "ok " ||
		*access.Video.Provider != "test" || access.Video.Available || access.Video.Message != textProviderAuthUnported {
		t.Fatalf("выбор: %+v %v", access, err)
	}
	// Одинаковые конфигурации проверяются один раз, разные — отдельно.
	if *calls != 2 {
		t.Fatalf("проверок %d", *calls)
	}
	if ActionProblem(access, KindAgent) != "" || ActionProblem(access, KindImage) != "" || ActionProblem(access, KindVideo) != textProviderAuthUnported {
		t.Fatal("ActionProblem")
	}
	checker.ProviderAuth = func(context.Context, string) (ProviderAuth, error) { return ProviderAuth{Status: Authenticated}, nil }
	access, _ = checker.GetAccess(t.Context(), &project, KindVideo)
	if !access.Video.Available || access.Video.Message != textLoginConfirmed("Тест") || access.Agent.Message != textAgentUnchecked || access.Image.Message != textProviderUnchecked {
		t.Fatalf("только видео: %+v", access)
	}
	checker.ProviderAuth = func(context.Context, string) (ProviderAuth, error) {
		return ProviderAuth{}, errors.New("сбой входа")
	}
	if access, _ = checker.GetAccess(t.Context(), &project, KindVideo); access.Video.Message != "сбой входа" {
		t.Fatalf("ошибка входа: %+v", access.Video)
	}

	// Сохранённый provider без provider_selected — не выбор; неизвестный провайдер не проверяется.
	other := testProject(t, `{"generation":{"image":{"provider":"codex"},"video":{"provider":"unknown","provider_selected":true}}}`)
	access, _ = checker.GetAccess(t.Context(), &other, "")
	if access.Image.Selected || access.Video.Message != textProviderUnsupported || access.Video.Available {
		t.Fatalf("defaults: %+v", access)
	}
	if err := checker.RequireAccess(t.Context(), &other, KindImage); err == nil || err.Error() != textMediaImageRequired {
		t.Fatalf("RequireAccess image: %v", err)
	}
	missing := filepath.Join(t.TempDir(), "missing")
	access, err = checker.GetAccess(t.Context(), &missing, "")
	if err != nil || access.Agent.Selected || access.Agent.Message == "" || access.Agent.Message != access.Image.Message {
		t.Fatalf("ошибка чтения проекта: %+v %v", access, err)
	}
}

func TestRequireAccess(t *testing.T) {
	checker, local, _ := accessFixture(t, &Settings{Provider: Claude})
	project := testProject(t, `{}`)
	if err := checker.RequireAccess(t.Context(), &project, KindAgent); err == nil || err.Error() != "Войдите." {
		t.Fatalf("не вошёл: %v", err)
	}
	checker, local, _ = accessFixture(t, &Settings{Provider: Codex})
	if err := checker.RequireAccess(t.Context(), &project, KindAgent); err != nil {
		t.Fatal(err)
	}
	// Смена агента во время диагностики отменяет разрешение.
	check := checker.Check
	checker.Check = func(ctx context.Context, config Settings) (CheckResult, error) {
		if _, err := NewSettingsStore(local).SaveAgent(&Settings{Provider: Codex, Model: "other"}); err != nil {
			t.Fatal(err)
		}
		return check(ctx, config)
	}
	if err := checker.RequireAccess(t.Context(), &project, KindAgent); err == nil || err.Error() != textSettingsChanged {
		t.Fatalf("смена настроек: %v", err)
	}
	checker.Check = func(context.Context, Settings) (CheckResult, error) {
		if _, err := NewSettingsStore(local).SaveAgent(nil); err != nil {
			t.Fatal(err)
		}
		return CheckResult{Availability: Available, Authorization: Authenticated}, nil
	}
	if err := checker.RequireAccess(t.Context(), &project, KindAgent); err == nil || err.Error() != textAgentRequired {
		t.Fatalf("агент снят во время проверки: %v", err)
	}
	if ActionProblem(Access{Agent: ExecutorAccess{Provider: pointer(Codex), Selected: true}}, KindAgent) != textAvailableAgentRequired {
		t.Fatal("причина по умолчанию")
	}
	if ActionProblem(Access{}, KindVideo) != textAvailableVideoRequired || ActionProblem(Access{}, KindImage) != textAvailableImageRequired {
		t.Fatal("причина медиа по умолчанию")
	}
}
