package referenceimage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/sourceedit"
)

// caseByName — случай эталона домена по имени каталога.
func caseByName(t *testing.T, domain, name string) golden.Case {
	t.Helper()
	for _, item := range golden.Load(t, domain) {
		if item.Name == name {
			return item
		}
	}
	t.Fatalf("нет случая %s/%s", domain, name)
	return golden.Case{}
}

// readJSON читает JSON-файл проекта в обычные значения Go.
func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

// fileShape — пути изображений и промптов референсов описи: код → [путь, промпт, …] и общий промпт.
func fileShape(manifest map[string]any) map[string][]any {
	result := map[string][]any{}
	for _, item := range manifest["references"].([]any) {
		ref := item.(map[string]any)
		shape := []any{}
		for _, file := range ref["files"].([]any) {
			shape = append(shape, file.(map[string]any)["path"], file.(map[string]any)["prompt"])
		}
		result[ref["id"].(string)] = append(shape, ref["prompt"])
	}
	return result
}

// entityImages — images сущностей кастинга по коду.
func entityImages(cast map[string]any) map[string][]any {
	result := map[string][]any{}
	for _, item := range cast["entities"].([]any) {
		entity := item.(map[string]any)
		result[entity["id"].(string)] = entity["images"].([]any)
	}
	return result
}

// TestKindChangeMovesFiles — смена типа переносит изображения, их промпты и общий промпт в папку
// нового типа (байты те же), опустевшая папка без .gitkeep удаляется, а images кастинга получают
// новые пути без расширения выбора пользователя. Отличие от 634fd94.
func TestKindChangeMovesFiles(t *testing.T) {
	item := caseByName(t, "sources-save-cast", "unchanged")
	project := item.CopyProject(t)
	source := filepath.Join(project, "source")
	before := digest(t, source)
	input, _ := readInput(t, item)
	input.References[0].Kind = "location"
	input.References[1].Kind = "character"
	if _, err := SaveSources(context.Background(), project, input, ""); err != nil {
		t.Fatal(err)
	}
	after := digest(t, source)
	for from, to := range map[string]string{
		"heroes/mira.png":            "locations/mira.png",
		"heroes/mira-2.png":          "locations/mira-2.png",
		"heroes/mira.png.prompt.txt": "locations/mira.png.prompt.txt",
		"vehicles/boat.png":          "heroes/boat.png",
		"vehicles/boat.prompt.txt":   "heroes/boat.prompt.txt",
	} {
		if _, ok := after[from]; ok {
			t.Errorf("%s остался на прежнем месте", from)
		}
		if after[to] != before[from] {
			t.Errorf("%s: байты не совпадают с %s", to, from)
		}
	}
	if _, err := os.Stat(filepath.Join(source, "vehicles")); !os.IsNotExist(err) {
		t.Error("опустевшая папка vehicles не удалена")
	}
	if _, ok := after["heroes/.gitkeep"]; !ok {
		t.Error("папка шаблона heroes потеряла .gitkeep")
	}
	want := map[string][]any{
		"mira": {"locations/mira.png", "locations/mira.png.prompt.txt", "locations/mira-2.png", nil, nil},
		"boat": {"heroes/boat.png", nil, "heroes/boat.prompt.txt"},
	}
	if got := fileShape(readJSON(t, filepath.Join(source, "manifest.json"))); !reflect.DeepEqual(got, want) {
		t.Errorf("опись: %v, ожидалось %v", got, want)
	}
	images := entityImages(readJSON(t, filepath.Join(project, "plan", "cast.json")))
	if !reflect.DeepEqual(images["mira"], []any{"locations/mira.png"}) || !reflect.DeepEqual(images["boat"], []any{"heroes/boat.png"}) {
		t.Errorf("images кастинга: %v", images)
	}
}

// TestPinnedKindChangeKeepsFiles — у закреплённого референса смена типа меняет только тип в описи:
// файлы и пути остаются прежними.
func TestPinnedKindChangeKeepsFiles(t *testing.T) {
	item := caseByName(t, "sources-save-cast", "unchanged")
	project := item.CopyProject(t)
	source := filepath.Join(project, "source")
	before := digest(t, source)
	input, _ := readInput(t, item)
	input.References[0].Kind = "location"
	_, moves, err := sourceedit.SaveManifest(context.Background(), project, input, "", sourceedit.SaveOptions{Pinned: map[string]bool{"mira": true}})
	if err != nil {
		t.Fatal(err)
	}
	if len(moves) != 0 {
		t.Fatalf("закреплённый референс перенесён: %v", moves)
	}
	after := digest(t, source)
	delete(before, "manifest.json")
	delete(after, "manifest.json")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("файлы изменились: было %v, стало %v", before, after)
	}
}

// TestPinnedReferences — референсы планов с готовыми материалами (принятый комплект или пакет)
// закреплены за этими планами; ссылка через card.primary_reference тоже считается.
func TestPinnedReferences(t *testing.T) {
	project := caseByName(t, "scenario-scenes", "mini-bounds").ProjectPath()
	got := PinnedReferences(project)
	want := map[string][]string{"mira": {"M01", "M02", "M03"}, "boat": {"M02"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("закрепление %v, ожидалось %v", got, want)
	}
	kinds := EntityKinds(project)
	if kinds["mira"] != "character" || kinds["boat"] != "vehicle" || kinds["world"] != "world" {
		t.Fatalf("типы сущностей: %v", kinds)
	}
}
