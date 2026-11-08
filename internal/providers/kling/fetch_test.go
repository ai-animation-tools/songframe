package kling

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"songframe/internal/providers/kling/mcp"
)

// TestFetch — скачивание оригинала по HTTPS на httptest: байты файла (сигнатура PNG) без
// изменений, обрыв тела до Content-Length и HTTP-ошибка не выдаются за успех, адрес не https
// отклоняется до запроса.
func TestFetch(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 4096)...)
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/ok.png":
			_, _ = writer.Write(png)
		case "/short.png":
			writer.Header().Set("Content-Length", strconv.Itoa(len(png)))
			_, _ = writer.Write(png[:100])
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	adapter := &Adapter{Client: &mcp.Client{StateDir: t.TempDir(), TLSConfig: &tls.Config{RootCAs: roots}}}
	ctx := context.Background()
	destination := filepath.Join(t.TempDir(), "original.png")

	if err := adapter.Fetch(ctx, server.URL+"/ok.png", destination); err != nil {
		t.Fatalf("скачивание: %v", err)
	}
	if data, err := os.ReadFile(destination); err != nil || !bytes.Equal(data, png) {
		t.Errorf("скачанный файл отличается: %v", err)
	}
	if err := adapter.Fetch(ctx, server.URL+"/short.png", destination); err == nil || err.Error() != "Загрузка не завершена." {
		t.Errorf("обрыв тела: %v", err)
	}
	if err := adapter.Fetch(ctx, server.URL+"/missing.png", destination); err == nil || err.Error() != "HTTP Error 404: Not Found" || mcp.ErrorTypeName(err) != "OSError" {
		t.Errorf("HTTP-ошибка: %v", err)
	}
	if err := adapter.Fetch(ctx, "http://example.test/ok.png", destination); err == nil || err.Error() != "Сервис вернул недопустимый адрес результата." {
		t.Errorf("адрес не https: %v", err)
	}
}
