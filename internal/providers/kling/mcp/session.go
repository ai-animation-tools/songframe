package mcp

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"songframe/internal/toolrt"
)

// UploadTypes — допустимые расширения загрузки и их Content-Type.
var UploadTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".mp4":  "video/mp4",
	".wav":  "audio/wav",
	".mp3":  "audio/mpeg",
}

// uploadURLKeys — ключи адреса загруженного файла в ответе приёма, по приоритету.
var uploadURLKeys = []string{"url", "file_url", "fileUrl", "resource_url", "resourceUrl"}

// Session — один сеанс MCP: initialize и notifications/initialized выполняются один раз на
// экземпляр, далее вызовы инструментов идут по той же версии протокола. Все вызовы сеанса
// передают TraceID как taskTraceId. Сеанс не безопасен для параллельного использования:
// попытка ведёт свои вызовы последовательно.
type Session struct {
	client  *Client
	timeout time.Duration
	// TraceID — UUID v7 попытки (или переданное значение state.task_trace_id).
	TraceID  any
	protocol string
	nextID   int64
	url      string
}

// NewSession — Session(timeout, trace_id): пустой (ложный) traceID заменяется новым UUID v7;
// timeout 0 — CallTimeout.
func (c *Client) NewSession(timeout time.Duration, traceID any) *Session {
	if timeout <= 0 {
		timeout = CallTimeout
	}
	if !toolrt.Truthy(traceID) {
		traceID = UUID7()
	}
	return &Session{client: c, timeout: timeout, TraceID: traceID, url: c.baseURL() + "/mcp"}
}

// headers — заголовки MCP-запроса; mcp-protocol-version — после initialize.
func (s *Session) headers(token string) []Field {
	headers := []Field{
		{"Authorization", "Bearer " + token},
		{"Content-Type", "application/json"},
		{"Accept", "application/json, text/event-stream"},
	}
	if s.protocol != "" {
		headers = append(headers, Field{"mcp-protocol-version", s.protocol})
	}
	return headers
}

// bearer — "Bearer " + token: нестроковый токен из повреждённой записи — TypeError.
func bearer(record *toolrt.Dict) (string, error) {
	token, ok := record.Value("access_token").(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "к строке можно прибавить только строку, получено: %s", toolrt.TypeName(record.Value("access_token")))
	}
	return token, nil
}

// post — POST JSON-RPC с одним обновлением токена при 401: такой ответ означает, что запрос не
// принят. Нет записи входа или повторный 401 — AuthRequired; не-2xx — TransportError(статус,
// первые 500 символов тела).
func (s *Session) post(ctx context.Context, payload *toolrt.Dict, timeout time.Duration) (string, []byte, error) {
	record := s.client.ReadCredentials()
	if record == nil {
		return "", nil, &AuthRequiredError{LoginRequired}
	}
	soon, err := s.client.expiring(record)
	if err != nil {
		return "", nil, err
	}
	if soon {
		if record, err = s.client.Refresh(ctx, record.Value("access_token")); err != nil {
			return "", nil, err
		}
	}
	text, err := toolrt.DumpsJSON(payload, toolrt.DumpOptions{})
	if err != nil {
		return "", nil, err
	}
	body, err := toolrt.EncodeUTF8(text)
	if err != nil {
		return "", nil, err
	}
	var answer response
	for attempt := 0; attempt < 2; attempt++ {
		token, err := bearer(record)
		if err != nil {
			return "", nil, err
		}
		answer, err = s.client.request(ctx, "POST", s.url, body, s.headers(token), timeout)
		if err != nil {
			return "", nil, err
		}
		if answer.status != 401 {
			break
		}
		if attempt > 0 {
			return "", nil, &AuthRequiredError{LoginRequired}
		}
		if record, err = s.client.Refresh(ctx, record.Value("access_token")); err != nil {
			return "", nil, err
		}
	}
	if answer.status < 200 || answer.status >= 300 {
		return "", nil, &TransportError{Status: answer.status, Text: firstRunes(toolrt.Strip(DecodeReplace(answer.data)), 500)}
	}
	return answer.contentType, answer.data, nil
}

// firstRunes — text[:limit] по кодовым точкам.
func firstRunes(text string, limit int) string {
	runes := toolrt.Runes(text)
	if len(runes) <= limit {
		return text
	}
	return toolrt.FromRunes(runes[:limit])
}

// Request — запрос JSON-RPC method с params; перед первым запросом сеанс выполняет initialize.
// Ответ ищется по id среди сообщений JSON или потока text/event-stream; нет ответа или поле
// error — ProtocolError. timeout 0 — таймаут сеанса.
func (s *Session) Request(ctx context.Context, method string, params *toolrt.Dict, timeout time.Duration) (any, error) {
	if s.protocol == "" && method != "initialize" {
		if _, err := s.Initialize(ctx); err != nil {
			return nil, err
		}
	}
	identifier := toolrt.NewInt(s.nextID)
	s.nextID++
	if params.Len() == 0 {
		params = toolrt.NewDict()
	}
	payload := toolrt.NewDict()
	payload.Set("jsonrpc", "2.0")
	payload.Set("id", identifier)
	payload.Set("method", method)
	payload.Set("params", params)
	if timeout <= 0 {
		timeout = s.timeout
	}
	contentType, data, err := s.post(ctx, payload, timeout)
	if err != nil {
		return nil, err
	}
	return answerFor(method, identifier, contentType, data)
}

// answerFor — разбор ответа JSON-RPC на запрос с идентификатором identifier.
func answerFor(method string, identifier any, contentType string, data []byte) (any, error) {
	var messages []any
	kind, _, _ := strings.Cut(contentType, ";")
	if strings.ToLower(toolrt.Strip(kind)) == "text/event-stream" {
		messages = SSEMessages(DecodeReplace(data))
	} else {
		value := jsonBody(data)
		if list, ok := value.([]any); ok {
			messages = list
		} else {
			messages = []any{value}
		}
	}
	var answer *toolrt.Dict
	for _, message := range messages {
		if item, ok := message.(*toolrt.Dict); ok && toolrt.Equal(item.Value("id"), identifier) {
			answer = item
			break
		}
	}
	if answer == nil {
		return nil, &ProtocolError{fmt.Sprintf("%s не вернул ответ JSON-RPC на запрос %s.", Title, method)}
	}
	if answer.Has("error") {
		failure, ok := answer.Value("error").(*toolrt.Dict)
		if !ok {
			failure = toolrt.NewDict()
		}
		message, found := failure.Get("message")
		if !found {
			message = "ошибка JSON-RPC"
		}
		return nil, &ProtocolError{fmt.Sprintf("%s: %s: %s (%s).", Title, method, toolrt.Str(message), toolrt.Str(failure.Value("code")))}
	}
	return answer.Value("result"), nil
}

// Initialize — initialize с версией ProtocolVersion и notifications/initialized. Версия ответа
// сервера (непустая строка) становится заголовком mcp-protocol-version.
func (s *Session) Initialize(ctx context.Context) (any, error) {
	client := toolrt.NewDict()
	client.Set("name", ClientName)
	client.Set("version", ClientName)
	params := toolrt.NewDict()
	params.Set("protocolVersion", ProtocolVersion)
	params.Set("capabilities", toolrt.NewDict())
	params.Set("clientInfo", client)
	result, err := s.Request(ctx, "initialize", params, 0)
	if err != nil {
		return nil, err
	}
	s.protocol = ProtocolVersion
	if values, ok := result.(*toolrt.Dict); ok {
		if version, ok := values.Value("protocolVersion").(string); ok && version != "" {
			s.protocol = version
		}
	}
	notification := toolrt.NewDict()
	notification.Set("jsonrpc", "2.0")
	notification.Set("method", "notifications/initialized")
	if _, _, err := s.post(ctx, notification, s.timeout); err != nil {
		return nil, err
	}
	return result, nil
}

// Tools — tools/list: список объявлений инструментов.
func (s *Session) Tools(ctx context.Context) ([]any, error) {
	result, err := s.Request(ctx, "tools/list", nil, 0)
	if err != nil {
		return nil, err
	}
	values, _ := result.(*toolrt.Dict)
	tools, ok := values.Value("tools").([]any)
	if !ok {
		return nil, &ProtocolError{Title + " вернул неверный список инструментов."}
	}
	return tools, nil
}

// Call — tools/call name с аргументами и taskTraceId (traceID или TraceID сеанса). Результат —
// тело инструмента (ToolBody). timeout 0 — таймаут сеанса.
func (s *Session) Call(ctx context.Context, name string, arguments *toolrt.Dict, timeout time.Duration, traceID any) (any, error) {
	values := toolrt.NewDict()
	if arguments != nil {
		values = arguments.Clone()
	}
	if !toolrt.Truthy(traceID) {
		traceID = s.TraceID
	}
	values.Set("taskTraceId", traceID)
	params := toolrt.NewDict()
	params.Set("name", name)
	params.Set("arguments", values)
	result, err := s.Request(ctx, "tools/call", params, timeout)
	if err != nil {
		return nil, err
	}
	return ToolBody(result)
}

// Upload — загрузка локального файла по одноразовому тикету: file_upload {filename, contentType,
// size} → multipart POST полей ticket и file на адрес тикета без токена. Результат — адрес файла у
// сервиса. Неподдерживаемое расширение отклоняется до сети (ValueError).
func (s *Session) Upload(ctx context.Context, path string, traceID any) (string, error) {
	contentType, err := UploadType(path)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", toolrt.OSErrorFrom(err, path)
	}
	name := toolrt.PathName(path)
	request := toolrt.NewDict()
	request.Set("filename", name)
	request.Set("contentType", contentType)
	request.Set("size", toolrt.NewInt(int64(len(data))))
	value, err := s.Call(ctx, "file_upload", request, 0, traceID)
	if err != nil {
		return "", err
	}
	ticket, isDict := value.(*toolrt.Dict)
	var target any
	if isDict {
		target, _ = toolrt.DictGet(ticket, "uploadUrl", ticket.Value("upload_url"))
	}
	ticketID, ticketOK := ticket.Value("ticket").(string)
	targetURL, targetOK := target.(string)
	if !isDict || !ticketOK || !targetOK {
		return "", &ProtocolError{Title + " не выдал тикет загрузки."}
	}
	body, multipartType := Multipart([]Field{{"ticket", ticketID}}, "file", name, contentType, data, "songframe-"+tokenHex(16))
	// Авторизует одноразовый тикет: токен на адрес загрузки не отправляется.
	timeout := time.Duration(120+(len(data)+65535)/65536) * time.Second
	answer, err := s.client.request(ctx, "POST", targetURL, body, []Field{{"Content-Type", multipartType}}, timeout)
	if err != nil {
		return "", err
	}
	url, err := FindUploadURL(jsonBody(answer.data))
	if err != nil {
		return "", err
	}
	if answer.status < 200 || answer.status >= 300 || url == "" {
		return "", &TransportError{Status: answer.status, Text: "загрузка файла " + name + " не принята"}
	}
	return url, nil
}

// SSEMessages — JSON-сообщения потока text/event-stream; строки data:
// одного события склеиваются через «\n», неразборчивые события пропускаются.
func SSEMessages(text string) []any {
	messages := []any{}
	lines := []string{}
	for _, line := range append(toolrt.SplitLines(text), "") {
		if strings.HasPrefix(line, "data:") {
			lines = append(lines, strings.TrimPrefix(line[5:], " "))
		} else if line == "" && len(lines) > 0 {
			if value := jsonBody([]byte(strings.Join(lines, "\n"))); value != nil {
				messages = append(messages, value)
			}
			lines = lines[:0]
		}
	}
	return messages
}

// ToolBody — structuredContent, иначе JSON из content[0].text, иначе сам
// текст. isError: true — ToolError с первыми 500 символами текста.
func ToolBody(result any) (any, error) {
	values, ok := result.(*toolrt.Dict)
	if !ok {
		return nil, &ProtocolError{Title + " вернул неверный результат инструмента."}
	}
	var text any
	if content, ok := values.Value("content").([]any); ok && len(content) > 0 {
		if first, ok := content[0].(*toolrt.Dict); ok {
			text = first.Value("text")
		}
	}
	if values.Value("isError") == true {
		message := "отказ без пояснения"
		if text != nil {
			message = toolrt.Str(text)
		}
		return nil, &ToolError{firstRunes(toolrt.Strip(message), 500)}
	}
	if values.Has("structuredContent") {
		return values.Value("structuredContent"), nil
	}
	body, ok := text.(string)
	if !ok {
		return nil, &ProtocolError{Title + " вернул результат инструмента без текста."}
	}
	data, err := toolrt.EncodeUTF8(body)
	if err != nil {
		return nil, err
	}
	if value := jsonBody(data); value != nil {
		return value, nil
	}
	// jsonBody не различает неразобранное тело и разобранный JSON null: оба — nil, тогда возвращается текст.
	return body, nil
}

// FindUploadURL — первый http(s)-адрес по ключам uploadURLKeys при
// обходе в глубину (сначала ключи словаря, затем его значения по порядку). Пусто — не найден.
func FindUploadURL(value any) (string, error) {
	var values []any
	switch item := value.(type) {
	case *toolrt.Dict:
		for _, key := range uploadURLKeys {
			if text, ok := item.Value(key).(string); ok {
				scheme, err := URLScheme(text)
				if err != nil {
					return "", err
				}
				if scheme == "http" || scheme == "https" {
					return text, nil
				}
			}
		}
		for _, key := range item.Keys() {
			values = append(values, item.Value(key))
		}
	case []any:
		values = item
	default:
		return "", nil
	}
	for _, item := range values {
		found, err := FindUploadURL(item)
		if err != nil || found != "" {
			return found, err
		}
	}
	return "", nil
}

// UploadType — Content-Type загрузки по расширению; прочие — ValueError до сети.
func UploadType(path string) (string, error) {
	contentType, ok := UploadTypes[strings.ToLower(toolrt.PathSuffix(path))]
	if !ok {
		return "", toolrt.Raise(toolrt.ValueError, "%s принимает загрузку только PNG, JPEG, MP4, WAV и MP3: %s.", Title, toolrt.PathName(path))
	}
	return contentType, nil
}

// Multipart — тело multipart/form-data: поля по порядку и один файл; кавычки и «\» в имени файла
// заменяются «_». Возвращает тело и Content-Type с границей boundary.
func Multipart(fields []Field, fileField, filename, contentType string, data []byte, boundary string) ([]byte, string) {
	quoted := strings.NewReplacer("\\", "_", "\"", "_").Replace(filename)
	var body []byte
	for _, field := range fields {
		body = append(body, "--"+boundary+"\r\nContent-Disposition: form-data; name=\""+field.Name+"\"\r\n\r\n"+field.Value+"\r\n"...)
	}
	body = append(body, "--"+boundary+"\r\nContent-Disposition: form-data; name=\""+fileField+"\"; filename=\""+quoted+"\"\r\n"+
		"Content-Type: "+contentType+"\r\n\r\n"...)
	body = append(body, data...)
	body = append(body, "\r\n--"+boundary+"--\r\n"...)
	return body, "multipart/form-data; boundary=" + boundary
}

// Debug — отладка неизвестного исхода только в явно заданный
// файл (DebugFile или SONGFRAME_KLING_DEBUG_FILE), без заголовков авторизации и токенов.
// status и body — nil, если они неизвестны.
func (c *Client) Debug(event string, err error, status *int, body *string) {
	target := c.DebugFile
	if target == "" {
		target = os.Getenv(DebugEnv)
	}
	if target == "" {
		return
	}
	stream, openErr := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o666)
	if openErr != nil {
		return
	}
	defer stream.Close()
	name, message := "", "None"
	if err != nil {
		name, message = ErrorTypeName(err), err.Error()
	}
	text := fmt.Sprintf("--- %s %s %s: %s\n", event, time.Now().Format("15:04:05"), name, message)
	if status != nil {
		text += fmt.Sprintf("status: %d\n", *status)
	}
	if body != nil {
		text += "body: " + *body + "\n"
	}
	_, _ = stream.WriteString(toolrt.TextMode(text))
}
