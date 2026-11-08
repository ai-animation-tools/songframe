package kling

import (
	"context"
	_ "embed"
	"net/http"
	"sync"
	"time"

	"songframe-go/internal/providers/kling/mcp"
	"songframe-go/internal/pycompat"
)

// Adapter — адаптер провайдера kling для общего цикла попытки (media_request) и оценки цены
// (cost_check): перенос функций tools/kling_request/kling_request.py. Знает команды и
// ограничения Kling, собирает вызовы MCP-сервера клиентом mcp, разбирает ответы, выбирает адреса
// оригиналов без логотипа, читает остаток аккаунта и выполняет вход. Состояние попытки, замок,
// SHA и сохранение оригиналов ведёт общий код; адаптер файлов попытки не пишет, кроме
// destination в Fetch.
//
// Данные запросов и состояния — словари pycompat (как dict Python), ошибки проверки — исключения
// pycompat с текстами оригинала. Методы безопасны для параллельного вызова: каждый сетевой метод
// открывает собственный сеанс MCP.
type Adapter struct {
	// Client — клиент MCP с каталогом состояния и адресом сервера.
	Client *mcp.Client
	// SubmitTimeout — таймаут вызова генерации; 0 — mcp.SubmitTimeout (300 с).
	SubmitTimeout time.Duration

	// newSession подменяет сеанс MCP в тестах эталонов; nil — настоящий сеанс Client.
	newSession func(timeout time.Duration, traceID any) session
	// clientLogin подменяет вход клиента в тестах эталонов; nil — Client.Login.
	clientLogin func(ctx context.Context, options mcp.LoginOptions) (*pycompat.Dict, error)

	fetchOnce   sync.Once
	fetchClient *http.Client
}

// New — адаптер с каталогом состояния приложения (там лежит providers/kling/credentials.json).
func New(stateDir string) *Adapter { return &Adapter{Client: mcp.NewClient(stateDir)} }

// session — то, что адаптеру нужно от сеанса MCP (*mcp.Session).
type session interface {
	Initialize(ctx context.Context) (any, error)
	Tools(ctx context.Context) ([]any, error)
	Call(ctx context.Context, name string, arguments *pycompat.Dict, timeout time.Duration, traceID any) (any, error)
	Upload(ctx context.Context, path string, traceID any) (string, error)
}

// open — mcp.Session(timeout, trace_id).
func (a *Adapter) open(timeout time.Duration, traceID any) session {
	if a.newSession != nil {
		return a.newSession(timeout, traceID)
	}
	return a.Client.NewSession(timeout, traceID)
}

// NotSubmittedError — NotSubmitted общего кода попытки: отправка не начиналась (нет входа,
// соединения, сбой загрузки входа), попытка остаётся подготовленной. В Python — подкласс
// ValueError; media_request сопоставляет его со своим типом.
type NotSubmittedError struct{ Message string }

func (e *NotSubmittedError) Error() string { return e.Message }

// PythonType — имя класса для эталонов и отладочной записи.
func (e *NotSubmittedError) PythonType() string { return "NotSubmitted" }

// RejectedRequestError — RejectedRequest (подкласс NotSubmitted): сервис явно отклонил запрос
// (isError), задание не создано; текст — краткая причина без секретов для last_rejection.
type RejectedRequestError struct{ Message string }

func (e *RejectedRequestError) Error() string { return e.Message }

// PythonType — имя класса для эталонов и отладочной записи.
func (e *RejectedRequestError) PythonType() string { return "RejectedRequest" }

//go:embed pricing.json
var pricing []byte

// PricingFile — pricing_file(): базовая таблица цен Kling для cost_check. Входит в поставку и
// только читается; наблюдения learn пишутся в каталог состояния (providers/kling/
// pricing-observations.json). Отличие от оригинала: вместо пути к файлу рядом с модулем —
// встроенные байты того же файла.
func (a *Adapter) PricingFile() []byte { return pricing }

// SnapshotWarnings — snapshot_warnings(snapshot) адаптера (см. функцию пакета).
func (a *Adapter) SnapshotWarnings(snapshot *pycompat.Dict) ([][2]string, error) {
	return SnapshotWarnings(snapshot)
}
