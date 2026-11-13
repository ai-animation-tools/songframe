package production_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/production"
)

// writeJSONFile пишет value в path проекта, создавая папки.
func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(value)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestProjectSpendAcceptedWithoutEntry — комплект, принятый до журнала расхода (как M05 на
// ogorod): план в «цена не указана», цена по комплекту попадает в суммы клипа, а исправленная
// цена своего видео видна в блоке «Принятый комплект», хотя снимок комплекта не меняется.
// Производный план расход не считает.
func TestProjectSpendAcceptedWithoutEntry(t *testing.T) {
	project := t.TempDir()
	writeJSONFile(t, filepath.Join(project, "plan", "scenes.json"), map[string]any{"fps": 30, "scenes": []any{
		map[string]any{"id": "M05"}, map[string]any{"id": "M06"}, map[string]any{"id": "M07", "derived_from": map[string]any{"shot": "M05"}},
	}})
	kit := func(shot string, request map[string]any) {
		dir := filepath.Join(project, "assets", "shots", shot)
		writeJSONFile(t, filepath.Join(dir, "generation-request.json"), request)
		writeJSONFile(t, filepath.Join(dir, "manifest.json"), map[string]any{
			"shot": shot, "accepted_edit": map[string]any{"frames": 120, "fps": 30},
			"generation": map[string]any{"request": map[string]any{"path": "generation-request.json"}, "original": map[string]any{"sha256": "o-" + shot}},
		})
	}
	kit("M05", map[string]any{"provider": "test-video", "request_sha256": "r-M05", "generation_id": nil})
	kit("M06", map[string]any{"provider": "manual", "request_sha256": "r-M06", "manual_generation": map[string]any{"source": "сайт", "cost": nil}})
	kit("M07", map[string]any{})

	spend, err := production.ProjectSpendFor(project)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(spend.Unpriced, ",") != "M05,M06" || len(spend.Totals) != 0 || len(spend.Shots) != 2 || !spend.Shots[0].Missing {
		t.Fatalf("до цены: %+v", spend)
	}
	if err := production.PriceAccepted(project, "M05", 300, "credits"); err != nil {
		t.Fatal(err)
	}
	if err := production.PriceAccepted(project, "M06", 150, "RUB"); err != nil {
		t.Fatal(err)
	}
	spend, err = production.ProjectSpendFor(project)
	if err != nil {
		t.Fatal(err)
	}
	if len(spend.Unpriced) != 0 || len(spend.Totals) != 2 || spend.Totals[0].Amount != 300 || strings.Join(spend.Totals[1].Shots, ",") != "M06" {
		t.Fatalf("после цены: %+v", spend)
	}
	if production.PriceAccepted(project, "M08", 1, "RUB") == nil {
		t.Fatal("цена плана без комплекта")
	}
	summary, err := production.SpendFor(project, "M06")
	if err != nil || len(summary.Entries) != 1 {
		t.Fatalf("записи M06: %+v %v", summary, err)
	}
	amount := 200.0
	if err := production.SetSpendAmount(project, summary.Entries[0].Ref, &amount, "USD"); err != nil {
		t.Fatal(err)
	}
	accepted, err := production.AcceptedKitFor(project, "M06")
	if err != nil || accepted == nil || !strings.Contains(string(accepted.ManualGeneration), `"amount":200`) || !strings.Contains(string(accepted.ManualGeneration), `"USD"`) {
		t.Fatalf("исправленная цена в комплекте: %+v %v", accepted, err)
	}
	if data, _ := os.ReadFile(filepath.Join(project, "assets", "shots", "M06", "generation-request.json")); strings.Contains(string(data), "200") {
		t.Fatalf("снимок комплекта изменён: %s", data)
	}
}
