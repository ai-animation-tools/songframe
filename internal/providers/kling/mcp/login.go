package mcp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"songframe/internal/toolrt"
)

// CallbackServer — loopback-сервер одного входа на 127.0.0.1: ждёт GET /callback с тем же state
// и запоминает код или ошибку авторизации. Строка запроса содержит код, поэтому сервер ничего не
// журналирует.
type CallbackServer struct {
	listener net.Listener
	server   *http.Server
	state    string

	mu     sync.Mutex
	result map[string]string
	done   chan struct{}
	once   sync.Once
}

// Port — фактический порт колбэка.
func (s *CallbackServer) Port() int { return s.listener.Addr().(*net.TCPAddr).Port }

// Done закрывается после первого принятого ответа авторизации (код или ошибка).
func (s *CallbackServer) Done() <-chan struct{} { return s.done }

// Result — {"code": …} или {"error": …} последнего принятого ответа; nil — ответа ещё нет.
func (s *CallbackServer) Result() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.result
}

// Close останавливает сервер (server.shutdown + server_close).
func (s *CallbackServer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.server.Shutdown(ctx)
	_ = s.server.Close()
}

// reply — страница ответа колбэка; разметка зафиксирована эталоном callback.json.
func reply(writer http.ResponseWriter, status int, text string) {
	body := []byte("<!doctype html><meta charset='utf-8'><title>SongFrame</title><p>" + text + "</p>")
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}

// ServeHTTP принимает GET колбэка входа и отвечает страницей reply.
func (s *CallbackServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		// Колбэк входа принимает только GET; прочие методы — 501 с названием метода.
		reply(writer, http.StatusNotImplemented, "Метод не поддерживается: "+toolrt.Repr(request.Method))
		return
	}
	parts, _ := ParseURL(request.RequestURI)
	if parts.Path != "/callback" {
		reply(writer, 404, "Не найдено.")
		return
	}
	values := ParseQueryFirst(parts.Query)
	query := func(key string) string { text, _ := values.Value(key).(string); return text }
	if query("state") != s.state {
		reply(writer, 400, "Неверный state: начните вход заново из SongFrame.")
		return
	}
	var result map[string]string
	switch {
	case query("error") != "":
		message := query("error_description")
		if message == "" {
			message = query("error")
		}
		result = map[string]string{"error": message}
		reply(writer, 400, "Вход в "+Title+" отменён. Вернитесь в SongFrame.")
	case query("code") != "":
		result = map[string]string{"code": query("code")}
		reply(writer, 200, "Вход в "+Title+" выполнен. Вернитесь в SongFrame.")
	default:
		reply(writer, 400, "Ответ без кода авторизации.")
		return
	}
	s.mu.Lock()
	s.result = result
	s.mu.Unlock()
	s.once.Do(func() { close(s.done) })
}

// Listen — сервер колбэка на первом свободном порту из списка клиента. Занятый
// порт пропускается (Go в Windows не ставит SO_REUSEADDR, поэтому чужой слушающий порт не
// перехватывается). Все порты заняты — NotSent.
func (c *Client) Listen(state string) (*CallbackServer, error) {
	for _, port := range c.ports() {
		listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			continue
		}
		server := &CallbackServer{listener: listener, state: state, done: make(chan struct{})}
		server.server = &http.Server{Handler: server, ReadHeaderTimeout: 30 * time.Second}
		// Соединение закрывается после ответа (как у сервера HTTP/1.0).
		server.server.SetKeepAlivesEnabled(false)
		go func() { _ = server.server.Serve(listener) }()
		return server, nil
	}
	return nil, &NotSentError{"Порты входа 8787–8790 заняты: закройте программу, которая их использует, и повторите вход."}
}

// LoginOptions — параметры входа в браузере.
type LoginOptions struct {
	// Timeout — ожидание подтверждения; 0 — LoginTimeout.
	Timeout time.Duration
	// Report получает строки «AUTHORIZE_URL <адрес>» и «BROWSER_NOT_OPENED»: приложение
	// показывает адрес, если браузер не открылся. nil — не сообщать.
	Report func(line string)
	// OpenBrowser открывает адрес авторизации средствами оболочки; nil или ошибка — браузер не
	// открыт (как --no-browser).
	OpenBrowser func(url string) error
}

// Login — регистрация клиента, loopback-колбэк, PKCE S256, state и resource, обмен кода
// и замена сохранённой записи под блокировкой; прежний refresh token после замены отзывается без
// влияния на результат. Отмена ctx прекращает ожидание: ошибка тогда errors.Is(context.Canceled),
// сохранённая запись не меняется.
func (c *Client) Login(ctx context.Context, options LoginOptions) (*toolrt.Dict, error) {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = LoginTimeout
	}
	report := options.Report
	if report == nil {
		report = func(string) {}
	}
	endpoints, err := c.Discover(ctx)
	if err != nil {
		return nil, err
	}
	clientID, err := c.register(ctx, endpoints)
	if err != nil {
		return nil, err
	}
	verifier, challenge := PKCE()
	state := tokenURLSafe(16)
	server, err := c.Listen(state)
	if err != nil {
		return nil, err
	}
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", server.Port())
	query := URLEncode([]Field{
		{"response_type", "code"},
		{"client_id", clientID},
		{"redirect_uri", redirect},
		{"state", state},
		{"code_challenge", challenge},
		{"code_challenge_method", "S256"},
		{"scope", endpoints.Scope},
		{"resource", endpoints.Resource},
	})
	authorize := endpoints.Authorize + "?" + query
	waitErr := func() error {
		defer server.Close()
		// Адрес авторизации не секретен (без кода и verifier): приложение показывает его.
		report("AUTHORIZE_URL " + authorize)
		opened := false
		if options.OpenBrowser != nil {
			opened = options.OpenBrowser(authorize) == nil
		}
		if !opened {
			report("BROWSER_NOT_OPENED")
		}
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case <-server.Done():
			return nil
		case <-timer.C:
			return &AuthRequiredError{"Вход в " + Title + " не подтверждён в браузере за отведённое время."}
		case <-ctx.Done():
			return &cancelledError{"Вход в " + Title + " отменён.", ctx.Err()}
		}
	}()
	if waitErr != nil {
		return nil, waitErr
	}
	result := server.Result()
	if message, ok := result["error"]; ok {
		return nil, &AuthRequiredError{Title + " отклонил вход: " + message}
	}
	status, answer, err := c.oauthPost(ctx, endpoints.Token, []Field{
		{"grant_type", "authorization_code"},
		{"client_id", clientID},
		{"code", result["code"]},
		{"code_verifier", verifier},
		{"redirect_uri", redirect},
		{"resource", endpoints.Resource},
	})
	if err != nil {
		return nil, err
	}
	if status != 200 || answer == nil {
		return nil, &TransportError{Status: status, Text: Title + " не обменял код авторизации на токен."}
	}
	client := toolrt.NewDict()
	client.Set("client_id", clientID)
	client.Set("token_endpoint", endpoints.Token)
	client.Set("revocation_endpoint", endpoints.Revoke)
	client.Set("resource", endpoints.Resource)
	client.Set("scope", endpoints.Scope)
	record, err := TokenRecord(client, answer, c.now())
	if err != nil {
		return nil, err
	}
	var previous *toolrt.Dict
	if err := c.withCredentialsLock(func() error {
		previous = c.ReadCredentials()
		return c.WriteCredentials(record)
	}); err != nil {
		return nil, err
	}
	if previous != nil && !toolrt.Equal(previous.Value("refresh_token"), record.Value("refresh_token")) {
		if err := c.revoke(ctx, previous); err != nil {
			return nil, err
		}
	}
	return record, nil
}

// IsCancelled — ошибка означает отмену операции вызывающим (контекст отменён или истёк).
func IsCancelled(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
