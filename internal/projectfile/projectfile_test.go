package projectfile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/golden"
)

// TestSettingsGolden — readProjectSettings/writeProjectSettings на эталонах оригинала
// (testdata/golden/project-settings): результат, байты plan/project.json и тексты ошибок.
// Для ошибок чтения Node (ENOENT, разбор JSON) сравнивается только префикс сообщения.
func TestSettingsGolden(t *testing.T) {
	for _, item := range golden.Load(t, "project-settings") {
		t.Run(item.Name, func(t *testing.T) {
			project := item.CopyProject(t)
			var expected struct {
				Error         *string         `json:"error"`
				ErrorPrefix   *string         `json:"errorPrefix"`
				Result        json.RawMessage `json:"result"`
				FileUnchanged bool            `json:"fileUnchanged"`
			}
			if err := json.Unmarshal(item.Expected(t), &expected); err != nil {
				t.Fatal(err)
			}
			file := File(project)
			before, _ := os.ReadFile(file)
			var got Settings
			var err error
			if item.Call == "writeProjectSettings" {
				var input struct {
					Settings struct {
						AgentInstructions *string         `json:"agentInstructions"`
						Name              string          `json:"name"`
						AnimaticVideo     string          `json:"animaticVideo"`
						Generation        json.RawMessage `json:"generation"`
					} `json:"settings"`
					Unset [][]string `json:"unset"`
				}
				if err := json.Unmarshal(item.Read(t, "input.json"), &input); err != nil {
					t.Fatal(err)
				}
				got, err = WriteSettings(project, SettingsInput{
					AgentInstructions: input.Settings.AgentInstructions, Name: input.Settings.Name,
					AnimaticVideo: input.Settings.AnimaticVideo, Generation: input.Settings.Generation, Unset: input.Unset,
				})
			} else {
				got, err = ReadSettings(project)
			}
			switch {
			case expected.ErrorPrefix != nil:
				if err == nil || !strings.HasPrefix(err.Error(), *expected.ErrorPrefix) {
					t.Fatalf("ошибка %v, ожидался префикс %q", err, *expected.ErrorPrefix)
				}
			case expected.Error != nil:
				if err == nil || err.Error() != *expected.Error {
					t.Fatalf("ошибка %v, ожидалась %q", err, *expected.Error)
				}
			default:
				if err != nil {
					t.Fatal(err)
				}
				golden.AssertValue(t, expected.Result, got, project)
			}
			after, _ := os.ReadFile(file)
			if expected.FileUnchanged {
				if string(before) != string(after) {
					t.Fatalf("plan/project.json изменился:\n%s", after)
				}
				return
			}
			if want := item.Read(t, "expected-project.json"); string(want) != string(after) {
				t.Fatalf("plan/project.json:\n%s\nожидалось:\n%s", after, want)
			}
		})
	}
}

// TestSettingsReadDoesNotWrite — просмотр настроек не меняет файл и время изменения.
func TestSettingsReadDoesNotWrite(t *testing.T) {
	project := t.TempDir()
	file := File(project)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(`{"name":"Клип","generation":{"video":{"provider":"test"}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(file)
	if _, err := ReadSettings(project); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(file)
	entries, _ := os.ReadDir(filepath.Dir(file))
	if !after.ModTime().Equal(info.ModTime()) || len(entries) != 1 {
		t.Fatal("чтение настроек записало файлы")
	}
}
