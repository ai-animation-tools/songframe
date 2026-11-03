// Package diagnostics хранит журнал и признак штатного завершения только в профиле новой оболочки.
package diagnostics

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// PreviousSessionInfo сохраняет контракт уведомления о прошлом аварийном сеансе.
type PreviousSessionInfo struct {
	Crashed   bool    `json:"crashed"`
	StartedAt *string `json:"startedAt"`
	Version   *string `json:"version"`
}

// RendererErrorReport содержит только предоставленные renderer текст и стек ошибки.
type RendererErrorReport struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Source  string `json:"source,omitempty"`
	Stack   string `json:"stack,omitempty"`
}

// sessionMarker отделяет начало сеанса от штатного выхода: незавершённая запись не означает потерю проекта.
type sessionMarker struct {
	StartedAt string `json:"startedAt"`
	Version   string `json:"version"`
	Clean     bool   `json:"clean"`
}

// Log сериализует записи обоих окон и отдаёт уведомление о прошлом сбое лишь один раз за запуск.
// Он не читает старый профиль SongFrame и не восстанавливает документы клипа.
type Log struct {
	mu        sync.Mutex
	directory string
	marker    sessionMarker
	previous  *PreviousSessionInfo
	closed    bool
}

// Open начинает диагностический сеанс; ошибки создания профиля возвращаются владельцу приложения.
func Open(profileDir string) (*Log, error) {
	directory := filepath.Join(profileDir, "logs")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, fmt.Errorf("создание журнала: %w", err)
	}
	result := &Log{directory: directory, marker: sessionMarker{StartedAt: time.Now().UTC().Format(time.RFC3339Nano), Version: "development"}}
	data, err := os.ReadFile(filepath.Join(directory, "session.json"))
	if err == nil {
		var previous sessionMarker
		if json.Unmarshal(data, &previous) != nil {
			result.previous = &PreviousSessionInfo{Crashed: true}
		} else if !previous.Clean {
			result.previous = &PreviousSessionInfo{Crashed: true, StartedAt: &previous.StartedAt, Version: &previous.Version}
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("чтение прошлого сеанса: %w", err)
	}
	if err := result.writeMarker(); err != nil {
		return nil, err
	}
	return result, nil
}

// writeMarker атомарно заменяет маленький служебный JSON, не оставляя половину записи после сбоя.
// Вызывается конструктором либо под mu; временный файл находится на том же томе.
func (l *Log) writeMarker() error {
	data, err := json.Marshal(l.marker)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(l.directory, ".session-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, filepath.Join(l.directory, "session.json"))
}

// CrashNotice потребляет только уведомление; содержимое журнала остаётся для отчёта разработчику.
func (l *Log) CrashNotice() *PreviousSessionInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	result := l.previous
	l.previous = nil
	return result
}

// ReportRendererError дописывает одну JSON-строку. Мьютекс исключает перемешивание ошибок разных окон.
func (l *Log) ReportRendererError(report RendererErrorReport) error {
	if report.Kind != "error" && report.Kind != "unhandledrejection" {
		return fmt.Errorf("неизвестный вид ошибки интерфейса")
	}
	if report.Message == "" {
		return fmt.Errorf("сообщение ошибки пусто")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return fmt.Errorf("диагностический сеанс завершён")
	}
	entry := struct {
		Time   string              `json:"time"`
		Report RendererErrorReport `json:"report"`
	}{time.Now().UTC().Format(time.RFC3339Nano), report}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(l.directory, "app.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(data, '\n'))
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

// Report возвращает диагностический текст с ограниченным хвостом журнала, без чтения файлов проектов.
func (l *Log) Report() ([]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	marker, _ := json.MarshalIndent(l.marker, "", "  ")
	prefix := []byte("SongFrame Go — диагностический отчёт\nСеанс:\n" + string(marker) + "\nЖурнал (последние 4 МиБ):\n")
	file, err := os.Open(filepath.Join(l.directory, "app.log"))
	if os.IsNotExist(err) {
		return append(prefix, []byte("Ошибок интерфейса не записано.\n")...), nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > 4<<20 {
		if _, err = file.Seek(-(4 << 20), io.SeekEnd); err != nil {
			return nil, err
		}
	}
	tail, err := io.ReadAll(io.LimitReader(file, 4<<20))
	if err != nil {
		return nil, err
	}
	return append(prefix, tail...), nil
}

// Close помечает штатный выход; повторный вызов безопасен для defer и Wails ServiceShutdown.
func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.marker.Clean = true
	if err := l.writeMarker(); err != nil {
		return err
	}
	l.closed = true
	return nil
}
