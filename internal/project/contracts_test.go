package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// recoveryContractFixtures фиксирует только блокировку незавершённой публикации.
// Резервы намеренно отличаются от текущих файлов, чтобы случайный rollback обнаруживался по дереву.
type recoveryContractFixtures struct {
	Cases []struct {
		ID              string            `json:"id"`
		Files           map[string]string `json:"files"`
		Blocked         bool              `json:"blocked"`
		ProblemContains string            `json:"problemContains"`
	} `json:"cases"`
}

// readProjectContract открывает fixture только внутри songframe-go, без обращения к старому приложению.
func readProjectContract(t *testing.T, name string, target any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("../../testdata/contracts", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatal(err)
	}
}

// TestContractRecoveryGateNeverRollsBack проверяет оба семейства журналов, их резервы и оригиналы.
// Повторная проверка после переноса папки не завершает публикацию и не выполняет recovery.
func TestContractRecoveryGateNeverRollsBack(t *testing.T) {
	var fixtures recoveryContractFixtures
	readProjectContract(t, "recovery.json", &fixtures)
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.ID, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Проект с журналом")
			write(t, root, "plan/project.json", `{"name":"Проверка журнала"}`)
			for path, content := range fixture.Files {
				write(t, root, path, content)
			}
			before := tree(t, root)
			for attempt := 0; attempt < 2; attempt++ {
				problems := PendingJournals(root)
				if blocked := len(problems) > 0; blocked != fixture.Blocked {
					t.Fatalf("blocked=%v, ожидалось %v: %v", blocked, fixture.Blocked, problems)
				}
				if fixture.Blocked && (len(problems) != 1 || !strings.Contains(problems[0], fixture.ProblemContains)) {
					t.Fatalf("причина блокировки: %v", problems)
				}
				if !reflect.DeepEqual(before, tree(t, root)) {
					t.Fatal("проект, оригиналы, резервы или журнал изменены при чтении")
				}
				if attempt == 0 {
					moved := filepath.Join(filepath.Dir(root), "Перенесённый журнал 🌿")
					if err := os.Rename(root, moved); err != nil {
						t.Fatal(err)
					}
					root = moved
				}
			}
		})
	}
}
