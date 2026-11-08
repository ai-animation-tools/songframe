package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/store"
)

// interruptedScenario оставляет в каталоге состояния журнал прерванной публикации сценария:
// plan/cast.json уже заменён (current), резерв хранит прежние байты (old).
func interruptedScenario(t *testing.T, local, project, old, current string) string {
	t.Helper()
	for name, text := range map[string]string{"plan/project.json": `{"name":"Тест"}`, "plan/cast.json": current} {
		path := filepath.Join(project, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	hash := func(text string) string {
		sum := sha256.Sum256([]byte(text))
		return hex.EncodeToString(sum[:])
	}
	key := sha256.Sum256([]byte(project))
	directory := filepath.Join(local, "scenario-apply", hex.EncodeToString(key[:]))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "0.bak"), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	pending, _ := json.Marshal(map[string]any{
		"schemaVersion": 1, "project": project,
		"files": []any{map[string]any{"path": "plan/cast.json", "backup": "0.bak", "mode": 0o644, "before": hash(old), "next": hash(`{"cast":"new"}`)}},
	})
	path := filepath.Join(directory, "pending.json")
	if err := os.WriteFile(path, pending, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestOpenRecoversScenarioPublication: открытие сначала восстанавливает прерванную
// публикацию сценария и лишь затем делает проект текущим.
func TestOpenRecoversScenarioPublication(t *testing.T) {
	local := t.TempDir()
	project := filepath.Join(t.TempDir(), "Клип")
	pending := interruptedScenario(t, local, project, `{"cast":"old"}`, `{"cast":"new"}`)
	if _, err := NewProjectService(&registrySpy{}, local).Open(project); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(project, "plan", "cast.json")); string(data) != `{"cast":"old"}` {
		t.Fatalf("кастинг не восстановлен: %s", data)
	}
	if _, err := os.Stat(pending); !os.IsNotExist(err) {
		t.Fatal("журнал не удалён")
	}
	if current, _ := store.NewLocalState(local).Current(); current != project {
		t.Fatalf("текущий проект: %q", current)
	}
}

// TestOpenRefusesConflictingScenarioRecovery — внешняя правка после сбоя: открытие отказывает,
// файл и журнал не трогаются, проект не становится текущим.
func TestOpenRefusesConflictingScenarioRecovery(t *testing.T) {
	local := t.TempDir()
	project := filepath.Join(t.TempDir(), "Клип")
	pending := interruptedScenario(t, local, project, `{"cast":"old"}`, `{"cast":"руками"}`)
	_, err := NewProjectService(&registrySpy{}, local).Open(project)
	if err == nil || !strings.Contains(err.Error(), "изменён после прерванного применения сценария") {
		t.Fatalf("конфликт не обнаружен: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(project, "plan", "cast.json")); string(data) != `{"cast":"руками"}` {
		t.Fatalf("внешняя правка перезаписана: %s", data)
	}
	if _, err := os.Stat(pending); err != nil {
		t.Fatal("журнал удалён при конфликте")
	}
	if current, _ := store.NewLocalState(local).Current(); current != "" {
		t.Fatalf("проект с конфликтом стал текущим: %q", current)
	}
}
