package productionworkflow

import (
	"os"
	"path/filepath"
	"testing"
)

// TestNextPackageSkipsSpentAttempts — новая попытка не занимает папку, на которую ссылается
// журнал расхода: попытка M30-attempt-01 удалена при приёмке, но её расход записан.
func TestNextPackageSkipsSpentAttempts(t *testing.T) {
	project := t.TempDir()
	if got := filepath.Base(nextPackage(project, "M30")); got != "M30-attempt-01" {
		t.Fatalf("без журнала: %s", got)
	}
	journal := `{"schema_version": 1, "entries": [{"shot": "M30", "attempt": "plan/batches/M30-attempt-01", "kind": "video",
"provider": "", "request_sha256": "own", "generation_id": null, "status": "manual", "amount": 120, "unit": "credits"},
{"shot": "M30", "attempt": "assets/shots/M30", "kind": "video", "provider": "", "request_sha256": "kit",
"generation_id": null, "status": "manual", "amount": 1, "unit": "credits"}]}`
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "spend.json"), []byte(journal), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(project, "plan", "batches", "M30-attempt-02"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := filepath.Base(nextPackage(project, "M30")); got != "M30-attempt-03" {
		t.Fatalf("с журналом: %s", got)
	}
}
