package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/components"
)

// TestComponentSmokeRejectsAmbiguousInput не позволяет принять часть JSON как отдельный запуск.
// До обращения к менеджеру ошибочный ввод не создаёт ни отчёт, ни профиль.
func TestComponentSmokeRejectsAmbiguousInput(t *testing.T) {
	for _, source := range []string{`{} {}`, `{"unknown":true}`, `{"profileDirectory":`} {
		t.Run(source, func(t *testing.T) {
			dir := t.TempDir()
			input, output := filepath.Join(dir, "input.json"), filepath.Join(dir, "report.json")
			if err := os.WriteFile(input, []byte(source), 0600); err != nil {
				t.Fatal(err)
			}
			if err := runComponentSmoke(context.Background(), input, output); err == nil {
				t.Fatal("неоднозначный запрос принят")
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("ошибочный запрос создал отчёт: %v", err)
			}
		})
	}
}

// TestComponentSmokePreservesReport защищает доказательство предыдущего запуска от перезаписи.
// Даже валидный JSON не должен обращаться к установщику, если имя отчёта уже занято.
func TestComponentSmokePreservesReport(t *testing.T) {
	dir := t.TempDir()
	input, output := filepath.Join(dir, "input.json"), filepath.Join(dir, "report.json")
	if err := os.WriteFile(input, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, []byte("предыдущий результат"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runComponentSmoke(context.Background(), input, output); err == nil {
		t.Fatal("повторное имя отчёта принято")
	}
	data, _ := os.ReadFile(output)
	if string(data) != "предыдущий результат" {
		t.Fatalf("отчёт перезаписан: %s", data)
	}
}

// TestComponentSmokeReportsFailure сохраняет машиночитаемую причину отказа вместе с ненулевым исходом.
// Невалидный набор офлайн-источников не создаёт профиль и не запускает native inference.
func TestComponentSmokeReportsFailure(t *testing.T) {
	dir := t.TempDir()
	input, output := filepath.Join(dir, "input.json"), filepath.Join(dir, "report.json")
	if err := os.WriteFile(input, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runComponentSmoke(context.Background(), input, output); err == nil {
		t.Fatal("пустой набор компонентов принят")
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var report components.PackageCheckReport
	if err := json.Unmarshal(data, &report); err != nil || report.Status != "error" || report.Error == "" {
		t.Fatalf("отсутствует причина отказа: %s, %v", data, err)
	}
}
