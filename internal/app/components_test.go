package app

import (
	"context"
	"testing"

	"songframe/internal/components"
)

// TestComponentsService сохраняет границу Wails: чтение и каталог не начинают установку,
// а ошибочная команда не создаёт ложный успешный результат или блокировку просмотра.
func TestComponentsService(t *testing.T) {
	manager, err := components.NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service := newComponentsService(manager, func(context.Context, []string, bool) (components.Snapshot, error) {
		return manager.State(), nil
	})
	if got := service.Catalog(); len(got) != 5 {
		t.Fatalf("каталог компонентов: %+v", got)
	}
	if got := service.Installation(); got.Status != "idle" || got.Log == nil {
		t.Fatalf("начальная установка: %+v", got)
	}
	if _, err := service.Install(context.Background(), components.InstallRequest{Components: []string{"неизвестный"}}); err == nil {
		t.Fatal("неизвестный компонент принят")
	}
	state := service.State()
	for _, operation := range state.Operations {
		if (operation.ID == "project-view" || operation.ID == "timing-view") && operation.Status != "ready" {
			t.Fatalf("чтение заблокировано: %+v", operation)
		}
	}
	if err := service.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
}
