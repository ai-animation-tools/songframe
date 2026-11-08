// Package mcp — клиент MCP-сервера Kling на стандартной библиотеке Go: вход OAuth, хранение и
// обновление токенов, вызовы инструментов и загрузка файлов.
//
// Протокол — stateless JSON-RPC поверх `POST <base>/mcp`, авторизация — OAuth 2.1 для публичного
// клиента (discovery RFC 9728/8414, регистрация RFC 7591, PKCE S256, resource RFC 8707). Токены
// хранятся в каталоге состояния приложения (`providers/kling/credentials.json`); файлы
// официального Kling CLI не читаются и не пишутся.
//
// Запросы к сервису (адреса, тела, формы OAuth, порядок вызовов), записи токенов, тексты ошибок и
// различие «не отправлено» / «явный отказ» / «исход неизвестен» зафиксированы эталонами: от них
// зависят согласование платной отправки и защита от её повтора в media_request. Тела JSON
// сериализуются моделью internal/pycompat, поэтому байты совпадают с json.dumps Python.
package mcp

import (
	"errors"
	"fmt"

	"songframe-go/internal/pycompat"
)

// AuthRequiredError — нет сохранённого входа или сервер отверг токен после
// обновления; запрос не принят.
type AuthRequiredError struct{ Message string }

func (e *AuthRequiredError) Error() string { return e.Message }

// NotSentError — NotSent: соединение не установлено (отказ, DNS, TLS), запрос к серверу не уходил.
type NotSentError struct{ Message string }

func (e *NotSentError) Error() string { return e.Message }

// TransportError — HTTP-ошибка или обрыв после отправки. Status 0 — ответ не получен:
// исход запроса неизвестен. Error() — «HTTP <status>: <text>» либо только текст.
type TransportError struct {
	Status int
	Text   string
}

func (e *TransportError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("HTTP %d: %s", e.Status, e.Text)
	}
	return e.Text
}

// ProtocolError — ответ JSON-RPC с полем error или неразборчивый ответ сервера.
type ProtocolError struct{ Message string }

func (e *ProtocolError) Error() string { return e.Message }

// ToolError — инструмент вернул isError: true: сервер явно отказал.
type ToolError struct{ Message string }

func (e *ToolError) Error() string { return e.Message }

// cancelledError — отмена операции контекстом вызывающего (кнопка отмены входа, закрытие
// приложения) — отдельная ошибка, которую errors.Is узнаёт как context.Canceled /
// DeadlineExceeded.
type cancelledError struct {
	message string
	cause   error
}

func (e *cancelledError) Error() string { return e.message }
func (e *cancelledError) Unwrap() error { return e.cause }

// IsKlingError — ошибка клиента (вход, транспорт, протокол, отказ инструмента). ValueError и
// OSError сюда не входят.
func IsKlingError(err error) bool {
	var (
		auth      *AuthRequiredError
		notSent   *NotSentError
		transport *TransportError
		protocol  *ProtocolError
		tool      *ToolError
	)
	return errors.As(err, &auth) || errors.As(err, &notSent) || errors.As(err, &transport) ||
		errors.As(err, &protocol) || errors.As(err, &tool)
}

// IsAuthRequired — ошибка требует нового входа.
func IsAuthRequired(err error) bool {
	var target *AuthRequiredError
	return errors.As(err, &target)
}

// IsNotSent — запрос не уходил на сервер.
func IsNotSent(err error) bool {
	var target *NotSentError
	return errors.As(err, &target)
}

// IsToolError — явный отказ инструмента (isError).
func IsToolError(err error) bool {
	var target *ToolError
	return errors.As(err, &target)
}

// ErrorTypeName — имя типа ошибки для отладочной записи и эталонов: имена
// классов клиента, тип исключения pycompat или «Exception» для прочих ошибок Go.
func ErrorTypeName(err error) string {
	switch err.(type) {
	case *AuthRequiredError:
		return "AuthRequired"
	case *NotSentError:
		return "NotSent"
	case *TransportError:
		return "TransportError"
	case *ProtocolError:
		return "ProtocolError"
	case *ToolError:
		return "ToolError"
	case *cancelledError:
		return "CancelledError"
	}
	var exception *pycompat.Exception
	if errors.As(err, &exception) {
		return exception.Type
	}
	var named interface{ PythonType() string }
	if errors.As(err, &named) {
		return named.PythonType()
	}
	return "Exception"
}
