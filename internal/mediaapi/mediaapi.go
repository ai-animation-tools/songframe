// Package mediaapi — контракт адаптера провайдера генерации: необязательные возможности,
// их результаты и ошибки отправки. Это перенос набора функций Python-модуля адаптера
// (tools/media_request/README.md#адаптеры оригинала), которые вызывают общие инструменты
// media_request, cost_check, regenerate_shot, shot_workflow и lint_registry.
//
// Пакет — лист графа зависимостей: его импортируют и общий код (internal/mediarequest,
// internal/costcheck), и пакеты провайдеров (internal/providers/<id>), и таблица
// internal/mediaadapters. Поэтому адаптер провайдера может напрямую возвращать NotSubmitted и
// RejectedRequest и объявлять методы с этими типами, не завися от таблицы адаптеров.
//
// Каждая возможность — отдельный интерфейс с одним методом, как hasattr(service, name)
// оригинала: общий код проверяет его утверждением типа. Имена методов прямо соответствуют
// функциям Python (validate_spec → ValidateSpec и т.д.). Сетевые методы принимают
// context.Context: отмена задания приложения прерывает вызов сервиса, а не только ожидание.
//
// Данные запроса и состояния попытки — *pycompat.Dict: так сохраняются порядок ключей, различие
// int/float и прочие значения файла request.json/attempt.json, а SHA замороженного запроса
// совпадает с оригиналом.
package mediaapi

import (
	"context"
	"errors"
	"time"

	"songframe-go/internal/pycompat"
)

// NotSubmitted — attempt.NotSubmitted: отправка не начиналась (нет входа, соединения,
// незавершённая загрузка входов). Попытка остаётся prepared, текст ошибки показывается
// пользователю как есть, поэтому в нём не должно быть секретов.
type NotSubmitted struct{ Message string }

func (e *NotSubmitted) Error() string { return e.Message }

// RejectedRequest — attempt.RejectedRequest: сервис явно отклонил запрос без создания задания
// (до оплаты). Message — краткая причина без секретов; общий код сохраняет её в last_rejection.
type RejectedRequest struct{ Message string }

func (e *RejectedRequest) Error() string { return e.Message }

// IsNotSubmitted — isinstance(error, NotSubmitted): RejectedRequest в оригинале — подкласс
// NotSubmitted, поэтому тоже считается неотправленным.
func IsNotSubmitted(err error) bool {
	var notSubmitted *NotSubmitted
	var rejected *RejectedRequest
	return errors.As(err, &notSubmitted) || errors.As(err, &rejected)
}

// SubmitResult — ответ submit адаптера: {"generation_id", "credits_consumed"?}.
type SubmitResult struct {
	// GenerationID — ID задания сервиса. Общий код проверяет его (identifier оригинала):
	// пустой или недопустимый ID — неизвестный исход отправки, а не повтор.
	GenerationID string
	// CreditsConsumed — фактический расход: pycompat.Int (целое JSON) или float64; nil — сервис
	// не сообщил. Тип важен: в attempt.json 12 и 12.0 пишутся по-разному, как в оригинале.
	CreditsConsumed any
}

// PollResult — ответ poll адаптера: {"status", "service_status"?, "outputs"?}.
type PollResult struct {
	// Status — running, outputs_pending, watermark_free_pending, failed или completed; иное —
	// ошибка опроса.
	Status string
	// ServiceStatus — статус сервиса в любом виде (str(...).lower() оригинала); nil — «unknown».
	// В attempt.json попадает только значение из [a-z_]{1,40}.
	ServiceStatus any
	// Outputs — непрозрачные ссылки на результаты для Fetch при completed; число должно совпасть
	// с outputs запроса, иначе общий код ждёт (outputs_pending). Не сохраняются в журнал попытки:
	// там могут быть подписанные адреса.
	Outputs []string
}

// Account — ответ account адаптера для cost_check: остаток и источник.
type Account struct {
	// Balance — остаток в кредитах; nil — неизвестен.
	Balance *float64
	// Source — имя поля ответа или причина, почему остаток неизвестен.
	Source string
}

// LoginResult — ответ login: {"ok", "message"} без исключений.
type LoginResult struct {
	OK      bool
	Message string
}

// AuthStatus — ответ auth_status: Status — authenticated, unauthenticated или unknown;
// Message — пояснение (пусто — поля нет).
type AuthStatus struct {
	Status  string
	Message string
}

// SpecValidator — validate_spec(spec): ограничения сервиса поверх общей формы спецификации
// (requestsnapshot.ValidateSpec). Нарушение — ошибка с текстом для пользователя (ValueError).
// Отличие от оригинала: адаптер без метода ничего не ограничивает (в Python отсутствие функции
// было ошибкой программирования — AttributeError).
type SpecValidator interface {
	ValidateSpec(spec *pycompat.Dict) error
}

// PromptValidator — validate_prompt(prompt): недопустимый промпт — ошибка, иначе предупреждения.
type PromptValidator interface {
	ValidatePrompt(prompt string) ([]string, error)
}

// FrozenFielder — FROZEN_FIELDS: поля, добавляемые в замороженный request.json и его SHA
// (может быть пустым). Возвращается новый словарь на каждый вызов.
type FrozenFielder interface {
	FrozenFields() *pycompat.Dict
}

// TaskTracer — TASK_TRACE_ID: true — общий код записывает UUID v7 попытки task_trace_id в
// attempt.json до вызова Submit, адаптер передаёт его сервису с каждым вызовом этой попытки.
type TaskTracer interface {
	TaskTraceID() bool
}

// PromptWarningLimiter — PROMPT_WARNING_CHARS: предел длины видеопромпта, после которого
// shot_workflow approve-prompt предупреждает (отказ по длине остаётся делом ValidatePrompt).
type PromptWarningLimiter interface {
	PromptWarningChars() int
}

// Submitter — submit(directory, request, state, timeout): единственная отправка подготовленной
// попытки. directory — папка попытки, request — замороженный request.json, state — копия
// attempt.json (адаптер не должен её менять), timeout — предел одного вызова сервиса.
// Ошибки: *RejectedRequest — явный отказ без задания, *NotSubmitted — отправка не начиналась;
// любая другая ошибка — неизвестный исход (кредиты могли быть списаны). Отмена ctx до отправки
// адаптер возвращает как *NotSubmitted, после — как обычную ошибку.
type Submitter interface {
	Submit(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (SubmitResult, error)
}

// Poller — poll(directory, request, state, timeout): состояние задания по сохранённому
// generation_id из state. Любая ошибка — «ID сохранён, повторите resume».
type Poller interface {
	Poll(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (PollResult, error)
}

// Fetcher — fetch(output, destination): записывает полные байты одного результата в новый файл
// destination. Публикацию без перезаписи, сигнатуры и журнал ведёт общий код.
type Fetcher interface {
	Fetch(ctx context.Context, output, destination string) error
}

// CapabilitiesReporter — capabilities(kind, timeout): {"reports": [{"command", "models"}],
// "problems": [{"command", "message"}]} для команд вида медиа. Ошибка — отказ discovery целиком.
// Словарь печатается как есть (json.dumps), поэтому порядок ключей — порядок адаптера.
type CapabilitiesReporter interface {
	Capabilities(ctx context.Context, kind string, timeout time.Duration) (*pycompat.Dict, error)
}

// AccountReader — account(timeout): информационный остаток для cost_check. Ошибка сервиса
// адаптер возвращает как Account{Balance: nil, Source: причина}, а не ошибкой.
type AccountReader interface {
	Account(ctx context.Context, timeout time.Duration) (Account, error)
}

// PricingFiler — pricing_file(): путь базовой таблицы цен провайдера. Файл в поставке только
// читается; наблюдения расхода общий код пишет в каталог состояния.
type PricingFiler interface {
	PricingFile() (string, error)
}

// PricingDataer — та же базовая таблица цен, встроенная в бинарник: адаптер отдаёт байты вместо
// пути к файлу поставки. cost_check предпочитает её PricingFiler; явный --pricing важнее обеих.
type PricingDataer interface {
	PricingData() []byte
}

// InputNormalizer — normalize_inputs(spec): приводит входы спецификации оплаченной отправки
// прежнего формата к именованным слотам перед повтором (regenerate_shot); меняет spec на месте.
type InputNormalizer interface {
	NormalizeInputs(ctx context.Context, spec *pycompat.Dict, timeout time.Duration) error
}

// Loginer — login(open_browser, timeout): вход к провайдеру. Строки адреса авторизации адаптер
// сообщает через options.Report: так слой провайдеров приложения открывает браузер сам и
// показывает адрес на странице «Среда», а CLI media_request — нет. Отмена ctx прекращает ожидание.
type Loginer interface {
	Login(ctx context.Context, options LoginOptions) LoginResult
}

// AuthStatusReader — auth_status(timeout): состояние входа без генерации.
type AuthStatusReader interface {
	AuthStatus(ctx context.Context, timeout time.Duration) AuthStatus
}

// Seconds — время в секундах Python (float) как time.Duration для вызова адаптера. NaN и
// отрицательные значения дают 0: общий код проверяет таймауты до вызова там, где это делал
// оригинал, а остальные адаптер трактует сам.
func Seconds(value float64) time.Duration {
	if !(value > 0) {
		return 0
	}
	if value > float64(1<<62)/float64(time.Second) {
		return time.Duration(1 << 62)
	}
	return time.Duration(value * float64(time.Second))
}
