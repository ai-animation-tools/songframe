package kling

import (
	"context"
	"strconv"
	"time"

	"songframe-go/internal/providers/kling/mcp"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
)

var (
	balanceKey       = pyre.MustCompile(`credit|balance|remain|point`, pyre.IgnoreCase)
	preferredBalance = pyre.MustCompile(`remain|available|balance|left`, pyre.IgnoreCase)
)

// BalanceField — числовое поле остатка в ответе аккаунта: путь вида «credits.remaining» и
// значение как float.
type BalanceField struct {
	Name  string
	Value float64
}

// FindBalance — числовые поля, имя которых похоже на остаток
// (credit, balance, remain, point), при обходе в глубину; сам ответ не сохраняется. Ошибка —
// OverflowError для целого вне float.
func FindBalance(value any, path string) ([]BalanceField, error) {
	found := []BalanceField{}
	switch item := value.(type) {
	case *pycompat.Dict:
		for _, key := range item.Keys() {
			name := key
			if path != "" {
				name = path + "." + key
			}
			field := item.Value(key)
			_, isBool := field.(bool)
			_, matched := balanceKey.Search(key)
			if pycompat.IsNumber(field) && !isBool && matched {
				number, err := pycompat.Float(field)
				if err != nil {
					return nil, err
				}
				found = append(found, BalanceField{name, number})
				continue
			}
			nested, err := FindBalance(field, name)
			if err != nil {
				return nil, err
			}
			found = append(found, nested...)
		}
	case []any:
		for index, element := range item {
			nested, err := FindBalance(element, path+"["+strconv.Itoa(index)+"]")
			if err != nil {
				return nil, err
			}
			found = append(found, nested...)
		}
	}
	return found, nil
}

// accountResult — {"balance", "source"} account().
func accountResult(balance any, source string) *pycompat.Dict {
	result := pycompat.NewDict()
	result.Set("balance", balance)
	result.Set("source", source)
	return result
}

// Account — остаток кредитов из query_membership_and_credits — только число и
// имя поля (предпочтительно remain/available/balance/left). Нет входа, нет ответа или нет числа —
// balance nil (None) с пояснением в source. Ошибка — только непредвиденное исключение.
func (a *Adapter) Account(ctx context.Context, timeout time.Duration) (*pycompat.Dict, error) {
	body, err := a.open(timeout, nil).Call(ctx, "query_membership_and_credits", nil, 0, nil)
	if err != nil {
		if mcp.IsAuthRequired(err) {
			return accountResult(nil, err.Error()), nil
		}
		if notSubmittedCause(err) {
			return accountResult(nil, "ответ query_membership_and_credits не получен или не разобран"), nil
		}
		return nil, err
	}
	return balanceOf(body)
}

// balanceOf — выбор поля остатка из ответа аккаунта.
func balanceOf(body any) (*pycompat.Dict, error) {
	found, err := FindBalance(body, "")
	if err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return accountResult(nil, "в ответе query_membership_and_credits нет числового поля остатка"), nil
	}
	choice := found[0]
	for _, field := range found {
		if _, ok := preferredBalance.Search(field.Name); ok {
			choice = field
			break
		}
	}
	return accountResult(choice.Value, choice.Name), nil
}

// loginIncomplete и loginCancelled — тексты для входа, завершённого непредвиденным сбоем или
// отменённого кнопкой.
var (
	loginIncomplete = "Вход в " + mcp.Title + " не завершён. Подтвердите вход в браузере и повторите при необходимости."
	loginCancelled  = "Вход в " + mcp.Title + " отменён."
	authCheckFailed = "Не удалось проверить вход в " + mcp.Title + ". Проверьте соединение и повторите проверку."
)

// loginResult — {"ok", "message"} login().
func loginResult(ok bool, message string) *pycompat.Dict {
	result := pycompat.NewDict()
	result.Set("ok", ok)
	result.Set("message", message)
	return result
}

// Login — вход в браузере без исключений наружу: {"ok": true,
// "message": "Вход в Kling выполнен, авторизация сохранена."} или {"ok": false, "message":
// "Вход в Kling не завершён: <причина>"}. Адрес авторизации приходит в options.Report строкой
// «AUTHORIZE_URL <адрес>». Отмена ctx — «Вход в Kling отменён.», непредвиденная ошибка — общий
// текст незавершённого входа (loginIncomplete).
func (a *Adapter) Login(ctx context.Context, options mcp.LoginOptions) *pycompat.Dict {
	login := a.Client.Login
	if a.clientLogin != nil {
		login = a.clientLogin
	}
	_, err := login(ctx, options)
	switch {
	case err == nil:
		return loginResult(true, "Вход в "+mcp.Title+" выполнен, авторизация сохранена.")
	case ctx.Err() != nil || mcp.IsCancelled(err):
		return loginResult(false, loginCancelled)
	case notSubmittedCause(err):
		return loginResult(false, "Вход в "+mcp.Title+" не завершён: "+err.Error())
	}
	return loginResult(false, loginIncomplete)
}

// authResult — {"status"[, "message"]} auth_status().
func authResult(status, message string) *pycompat.Dict {
	result := pycompat.NewDict()
	result.Set("status", status)
	if message != "" {
		result.Set("message", message)
	}
	return result
}

// AuthStatus — authenticated только после успешного бесплатного who_am_i;
// без сохранённого входа или с отвергнутым токеном — unauthenticated; без сети или при ошибке
// сервера — unknown. Непредвиденная ошибка — unknown с общим текстом.
func (a *Adapter) AuthStatus(ctx context.Context, timeout time.Duration) *pycompat.Dict {
	if a.Client.ReadCredentials() == nil {
		return authResult("unauthenticated", mcp.LoginRequired)
	}
	_, err := a.open(timeout, nil).Call(ctx, "who_am_i", nil, 0, nil)
	switch {
	case err == nil:
		return authResult("authenticated", "")
	case mcp.IsAuthRequired(err):
		return authResult("unauthenticated", err.Error())
	case mcp.IsNotSent(err):
		return authResult("unknown", "Нет соединения с "+mcp.Title+". Проверьте сеть и повторите проверку.")
	case notSubmittedCause(err):
		return authResult("unknown", mcp.Title+" не подтвердил вход. Повторите проверку позже.")
	}
	return authResult("unknown", authCheckFailed)
}
