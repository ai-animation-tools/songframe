package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/jobs"
	"songframe/internal/production"
)

// TestExportBundleRoute — маршрут window.api.production.exportBundle доходит до сервиса: отказ по
// пути и настоящее задание с папкой пакета.
func TestExportBundleRoute(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	manager := jobs.New(filepath.Join(root, "jobs"), jobs.Options{SkipRestore: true})
	t.Cleanup(func() { _ = manager.Shutdown(context.Background(), "конец теста") })
	service := NewProductionService(production.New(production.Options{Jobs: manager}), nil, nil, nil)
	if _, err := service.ExportBundle(project, ExportBundleOptions{Target: "bundle"}); err == nil || err.Error() != "Укажите абсолютный путь папки пакета." {
		t.Fatalf("относительный путь: %v", err)
	}
	target := filepath.Join(root, "bundle")
	info, err := service.ExportBundle(project, ExportBundleOptions{Target: target})
	if err != nil {
		t.Fatal(err)
	}
	if info.Title != "Пакет для монтажёра" || len(info.Steps) != 1 || info.Steps[0].Tool != "export_edit_bundle" {
		t.Fatalf("задание %+v", info)
	}
	if finished, err := manager.Wait(context.Background(), info.ID); err != nil || finished.Status != jobs.StatusFailed {
		t.Fatalf("проект без реестра: %+v %v", finished, err)
	}
	if entry, err := os.Stat(target); err != nil || !entry.IsDir() {
		t.Fatalf("папка пакета: %v", err)
	}
}
