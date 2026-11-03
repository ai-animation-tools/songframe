package media

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// testServer запускает настоящий loopback, чтобы проверить HTTP-клиентом Range и lifecycle.
// Все файлы тестов временные; при ошибке проверка всё равно освобождает listener.
func testServer(t *testing.T) *Server {
	t.Helper()
	s, err := Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return s
}

// testFile создаёт управляемый источник без зависимости от реальных клипов и внешних кодеков.
func testFile(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// request ограничивает время HTTP-проверки, чтобы отказ listener не подвешивал suite.
func request(t *testing.T, method, address, byteRange string) *http.Response {
	t.Helper()
	r, err := http.NewRequest(method, address, nil)
	if err != nil {
		t.Fatal(err)
	}
	if byteRange != "" {
		r.Header.Set("Range", byteRange)
	}
	r.Header.Set("Origin", "wails://wails.localhost")
	response, err := (&http.Client{Timeout: 3 * time.Second}).Do(r)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	return response
}

func TestRangeHeadAndUnicodePath(t *testing.T) {
	s := testServer(t)
	path := testFile(t, "Песня #1 + 50%.wav", "0123456789")
	address, err := s.Register(path)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(address)
	if err != nil || u.Hostname() != "127.0.0.1" || !strings.HasSuffix(u.Path, filepath.Base(path)) {
		t.Fatalf("неверный loopback URL: %s, %v", address, err)
	}
	if strings.ContainsAny(address, " #") || !strings.Contains(address, "%25") {
		t.Fatalf("не закодирован путь: %s", address)
	}
	cases := []struct {
		name, method, byteRange, body, contentRange string
		status                                      int
		length                                      int64
	}{
		{"полный файл", "GET", "", "0123456789", "", 200, 10},
		{"перемотка", "GET", "bytes=2-5", "2345", "bytes 2-5/10", 206, 4},
		{"хвост", "GET", "bytes=-3", "789", "bytes 7-9/10", 206, 3},
		{"до конца", "GET", "bytes=8-", "89", "bytes 8-9/10", 206, 2},
		{"только заголовки", "HEAD", "", "", "", 200, 10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := request(t, tc.method, address, tc.byteRange)
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatal(err)
			}
			if r.StatusCode != tc.status || string(body) != tc.body || r.ContentLength != tc.length || r.Header.Get("Content-Range") != tc.contentRange {
				t.Fatalf("status=%d body=%q length=%d range=%q", r.StatusCode, body, r.ContentLength, r.Header.Get("Content-Range"))
			}
			if r.Header.Get("Content-Type") != "audio/wav" || r.Header.Get("Accept-Ranges") != "bytes" || r.Header.Get("Access-Control-Allow-Origin") != "*" {
				t.Fatalf("нет MIME/Range/CORS: %v", r.Header)
			}
		})
	}
	r := request(t, "GET", address, "bytes=10-20")
	if r.StatusCode != 416 || r.Header.Get("Content-Range") != "bytes */10" {
		t.Fatalf("некорректный ответ вне файла: %d %v", r.StatusCode, r.Header)
	}
}

func TestSelectedFilesOnlyAndMissingMedia(t *testing.T) {
	s := testServer(t)
	path := testFile(t, "song.mp3", "audio")
	address, err := s.Register(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Register("relative.mp3"); err == nil {
		t.Fatal("принят относительный путь")
	}
	if _, err := s.Register(filepath.Dir(path)); err == nil {
		t.Fatal("принята директория")
	}
	if _, err := s.Register(path + "-missing"); err == nil {
		t.Fatal("принят отсутствующий файл")
	}
	if got, err := s.Register(path); err != nil || got != address {
		t.Fatalf("повторная регистрация: %q %v", got, err)
	}
	for _, route := range []string{"/", "/media/999/song.mp3", "/media/1/other.mp3", "/media/1/../../etc/passwd"} {
		r := request(t, "GET", s.baseURL+route, "")
		if r.StatusCode != 404 {
			t.Errorf("произвольный путь %s: %d", route, r.StatusCode)
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	r := request(t, "GET", address, "")
	if r.StatusCode != 404 {
		t.Fatalf("удалённый файл: %d", r.StatusCode)
	}
}

func TestMethodsAndMediaTypes(t *testing.T) {
	s := testServer(t)
	for extension, expected := range map[string]string{".mp3": "audio/mpeg", ".MP4": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav"} {
		address, err := s.Register(testFile(t, "sample"+extension, "media"))
		if err != nil {
			t.Fatal(err)
		}
		if got := request(t, "GET", address, "").Header.Get("Content-Type"); got != expected {
			t.Errorf("%s: MIME %q, ожидался %q", extension, got, expected)
		}
	}
	r := request(t, "OPTIONS", s.baseURL+"/", "")
	if r.StatusCode != 204 || r.Header.Get("Access-Control-Allow-Headers") != "Range" {
		t.Fatalf("CORS preflight: %d %v", r.StatusCode, r.Header)
	}
	r = request(t, "POST", s.baseURL+"/", "")
	if r.StatusCode != 405 || r.Header.Get("Allow") != "GET, HEAD, OPTIONS" {
		t.Fatalf("метод: %d %v", r.StatusCode, r.Header)
	}
}

func TestLargeFileSeekAndConcurrentWindows(t *testing.T) {
	s := testServer(t)
	path := filepath.Join(t.TempDir(), "large.mp4")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	const size int64 = 64 << 20
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte("tail"), size-4); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	address, err := s.Register(path)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			// Одновременные окна регистрируют тот же файл и читают разные дескрипторы.
			if got, err := s.Register(path); err != nil || got != address {
				t.Errorf("регистрация: %s %v", got, err)
				return
			}
			req, err := http.NewRequest(http.MethodGet, address, nil)
			if err != nil {
				t.Error(err)
				return
			}
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", size-4))
			r, err := (&http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}).Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			defer r.Body.Close()
			body, err := io.ReadAll(r.Body)
			if err != nil || r.StatusCode != 206 || string(body) != "tail" || r.ContentLength != 4 {
				t.Errorf("параллельное чтение: %d %q %v", r.StatusCode, body, err)
			}
		})
	}
	wg.Wait()
}

func TestCloseStopsListenerAndRegistration(t *testing.T) {
	s := testServer(t)
	path := testFile(t, "sound.wav", "audio")
	address, err := s.Register(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Register(path); err == nil {
		t.Fatal("регистрация после Close разрешена")
	}
	if r, err := (&http.Client{Timeout: time.Second}).Get(address); err == nil {
		r.Body.Close()
		t.Fatal("listener работает после Close")
	}
	select {
	case err, ok := <-s.Errors():
		if ok {
			t.Fatalf("штатная остановка сообщила ошибку: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("цикл Serve не завершился")
	}
	if err := s.Close(ctx); err != nil {
		t.Fatalf("повторный Close: %v", err)
	}
}

func TestContainsURLAllowsOnlyRegisteredAddress(t *testing.T) {
	s := testServer(t)
	address, err := s.Register(testFile(t, "Песня #1.mp3", "audio"))
	if err != nil {
		t.Fatal(err)
	}
	if !s.ContainsURL(address) {
		t.Fatal("собственный URL не найден")
	}
	for _, candidate := range []string{
		address + "?other=1", address + "#fragment", s.baseURL + "/media/999/other.mp3",
		strings.Replace(address, "127.0.0.1", "localhost", 1), "https://example.org/media/song.mp3",
	} {
		if s.ContainsURL(candidate) {
			t.Errorf("принят посторонний URL: %s", candidate)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if s.ContainsURL(address) {
		t.Fatal("URL закрытого сервера разрешён")
	}
}
