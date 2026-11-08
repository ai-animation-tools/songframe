package app

import (
	"os"
	"path/filepath"
	"testing"
)

// Проверка не принимает частичный либо повторённый отчёт за успешный прогон.
func TestNativeCheckRequiresCompleteEvidence(t *testing.T) {
	for _, scenario := range []string{"полный", "пропущен", "повторён", "ошибка"} {
		t.Run(scenario, func(t *testing.T) {
			report := filepath.Join(t.TempDir(), "report.json")
			completed := 0
			service := NewNativeCheckService(NativeCheckConfig{Project: "копия"}, report, func() { completed++ })
			checks := []NativeCheckItem{}
			for _, name := range nativeCheckNames(true) {
				checks = append(checks, NativeCheckItem{Name: name, Passed: true})
			}
			switch scenario {
			case "пропущен":
				checks = checks[:len(checks)-1]
			case "повторён":
				checks[len(checks)-1] = checks[0]
			case "ошибка":
				checks[0].Passed = false
			}
			if err := service.Complete(NativeCheckResult{Passed: true, Checks: checks}); err != nil {
				t.Fatal(err)
			}
			if service.Passed() != (scenario == "полный") {
				t.Fatal("неверный итог проверки")
			}
			before, _ := os.ReadFile(report)
			if err := service.Complete(NativeCheckResult{Error: "поздний timeout"}); err != nil {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(report)
			if string(before) != string(after) || completed != 1 {
				t.Fatal("поздний ответ заменил первый результат")
			}
		})
	}
}

// Невозможность записать отчёт не превращается в успешное завершение GUI.
func TestNativeCheckReportFailure(t *testing.T) {
	file := filepath.Join(t.TempDir(), "обычный файл")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	service := NewNativeCheckService(NativeCheckConfig{}, filepath.Join(file, "report.json"), func() {})
	checks := []NativeCheckItem{}
	for _, name := range nativeCheckNames(false) {
		checks = append(checks, NativeCheckItem{Name: name, Passed: true})
	}
	if err := service.Complete(NativeCheckResult{Passed: true, Checks: checks}); err == nil {
		t.Fatal("ожидалась ошибка записи")
	}
	if service.Passed() {
		t.Fatal("ошибка диска объявлена успехом")
	}
}
