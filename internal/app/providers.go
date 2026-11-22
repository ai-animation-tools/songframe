package app

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"songframe/internal/agents"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/providers"
	"songframe/internal/wire"
)

// Имена событий Wails группы window.api.environment.
const (
	// EnvironmentProgressEvent — строка проверки среды {requestId, check} для environment.check.
	EnvironmentProgressEvent = "environment:progress"
	// LoginURLEvent — адрес авторизации текущего входа {provider, url} для environment.onLoginUrl.
	LoginURLEvent = "environment:loginUrl"
)

// EnvironmentProgress — событие environment:progress: строка проверки для вызова requestId.
type EnvironmentProgress struct {
	RequestID string                    `json:"requestId"`
	Check     mediaapi.EnvironmentCheck `json:"check"`
}

// EnvironmentService реализует группу window.api.environment: строки страницы «Среда», проверку
// входа к платному провайдеру и вход через браузер. Состояние текущих запросов принадлежит слою
// провайдеров (internal/providers).
type EnvironmentService struct {
	layer *providers.Layer

	mu   sync.RWMutex
	emit func(name string, data any)
}

// NewEnvironmentService связывает группу со слоем провайдеров приложения.
func NewEnvironmentService(layer *providers.Layer) *EnvironmentService {
	return &EnvironmentService{layer: layer}
}

// send передаёт событие renderer, если GUI уже подключён.
func (s *EnvironmentService) send(name string, data any) {
	s.mu.RLock()
	emit := s.emit
	s.mu.RUnlock()
	if emit != nil {
		emit(name, data)
	}
}

// Check — проверка среды. Каждая строка до и во время проверки приходит событием
// environment:progress с requestId вызова (адаптер renderer передаёт её в onProgress); итог —
// строки в порядке показа. Одновременные вызовы ждут одну проверку.
func (s *EnvironmentService) Check(ctx context.Context, requestID string) ([]mediaapi.EnvironmentCheck, error) {
	return wire.Done(s.layer.CheckEnvironment(ctx, func(check mediaapi.EnvironmentCheck) {
		s.send(EnvironmentProgressEvent, EnvironmentProgress{RequestID: requestID, Check: check})
	}))
}

// ProviderAuth — состояние входа в платного провайдера без генерации.
func (s *EnvironmentService) ProviderAuth(ctx context.Context, provider string) (agents.ProviderAuth, error) {
	return s.layer.ProviderAuth(ctx, provider)
}

// balanceTimeout — предел запроса остатка: он информационный и не должен задерживать страницу долго.
const balanceTimeout = 30 * time.Second

// ProviderBalance — остаток кредитов платного провайдера и время его запроса (UTC, ISO 8601).
// Единицы — те, что отдаёт адаптер; приложение показывает их как кредиты.
type ProviderBalance struct {
	Credits   float64 `json:"credits"`
	CheckedAt string  `json:"checkedAt"`
}

// ProviderBalance — остаток кредитов провайдера через AccountReader его адаптера (бесплатный запрос, как в
// cost_check). nil без ошибки — остаток недоступен: адаптер его не отдаёт, сервис не ответил или вход не
// выполнен; страница тогда просто не показывает строку. Ошибка — только для провайдера, который не платный.
// Результат не кэшируется: страница сама решает, когда спросить заново.
func (s *EnvironmentService) ProviderBalance(ctx context.Context, provider string) (*ProviderBalance, error) {
	paid, ok := providers.PaidAdapter(provider)
	if !ok {
		return nil, errors.New("Провайдер не поддерживает запрос остатка.")
	}
	adapter, ok := mediaadapters.Get(paid.ID)
	if !ok {
		return nil, nil
	}
	reader, ok := adapter.(mediaapi.AccountReader)
	if !ok {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, balanceTimeout)
	defer cancel()
	account, err := reader.Account(ctx, balanceTimeout)
	if err != nil || account.Balance == nil || math.IsNaN(*account.Balance) || math.IsInf(*account.Balance, 0) {
		return nil, nil
	}
	return &ProviderBalance{Credits: *account.Balance, CheckedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, nil
}

// LoginProvider — вход в платного провайдера: приложение открывает страницу авторизации в
// браузере, сообщает адрес событием environment:loginUrl и ждёт подтверждения.
func (s *EnvironmentService) LoginProvider(ctx context.Context, provider string) (providers.LoginResult, error) {
	return s.layer.Login(ctx, provider, func(url providers.LoginURL) { s.send(LoginURLEvent, url) })
}

// CancelLogin прерывает ожидание входа.
func (s *EnvironmentService) CancelLogin(provider string) { s.layer.CancelLogin(provider) }

// MediaService реализует группу window.api.media: объявления моделей провайдера без загрузки
// референсов и отправки генерации.
type MediaService struct{ layer *providers.Layer }

// NewMediaService связывает группу со слоем провайдеров приложения.
func NewMediaService(layer *providers.Layer) *MediaService { return &MediaService{layer: layer} }

// Capabilities — объявления моделей провайдера вида медиа (свежий каталог аккаунта).
func (s *MediaService) Capabilities(ctx context.Context, project, kind, provider string) (mediaapi.Capabilities, error) {
	return wire.Done(s.layer.Capabilities(ctx, project, kind, provider))
}

// ConfigureEnvironmentEvents связывает группу с событиями Wails до запуска GUI; функция не
// экспортируется в bindings.
func ConfigureEnvironmentEvents(s *EnvironmentService, desktop *application.App) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.emit = func(name string, data any) { desktop.Event.Emit(name, data) }
}
