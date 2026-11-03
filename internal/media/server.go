// Package media отдаёт выбранные приложением файлы системному WebView через loopback.
// HTTP Range позволяет перематывать большие записи без чтения файла целиком в память Go.
package media

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Server принадлежит приложению и обслуживает все его окна одним listener.
// Реестр содержит только явно зарегистрированные файлы; URL не преобразуется обратно
// в произвольный путь диска. Close вызывается при завершении приложения.
type Server struct {
	mu      sync.RWMutex
	files   map[string]string
	urls    map[string]string
	baseURL string
	closed  bool
	http    *http.Server
	errors  chan error
}

// Start занимает свободный порт только IPv4 loopback и сразу начинает HTTP-обслуживание.
// Системные WebView используют полученный URL для audio/video и AudioContext; отдельный
// процесс и авторизация локального приложения здесь не требуются.
func Start() (*Server, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("не удалось открыть локальный медиасервер: %w", err)
	}
	s := &Server{
		files:   make(map[string]string),
		urls:    make(map[string]string),
		baseURL: "http://" + listener.Addr().String(),
		errors:  make(chan error, 1),
	}
	// Длительность медиаответа не ограничивается WriteTimeout: длинный просмотр
	// и медленный клиент не должны обрывать корректную потоковую передачу.
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		defer close(s.errors)
		if err := s.http.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.errors <- fmt.Errorf("локальный медиасервер остановился: %w", err)
		}
	}()
	return s, nil
}

// Register проверяет абсолютный путь к обычному файлу и возвращает его стабильный URL
// в рамках этого запуска. Разрешённая символическая ссылка закрепляется за текущим
// целевым файлом; имена с кириллицей, пробелами и служебными знаками кодирует net/url.
func (s *Server) Register(absolutePath string) (string, error) {
	if !filepath.IsAbs(absolutePath) {
		return "", fmt.Errorf("для медиа нужен абсолютный путь: %q", absolutePath)
	}
	path, err := filepath.EvalSymlinks(filepath.Clean(absolutePath))
	if err != nil {
		return "", fmt.Errorf("медиафайл недоступен: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("медиафайл недоступен: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("выбранный путь не является обычным медиафайлом: %s", absolutePath)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", fmt.Errorf("локальный медиасервер уже закрыт")
	}
	if existing, ok := s.urls[path]; ok {
		return existing, nil
	}
	resource := "/media/" + strconv.Itoa(len(s.files)+1) + "/" + filepath.Base(path)
	address := s.baseURL + (&url.URL{Path: resource}).EscapedPath()
	s.files[resource] = path
	s.urls[path] = address
	return address, nil
}

// ContainsURL проверяет, что второе окно открывает адрес из этого реестра, а не
// произвольную страницу. Сравнение точное: иной host, query, fragment или кодирование
// не подменяют зарегистрированный URL; после Close новых просмотров уже нет.
func (s *Server) ContainsURL(address string) bool {
	parsed, err := url.Parse(address)
	if err != nil || s.baseURL+(&url.URL{Path: parsed.Path}).EscapedPath() != address {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, exists := s.files[parsed.Path]
	return exists && !s.closed
}

// Errors сообщает единственную неожиданную ошибку HTTP-цикла для диагностики приложения.
// Канал закрывается при завершении listener; штатный Close не публикует ошибку.
func (s *Server) Errors() <-chan error { return s.errors }

// Close прекращает регистрацию и ждёт текущие ответы до срока контекста.
// При истечении срока соединения принудительно закрываются, чтобы завершение приложения
// не оставляло listener и открытые медиафайлы; повторный вызов безопасен.
func (s *Server) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	if err := s.http.Shutdown(ctx); err != nil {
		_ = s.http.Close()
		return fmt.Errorf("завершение медиасервера: %w", err)
	}
	return nil
}

// ServeHTTP открывает файл заново для каждого запроса, поэтому окна и перемотки
// не делят позицию чтения. ServeContent выполняет HEAD, условные запросы и Range
// (включая 206/416), а закрытие дескриптора гарантируется после ответа или отмены.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// WebView загружен с собственного origin Wails. CORS нужен и обычному fetch,
	// и AudioContext; локальный сервис не принимает cookies или другие credentials.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range")
	w.Header().Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "поддерживаются только GET и HEAD", http.StatusMethodNotAllowed)
		return
	}
	s.mu.RLock()
	path, exists := s.files[r.URL.Path]
	closed := s.closed
	s.mu.RUnlock()
	if closed {
		http.Error(w, "медиасервер завершает работу", http.StatusServiceUnavailable)
		return
	}
	if !exists {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		// В ответ не попадает полный путь диска; UI уже знает выбранное имя.
		http.Error(w, "медиафайл недоступен или был перемещён", http.StatusNotFound)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "медиафайл недоступен", http.StatusNotFound)
		return
	}
	if contentType := mediaType(path); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

// mediaType закрепляет типы проверяемых форматов независимо от базы MIME ОС.
// Для остальных расширений сохраняется системный тип либо определение ServeContent по данным.
func mediaType(path string) string {
	extension := strings.ToLower(filepath.Ext(path))
	switch extension {
	case ".wav":
		return "audio/wav"
	case ".mp3":
		return "audio/mpeg"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".m4a":
		return "audio/mp4"
	case ".ogg", ".oga":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	default:
		return mime.TypeByExtension(extension)
	}
}
