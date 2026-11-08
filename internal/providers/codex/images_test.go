package codex

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"songframe/internal/agents"
	"songframe/internal/mediaapi"
)

// TestCapabilities — возможности по диагностике программы и каталогу моделей.
func TestCapabilities(t *testing.T) {
	now := func() time.Time { return time.Date(2026, 11, 4, 1, 2, 3, 4_000_000, time.UTC) }
	check := func(result agents.CheckResult, err error) func(context.Context) (agents.CheckResult, error) {
		return func(context.Context) (agents.CheckResult, error) { return result, err }
	}
	models := func(list []mediaapi.Model, err error) func(context.Context) ([]mediaapi.Model, error) {
		return func(context.Context) ([]mediaapi.Model, error) { return list, err }
	}
	row := ModelsFromCatalog([]agents.CodexModel{{Model: "gpt-image"}})
	cases := []struct {
		name      string
		options   ImageOptions
		available bool
		models    int
		problems  string
	}{
		{"ok", ImageOptions{Check: check(agents.CheckResult{Availability: agents.Available, Authorization: agents.Authenticated, Message: "ok"}, nil), Models: models(row, nil)}, true, 1, ""},
		{"unknown-auth", ImageOptions{Check: check(agents.CheckResult{Availability: agents.Available, Authorization: agents.AuthUnknown, Message: "Вход не проверен."}, nil), Models: models(nil, nil)}, true, 0, "Вход не проверен.|" + textModelsEmpty},
		{"catalog-failed", ImageOptions{Check: check(agents.CheckResult{Availability: agents.Available, Authorization: agents.Authenticated}, nil), Models: models(nil, errors.New("сбой"))}, true, 0, textModelsUnavailable},
		{"unauthenticated", ImageOptions{Check: check(agents.CheckResult{Availability: agents.Available, Authorization: agents.Unauthenticated, Message: "Войдите."}, nil), Models: models(row, nil)}, false, 0, "Войдите."},
		{"check-error", ImageOptions{Check: check(agents.CheckResult{}, errors.New("не запустился"))}, false, 0, "не запустился"},
	}
	for _, item := range cases {
		item.options.Now = now
		caps := NewImageExecutor(item.options).Capabilities(context.Background(), "/клип")
		if caps.Provider != ID || caps.Kind != Kind || caps.Available != item.available || len(caps.Models) != item.models ||
			strings.Join(caps.Problems, "|") != item.problems || caps.CheckedAt != "2026-11-04T01:02:03.004Z" || caps.GenerationVerified {
			t.Errorf("%s: %+v", item.name, caps)
		}
	}
	if string(row[0].Arguments) != "{}" || row[0].Command != "codex_exec" {
		t.Fatalf("модель каталога %+v", row[0])
	}
}
