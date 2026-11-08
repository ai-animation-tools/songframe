package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalStateFileNames(t *testing.T) {
	dir := t.TempDir()
	project := t.TempDir()
	state := NewLocalState(dir)
	state.Now = func() time.Time { return time.Date(2026, 11, 4, 1, 2, 3, 456_000_000, time.UTC) }
	if current, err := state.Current(); err != nil || current != "" {
		t.Fatalf("пустое состояние: %q %v", current, err)
	}
	if err := state.WriteCurrent(project); err != nil {
		t.Fatal(err)
	}
	if err := state.Touch(project, "Клип"); err != nil {
		t.Fatal(err)
	}
	if err := state.Touch("/нет/такой", ""); err != nil {
		t.Fatal(err)
	}
	current, _ := os.ReadFile(filepath.Join(dir, CurrentFile))
	want := "{\n  \"schema_version\": 1,\n  \"path\": \"" + project + "\",\n  \"selected_at\": \"2026-11-04T01:02:03+00:00\"\n}\n"
	if string(current) != want {
		t.Fatalf("current-project.json:\n%s", current)
	}
	history, err := state.History()
	if err != nil || len(history) != 2 || history[0].Name != "такой" || history[0].Exists || !history[1].Exists || history[1].LastOpened != "2026-11-04T01:02:03.456Z" {
		t.Fatalf("история: %+v %v", history, err)
	}
	if err := state.Remove("/нет/такой"); err != nil {
		t.Fatal(err)
	}
	if history, _ := state.History(); len(history) != 1 || history[0].Path != project {
		t.Fatalf("после удаления: %+v", history)
	}
	if err := state.ClearCurrent(); err != nil {
		t.Fatal(err)
	}
	if err := state.ClearCurrent(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalStateRejectsDamagedFiles(t *testing.T) {
	dir := t.TempDir()
	state := NewLocalState(dir)
	if err := os.WriteFile(filepath.Join(dir, CurrentFile), []byte(`{"schema_version":2,"path":"/x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := state.Current(); err == nil || !strings.Contains(err.Error(), "Неверный формат") {
		t.Fatalf("current: %v", err)
	}
	if err := state.WriteCurrent("/y"); err == nil {
		t.Fatal("повреждённый current перезаписан")
	}
	if err := os.WriteFile(filepath.Join(dir, HistoryFile), []byte(`{"schema_version":1,"projects":[{"name":"x"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := state.History(); err == nil || !strings.Contains(err.Error(), "исправьте список projects") {
		t.Fatalf("history: %v", err)
	}
}
