package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// SmokeReport подтверждает только запуск оболочки и вызов State из настоящего frontend.
// Он не подтверждает открытие проектов, медиа, звук или платформы вне выполненного запуска.
type SmokeReport struct {
	Passed        bool      `json:"passed"`
	AppID         string    `json:"appId"`
	FrontendReady bool      `json:"frontendReady"`
	State         *AppState `json:"state,omitempty"`
	Error         string    `json:"error,omitempty"`
}

// SmokeResult сериализует единственный исход проверки между frontend, таймером и shutdown.
// Отчёт появляется только в явно выбранном файле, пользовательский профиль не используется.
type SmokeResult struct {
	mu         sync.Mutex
	reportPath string
	done       bool
	passed     bool
}

// NewSmokeResult создаёт получателя отчёта без записи; пустой путь отклоняет main до запуска.
func NewSmokeResult(reportPath string) *SmokeResult { return &SmokeResult{reportPath: reportPath} }

// Complete записывает первый результат и не позволяет позднему callback перезаписать timeout.
// Ошибка записи означает провал проверки даже при готовом интерфейсе.
func (s *SmokeResult) Complete(state *AppState, failure string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return nil
	}
	s.done = true
	report := SmokeReport{Passed: failure == "" && state != nil, AppID: AppID, FrontendReady: state != nil, State: state, Error: failure}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.reportPath), 0o700); err != nil {
		return fmt.Errorf("папка smoke-отчёта: %w", err)
	}
	if err := os.WriteFile(s.reportPath, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("запись smoke-отчёта: %w", err)
	}
	s.passed = report.Passed
	return nil
}

// Passed возвращает итог, защищённый от конкурентного завершения таймером и frontend.
func (s *SmokeResult) Passed() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.done && s.passed }
