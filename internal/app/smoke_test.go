package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSmokeTimeoutCannotBeOverwrittenByLateFrontend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "report.json")
	result := NewSmokeResult(path)
	if err := result.Complete(nil, "таймаут"); err != nil {
		t.Fatal(err)
	}
	if err := result.Complete(&AppState{}, ""); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var report SmokeReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatal(err)
	}
	if result.Passed() || report.Passed || report.FrontendReady || report.Error != "таймаут" {
		t.Fatalf("поздний успех перезаписал отказ: %s", raw)
	}
}

func TestSmokeWriteFailureCannotPass(t *testing.T) {
	result := NewSmokeResult(t.TempDir())
	if err := result.Complete(&AppState{}, ""); err == nil {
		t.Fatal("запись отчёта в каталог не завершилась ошибкой")
	}
	if result.Passed() {
		t.Fatal("отчёт не записан, но проверка успешна")
	}
}
