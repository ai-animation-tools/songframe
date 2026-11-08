package mediaadapters

import (
	"context"
	"errors"
	"os"
	"time"

	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/providers/kling"
	"songframe-go/internal/providers/kling/mcp"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/store"
)

// StateDir — каталог состояния, в котором провайдеры хранят вход (`providers/<id>/`). По
// умолчанию — профиль Go-версии (SONGFRAME_GO_LOCAL_DIR либо папка ОС); приложение подменяет
// его своим профилем при старте. Читается при каждом обращении: смена профиля не требует
// пересоздания таблицы.
var StateDir = func() (string, error) { return store.NewProfile(os.Getenv("SONGFRAME_GO_LOCAL_DIR")).Path() }

// LoginBrowser открывает адрес авторизации для входа с OpenBrowser (CLI media_request login без
// --no-browser); nil — браузер не открывается. Приложение входит с OpenBrowser=false и открывает
// адрес само по строке AUTHORIZE_URL (internal/providers).
var LoginBrowser func(url string) error

// klingAdapter связывает таблицу с пакетом провайдера, не давая ему зависеть от таблицы, и
// приводит его ответы (dict Python) к типам контракта mediaapi. Клиент создаётся на каждый вызов
// по текущему StateDir: состояние входа живёт в файле, а не в памяти.
type klingAdapter struct{}

var (
	_ mediaapi.SpecValidator        = klingAdapter{}
	_ mediaapi.PromptValidator      = klingAdapter{}
	_ mediaapi.FrozenFielder        = klingAdapter{}
	_ mediaapi.TaskTracer           = klingAdapter{}
	_ mediaapi.PromptWarningLimiter = klingAdapter{}
	_ mediaapi.Submitter            = klingAdapter{}
	_ mediaapi.Poller               = klingAdapter{}
	_ mediaapi.Fetcher              = klingAdapter{}
	_ mediaapi.CapabilitiesReporter = klingAdapter{}
	_ mediaapi.AccountReader        = klingAdapter{}
	_ mediaapi.PricingDataer        = klingAdapter{}
	_ mediaapi.InputNormalizer      = klingAdapter{}
	_ mediaapi.Loginer              = klingAdapter{}
	_ mediaapi.AuthStatusReader     = klingAdapter{}
	_ mediaapi.RulesProvider        = klingAdapter{}
	_ mediaapi.EnvironmentProvider  = klingAdapter{}
)

// RequestRules — правила платного запроса Kling для слоя провайдеров приложения.
func (klingAdapter) RequestRules() mediaapi.RequestRules { return kling.RequestRules() }

// Environment — строка страницы «Среда»; название — из реестра провайдеров медиа.
func (klingAdapter) Environment() mediaapi.Environment {
	info, _ := mediaproviders.Lookup(kling.ID)
	return kling.Environment(info.Title)
}

// client — адаптер Kling для текущего каталога состояния.
func (klingAdapter) client() (*kling.Adapter, error) {
	dir, err := StateDir()
	if err != nil {
		return nil, err
	}
	return kling.New(dir), nil
}

// failure переводит ошибки «запрос не отправлен» Kling в типы контракта: по ним общий цикл
// решает, что оплаты не было и попытку можно вернуть в prepared.
func failure(err error) error {
	var notSubmitted *kling.NotSubmittedError
	var rejected *kling.RejectedRequestError
	switch {
	case errors.As(err, &rejected):
		return &mediaapi.RejectedRequest{Message: rejected.Message}
	case errors.As(err, &notSubmitted):
		return &mediaapi.NotSubmitted{Message: notSubmitted.Message}
	}
	return err
}

func (klingAdapter) ValidateSpec(spec *pycompat.Dict) error {
	return (&kling.Adapter{}).ValidateSpec(spec)
}

func (klingAdapter) ValidatePrompt(prompt string) ([]string, error) {
	return (&kling.Adapter{}).ValidatePrompt(prompt), nil
}

func (klingAdapter) FrozenFields() *pycompat.Dict { return (&kling.Adapter{}).FrozenFields() }

func (klingAdapter) TaskTraceID() bool { return (&kling.Adapter{}).TaskTraceID() }

// PromptWarningChars — PROMPT_WARNING_CHARS kling_request.py: длиннее — предупреждение shot_workflow.
func (klingAdapter) PromptWarningChars() int { return kling.PromptWarningChars }

func (klingAdapter) PricingData() []byte { return (&kling.Adapter{}).PricingFile() }

func (k klingAdapter) Submit(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (mediaapi.SubmitResult, error) {
	adapter, err := k.client()
	if err != nil {
		return mediaapi.SubmitResult{}, err
	}
	answer, err := adapter.Submit(ctx, directory, request, state, timeout)
	if err != nil {
		return mediaapi.SubmitResult{}, failure(err)
	}
	id, _ := answer.Value("generation_id").(string)
	return mediaapi.SubmitResult{GenerationID: id, CreditsConsumed: answer.Value("credits_consumed")}, nil
}

func (k klingAdapter) Poll(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (mediaapi.PollResult, error) {
	adapter, err := k.client()
	if err != nil {
		return mediaapi.PollResult{}, err
	}
	answer, err := adapter.Poll(ctx, directory, request, state, timeout)
	if err != nil {
		return mediaapi.PollResult{}, err
	}
	status, _ := answer.Value("status").(string)
	result := mediaapi.PollResult{Status: status, ServiceStatus: answer.Value("service_status")}
	if items, ok := answer.Value("outputs").([]any); ok {
		for _, item := range items {
			if url, ok := item.(string); ok {
				result.Outputs = append(result.Outputs, url)
			}
		}
	}
	return result, nil
}

func (k klingAdapter) Fetch(ctx context.Context, output, destination string) error {
	adapter, err := k.client()
	if err != nil {
		return err
	}
	return adapter.Fetch(ctx, output, destination)
}

func (k klingAdapter) Capabilities(ctx context.Context, kind string, timeout time.Duration) (*pycompat.Dict, error) {
	adapter, err := k.client()
	if err != nil {
		return nil, err
	}
	return adapter.Capabilities(ctx, kind, timeout)
}

func (k klingAdapter) Account(ctx context.Context, timeout time.Duration) (mediaapi.Account, error) {
	adapter, err := k.client()
	if err != nil {
		return mediaapi.Account{}, err
	}
	answer, err := adapter.Account(ctx, timeout)
	if err != nil {
		return mediaapi.Account{}, err
	}
	result := mediaapi.Account{}
	result.Source, _ = answer.Value("source").(string)
	switch balance := answer.Value("balance").(type) {
	case float64:
		result.Balance = &balance
	case pycompat.Int:
		if value, err := balance.Float(); err == nil {
			result.Balance = &value
		}
	}
	return result, nil
}

// NormalizeInputs раскрывает короткие флаги старых снимков в слоты на месте (Python менял spec
// и возвращал его же).
func (k klingAdapter) NormalizeInputs(ctx context.Context, spec *pycompat.Dict, timeout time.Duration) error {
	adapter, err := k.client()
	if err != nil {
		return err
	}
	_, err = adapter.NormalizeInputs(ctx, spec, timeout)
	return err
}

func (k klingAdapter) Login(ctx context.Context, login mediaapi.LoginOptions) mediaapi.LoginResult {
	adapter, err := k.client()
	if err != nil {
		return mediaapi.LoginResult{Message: err.Error()}
	}
	options := mcp.LoginOptions{Timeout: login.Timeout, Report: login.Report}
	if login.OpenBrowser {
		options.OpenBrowser = LoginBrowser
	}
	answer := adapter.Login(ctx, options)
	ok, _ := answer.Value("ok").(bool)
	message, _ := answer.Value("message").(string)
	return mediaapi.LoginResult{OK: ok, Message: message}
}

func (k klingAdapter) AuthStatus(ctx context.Context, timeout time.Duration) mediaapi.AuthStatus {
	adapter, err := k.client()
	if err != nil {
		return mediaapi.AuthStatus{Status: "error", Message: err.Error()}
	}
	answer := adapter.AuthStatus(ctx, timeout)
	status, _ := answer.Value("status").(string)
	message, _ := answer.Value("message").(string)
	return mediaapi.AuthStatus{Status: status, Message: message}
}

// SnapshotWarnings — модельные предупреждения снимка принятого комплекта (lint_registry).
func (klingAdapter) SnapshotWarnings(snapshot *pycompat.Dict) ([]Warning, error) {
	items, err := kling.SnapshotWarnings(snapshot)
	if err != nil {
		return nil, err
	}
	result := make([]Warning, len(items))
	for index, item := range items {
		result[index] = Warning{Where: item[0], Message: item[1]}
	}
	return result, nil
}
