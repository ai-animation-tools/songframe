// Package media отдаёт разрешённые приложением файлы системному WebView через loopback.
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
	"runtime"
	"strings"
	"sync"
	"time"
)

// Server принадлежит приложению и обслуживает все его окна одним listener.
// Отдаются только файлы, которые приложение разрешило: под зарегистрированными корнями
// (открытый проект, профиль) или выбранные пользователем по одному. URL имеет вид
// /file/<путь диска>, поэтому renderer строит его синхронно (shell.fileUrl), как
// local-file:// в Electron. Порт временный: такие URL не сохраняются в проект.
type Server struct {
	mu      sync.RWMutex
	roots   map[string]struct{}
	files   map[string]struct{}
	baseURL string
	closed  bool
	http    *http.Server
	errors  chan error
}

// filePrefix — маршрут файлов; TS-адаптер строит тот же вид в frontend/src/platform/file-url.ts.
const filePrefix = "/file/"

// Start занимает свободный порт только IPv4 loopback и сразу начинает HTTP-обслуживание.
// Системные WebView используют полученный URL для audio/video и AudioContext; отдельный
// процесс и авторизация локального приложения здесь не требуются.
func Start() (*Server, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("не удалось открыть локальный медиасервер: %w", err)
	}
	s := &Server{
		roots:   make(map[string]struct{}),
		files:   make(map[string]struct{}),
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

// BaseURL — адрес listener этого запуска; renderer получает его один раз при старте.
func (s *Server) BaseURL() string { return s.baseURL }

// FileURL кодирует абсолютный путь по сегментам: пробелы, кириллица, '#', '?' и диск
// Windows не ломают адрес. Разрешение файла проверяется при запросе, а не здесь.
func FileURL(baseURL, absolutePath string) string {
	slashed := strings.TrimPrefix(filepath.ToSlash(absolutePath), "/")
	segments := strings.Split(slashed, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return baseURL + filePrefix + strings.Join(segments, "/")
}

// filePath восстанавливает путь диска из уже декодированного net/http пути запроса.
// Результат очищен и абсолютен; '..' не выводит за пределы разрешённого корня,
// потому что проверка allowed выполняется по очищенному пути.
func filePath(requestPath string) (string, bool) {
	rest, ok := strings.CutPrefix(requestPath, filePrefix)
	if !ok || rest == "" {
		return "", false
	}
	path := filepath.FromSlash(rest)
	if runtime.GOOS != "windows" {
		path = string(filepath.Separator) + path
	}
	path = filepath.Clean(path)
	return path, filepath.IsAbs(path)
}

// sameKey приводит путь к ключу сравнения: в Windows регистр имён не различается.
func sameKey(path string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

// AllowRoot разрешает файлы каталога и его подкаталогов, например открытого проекта.
// Корень не снимается при смене проекта: прежние URL этого запуска остаются рабочими,
// а повторная регистрация того же каталога ничего не меняет.
func (s *Server) AllowRoot(directory string) error {
	if !filepath.IsAbs(directory) {
		return fmt.Errorf("для медиа нужен абсолютный путь: %q", directory)
	}
	info, err := os.Stat(directory)
	if err != nil {
		return fmt.Errorf("каталог медиа недоступен: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("путь не является каталогом: %s", directory)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("локальный медиасервер уже закрыт")
	}
	s.roots[sameKey(filepath.Clean(directory))] = struct{}{}
	return nil
}

// AllowFile разрешает отдельный файл вне корней (выбранный в диалоге или перетащенный).
// Существование не проверяется: страница может показать файл после его появления.
func (s *Server) AllowFile(path string) {
	if !filepath.IsAbs(path) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.files[sameKey(filepath.Clean(path))] = struct{}{}
	}
}

// Register проверяет абсолютный путь к обычному файлу, разрешает его и возвращает URL.
// Имена с кириллицей, пробелами и служебными знаками кодируются FileURL.
func (s *Server) Register(absolutePath string) (string, error) {
	if !filepath.IsAbs(absolutePath) {
		return "", fmt.Errorf("для медиа нужен абсолютный путь: %q", absolutePath)
	}
	path := filepath.Clean(absolutePath)
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
	s.files[sameKey(path)] = struct{}{}
	return FileURL(s.baseURL, path), nil
}

// allowed сообщает, разрешён ли очищенный путь отдельным выбором или корнем.
func (s *Server) allowed(path string) bool {
	key := sameKey(path)
	if _, ok := s.files[key]; ok {
		return true
	}
	for directory := key; ; {
		parent := filepath.Dir(directory)
		if parent == directory {
			return false
		}
		if _, ok := s.roots[parent]; ok {
			return true
		}
		directory = parent
	}
}

// ContainsURL проверяет, что второе окно открывает разрешённый файл этого сервера, а не
// произвольную страницу: иной host, query или fragment адрес не принимают.
func (s *Server) ContainsURL(address string) bool {
	parsed, err := url.Parse(address)
	if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Scheme+"://"+parsed.Host != s.baseURL {
		return false
	}
	path, ok := filePath(parsed.Path)
	if !ok {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return !s.closed && s.allowed(path)
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
	path, exists := filePath(r.URL.Path)
	s.mu.RLock()
	exists = exists && s.allowed(path)
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
