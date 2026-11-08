package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"songframe/internal/golden"
	"songframe/internal/jobs"
	"songframe/internal/mediacmd"
	"songframe/internal/store"
)

// hashText — SHA-256 текста.
func hashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// interruptedDerived — журнал publishing первой приёмки: комплект опубликован, резерва нет.
func interruptedDerived(t *testing.T, project, kitText string) string {
	t.Helper()
	id := strings.Repeat("a", 32)
	history := "plan/derived-history/" + id
	writeFiles(t, project, map[string]string{
		"plan/project.json":              `{"name":"Тест"}`,
		"assets/shots/M01/manifest.json": kitText,
		history + "/journal.json": `{"schema_version":1,"id":"` + id + `","shot":"M01","state":"publishing","files":[],"directory":{` +
			`"path":"assets/shots/M01","backup":"` + history + `/before-kit","retired":"assets/replaced/M01/` + id + `","before_files":null,` +
			`"after_files":{"manifest.json":"` + hashText("новый") + `"}}}`,
	})
	return filepath.Join(project, filepath.FromSlash(history), "journal.json")
}

// TestOpenRecoversDerivedPublication — открытие откатывает прерванную приёмку производного плана до
// того, как проект станет текущим; конфликт с ручной правкой не открывает проект и сохраняет журнал.
func TestOpenRecoversDerivedPublication(t *testing.T) {
	local := t.TempDir()
	project := filepath.Join(t.TempDir(), "Клип")
	journal := interruptedDerived(t, project, "новый")
	if _, err := NewProjectService(&registrySpy{}, local).Open(project); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(project, "assets", "shots", "M01")); !os.IsNotExist(err) {
		t.Fatalf("комплект не откатан: %v", err)
	}
	if data, _ := os.ReadFile(journal); !strings.Contains(string(data), `"state": "rolled_back"`) {
		t.Fatalf("журнал: %s", data)
	}

	other := filepath.Join(t.TempDir(), "Другой")
	interruptedDerived(t, other, "руками")
	_, err := NewProjectService(&registrySpy{}, local).Open(other)
	if err == nil || !strings.Contains(err.Error(), "Не удалось восстановить приёмку производного плана") {
		t.Fatalf("конфликт не обнаружен: %v", err)
	}
	if current, _ := store.NewLocalState(local).Current(); current != project {
		t.Fatalf("текущий проект сменился: %q", current)
	}
}

// TestDerivedShotFlow — страница целиком на настоящем менеджере и FFmpeg: сборка заданием даёт
// свежую пробу, приёмка публикует комплект, а принятие видно и без журнала заданий.
func TestDerivedShotFlow(t *testing.T) {
	if _, err := exec.LookPath(mediacmd.FFmpeg()); err != nil {
		t.Skip("нет FFmpeg")
	}
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(t.TempDir(), "Клип")
	if err := os.CopyFS(project, os.DirFS(filepath.Join(root, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name  string `json:"name"`
			Setup []struct {
				Path string `json:"path"`
				Text string `json:"text"`
			} `json:"setup"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "derive-shot", "cases.json"), &file); err != nil {
		t.Fatal(err)
	}
	for _, item := range file.Cases {
		if item.Name == "build-still" { // Короткое окно M05: сборка занимает доли секунды.
			for _, op := range item.Setup {
				writeFiles(t, project, map[string]string{op.Path: op.Text})
			}
		}
	}
	manager := jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})
	service := NewDerivedShotService(manager)
	finish := func(id string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		info, err := manager.Wait(ctx, id)
		if err != nil || info.Status != jobs.StatusDone {
			t.Fatalf("задание: %v %+v %s", err, info, info.Log)
		}
	}
	view, err := service.Build(project, "M05", json.RawMessage(`{"mode":"still","frame":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if view.Job == nil {
		t.Fatal("нет задания сборки")
	}
	finish(view.Job.ID)
	view, err = service.View(project, "M05")
	if err != nil {
		t.Fatal(err)
	}
	if view.Preview == nil || !view.Preview.Fresh || view.Preview.Accepted {
		t.Fatalf("проба: %+v", view.Preview)
	}
	view, err = service.Accept(project, "M05", view.Preview.ID, view.Preview.ResultToken, true)
	if err != nil {
		t.Fatal(err)
	}
	finish(view.Job.ID)
	view, err = NewDerivedShotService(jobs.New(t.TempDir(), jobs.Options{SkipRestore: true})).View(project, "M05")
	if err != nil {
		t.Fatal(err)
	}
	if view.Preview == nil || !view.Preview.Accepted || !view.HasAsset {
		t.Fatalf("приёмка: %+v", view.Preview)
	}
}
