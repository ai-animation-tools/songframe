package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"songframe-go/internal/project"
)

// NativeCheckConfig задаётся только явными CLI-флагами разработчика. Медиа уже
// зарегистрированы сервером; WebView не получает произвольный доступ к каталогу.
type NativeCheckConfig struct {
	Files   []project.MediaFile `json:"files"`
	Project string              `json:"project"`
}

// NativeCheckResult содержит наблюдения реального WebView. Физический звук
// намеренно не выводится из успешного play: это отдельная ручная проверка.
type NativeCheckResult struct {
	Passed    bool              `json:"passed"`
	Checks    []NativeCheckItem `json:"checks"`
	UserAgent string            `json:"userAgent"`
	Error     string            `json:"error"`
}

// NativeCheckItem связывает утверждение с фактическим результатом и деталями.
type NativeCheckItem struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Details string `json:"details"`
}

// NativeCheckService существует только в режиме проверки. Первый отчёт побеждает
// timeout и поздний ответ; callback закрывает окно после ответа Wails binding.
type NativeCheckService struct {
	config NativeCheckConfig
	report string
	finish func()
	mu     sync.Mutex
	done   bool
	passed bool
}

// NewNativeCheckService не читает пользовательские профили и не пишет проект.
func NewNativeCheckService(config NativeCheckConfig, report string, finish func()) *NativeCheckService {
	return &NativeCheckService{config: config, report: report, finish: finish}
}

// Config отдаёт явные входы проверки вместо поиска файлов на машине пользователя.
func (s *NativeCheckService) Config() NativeCheckConfig { return s.config }

// Complete сохраняет проверяемый отчёт. Ошибка диска не считается успехом проверки.
func (s *NativeCheckService) Complete(result NativeCheckResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return nil
	}
	s.done = true
	defer s.finish()
	// Отчёт обязан покрыть весь объявленный набор: одна успешная проверка не
	// подменяет закончившийся прогон. Имена уникальны и сверяются независимо от UI.
	expected := nativeCheckNames(s.config.Project != "")
	seen := make(map[string]bool)
	for _, check := range result.Checks {
		if !check.Passed || seen[check.Name] {
			result.Passed = false
		}
		seen[check.Name] = true
	}
	missing := []string{}
	for _, name := range expected {
		if !seen[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 || len(result.Checks) != len(expected) {
		result.Passed = false
		result.Error += " Неполный набор нативных проверок: " + strings.Join(missing, "; ")
	}
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(s.report), 0700); err != nil {
		return err
	}
	if err = os.WriteFile(s.report, append(data, '\n'), 0600); err != nil {
		return fmt.Errorf("отчёт нативной проверки: %w", err)
	}
	s.passed = result.Passed && result.Error == ""
	return nil
}

// Passed безопасно читается после завершения GUI или срабатывания таймера.
func (s *NativeCheckService) Passed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done && s.passed
}

// nativeCheckNames — минимальный набор доказательств режима проверки. При изменении
// harness список обновляется вместе с ним; наличие проекта добавляет проверки его открытия.
func nativeCheckNames(withProject bool) []string {
	names := []string{}
	for _, ext := range []string{"wav", "mp3", "mp4", "webm"} {
		names = append(names, ext+": метаданные, seek и воспроизведение", "HTTP HEAD/Range/416: "+ext)
	}
	names = append(names, "WAV: фактический возврат loop", "AudioContext: wav, ненулевая волна", "AudioContext: mp3, ненулевая волна", "Второе нативное окно: loadedmetadata и закрытие")
	if withProject {
		names = append(names, "Копия проекта: чтение Unicode-пути и таймингов через Go", "Notification target: настоящий переход события и unsubscribe/remount")
	}
	return names
}
