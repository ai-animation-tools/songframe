package agents

import (
	"context"
	"errors"

	"songframe-go/internal/jscompat"
)

// Служебные протоколы CLI без пользовательского хода: control protocol Claude (initialize,
// get_usage) и app-server Codex (account/read, account/rateLimits/read, model/list). Используются
// только для сведений аккаунта и каталога моделей; генерация, вход и обновление токенов не
// вызываются. Ответы разбираются как JSON JS (jscompat), чтобы проверки типов совпадали с оригиналом.

// claudeControlArgs — изолированный служебный запуск Claude: без инструментов, MCP, хуков,
// пользовательских настроек и сохранения сеанса.
var claudeControlArgs = []string{
	"--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--setting-sources=",
	"--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`, "--tools", "", "--no-session-persistence",
	"--settings", `{"disableAllHooks":true}`,
}

var errClaudeNoReply = errors.New("Claude не ответил на служебный запрос.")

// claudeControl отправляет control-запросы по одному и возвращает ответы. Служебные уведомления
// system допустимы; неожиданный ход модели, запрос инструмента, чужой или неуспешный ответ
// прерывают чтение. request — объекты {subtype, …}; request_id равен subtype.
func claudeControl(ctx context.Context, executable string, options ProcessOptions, requests []*jscompat.Object) ([]any, error) {
	return withServiceProcess(ctx, executable, claudeControlArgs, options, func(ctx context.Context, s *serviceSession) ([]any, error) {
		responses := []any{}
		for _, request := range requests {
			subtype := text(request.Value("subtype"))
			envelope := object2("type", "control_request", "request_id", subtype)
			envelope.Set("request", request)
			if err := s.send([]byte(jscompat.Stringify(envelope))); err != nil {
				return nil, errClaudeNoReply
			}
			for answered := false; !answered; {
				line, err := s.next(ctx)
				if err != nil {
					return nil, errClaudeNoReply
				}
				if jscompat.Trim(jscompat.DecodeUTF8(line)) == "" {
					continue
				}
				value, err := jscompat.Parse([]byte(jscompat.Trim(jscompat.DecodeUTF8(line))))
				message, ok := value.(*jscompat.Object)
				if err != nil || !ok {
					return nil, errClaudeNoReply
				}
				if message.Value("type") == "system" {
					continue
				}
				response, ok := message.Value("response").(*jscompat.Object)
				if message.Value("type") != "control_response" || !ok || response.Value("request_id") != subtype || response.Value("subtype") != "success" {
					return nil, errClaudeNoReply
				}
				responses = append(responses, response.Value("response"))
				answered = true
			}
		}
		return responses, nil
	})
}

// codexRPC — короткая RPC-сессия app-server Codex только для чтения. После initialize
// отправляется уведомление initialized, затем operation выполняет запросы последовательно.
// Ответ с error или без result отклоняет только свой запрос; испорченная строка, выход сервера
// или общий тайм-аут прерывают всю сессию.
func codexRPC[T any](ctx context.Context, executable string, options ProcessOptions, operation func(request func(method string, params *jscompat.Object) (any, error)) (T, error)) (T, error) {
	return withServiceProcess(ctx, executable, []string{"app-server", "--listen", "stdio://"}, options, func(ctx context.Context, s *serviceSession) (T, error) {
		var zero T
		nextID := 0
		var fatal error
		request := func(method string, params *jscompat.Object) (any, error) {
			if fatal != nil {
				return nil, errSessionClosed
			}
			nextID++
			id := float64(nextID)
			line := jscompat.NewObject()
			line.Set("id", id)
			line.Set("method", method)
			line.Set("params", params)
			if err := s.send([]byte(jscompat.Stringify(line))); err != nil {
				fatal = err
				return nil, errSessionClosed
			}
			for {
				raw, err := s.next(ctx)
				if err != nil {
					fatal = err
					return nil, errSessionClosed
				}
				trimmed := jscompat.Trim(jscompat.DecodeUTF8(raw))
				if trimmed == "" {
					continue
				}
				value, err := jscompat.Parse([]byte(trimmed))
				reply, ok := value.(*jscompat.Object)
				if err != nil || !ok {
					fatal = errSessionFailed
					return nil, errSessionFailed
				}
				if replyID, isNumber := reply.Value("id").(float64); !isNumber || replyID != id {
					continue
				}
				if reply.Has("error") || !reply.Has("result") {
					return nil, errors.New("Codex не поддерживает запрос диагностики.")
				}
				return reply.Value("result"), nil
			}
		}
		clientInfo := jscompat.NewObject()
		clientInfo.Set("name", "songframe")
		clientInfo.Set("title", "SongFrame")
		clientInfo.Set("version", "0.1.0")
		params := jscompat.NewObject()
		params.Set("clientInfo", clientInfo)
		if _, err := request("initialize", params); err != nil {
			return zero, err
		}
		initialized := jscompat.NewObject()
		initialized.Set("method", "initialized")
		if err := s.send([]byte(jscompat.Stringify(initialized))); err != nil {
			return zero, err
		}
		return operation(request)
	})
}
