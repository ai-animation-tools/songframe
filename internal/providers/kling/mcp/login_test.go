package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"songframe-go/internal/pycompat"
)

// Лёгкие сценарии входа и обновления на минимальном OAuth-сервере httptest: точные байты
// запросов проверяют эталоны traces.json, здесь — цикл браузер → колбэк → обмен кода, права
// файла входа, отзыв прежнего токена, таймаут/отмена/занятые порты и однократный refresh при
// параллельных вызовах. К настоящему Kling тесты не обращаются.

// authServer — OAuth-сервер Kling без метаданных (вход идёт по адресам <base>/auth/*).
type authServer struct {
	*httptest.Server
	mu        sync.Mutex
	challenge string
	issued    int
	refreshes int
	revoked   []string
}

func newAuthServer(t *testing.T) *authServer {
	t.Helper()
	server := &authServer{}
	server.Server = httptest.NewServer(http.HandlerFunc(server.serve))
	t.Cleanup(server.Close)
	return server
}

func (s *authServer) serve(writer http.ResponseWriter, request *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = request.ParseForm()
	answer := func(status int, body string) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(body))
	}
	switch request.URL.Path {
	case "/auth/register":
		answer(201, `{"client_id": "songframe-test"}`)
	case "/auth/token":
		switch request.PostForm.Get("grant_type") {
		case "authorization_code":
			sum := sha256.Sum256([]byte(request.PostForm.Get("code_verifier")))
			if request.PostForm.Get("code") != "code-1" || base64.RawURLEncoding.EncodeToString(sum[:]) != s.challenge {
				answer(400, `{"error": "invalid_grant"}`)
				return
			}
		case "refresh_token":
			s.refreshes++
			// Медленный ответ: параллельные вызовы должны дождаться блокировки, а не обновлять сами.
			time.Sleep(50 * time.Millisecond)
		}
		s.issued++
		answer(200, fmt.Sprintf(`{"access_token": "access-%d", "refresh_token": "refresh-%d", "expires_in": 3600}`, s.issued, s.issued))
	case "/auth/revoke":
		s.revoked = append(s.revoked, request.PostForm.Get("token"))
		answer(200, `{}`)
	default:
		http.NotFound(writer, request)
	}
}

// browser — «пользователь подтвердил вход»: проверяет адрес авторизации и переходит на колбэк.
func (s *authServer) browser(t *testing.T) func(string) error {
	return func(authorize string) error {
		parsed, err := url.Parse(authorize)
		if err != nil {
			return err
		}
		query := parsed.Query()
		if parsed.Path != "/auth/authorize" || query.Get("code_challenge_method") != "S256" || query.Get("resource") != s.URL+"/mcp" {
			t.Errorf("адрес авторизации: %s", authorize)
		}
		s.mu.Lock()
		s.challenge = query.Get("code_challenge")
		s.mu.Unlock()
		go func() {
			response, err := http.Get(query.Get("redirect_uri") + "?code=code-1&state=" + url.QueryEscape(query.Get("state")))
			if err == nil {
				response.Body.Close()
			}
		}()
		return nil
	}
}

func testClient(t *testing.T, base string) *Client {
	return &Client{StateDir: t.TempDir(), BaseURL: base, LoginPorts: []int{0}}
}

func TestLoginStoresCredentials(t *testing.T) {
	server := newAuthServer(t)
	client := testClient(t, server.URL)
	lines := []string{}
	report := func(line string) { lines = append(lines, line) }
	if _, err := client.Login(context.Background(), LoginOptions{Timeout: 5 * time.Second, Report: report, OpenBrowser: server.browser(t)}); err != nil {
		t.Fatalf("вход: %v", err)
	}
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "AUTHORIZE_URL "+server.URL+"/auth/authorize?") {
		t.Errorf("сообщения входа: %q", lines)
	}
	record := client.ReadCredentials()
	if record == nil || strings.Join(record.Keys(), ",") != "client_id,token_endpoint,revocation_endpoint,resource,scope,access_token,refresh_token,expires_at" {
		t.Fatalf("запись входа: %v", record)
	}
	if record.Value("access_token") != "access-1" || record.Value("token_endpoint") != server.URL+"/auth/token" {
		t.Errorf("запись входа: %s", dumps(t, record))
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(client.CredentialsPath())
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("права файла входа: %v %v", info.Mode(), err)
		}
	}
	// Повторный вход заменяет запись и отзывает прежний refresh token.
	if _, err := client.Login(context.Background(), LoginOptions{Timeout: 5 * time.Second, OpenBrowser: server.browser(t)}); err != nil {
		t.Fatalf("повторный вход: %v", err)
	}
	if got := client.ReadCredentials().Value("access_token"); got != "access-2" || strings.Join(server.revoked, ",") != "refresh-1" {
		t.Errorf("повторный вход: токен %v, отозваны %v", got, server.revoked)
	}
}

func TestLoginWaitFailures(t *testing.T) {
	server := newAuthServer(t)
	client := testClient(t, server.URL)
	lines := []string{}
	_, err := client.Login(context.Background(), LoginOptions{Timeout: 50 * time.Millisecond, Report: func(line string) { lines = append(lines, line) }})
	if !IsAuthRequired(err) || err.Error() != "Вход в Kling не подтверждён в браузере за отведённое время." {
		t.Errorf("таймаут входа: %v", err)
	}
	if len(lines) != 2 || lines[1] != "BROWSER_NOT_OPENED" {
		t.Errorf("вход без браузера: %q", lines)
	}
	ctx, cancel := context.WithCancel(context.Background())
	opened := func(string) error { cancel(); return nil }
	if _, err := client.Login(ctx, LoginOptions{Timeout: 5 * time.Second, OpenBrowser: opened}); !IsCancelled(err) || ErrorTypeName(err) != "CancelledError" {
		t.Errorf("отмена входа: %v", err)
	}
	if client.ReadCredentials() != nil {
		t.Error("неподтверждённый вход записал токены")
	}
	busy, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	client.LoginPorts = []int{busy.Addr().(*net.TCPAddr).Port}
	if _, err := client.Login(context.Background(), LoginOptions{Timeout: time.Second}); !IsNotSent(err) {
		t.Errorf("занятые порты: %v", err)
	}
}

func TestParallelRefreshOnce(t *testing.T) {
	server := newAuthServer(t)
	client := testClient(t, server.URL)
	record := pycompat.NewDict()
	record.Set("client_id", "songframe-test")
	record.Set("token_endpoint", server.URL+"/auth/token")
	record.Set("access_token", "stale")
	record.Set("refresh_token", "refresh-0")
	record.Set("expires_at", pycompat.NewInt(1))
	if err := client.WriteCredentials(record); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	failures := make(chan error, 4)
	for range 4 {
		group.Add(1)
		go func() {
			defer group.Done()
			fresh, err := client.Refresh(context.Background(), "stale")
			if err == nil && fresh.Value("access_token") != "access-1" {
				err = errors.New("получен не обновлённый токен")
			}
			failures <- err
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Error(err)
		}
	}
	if server.refreshes != 1 {
		t.Errorf("обновлений токена: %d, ожидалось 1", server.refreshes)
	}
}
