package app

import (
	"context"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"songframe-go/internal/agents"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/providers"
	"songframe-go/internal/wire"
)

// Имена событий Wails группы window.api.environment (каналы Electron оригинала).
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
