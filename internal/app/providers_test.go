package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
)

// balanceFake — платный адаптер провайдера test: отдаёт заданный остаток или ошибку без обращения к сети.
type balanceFake struct {
	account mediaapi.Account
	err     error
}

func (balanceFake) RequestRules() mediaapi.RequestRules { return mediaapi.RequestRules{} }

func (f balanceFake) Account(context.Context, time.Duration) (mediaapi.Account, error) {
	return f.account, f.err
}

// rulesOnly — платный адаптер без AccountReader: остаток недоступен, но ошибки нет.
type rulesOnly struct{}

func (rulesOnly) RequestRules() mediaapi.RequestRules { return mediaapi.RequestRules{} }

// TestProviderBalance различает остаток, недоступный остаток (nil без ошибки) и неплатного провайдера.
func TestProviderBalance(t *testing.T) {
	service := NewEnvironmentService(nil)
	credits := 42.5
	t.Cleanup(mediaadapters.Register("test", balanceFake{account: mediaapi.Account{Balance: &credits, Source: "balance"}}))
	balance, err := service.ProviderBalance(context.Background(), " TEST ")
	if err != nil || balance == nil || balance.Credits != 42.5 || balance.CheckedAt == "" {
		t.Fatalf("остаток %+v, ошибка %v", balance, err)
	}
	t.Cleanup(mediaadapters.Register("test", balanceFake{account: mediaapi.Account{Source: "нет входа"}}))
	if balance, err := service.ProviderBalance(context.Background(), "test"); balance != nil || err != nil {
		t.Fatalf("неизвестный остаток: %+v, %v", balance, err)
	}
	t.Cleanup(mediaadapters.Register("test", balanceFake{err: errors.New("сеть")}))
	if balance, err := service.ProviderBalance(context.Background(), "test"); balance != nil || err != nil {
		t.Fatalf("ошибка сервиса не должна доходить до страницы: %+v, %v", balance, err)
	}
	t.Cleanup(mediaadapters.Register("test", rulesOnly{}))
	if balance, err := service.ProviderBalance(context.Background(), "test"); balance != nil || err != nil {
		t.Fatalf("адаптер без остатка: %+v, %v", balance, err)
	}
	if _, err := service.ProviderBalance(context.Background(), "codex"); err == nil {
		t.Fatal("неплатный провайдер принят")
	}
}
