package diagnostics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestSessionLifecycle различает штатный выход, незавершённый сеанс и одноразовое уведомление.
func TestSessionLifecycle(t *testing.T) {
	directory := t.TempDir()
	first, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	if first.CrashNotice() != nil {
		t.Fatal("чистый профиль объявлен аварийным")
	}
	second, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	notice := second.CrashNotice()
	if notice == nil || !notice.Crashed || notice.StartedAt == nil {
		t.Fatalf("незавершённый сеанс не найден: %+v", notice)
	}
	if second.CrashNotice() != nil {
		t.Fatal("уведомление повторено")
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	if third.CrashNotice() != nil {
		t.Fatal("штатный выход объявлен аварийным")
	}
}

// TestConcurrentReports сохраняет независимые JSON-строки от двух renderer без перемешивания.
func TestConcurrentReports(t *testing.T) {
	directory := t.TempDir()
	log, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	var group sync.WaitGroup
	for range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := log.ReportRendererError(RendererErrorReport{Kind: "error", Message: "Ошибка окна", Stack: "строка\nстек"}); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	data, err := os.ReadFile(filepath.Join(directory, "logs", "app.log"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 12 {
		t.Fatalf("строк %d", len(lines))
	}
	for _, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
	}
	report, err := log.Report()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(report), "Ошибка окна") {
		t.Fatal("экспорт потерял ошибку")
	}
}

// TestPreviousSessionKeptAndPanicRecorded: сбой прошлого сеанса виден весь сеанс после потребления уведомления,
// а паника попадает в app.log и не превращается в штатный выход при отложенном Close.
func TestPreviousSessionKeptAndPanicRecorded(t *testing.T) {
	directory := t.TempDir()
	first, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	if first.PreviousSession() != nil {
		t.Fatal("чистый профиль объявлен аварийным")
	}
	if err := first.RecordPanic("сбой теста", []byte("стек")); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(directory, "logs", "app.log"))
	if err != nil || !strings.Contains(string(data), "сбой теста") {
		t.Fatalf("паника не записана: %v %s", err, data)
	}
	second, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if second.CrashNotice() == nil {
		t.Fatal("сбой после паники не найден")
	}
	previous := second.PreviousSession()
	if previous == nil || !previous.Crashed || previous.StartedAt == nil || previous.Version == nil {
		t.Fatalf("сведения о сбое потеряны после уведомления: %+v", previous)
	}
	report, err := second.Report()
	if err != nil || !strings.Contains(string(report), "Прошлый сеанс завершился аварийно") {
		t.Fatalf("отчёт без сведений о сбое: %v", err)
	}
}
