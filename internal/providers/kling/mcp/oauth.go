package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"songframe-go/internal/pycompat"
)

// Endpoints — адреса OAuth и параметры ресурса после discovery.
type Endpoints struct {
	Authorize string
	Token     string
	Register  string
	Revoke    string
	Resource  string
	Scope     string
}

// Discover — discover(): метаданные сервера (RFC 9728 и RFC 8414) поверх умолчаний
// `<base>/auth/*`; недоступные или неверные метаданные не мешают входу. Ошибка — только неверный
// адрес сервера (ValueError).
func (c *Client) Discover(ctx context.Context) (Endpoints, error) {
	base := c.baseURL()
	endpoints := Endpoints{
		Authorize: base + "/auth/authorize",
		Token:     base + "/auth/token",
		Register:  base + "/auth/register",
		Revoke:    base + "/auth/revoke",
		Resource:  base + "/mcp",
		Scope:     DefaultScope,
	}
	issuer := base + "/auth"
	resource, err := c.getJSON(ctx, base+"/.well-known/oauth-protected-resource", DiscoveryTimeout)
	if err != nil {
		return Endpoints{}, err
	}
	if resource.Len() > 0 {
		if value, ok := resource.Value("resource").(string); ok {
			endpoints.Resource = value
		}
		if servers, ok := resource.Value("authorization_servers").([]any); ok && len(servers) > 0 {
			if first, ok := servers[0].(string); ok {
				issuer = strings.TrimRight(first, "/")
			}
		}
	}
	parsed, err := ParseURL(issuer)
	if err != nil {
		return Endpoints{}, err
	}
	origin := parsed.Scheme + "://" + parsed.Netloc
	metadata, err := c.getJSON(ctx, origin+"/.well-known/oauth-authorization-server"+parsed.Path, DiscoveryTimeout)
	if err != nil {
		return Endpoints{}, err
	}
	if metadata == nil && parsed.Path != "" {
		if metadata, err = c.getJSON(ctx, issuer+"/.well-known/oauth-authorization-server", DiscoveryTimeout); err != nil {
			return Endpoints{}, err
		}
	}
	for _, item := range []struct {
		target *string
		name   string
	}{
		{&endpoints.Authorize, "authorization_endpoint"},
		{&endpoints.Token, "token_endpoint"},
		{&endpoints.Register, "registration_endpoint"},
		{&endpoints.Revoke, "revocation_endpoint"},
	} {
		if value, ok := metadata.Value(item.name).(string); ok {
			*item.target = value
		}
	}
	// (metadata or {}).get(...) or (resource or {}).get(...): пустой список — «нет».
	scopes := metadata.Value("scopes_supported")
	if !pycompat.Truthy(scopes) {
		scopes = resource.Value("scopes_supported")
	}
	if list, ok := scopes.([]any); ok && len(list) > 0 {
		names := make([]string, 0, len(list))
		for _, item := range list {
			if text, ok := item.(string); ok {
				names = append(names, text)
			}
		}
		if len(names) == len(list) {
			endpoints.Scope = strings.Join(names, " ")
		}
	}
	return endpoints, nil
}

// oauthPost — oauth_post(url, fields): форма к OAuth; ответ — статус и объект JSON или nil.
// Тело ответа не журналируется: в нём токены.
func (c *Client) oauthPost(ctx context.Context, url string, fields []Field) (int, *pycompat.Dict, error) {
	headers := []Field{{"Content-Type", "application/x-www-form-urlencoded"}, {"Accept", "application/json"}}
	answer, err := c.request(ctx, "POST", url, []byte(URLEncode(fields)), headers, OAuthTimeout)
	if err != nil {
		return 0, nil, err
	}
	value, _ := jsonBody(answer.data).(*pycompat.Dict)
	return answer.status, value, nil
}

// register — динамическая регистрация публичного клиента SongFrame без секрета. Колбэки
// перечисляют все порты LoginPorts на 127.0.0.1 и localhost, даже если тест слушает другой.
func (c *Client) register(ctx context.Context, endpoints Endpoints) (string, error) {
	redirects := []any{}
	for _, port := range LoginPorts {
		for _, host := range []string{"127.0.0.1", "localhost"} {
			redirects = append(redirects, fmt.Sprintf("http://%s:%d/callback", host, port))
		}
	}
	payload := pycompat.NewDict()
	payload.Set("client_name", ClientName)
	payload.Set("application_type", "native")
	payload.Set("redirect_uris", redirects)
	payload.Set("grant_types", []any{"authorization_code", "refresh_token"})
	payload.Set("response_types", []any{"code"})
	payload.Set("token_endpoint_auth_method", "none")
	body, err := pycompat.DumpsJSON(payload, pycompat.DumpOptions{EnsureASCII: true})
	if err != nil {
		return "", err
	}
	headers := []Field{{"Content-Type", "application/json"}, {"Accept", "application/json"}}
	answer, err := c.request(ctx, "POST", endpoints.Register, []byte(body), headers, OAuthTimeout)
	if err != nil {
		return "", err
	}
	value, _ := jsonBody(answer.data).(*pycompat.Dict)
	clientID, ok := value.Value("client_id").(string)
	if (answer.status != 200 && answer.status != 201) || value == nil || !ok {
		return "", &TransportError{Status: answer.status, Text: "Регистрация клиента в " + Title + " не удалась."}
	}
	return clientID, nil
}

// TokenRecord — token_record(previous, answer, now): новая запись по ответу token endpoint.
// Поля previous сохраняют порядок; без нового refresh token остаётся прежний; expires_at —
// int(now + expires_in) или 0, если срок не объявлен. now — секунды Unix.
func TokenRecord(previous, answer *pycompat.Dict, now float64) (*pycompat.Dict, error) {
	access, ok := answer.Value("access_token").(string)
	if !ok || access == "" {
		return nil, &ProtocolError{Title + " не выдал токен доступа."}
	}
	record := previous.Clone()
	record.Set("access_token", access)
	if refresh, ok := answer.Value("refresh_token").(string); ok && refresh != "" {
		record.Set("refresh_token", refresh)
	}
	expiresAt := pycompat.NewInt(0)
	var seconds float64
	positive := false
	switch value := answer.Value("expires_in").(type) {
	case pycompat.Int:
		if value.Sign() > 0 {
			converted, err := value.Float()
			if err != nil {
				return nil, err
			}
			seconds, positive = converted, true
		}
	case float64:
		seconds, positive = value, value > 0
	}
	if positive {
		integer, err := pycompat.FloatToInt(now+seconds, false)
		if err != nil {
			return nil, err
		}
		expiresAt = pycompat.NewInt(integer)
	}
	record.Set("expires_at", expiresAt)
	if scope, ok := answer.Value("scope").(string); ok {
		record.Set("scope", scope)
	}
	return record, nil
}

// expiring — до истечения токена меньше RefreshMargin секунд. Неверный тип expires_at —
// TypeError Python.
func (c *Client) expiring(record *pycompat.Dict) (bool, error) {
	value := record.Value("expires_at")
	if !pycompat.Truthy(value) {
		return false, nil
	}
	left, err := pycompat.Sub(value, c.now())
	if err != nil {
		return false, err
	}
	return pycompat.Less(left, pycompat.NewInt(RefreshMargin))
}

// Refresh — refresh(stale_token): обновляет токен под межпроцессной блокировкой. Если другой
// процесс уже заменил устаревший токен свежим, запись берётся из файла без запроса. Отказ сервера
// 400/401 — AuthRequired; прочие сбои обновления — NotSent: вызов инструмента ещё не уходил.
func (c *Client) Refresh(ctx context.Context, staleToken any) (*pycompat.Dict, error) {
	var result *pycompat.Dict
	err := c.withCredentialsLock(func() error {
		record := c.ReadCredentials()
		if record == nil {
			return &AuthRequiredError{LoginRequired}
		}
		soon, err := c.expiring(record)
		if err != nil {
			return err
		}
		if !pycompat.Equal(record.Value("access_token"), staleToken) && !soon {
			result = record
			return nil
		}
		if !pycompat.Truthy(record.Value("refresh_token")) || !pycompat.Truthy(record.Value("client_id")) {
			return &AuthRequiredError{LoginRequired}
		}
		fields := []Field{
			{"grant_type", "refresh_token"},
			{"client_id", pycompat.Str(record.Value("client_id"))},
			{"refresh_token", pycompat.Str(record.Value("refresh_token"))},
		}
		if pycompat.Truthy(record.Value("resource")) {
			fields = append(fields, Field{"resource", pycompat.Str(record.Value("resource"))})
		}
		endpoint := record.Value("token_endpoint")
		if !pycompat.Truthy(endpoint) {
			endpoints, err := c.Discover(ctx)
			if err != nil {
				return err
			}
			endpoint = endpoints.Token
		}
		status, answer, err := c.oauthPost(ctx, pycompat.Str(endpoint), fields)
		if transport, ok := err.(*TransportError); ok {
			return &NotSentError{"Не удалось обновить вход в " + Title + ": " + transport.Error()}
		}
		if err != nil {
			return err
		}
		if status == 400 || status == 401 {
			return &AuthRequiredError{LoginRequired}
		}
		if status != 200 || answer == nil {
			return &NotSentError{fmt.Sprintf("Не удалось обновить вход в %s: HTTP %d.", Title, status)}
		}
		if record, err = TokenRecord(record, answer, c.now()); err != nil {
			return err
		}
		if err := c.WriteCredentials(record); err != nil {
			return err
		}
		result = record
		return nil
	})
	return result, err
}

// revoke — отзыв прежнего refresh token при повторном входе; сбой отзыва не мешает новому входу.
func (c *Client) revoke(ctx context.Context, record *pycompat.Dict) error {
	if record == nil || !pycompat.Truthy(record.Value("refresh_token")) || !pycompat.Truthy(record.Value("client_id")) {
		return nil
	}
	url := record.Value("revocation_endpoint")
	if !pycompat.Truthy(url) {
		endpoints, err := c.Discover(ctx)
		if err != nil {
			return ignoreRevokeError(err)
		}
		url = endpoints.Revoke
	}
	fields := []Field{
		{"token", pycompat.Str(record.Value("refresh_token"))},
		{"token_type_hint", "refresh_token"},
		{"client_id", pycompat.Str(record.Value("client_id"))},
	}
	_, _, err := c.oauthPost(ctx, pycompat.Str(url), fields)
	return ignoreRevokeError(err)
}

// ignoreRevokeError — except (KlingError, ValueError): pass.
func ignoreRevokeError(err error) error {
	if err == nil || IsKlingError(err) || pycompat.Is(err, pycompat.ValueError) {
		return nil
	}
	return err
}

// randomBytes — secrets.token_bytes; сбой системного источника случайности — паника, как
// исключение os.urandom.
func randomBytes(size int) []byte {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return data
}

// urlsafe — base64.urlsafe_b64encode без «=».
func urlsafe(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

// PKCE — пара verifier и challenge S256 (RFC 7636).
func PKCE() (verifier, challenge string) {
	verifier = urlsafe(randomBytes(32))
	digest := sha256.Sum256([]byte(verifier))
	return verifier, urlsafe(digest[:])
}

// tokenURLSafe — secrets.token_urlsafe(n).
func tokenURLSafe(size int) string { return urlsafe(randomBytes(size)) }

// tokenHex — secrets.token_hex(n): граница multipart. Переменная — чтобы эталоны фиксировали
// границу, как съёмка оригинала.
var tokenHex = func(size int) string { return hex.EncodeToString(randomBytes(size)) }

// UUID7 — tools/common.py uuid7(): UUID версии 7 по RFC 9562 (48 бит времени Unix в
// миллисекундах, версия, вариант, случайные биты). Им попытка связывает загрузки, отправку и
// опрос одного намерения (taskTraceId).
func UUID7() string {
	value := randomBytes(16)
	binary.BigEndian.PutUint64(value[:8], uint64(time.Now().UnixMilli())<<16|uint64(binary.BigEndian.Uint16(value[6:8])))
	value[6] = value[6]&0x0F | 0x70
	value[8] = value[8]&0x3F | 0x80
	text := hex.EncodeToString(value)
	return text[:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}
