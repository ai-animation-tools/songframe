package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"songframe/internal/montage"
	"songframe/internal/store"
)

// writeFiles создаёт файлы проекта по относительным путям.
func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, text := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// interruptedMontage — журнал publishing: реестр уже заменён, резерв хранит прежний.
func interruptedMontage(t *testing.T, project, current string) string {
	t.Helper()
	hash := func(text string) string {
		sum := sha256.Sum256([]byte(text))
		return hex.EncodeToString(sum[:])
	}
	history := "plan/montage-history/" + strings.Repeat("a", 32)
	writeFiles(t, project, map[string]string{
		"plan/project.json":                  `{"name":"Тест"}`,
		"plan/scenes.json":                   current,
		history + "/before/plan/scenes.json": "старый",
		history + "/journal.json": `{"schema_version":1,"id":"` + strings.Repeat("a", 32) + `","state":"publishing","files":[` +
			`{"path":"plan/scenes.json","before":"` + hash("старый") + `","after":"` + hash("новый") + `"}]}`,
	})
	return filepath.Join(project, filepath.FromSlash(history), "journal.json")
}

// TestOpenRecoversMontagePublication: открытие откатывает прерванную публикацию монтажа
// до того, как проект станет текущим; конфликт с ручной правкой не открывает проект.
func TestOpenRecoversMontagePublication(t *testing.T) {
	local := t.TempDir()
	project := filepath.Join(t.TempDir(), "Клип")
	journal := interruptedMontage(t, project, "новый")
	if _, err := NewProjectService(&registrySpy{}, local).Open(project); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(project, "plan", "scenes.json")); string(data) != "старый" {
		t.Fatalf("реестр не восстановлен: %s", data)
	}
	if data, _ := os.ReadFile(journal); !strings.Contains(string(data), `"state": "rolled_back"`) {
		t.Fatalf("журнал: %s", data)
	}

	other := filepath.Join(t.TempDir(), "Другой")
	interruptedMontage(t, other, "руками")
	_, err := NewProjectService(&registrySpy{}, local).Open(other)
	if err == nil || !strings.Contains(err.Error(), "После прерывания монтажа изменён plan/scenes.json") {
		t.Fatalf("конфликт не обнаружен: %v", err)
	}
	if current, _ := store.NewLocalState(local).Current(); current != project {
		t.Fatalf("текущий проект сменился: %q", current)
	}
}

// TestRecoverProjectsCoversHistory — запуск восстанавливает текущий проект и проекты истории.
func TestRecoverProjectsCoversHistory(t *testing.T) {
	local := t.TempDir()
	project := filepath.Join(t.TempDir(), "Клип")
	interruptedMontage(t, project, "новый")
	state := store.NewLocalState(local)
	if err := state.Touch(project, "Тест"); err != nil {
		t.Fatal(err)
	}
	if err := montage.RecoverProjects(local); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(project, "plan", "scenes.json")); string(data) != "старый" {
		t.Fatalf("реестр не восстановлен: %s", data)
	}
}

// TestSaveVideoChecksProbeBeforeDialog — неготовая проба отклоняется до диалога; отмена диалога —
// nil; выбранный путь получает копию с суффиксом .mp4.
func TestSaveVideoChecksProbeBeforeDialog(t *testing.T) {
	project := t.TempDir()
	service := NewMontageService(nil, nil)
	asked := 0
	choice := ""
	service.saveDialog = func(application.Window) (string, error) {
		asked++
		return choice, nil
	}
	video := "plan/batches/review-manual-x/review.mp4"
	if _, err := service.SaveVideo(context.Background(), project, video); err == nil || asked != 0 {
		t.Fatalf("неготовая проба: %v, диалогов %d", err, asked)
	}
	writeFiles(t, project, map[string]string{
		video: "ролик", "plan/batches/review-manual-x/review.json": `{"video_sha256":"h","total_frames":3}`,
	})
	if path, err := service.SaveVideo(context.Background(), project, video); err != nil || path != nil {
		t.Fatalf("отмена: %v %v", path, err)
	}
	choice = filepath.Join(t.TempDir(), "проба")
	path, err := service.SaveVideo(context.Background(), project, video)
	if err != nil || path == nil || *path != choice+".mp4" {
		t.Fatalf("копия: %v %v", path, err)
	}
	if data, _ := os.ReadFile(*path); string(data) != "ролик" {
		t.Fatalf("содержимое копии: %s", data)
	}
}
