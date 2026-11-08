package agents

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/golden"
)

// TestPaidAccessGolden сверяет платную часть ai.access (выбор provider_selected, вход платного
// провайдера, тексты подтверждения и запрета) с createAiAccess оригинала
// (testdata/golden/ai-access-paid, test-projects/golden/capture/45d/capture-ai-access-paid.ts).
func TestPaidAccessGolden(t *testing.T) {
	var cases []struct {
		Name         string                     `json:"name"`
		Generation   json.RawMessage            `json:"generation"`
		Auth         map[string]json.RawMessage `json:"auth"`
		RequiredKind string                     `json:"requiredKind"`
		Require      string                     `json:"require"`
		Access       *Access                    `json:"access"`
		Required     bool                       `json:"required"`
		Error        string                     `json:"error"`
		AuthCalls    []string                   `json:"authCalls"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "ai-access-paid", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			var answer struct {
				Status     string  `json:"status"`
				Message    string  `json:"message"`
				Throws     *string `json:"throws"`
				ThrowsText *string `json:"throwsValue"`
			}
			if raw, ok := item.Auth["kling"]; ok {
				if err := json.Unmarshal(raw, &answer); err != nil {
					t.Fatal(err)
				}
			}
			if answer.ThrowsText != nil {
				t.Skip("исключение не-Error оригинала Go выразить не может")
			}
			project := t.TempDir()
			data, _ := json.Marshal(map[string]any{"name": "Клип", "generation": item.Generation})
			if err := os.MkdirAll(filepath.Join(project, "plan"), 0o777); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(project, "plan", "project.json"), data, 0o666); err != nil {
				t.Fatal(err)
			}
			calls := []string{}
			checker := &AccessChecker{
				Settings: NewSettingsStore(t.TempDir()),
				ProviderAuth: func(_ context.Context, provider string) (ProviderAuth, error) {
					calls = append(calls, provider)
					if answer.Throws != nil {
						return ProviderAuth{}, errors.New(*answer.Throws)
					}
					return ProviderAuth{Status: answer.Status, Message: answer.Message}, nil
				},
			}
			if item.Require != "" {
				err := checker.RequireAccess(context.Background(), &project, item.Require)
				if (err == nil) != item.Required || (err != nil && err.Error() != item.Error) {
					t.Fatalf("RequireAccess %v, ожидалось %q", err, item.Error)
				}
			} else {
				access, err := checker.GetAccess(context.Background(), &project, item.RequiredKind)
				if err != nil {
					t.Fatal(err)
				}
				got, _ := json.Marshal(access)
				want, _ := json.Marshal(item.Access)
				if string(got) != string(want) {
					t.Fatalf("доступ\n%s\nожидался\n%s", got, want)
				}
			}
			if len(calls) != len(item.AuthCalls) {
				t.Fatalf("проверок входа %v, ожидались %v", calls, item.AuthCalls)
			}
		})
	}
}
