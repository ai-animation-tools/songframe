package production_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/jobs"
	"songframe/internal/production"
)

// promptVariants — пакет M03 с видеопромптом на двух языках: video-prompt.txt (оригинал) и
// video-prompt.ru.txt (перевод), к отправке выбран вариант selected.
func promptVariants(e *env, original, translation, selected string) {
	e.t.Helper()
	for name, text := range map[string]string{"video-prompt.txt": original, "video-prompt.ru.txt": translation} {
		if err := os.WriteFile(filepath.Join(e.pkg, name), []byte(text), 0o644); err != nil {
			e.t.Fatal(err)
		}
	}
	path := filepath.Join(e.pkg, "workflow.json")
	data, err := os.ReadFile(path)
	if err != nil {
		e.t.Fatal(err)
	}
	var workflow map[string]any
	if err := json.Unmarshal(data, &workflow); err != nil {
		e.t.Fatal(err)
	}
	file := "video-prompt.txt"
	if selected == "translation" {
		file = "video-prompt.ru.txt"
	}
	workflow["prompt"] = map[string]any{"path": file, "approved": true, "original": "video-prompt.txt", "translation": "video-prompt.ru.txt"}
	text := original
	if selected == "translation" {
		text = translation
	}
	digest := sha256.Sum256([]byte(text))
	workflow["approved_prompt_sha256"] = hex.EncodeToString(digest[:])
	if data, err = json.MarshalIndent(workflow, "", "  "); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		e.t.Fatal(err)
	}
}

// Пакет показывает оба варианта видеопромпта и выбранный к отправке, а приёмка сохраняет рядом с
// отправленным текстом второй вариант: перевод при отправленном оригинале, оригинал при
// отправленном переводе. Принятый комплект отдаёт оба текста.
func TestPromptVariantsAccept(t *testing.T) {
	for _, selected := range []string{"original", "translation"} {
		t.Run(selected, func(t *testing.T) {
			e := newEnv(t, "test-video")
			fakeMedia(t, "120")
			// Замороженный запрос отправляет «Один дубль.»: это выбранный вариант, второй — другой текст.
			sent, other := "Один дубль.", "One take."
			original, translation := other, sent
			if selected == "original" {
				original, translation = sent, other
			}
			promptVariants(e, original, translation, selected)
			view := e.view()
			if view.Prompt == nil || view.Prompt.Variants == nil || view.Prompt.Variants.Original != original ||
				view.Prompt.Variants.Translation != translation || view.Prompt.Variants.Selected != selected || view.Prompt.Text != sent {
				t.Fatalf("промпт пакета: %+v", view.Prompt)
			}
			info, err := e.submit(e.quote(), "")
			if err != nil {
				t.Fatal(err)
			}
			if finished := e.wait(info); finished.Status != jobs.StatusDone {
				t.Fatalf("отправка %+v", finished)
			}
			accepted, err := e.prod.Accept(e.project, "M03", e.pkg, production.AcceptOptions{Mode: "full", ExpectedResultToken: e.view().ResultToken})
			if err != nil {
				t.Fatal(err)
			}
			if finished := e.wait(accepted); finished.Status != jobs.StatusDone {
				t.Fatalf("приёмка %+v", finished)
			}
			kitDir := filepath.Join(e.project, "assets", "shots", "M03")
			name, key := "generation-prompt.translation.txt", "prompt_translation"
			if selected == "translation" {
				name, key = "generation-prompt.original.txt", "prompt_original"
			}
			for file, want := range map[string]string{"generation-prompt.txt": sent, name: other} {
				if data, err := os.ReadFile(filepath.Join(kitDir, file)); err != nil || string(data) != want {
					t.Fatalf("%s: %q %v", file, data, err)
				}
			}
			var manifest struct {
				Generation map[string]json.RawMessage `json:"generation"`
			}
			data, _ := os.ReadFile(filepath.Join(kitDir, "manifest.json"))
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
			var descriptor struct {
				Path   string `json:"path"`
				SHA256 string `json:"sha256"`
			}
			if err := json.Unmarshal(manifest.Generation[key], &descriptor); err != nil || descriptor.Path != name || len(descriptor.SHA256) != 64 {
				t.Fatalf("manifest.generation.%s: %s", key, manifest.Generation[key])
			}
			kit, err := production.AcceptedKitFor(e.project, "M03")
			if err != nil || kit == nil || kit.Prompt == nil || *kit.Prompt != sent || kit.PromptVariants == nil ||
				kit.PromptVariants.Original != original || kit.PromptVariants.Translation != translation || kit.PromptVariants.Selected != selected {
				t.Fatalf("комплект: %+v %v", kit, err)
			}
		})
	}
}
