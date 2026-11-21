package acceptshot

import (
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/assetpackage"
	"songframe/internal/toolrt"
)

// Сведения подготовки опор: план опор попытки с промптом генератора и действовавшими замечаниями,
// референс из source ссылкой с SHA-256, кадр другого плана и описание — копиями в комплекте.
func TestCollectPreparation(t *testing.T) {
	root := t.TempDir()
	write := func(path, text string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	attempt := "plan/batches/M02-attempt-01"
	write("source/heroes/mira.png", "png")
	write(attempt+"/continuity/M01-last.png", "кадр")
	write(attempt+"/description.md", "# M02\n")
	write(attempt+"/keyframe-prompts.json", `[
  {"id": "K01", "role": "first", "timeSeconds": 0, "prompt": "Мира у ворот", "referencePaths": ["source/heroes/mira.png", "`+attempt+`/continuity/M01-last.png"]},
  {"id": "K02", "role": "last", "timeSeconds": 5, "prompt": "", "referencePaths": [], "copyOf": "K01"}
]`)
	write(attempt+"/workflow.json", `{
  "keyframes": [
    {"id": "K01", "approved": true, "sha256": "aa", "provider": "codex", "generator_prompt": "Мира у ворот, вид снизу"},
    {"id": "K02", "approved": false, "sha256": null}
  ],
  "keyframe_notes": [
    {"id": 1, "frame": "K01", "note": "Без дождя", "scope": "frame", "active": true},
    {"id": 2, "frame": "K01", "note": "Снято", "scope": "frame", "active": false},
    {"id": 3, "frame": "K01", "note": "Тот же свет", "scope": "following", "active": true}
  ]
}`)
	workflow, err := loadJSON(filepath.Join(root, attempt, "workflow.json"))
	if err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	result, err := collectPreparation(root, attemptData{packageDir: filepath.Join(root, attempt), workflow: dict(workflow)}, staging)
	if err != nil {
		t.Fatal(err)
	}
	text := func(value any) string {
		t.Helper()
		out, err := toolrt.DumpsJSON(value, toolrt.DumpOptions{Compact: true})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	wantPrompts := `[{"id":"K01","role":"first","time_seconds":0,"prompt":"Мира у ворот","generator_prompt":"Мира у ворот, вид снизу",` +
		`"reference_paths":["source/heroes/mira.png","` + attempt + `/continuity/M01-last.png"],"notes":["Без дождя","Тот же свет"],"sha256":"aa"},` +
		`{"id":"K02","role":"last","time_seconds":5,"copy_of":"K01","prompt":"","generator_prompt":null,"reference_paths":[],"notes":["Тот же свет"],"sha256":null}]`
	if got := text(result.prompts); got != wantPrompts {
		t.Fatalf("frame_prompts:\n%s\nожидалось:\n%s", got, wantPrompts)
	}
	references := text(result.references)
	wantReferences := `[{"plan_path":"source/heroes/mira.png","root":"source","path":"heroes/mira.png","sha256":"` + fileSHA(t, filepath.Join(root, "source/heroes/mira.png")) + `","bytes":3},` +
		`{"plan_path":"` + attempt + `/continuity/M01-last.png","path":"reference-M01-last.png","sha256":"` + fileSHA(t, filepath.Join(root, attempt, "continuity/M01-last.png")) + `","bytes":8}]`
	if references != wantReferences {
		t.Fatalf("references:\n%s\nожидалось:\n%s", references, wantReferences)
	}
	if result.description != "description.md" || len(result.files) != 2 {
		t.Fatalf("описание %q, файлы %s", result.description, text(result.files))
	}
	for _, name := range []string{"description.md", "reference-M01-last.png"} {
		if !toolrt.IsFile(filepath.Join(staging, name)) {
			t.Fatalf("в комплекте нет %s", name)
		}
	}
	// Без попытки (приёмка по папке запроса) сведения пусты, как раньше.
	empty, err := collectPreparation(root, attemptData{}, t.TempDir())
	if err != nil || text(empty.prompts) != "[]" || text(empty.references) != "[]" || len(empty.files) != 0 {
		t.Fatalf("без попытки: %+v %v", empty, err)
	}
}

// fileSHA — SHA-256 файла path.
func fileSHA(t *testing.T, path string) string {
	t.Helper()
	digest, err := assetpackage.FileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	return digest
}
