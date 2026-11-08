package mcp

import (
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe/internal/golden"
	"songframe/internal/toolrt"
)

// Эталоны kling-request: cases.json — чистые функции, traces.json — точные HTTP-запросы клиента на
// сценарии ответов, callback.json — ответы колбэка входа. Значения записаны JSON-строками,
// исключения — {type, message}.

const domain = "kling-request"

// field — поле объекта эталона.
func field(value any, key string) any { return value.(*toolrt.Dict).Value(key) }

// arg — аргумент случая, записанный JSON-строкой.
func arg(t *testing.T, entry any, key string) any {
	t.Helper()
	return golden.ParseValue(t, golden.ValueString(t, field(entry, "args"), key))
}

// dumps — компактная JSON-запись value без экранирования не-ASCII (toolrt.DumpsJSON).
func dumps(t *testing.T, value any) string {
	t.Helper()
	text, err := toolrt.DumpsJSON(value, toolrt.DumpOptions{})
	if err != nil {
		t.Fatalf("сериализация: %v", err)
	}
	return text
}

// assertOutcome сверяет исход с {result} или {error: {type, message}} эталона; normalize
// приводит текст перед сравнением (nil — без изменений).
func assertOutcome(t *testing.T, label string, expected any, got any, err error, normalize func(string) string) {
	t.Helper()
	if normalize == nil {
		normalize = func(text string) string { return text }
	}
	want := expected.(*toolrt.Dict)
	if failure, ok := want.Value("error").(*toolrt.Dict); ok {
		wantType, wantMessage := failure.Value("type").(string), failure.Value("message").(string)
		if err == nil {
			t.Errorf("%s: ожидалось %s: %s, получено %s", label, wantType, wantMessage, dumps(t, got))
			return
		}
		if gotType := ErrorTypeName(err); gotType != wantType || normalize(err.Error()) != normalize(wantMessage) {
			t.Errorf("%s: исключение\n  ожидалось %s: %s\n  получено  %s: %s", label, wantType, wantMessage, gotType, err.Error())
		}
		return
	}
	if err != nil {
		t.Errorf("%s: ожидалось %s, получено исключение %s: %v", label, want.Value("result"), ErrorTypeName(err), err)
		return
	}
	if text, wantText := normalize(dumps(t, got)), normalize(want.Value("result").(string)); text != wantText {
		t.Errorf("%s:\n  ожидалось %s\n  получено  %s", label, wantText, text)
	}
}

// fields — список пар [[имя, значение]] как []Field.
func fields(value any) []Field {
	result := []Field{}
	for _, item := range value.([]any) {
		pair := item.([]any)
		result = append(result, Field{pair[0].(string), pair[1].(string)})
	}
	return result
}

// urlPartsDict — части адреса в форме объекта эталона.
func urlPartsDict(parts URLParts) *toolrt.Dict {
	result := toolrt.NewDict()
	result.Set("scheme", parts.Scheme)
	result.Set("netloc", parts.Netloc)
	result.Set("path", parts.Path)
	result.Set("query", parts.Query)
	result.Set("fragment", parts.Fragment)
	var hostname any
	if host := parts.Hostname(); host != "" {
		hostname = host
	}
	result.Set("hostname", hostname)
	port, has, err := parts.Port()
	var portValue, portError any
	if err != nil {
		failure := toolrt.NewDict()
		failure.Set("type", ErrorTypeName(err))
		failure.Set("message", err.Error())
		portError = failure
	} else if has {
		portValue = toolrt.NewInt(int64(port))
	}
	result.Set("port", portValue)
	result.Set("port_error", portError)
	return result
}

// TestPureGolden — чистые функции клиента на cases.json.
func TestPureGolden(t *testing.T) {
	cases := golden.ValueFile(t, domain, "cases.json").([]any)
	count := 0
	for _, entry := range cases {
		name, call := golden.ValueString(t, entry, "name"), golden.ValueString(t, entry, "call")
		expected := field(entry, "expected")
		var got any
		var err error
		switch call {
		case "tool_body":
			got, err = ToolBody(arg(t, entry, "result"))
		case "sse_messages":
			got = SSEMessages(arg(t, entry, "text").(string))
		case "find_upload_url":
			var found string
			found, err = FindUploadURL(arg(t, entry, "value"))
			if found != "" {
				got = found
			}
		case "upload_type":
			got, err = UploadType(arg(t, entry, "path").(string))
		case "token_record":
			now, _ := toolrt.Float(arg(t, entry, "now"))
			got, err = TokenRecord(arg(t, entry, "previous").(*toolrt.Dict), arg(t, entry, "answer").(*toolrt.Dict), now)
		case "multipart":
			filename := arg(t, entry, "filename").(string)
			data, _ := base64.StdEncoding.DecodeString(arg(t, entry, "data").(string))
			contentType, _ := UploadType(filename)
			body, multipartType := Multipart([]Field{{"ticket", "ticket-9"}}, "file", filename, contentType, data, arg(t, entry, "boundary").(string))
			result := toolrt.NewDict()
			result.Set("body", base64.StdEncoding.EncodeToString(body))
			result.Set("content_type", multipartType)
			got = result
		case "urlencode":
			got = URLEncode(fields(arg(t, entry, "fields")))
		case "query":
			got = ParseQueryFirst(arg(t, entry, "query").(string))
		case "url":
			var parts URLParts
			parts, err = ParseURL(arg(t, entry, "url").(string))
			got = urlPartsDict(parts)
		case "answer":
			data, _ := base64.StdEncoding.DecodeString(arg(t, entry, "data").(string))
			got, err = answerFor(arg(t, entry, "method").(string), toolrt.NewInt(0), arg(t, entry, "content_type").(string), data)
		default:
			continue
		}
		count++
		assertOutcome(t, name, expected, got, err, nil)
	}
	if count < 80 {
		t.Fatalf("проверено %d случаев клиента — меньше ожидаемого", count)
	}
}

// scripted — сервер сценария трассы: отвечает по очереди заданными ответами и записывает
// запросы. Ответ {"raise"} имитирует обрыв соединения без ответа.
type scripted struct {
	mu        sync.Mutex
	responses []any
	requests  []*http.Request
	bodies    [][]byte
	base      string
}

func (s *scripted) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	body, _ := io.ReadAll(request.Body)
	s.mu.Lock()
	s.requests = append(s.requests, request)
	s.bodies = append(s.bodies, body)
	var answer *toolrt.Dict
	if len(s.responses) > 0 {
		answer = s.responses[0].(*toolrt.Dict)
		s.responses = s.responses[1:]
	}
	s.mu.Unlock()
	if answer == nil {
		http.Error(writer, "нет ответа в сценарии", 599)
		return
	}
	if answer.Has("raise") {
		connection, _, err := writer.(http.Hijacker).Hijack()
		if err == nil {
			connection.Close()
		}
		return
	}
	var data []byte
	if encoded, ok := answer.Value("body_b64").(string); ok {
		data, _ = base64.StdEncoding.DecodeString(encoded)
	} else if text, ok := answer.Value("body").(string); ok {
		data = []byte(text)
	} else {
		encoded, _ := toolrt.DumpsJSON(answer.Value("body"), toolrt.DumpOptions{EnsureASCII: true})
		data = []byte(encoded)
	}
	contentType, ok := answer.Value("type").(string)
	if !ok {
		contentType = "application/json"
	}
	writer.Header().Set("Content-Type", contentType)
	status, _ := answer.Value("status").(toolrt.Int).Int64()
	writer.WriteHeader(int(status))
	_, _ = writer.Write(data)
}

// traceBase — адрес сервера в трассах эталона.
const traceBase = "http://kling.test"

// fromTrace переводит текст эталона на адрес тестового сервера (и обратно — toTrace), включая
// формы, где адрес закодирован quote_plus.
func replacer(from, to string) *strings.Replacer {
	return strings.NewReplacer(from, to, url.QueryEscape(from), url.QueryEscape(to))
}

// socketName — описание сбоя соединения в тексте ошибки транспорта (SocketFailure): обрыв
// сценария даёт другой сбой, чем записан в эталоне.
var socketName = regexp.MustCompile(`(прервано после отправки|Нет соединения с Kling): [^.:]+\.`)

// TestTracesGolden — точные запросы клиента (метод, адрес, явные заголовки, тело), результаты и
// байты записи входа на сценариях traces.json.
func TestTracesGolden(t *testing.T) {
	upload := filepath.Join(t.TempDir(), "кадр 01.png")
	data, err := os.ReadFile(filepath.Join(mustGoldenRoot(t), domain, "upload", "кадр 01.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(upload, data, 0o644); err != nil {
		t.Fatal(err)
	}
	previous := tokenHex
	tokenHex = func(int) string { return strings.Repeat("0", 32) }
	t.Cleanup(func() { tokenHex = previous })
	now := time.Unix(1800000000, 250000000)
	for _, entry := range golden.ValueFile(t, domain, "traces.json").([]any) {
		name := golden.ValueString(t, entry, "name")
		t.Run(name, func(t *testing.T) {
			script := &scripted{}
			server := httptest.NewServer(script)
			defer server.Close()
			in, out := replacer(traceBase, server.URL), replacer(server.URL, traceBase)
			responses := golden.ParseValue(t, in.Replace(golden.ValueString(t, entry, "responses"))).([]any)
			script.responses = responses
			client := &Client{StateDir: t.TempDir(), BaseURL: server.URL, Now: func() time.Time { return now }}
			if stored := golden.ParseValue(t, in.Replace(golden.ValueString(t, entry, "stored"))); stored != nil {
				if err := client.WriteCredentials(stored.(*toolrt.Dict)); err != nil {
					t.Fatal(err)
				}
			}
			result, err := traceAction(t, client, name, upload)
			// Записи сервера читаются под его блокировкой: обрыв соединения не упорядочивает их для race.
			script.mu.Lock()
			defer script.mu.Unlock()
			expected := field(entry, "expected").(*toolrt.Dict)
			normalize := func(text string) string { return socketName.ReplaceAllString(out.Replace(text), "$1: <socket>.") }
			assertOutcome(t, name, expected, result, err, normalize)
			wantRequests := golden.ParseValue(t, expected.Value("requests").(string)).([]any)
			if len(wantRequests) != len(script.requests) {
				t.Fatalf("запросов %d, ожидалось %d", len(script.requests), len(wantRequests))
			}
			for index, want := range wantRequests {
				compareRequest(t, index, want.(*toolrt.Dict), script.requests[index], script.bodies[index], in)
			}
			if unused, _ := expected.Value("unused").(toolrt.Int).Int64(); int(unused) != len(script.responses) {
				t.Errorf("неиспользованных ответов %d, ожидалось %d", len(script.responses), unused)
			}
			stored, readErr := os.ReadFile(client.CredentialsPath())
			if wantText, ok := expected.Value("credentials").(string); ok {
				if readErr != nil || out.Replace(string(stored)) != wantText {
					t.Errorf("credentials.json:\n  ожидалось %q\n  получено  %q (%v)", wantText, out.Replace(string(stored)), readErr)
				}
			} else if readErr == nil {
				t.Errorf("credentials.json не ожидался: %s", stored)
			}
		})
	}
}

// implicitHeaders — заголовки, которые клиент задаёт для каждого запроса или добавляет net/http сам.
var implicitHeaders = map[string]bool{"Host": true, "Accept-Encoding": true, "Content-Length": true, "Connection": true}

// compareRequest сверяет запрос сценария с эталоном: метод, адрес, набор явных заголовков и тело.
func compareRequest(t *testing.T, index int, want *toolrt.Dict, got *http.Request, body []byte, in *strings.Replacer) {
	t.Helper()
	wantURL := in.Replace(want.Value("url").(string))
	parsed, _ := url.Parse(wantURL)
	if got.Method != want.Value("method") || got.RequestURI != parsed.RequestURI() {
		t.Errorf("запрос %d: %s %s, ожидалось %s %s", index, got.Method, got.RequestURI, want.Value("method"), parsed.RequestURI())
	}
	names := map[string]bool{}
	for _, item := range want.Value("headers").([]any) {
		pair := item.([]any)
		name := http.CanonicalHeaderKey(pair[0].(string))
		names[name] = true
		if value := got.Header.Get(name); value != pair[1] {
			t.Errorf("запрос %d: заголовок %s=%q, ожидалось %q", index, name, value, pair[1])
		}
	}
	for name := range got.Header {
		if !names[name] && !implicitHeaders[name] {
			t.Errorf("запрос %d: лишний заголовок %s: %q", index, name, got.Header.Get(name))
		}
	}
	if got.Header.Get("Accept-Encoding") != "identity" {
		t.Errorf("запрос %d: Accept-Encoding %q", index, got.Header.Get("Accept-Encoding"))
	}
	wantBody, _ := base64.StdEncoding.DecodeString(want.Value("body").(string))
	if in.Replace(string(wantBody)) != string(body) {
		t.Errorf("запрос %d: тело\n  ожидалось %q\n  получено  %q", index, in.Replace(string(wantBody)), body)
	}
}

// traceAction — действие сценария трассы.
func traceAction(t *testing.T, client *Client, name, upload string) (any, error) {
	ctx := context.Background()
	record := func() *toolrt.Dict { return client.ReadCredentials() }
	switch {
	case strings.HasPrefix(name, "discover"):
		endpoints, err := client.Discover(ctx)
		if err != nil {
			return nil, err
		}
		result := toolrt.NewDict()
		result.Set("authorize", endpoints.Authorize)
		result.Set("token", endpoints.Token)
		result.Set("register", endpoints.Register)
		result.Set("revoke", endpoints.Revoke)
		result.Set("resource", endpoints.Resource)
		result.Set("scope", endpoints.Scope)
		return result, nil
	case strings.HasPrefix(name, "register"):
		return client.register(ctx, Endpoints{Register: client.baseURL() + "/auth/register"})
	case name == "session":
		session := client.NewSession(0, "trace-1")
		tools, err := session.Tools(ctx)
		if err != nil {
			return nil, err
		}
		arguments := toolrt.NewDict()
		arguments.Set("tools", []any{"x"})
		arguments.Set("taskTraceId", "override")
		who, err := session.Call(ctx, "who_am_i", arguments, 0, nil)
		if err != nil {
			return nil, err
		}
		tasks, err := session.Call(ctx, "query_tasks", nil, 0, "other")
		if err != nil {
			return nil, err
		}
		return []any{tools, who, tasks}, nil
	case name == "session-sse", name == "no-credentials", strings.HasPrefix(name, "unauthorized"), name == "rpc-error":
		return client.NewSession(0, "t").Call(ctx, "who_am_i", nil, 0, nil)
	case strings.HasPrefix(name, "http-error"):
		return client.NewSession(0, "t").Call(ctx, "query_tasks", nil, 0, nil)
	case name == "protocol-default":
		return client.NewSession(0, "t").Call(ctx, "x", nil, 0, nil)
	case name == "refresh-expiring":
		return client.NewSession(0, "t").Call(ctx, "who_am_i", nil, 0, nil)
	case name == "refresh-fresh":
		return client.Refresh(ctx, "stale")
	case strings.HasPrefix(name, "refresh"):
		return client.Refresh(ctx, record().Value("access_token"))
	case name == "upload-snake":
		return client.NewSession(0, "t").Upload(ctx, upload, "explicit")
	case name == "upload":
		return client.NewSession(0, "trace-u").Upload(ctx, upload, nil)
	case strings.HasPrefix(name, "upload"):
		return client.NewSession(0, "t").Upload(ctx, upload, nil)
	case strings.HasPrefix(name, "revoke"):
		value := toolrt.NewDict()
		switch name {
		case "revoke-skip":
			value.Set("refresh_token", "r")
		default:
			value = recordFor(client)
		}
		return nil, client.revoke(ctx, value)
	case name == "invalid-base":
		_, err := client.request(ctx, "GET", "ftp://kling.test/x", nil, nil, CallTimeout)
		return nil, err
	}
	t.Fatalf("нет действия для трассы %s", name)
	return nil, nil
}

// recordFor — запись входа сценария для отзыва.
func recordFor(client *Client) *toolrt.Dict {
	base := client.baseURL()
	record := toolrt.NewDict()
	record.Set("client_id", "client-1")
	record.Set("access_token", "access-1")
	record.Set("refresh_token", "refresh-1")
	record.Set("expires_at", toolrt.NewInt(1800000000+3600))
	record.Set("token_endpoint", base+"/auth/token")
	record.Set("revocation_endpoint", base+"/auth/revoke")
	record.Set("resource", base+"/mcp")
	record.Set("scope", DefaultScope)
	return record
}

// mustGoldenRoot — корень testdata/golden.
func mustGoldenRoot(t *testing.T) string {
	t.Helper()
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// TestCallbackGolden — ответы колбэка входа: статус, страница, Content-Type и принятый результат.
func TestCallbackGolden(t *testing.T) {
	for _, entry := range golden.ValueFile(t, domain, "callback.json").([]any) {
		name := golden.ValueString(t, entry, "name")
		target := golden.ValueString(t, entry, "target")
		expected := field(entry, "expected").(*toolrt.Dict)
		t.Run(name, func(t *testing.T) {
			client := &Client{LoginPorts: []int{0}}
			server, err := client.Listen("expected")
			if err != nil {
				t.Fatal(err)
			}
			defer server.Close()
			response, err := http.Get("http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(server.Port())) + target)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			status, _ := expected.Value("status").(toolrt.Int).Int64()
			if response.StatusCode != int(status) || string(body) != expected.Value("body") || response.Header.Get("Content-Type") != expected.Value("content_type") {
				t.Errorf("ответ %d %q %q, ожидалось %d %q %q", response.StatusCode, body, response.Header.Get("Content-Type"), status, expected.Value("body"), expected.Value("content_type"))
			}
			var result any
			if values := server.Result(); values != nil {
				dict := toolrt.NewDict()
				for _, key := range []string{"code", "error"} {
					if value, ok := values[key]; ok {
						dict.Set(key, value)
					}
				}
				result = dict
			}
			if dumps(t, result) != expected.Value("result") {
				t.Errorf("результат %s, ожидалось %s", dumps(t, result), expected.Value("result"))
			}
			done := false
			select {
			case <-server.Done():
				done = true
			default:
			}
			if done != (expected.Value("done") == true) {
				t.Errorf("done=%v", done)
			}
		})
	}
}
