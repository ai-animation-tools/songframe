package codex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/agents"
	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaapi"
)

// codexCases — разделы codexPrepare и codexCover эталона media-providers.
type codexCases struct {
	Select []struct {
		Files map[string]map[string]any `json:"files"`
	} `json:"select"`
	CodexPrepare []struct {
		Name  string               `json:"name"`
		Input mediaapi.ImagesInput `json:"input"`
		JSON  string               `json:"json"`
		Error string               `json:"error"`
	} `json:"codexPrepare"`
	CodexCover []struct {
		Name       string   `json:"name"`
		Purpose    string   `json:"purpose"`
		References []string `json:"references"`
		Prompt     *string  `json:"prompt"`
		Job        struct {
			Status   string `json:"status"`
			ExitCode int    `json:"exitCode"`
			Result   string `json:"result"`
			Message  string `json:"message"`
		} `json:"job"`
		Starts []struct {
			Input   agents.StartInput `json:"input"`
			WorkDir string            `json:"workDir"`
			Config  agents.Settings   `json:"config"`
		} `json:"starts"`
		Copied      []string `json:"copied"`
		ProjectJSON string   `json:"projectJson"`
		Result      *struct {
			Path string `json:"path"`
		} `json:"result"`
		Error string `json:"error"`
	} `json:"codexCover"`
}

func load(t *testing.T) codexCases {
	t.Helper()
	var cases codexCases
	if err := json.Unmarshal(golden.ReadFile(t, "media-providers", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// png — заголовок PNG с размерами, как во входах эталона.
func png(width, height int) []byte {
	header := make([]byte, 33)
	copy(header, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	header[11] = 13
	copy(header[12:], "IHDR")
	put := func(offset, value int) {
		header[offset], header[offset+1], header[offset+2], header[offset+3] = byte(value>>24), byte(value>>16), byte(value>>8), byte(value)
	}
	put(16, width)
	put(20, height)
	header[24], header[25] = 8, 2
	return header
}

func write(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o666); err != nil {
		t.Fatal(err)
	}
}

// TestPrepareGolden сверяет зафиксированный запрос опор и его SHA с эталоном.
func TestPrepareGolden(t *testing.T) {
	cases := load(t)
	files := cases.Select[0].Files
	executor := NewImageExecutor(ImageOptions{})
	for _, item := range cases.CodexPrepare {
		t.Run(item.Name, func(t *testing.T) {
			project := t.TempDir()
			for path, spec := range files {
				data := []byte(jscompat.ToString(spec["text"]))
				if size, ok := spec["png"].([]any); ok {
					data = png(int(size[0].(float64)), int(size[1].(float64)))
				}
				write(t, filepath.Join(project, path), data)
			}
			real, _ := filepath.EvalSymlinks(project)
			input := item.Input
			input.Project = project
			prepared, err := executor.Prepare(input)
			if item.Error != "" {
				if err == nil || err.Error() != item.Error {
					t.Fatalf("ошибка %v, ожидалась %q", err, item.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			text := strings.ReplaceAll(item.JSON, "<project>", real)
			sum := sha256.Sum256([]byte(text))
			if prepared.RequestSha != hex.EncodeToString(sum[:]) {
				t.Fatalf("SHA %s не совпадает с JSON эталона %s", prepared.RequestSha, text)
			}
		})
	}
}

// fakeManager — менеджер временного проекта: запоминает запуск и сразу отдаёт итог задания.
type fakeManager struct {
	job    agents.Job
	starts []agents.StartInput
	dirs   []string
	config []agents.Settings
}

func (m *fakeManager) StartImages(input agents.StartInput, workDir string, config agents.Settings) (agents.Job, error) {
	m.starts, m.dirs, m.config = append(m.starts, input), append(m.dirs, workDir), append(m.config, config)
	return agents.Job{ID: m.job.ID, Status: agents.StatusRunning}, nil
}
func (m *fakeManager) Get(string) (agents.Job, bool)         { return m.job, true }
func (m *fakeManager) OnEvent(func(agents.Event)) func()     { return func() {} }
func (m *fakeManager) ShutdownAndWait(context.Context) error { return nil }

// TestCoverRunnerGolden сверяет промпт, контекст, копии опор и разбор ответа с эталоном.
func TestCoverRunnerGolden(t *testing.T) {
	for _, item := range load(t).CodexCover {
		t.Run(item.Name, func(t *testing.T) {
			base := t.TempDir()
			workDir := filepath.Join(base, "catalog", "image-jobs", "attempt-01")
			outside := filepath.Join(base, "pinned", "Опора 1.PNG")
			inside := filepath.Join(workDir, "inputs", "inner.png")
			write(t, outside, png(64, 32))
			write(t, inside, png(16, 16))
			references := []mediaapi.ReferenceImage{}
			for index, kind := range item.References {
				path := outside
				if kind == "inside" {
					path = inside
				}
				data, _ := os.ReadFile(path)
				sum := sha256.Sum256(data)
				references = append(references, mediaapi.ReferenceImage{Path: path, Label: "Опора " + jscompat.NumberToString(float64(index+1)) + " «" + kind + "»", SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(data))})
			}
			code := item.Job.ExitCode
			manager := &fakeManager{job: agents.Job{ID: "job-1", Status: item.Job.Status, ExitCode: &code, Result: item.Job.Result, Message: item.Job.Message}}
			runner := CoverRunner{Config: agents.Settings{Provider: "codex", Model: "gpt-image"}, NewManager: func(*agents.SettingsStore) CoverManager { return manager }}
			prompt := "Солнечная обложка."
			if item.Prompt != nil {
				prompt = *item.Prompt
			}
			path, err := runner.Run(context.Background(), CoverInput{WorkDir: workDir, Project: base, Prompt: prompt, Purpose: item.Purpose, References: references})
			if item.Error != "" {
				if err == nil || err.Error() != item.Error {
					t.Fatalf("ошибка %v, ожидалась %q", err, item.Error)
				}
			} else if err != nil || path != item.Result.Path {
				t.Fatalf("путь %q %v, ожидался %q", path, err, item.Result.Path)
			}
			if len(manager.starts) != 1 {
				t.Fatalf("запусков %d", len(manager.starts))
			}
			start, want := manager.starts[0], item.Starts[0]
			start.Project = strings.ReplaceAll(start.Project, base, "<project>")
			if got, expected := jsonOf(start), jsonOf(want.Input); got != expected {
				t.Fatalf("запуск\n%s\nожидался\n%s", got, expected)
			}
			if strings.ReplaceAll(manager.dirs[0], base, "<project>") != want.WorkDir || manager.config[0] != want.Config {
				t.Fatalf("папка %s настройки %+v", manager.dirs[0], manager.config[0])
			}
			entries, _ := os.ReadDir(filepath.Join(workDir, "references"))
			copied := []string{}
			for _, entry := range entries {
				copied = append(copied, entry.Name())
			}
			if strings.Join(copied, ",") != strings.Join(item.Copied, ",") {
				t.Fatalf("копии %v, ожидались %v", copied, item.Copied)
			}
			if data, _ := os.ReadFile(filepath.Join(base, "catalog", "plan", "project.json")); string(data) != item.ProjectJSON {
				t.Fatalf("project.json %q", data)
			}
		})
	}
}

// jsonOf — JSON значения для сравнения структур со срезами.
func jsonOf(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
