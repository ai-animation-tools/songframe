package derivedworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/project"
)

// sha — SHA-256 текста.
func sha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// publishingProject — проект с журналом publishing первой приёмки: комплект уже опубликован.
func publishingProject(t *testing.T) (root, journal string) {
	t.Helper()
	root = t.TempDir()
	id := strings.Repeat("a", 32)
	write := func(name, text string) {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("assets/shots/M01/manifest.json", "новый")
	data, err := json.Marshal(map[string]any{
		"schema_version": 1, "id": id, "shot": "M01", "state": "publishing", "files": []any{},
		"directory": map[string]any{
			"path": "assets/shots/M01", "backup": "plan/derived-history/" + id + "/before-kit", "retired": "assets/replaced/M01/" + id,
			"before_files": nil, "after_files": map[string]any{"manifest.json": sha("новый")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	journal = "plan/derived-history/" + id + "/journal.json"
	write(journal, string(data))
	write("plan/derived-history/"+id+"/staging/mark.txt", "x")
	return root, filepath.Join(root, filepath.FromSlash(journal))
}

// TestRecoverOpenedSkipsLivePublication — живая публикация этого процесса не откатывается, а после
// её окончания открытие снимает журнал и освобождает шлюз записи.
func TestRecoverOpenedSkipsLivePublication(t *testing.T) {
	root, journal := publishingProject(t)
	previous := toolActive
	t.Cleanup(func() { toolActive = previous })
	toolActive = func(string) bool { return true }
	if err := RecoverOpened(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "assets", "shots", "M01", "manifest.json")); err != nil {
		t.Fatal("живая публикация откатана")
	}
	if len(project.PendingJournals(root)) == 0 {
		t.Fatal("журнал не держит шлюз записи")
	}
	toolActive = func(string) bool { return false }
	for range 2 { // Повторное восстановление ничего не меняет.
		if err := RecoverOpened(root); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "assets", "shots", "M01")); !os.IsNotExist(err) {
		t.Fatalf("комплект остался: %v", err)
	}
	data, err := os.ReadFile(journal)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"state": "rolled_back"`) {
		t.Fatalf("журнал: %s", data)
	}
	if problems := project.PendingJournals(root); len(problems) != 0 {
		t.Fatalf("шлюз: %v", problems)
	}
}
