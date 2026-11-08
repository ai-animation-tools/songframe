package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"songframe-go/internal/components"
)

// runComponentSmoke читает явный офлайн-запрос и сохраняет исход даже при отказе установки/inference.
// Абсолютные пути не зависят от рабочего каталога, который AppRun меняет ради песочницы WebKit.
func runComponentSmoke(ctx context.Context, input, output string) error {
	if !filepath.IsAbs(input) || !filepath.IsAbs(output) || filepath.Clean(input) == filepath.Clean(output) {
		return fmt.Errorf("component-smoke: нужны разные абсолютные пути input и report")
	}
	file, err := os.Open(input)
	if err != nil {
		return err
	}
	defer file.Close()
	var request components.PackageCheckRequest
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return fmt.Errorf("component-smoke: запрос: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("component-smoke: после запроса обнаружены лишние данные")
	}
	// Отчёт принадлежит одному запуску: существующий результат нельзя затереть новой проверкой.
	// Открываем его до установки, чтобы ошибка прав не оставила дорогую проверку без доказательства.
	result, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("component-smoke: создание нового отчёта: %w", err)
	}
	defer result.Close()
	report, checkErr := components.PackageCheck(ctx, request)
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if _, err = result.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("component-smoke: запись отчёта: %w", err)
	}
	if err = result.Close(); err != nil {
		return fmt.Errorf("component-smoke: завершение записи отчёта: %w", err)
	}
	return checkErr
}
