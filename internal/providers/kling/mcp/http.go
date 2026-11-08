package mcp

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"songframe/internal/toolrt"
)

// Постоянные клиента; от них зависят запросы, зафиксированные эталонами.
const (
	// Title — название сервиса в сообщениях.
	Title = "Kling"
	// ProviderID — id провайдера и имя папки в каталоге состояния.
	ProviderID = "kling"
	// DefaultBaseURL — адрес сервера.
	DefaultBaseURL = "https://kling.ai"
	// BaseURLEnv подменяет адрес сервера только для тестов с локальным поддельным сервером.
	BaseURLEnv = "SONGFRAME_KLING_BASE_URL"
	// DebugEnv — файл отладки неизвестного исхода отправки.
	DebugEnv = "SONGFRAME_KLING_DEBUG_FILE"
	// ClientName — имя публичного клиента OAuth и clientInfo MCP.
	ClientName = "songframe"
	// ProtocolVersion — версия MCP, предлагаемая в initialize.
	ProtocolVersion = "2025-11-25"
	// DefaultScope — scope, если метаданные сервера его не объявили.
	DefaultScope = "generation.create generation.read account.credit.read"

	// LoginTimeout — ожидание подтверждения входа в браузере.
	LoginTimeout = 300 * time.Second
	// CallTimeout — обычный вызов MCP.
	CallTimeout = 60 * time.Second
	// SubmitTimeout — платная отправка может отвечать дольше обычного вызова; обрыв по короткому
	// таймауту дал бы неизвестный исход.
	SubmitTimeout = 300 * time.Second
	// OAuthTimeout — запросы к token/register/revoke.
	OAuthTimeout = 30 * time.Second
	// DiscoveryTimeout — чтение метаданных OAuth.
	DiscoveryTimeout = 10 * time.Second
	// RefreshMargin — токен обновляется заранее, чтобы не истёк по дороге к серверу (секунды).
	RefreshMargin = 60
)

// LoginPorts — порты loopback-колбэка, зарегистрированные у сервера.
var LoginPorts = []int{8787, 8788, 8789, 8790}

// LoginRequired — текст AuthRequired без сохранённого входа.
var LoginRequired = "Войдите в " + Title + " на странице «Среда»."

// Client — настройки клиента: каталог состояния (владелец записей входа), адрес сервера и
// подмены для тестов. Нулевые поля берут штатные значения: адрес — из SONGFRAME_KLING_BASE_URL
// или https://kling.ai, файл отладки — из SONGFRAME_KLING_DEBUG_FILE, порты — LoginPorts.
// Экземпляр безопасен для параллельного использования: общее состояние — только транспорт,
// а обновление токена сериализуется межпроцессной блокировкой файла.
type Client struct {
	// StateDir — каталог состояния приложения.
	StateDir string
	// BaseURL — адрес сервера; пусто — переменная окружения или DefaultBaseURL.
	BaseURL string
	// DebugFile — файл отладки; пусто — переменная окружения DebugEnv.
	DebugFile string
	// LoginPorts — порты колбэка входа; nil — LoginPorts. Порт 0 — свободный (тесты).
	LoginPorts []int
	// TLSConfig — корни доверия HTTPS (тесты); nil — системные, как ssl.create_default_context.
	TLSConfig *tls.Config
	// Now — текущее время (тесты истечения токена); nil — time.Now.
	Now func() time.Time

	once   sync.Once
	client *http.Client
}

// NewClient — клиент с каталогом состояния и остальными значениями по умолчанию.
func NewClient(stateDir string) *Client { return &Client{StateDir: stateDir} }

// baseURL — адрес без завершающих «/».
func (c *Client) baseURL() string {
	value := c.BaseURL
	if value == "" {
		value = os.Getenv(BaseURLEnv)
	}
	if value == "" {
		value = DefaultBaseURL
	}
	return strings.TrimRight(value, "/")
}

// now — секунды Unix как time.time().
func (c *Client) now() float64 {
	current := time.Now()
	if c.Now != nil {
		current = c.Now()
	}
	return float64(current.UnixNano()) / 1e9
}

// ports — порты колбэка входа.
func (c *Client) ports() []int {
	if c.LoginPorts != nil {
		return c.LoginPorts
	}
	return LoginPorts
}

// httpClient — общий HTTP-клиент без перенаправлений, прокси и повторного использования
// соединений: одно соединение на запрос, редиректы не выполняются.
func (c *Client) httpClient() *http.Client {
	c.once.Do(func() {
		c.client = &http.Client{
			Transport: NewTransport(c.TLSConfig, false),
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	})
	return c.client
}

// timeoutKey — ключ контекста с таймаутом операции сокета для одного запроса.
type timeoutKey struct{}

// WithSocketTimeout — контекст запроса с таймаутом каждой операции сокета (подключение, каждое
// чтение и запись). Общий срок запроса не ограничивается: большой
// оригинал скачивается сколько нужно, пока данные идут.
func WithSocketTimeout(ctx context.Context, timeout time.Duration) context.Context {
	return context.WithValue(ctx, timeoutKey{}, timeout)
}

func socketTimeout(ctx context.Context) time.Duration {
	value, _ := ctx.Value(timeoutKey{}).(time.Duration)
	return value
}

// deadlineConn продлевает срок соединения перед каждой операцией: таймаут простоя, а не срок
// всего запроса.
type deadlineConn struct {
	net.Conn
	timeout time.Duration
}

func (c *deadlineConn) Read(data []byte) (int, error) {
	if c.timeout > 0 {
		_ = c.Conn.SetReadDeadline(time.Now().Add(c.timeout))
	}
	return c.Conn.Read(data)
}

func (c *deadlineConn) Write(data []byte) (int, error) {
	if c.timeout > 0 {
		_ = c.Conn.SetWriteDeadline(time.Now().Add(c.timeout))
	}
	return c.Conn.Write(data)
}

// dialFailure помечает сбой установки соединения (TCP или TLS): запрос не уходил.
type dialFailure struct{ err error }

func (d *dialFailure) Error() string { return d.err.Error() }
func (d *dialFailure) Unwrap() error { return d.err }

// NewTransport — транспорт с таймаутом операций из WithSocketTimeout и пометкой сбоев
// подключения. TLS-рукопожатие входит в подключение.
// proxy — брать прокси из окружения (при скачивании результатов; запросы MCP — без прокси).
func NewTransport(tlsConfig *tls.Config, proxy bool) *http.Transport {
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		timeout := socketTimeout(ctx)
		dialer := net.Dialer{Timeout: timeout}
		conn, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, &dialFailure{err}
		}
		return &deadlineConn{Conn: conn, timeout: timeout}, nil
	}
	transport := &http.Transport{
		DialContext:        dial,
		DisableKeepAlives:  true,
		DisableCompression: true,
		TLSClientConfig:    tlsConfig,
	}
	transport.DialTLSContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		config := &tls.Config{}
		if tlsConfig != nil {
			config = tlsConfig.Clone()
		}
		if config.ServerName == "" {
			host, _, _ := net.SplitHostPort(address)
			config.ServerName = host
		}
		client := tls.Client(conn, config)
		if err := client.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, &dialFailure{err}
		}
		return client, nil
	}
	if proxy {
		transport.Proxy = http.ProxyFromEnvironment
	}
	return transport
}

// response — статус, content_type и байты ответа HTTP.
type response struct {
	status      int
	contentType string
	data        []byte
}

// Request — один HTTP-запрос к адресу rawURL с телом и заголовками в заданном порядке.
// Неверный адрес — ValueError («Недопустимый адрес сервера.»); сбой подключения — *NotSentError;
// сбой после начала отправки — *TransportError без статуса. HTTP-статусы ошибкой не считаются.
func (c *Client) request(ctx context.Context, method, rawURL string, body []byte, headers []Field, timeout time.Duration) (response, error) {
	parts, err := ParseURL(rawURL)
	if err != nil {
		return response{}, err
	}
	hostname := parts.Hostname()
	if (parts.Scheme != "http" && parts.Scheme != "https") || hostname == "" {
		return response{}, toolrt.New(toolrt.ValueError, "Недопустимый адрес сервера.")
	}
	port, hasPort, err := parts.Port()
	if err != nil {
		return response{}, err
	}
	host := hostname
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if hasPort {
		host += ":" + strconv.Itoa(port)
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(WithSocketTimeout(ctx, timeout), method, parts.Scheme+"://"+host+"/", reader)
	if err != nil {
		return response{}, toolrt.New(toolrt.ValueError, "Недопустимый адрес сервера.")
	}
	path := parts.Path
	if path == "" {
		path = "/"
	}
	// Путь и запрос уходят дословно, без повторного кодирования net/url.
	request.URL.Opaque = path
	request.URL.RawQuery = parts.Query
	// Accept-Encoding: identity (тело читается без сжатия) и без User-Agent — как зафиксировано
	// эталонами запросов; имена заголовков записываются как заданы (mcp-protocol-version — строчными).
	request.Header = http.Header{"Accept-Encoding": {"identity"}, "User-Agent": {""}}
	for _, header := range headers {
		request.Header[header.Name] = []string{header.Value}
	}
	answer, err := c.httpClient().Do(request)
	if err != nil {
		var failure *dialFailure
		if errors.As(err, &failure) {
			return response{}, &NotSentError{"Нет соединения с " + Title + ": " + SocketFailure(failure.err, false) + "."}
		}
		return response{}, &TransportError{Text: "Соединение с " + Title + " прервано после отправки: " + SocketFailure(err, false) + "."}
	}
	defer answer.Body.Close()
	data, err := io.ReadAll(answer.Body)
	if err != nil {
		return response{}, &TransportError{Text: "Соединение с " + Title + " прервано после отправки: " + SocketFailure(err, true) + "."}
	}
	return response{status: answer.StatusCode, contentType: answer.Header.Get("Content-Type"), data: data}, nil
}

// SocketFailure — краткое русское описание сбоя соединения («время ожидания истекло», «в соединении
// отказано» и т. п.): оно входит в текст ошибок NotSent и TransportError и в ошибку скачивания
// результата. Адрес и прочие подробности ошибки Go в текст не попадают. body — сбой при чтении
// тела ответа (обрыв до объявленной длины — «ответ оборван»).
func SocketFailure(err error, body bool) string {
	var (
		dns       *net.DNSError
		authority x509.UnknownAuthorityError
		hostname  x509.HostnameError
		invalid   x509.CertificateInvalidError
		record    tls.RecordHeaderError
		alert     tls.AlertError
		netError  net.Error
	)
	switch {
	case errors.Is(err, context.Canceled):
		return "операция отменена"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded),
		errors.As(err, &netError) && netError.Timeout():
		return "время ожидания истекло"
	case errors.As(err, &dns):
		return "адрес не найден"
	case errors.As(err, &authority), errors.As(err, &hostname), errors.As(err, &invalid):
		return "сертификат не прошёл проверку"
	case errors.As(err, &record), errors.As(err, &alert):
		return "ошибка TLS"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "в соединении отказано"
	case errors.Is(err, syscall.ECONNRESET):
		return "соединение сброшено"
	case errors.Is(err, syscall.EPIPE):
		return "соединение разорвано"
	case errors.Is(err, io.ErrUnexpectedEOF) && body:
		return "ответ оборван"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "сервер закрыл соединение"
	}
	return "ошибка сети"
}

// jsonBody — JSON из UTF-8 или nil, если байты не разбираются.
func jsonBody(data []byte) any {
	text, err := toolrt.DecodeUTF8(data)
	if err != nil {
		return nil
	}
	value, err := toolrt.LoadsJSON(text)
	if err != nil {
		return nil
	}
	return value
}

// getJSON — объект JSON ответа 200 или nil; ошибки клиента не мешают discovery,
// а неверный адрес (ValueError) возвращается вызывающему.
func (c *Client) getJSON(ctx context.Context, rawURL string, timeout time.Duration) (*toolrt.Dict, error) {
	answer, err := c.request(ctx, "GET", rawURL, nil, []Field{{"Accept", "application/json"}}, timeout)
	if err != nil {
		if IsKlingError(err) {
			return nil, nil
		}
		return nil, err
	}
	if answer.status != 200 {
		return nil, nil
	}
	value, _ := jsonBody(answer.data).(*toolrt.Dict)
	return value, nil
}
