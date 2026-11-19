package scenesave

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
)

// TestSplitAndMergeKeepAcceptedShot повторяет деление и объединение планов редактора сценария
// (frontend/src/shared/scene-editing.ts) выше принятого плана: коды не сдвигаются, первая половина
// сохраняет итог состояния, поэтому отпечаток принятого M02 не меняется, сохранение не включает
// его в затронутые и оставляет его приёмку.
func TestSplitAndMergeKeepAcceptedShot(t *testing.T) {
	var item golden.Case
	for _, candidate := range golden.Load(t, "scenario-scenes") {
		if candidate.Name == "mini-state-keep" {
			item = candidate
		}
	}
	if item.Name == "" {
		t.Fatal("нет случая mini-state-keep")
	}
	project := item.CopyProject(t)
	registry := readScenes(t, project)
	scenes := registry["scenes"].([]any)
	first := scenes[0].(map[string]any)
	accepted := acceptedFingerprints(project)["M02"]
	if accepted == "" {
		t.Fatal("M02 должен быть принят")
	}

	// Деление M01 на M01 (со всеми изменениями состояния) и M01.1, продолжающий его итог, как splitShot;
	// ссылка M03 на M01 (фаза same) не переписывается.
	second := cloneMap(t, first)
	first["end_frame_exclusive"] = 45
	second["id"] = "M01.1"
	second["start_frame"] = 45
	second["state_from"] = "M01"
	second["state_changes"] = map[string]any{}
	registry["scenes"] = append([]any{first, second}, scenes[1:]...)
	assertKept(t, project, registry, accepted)

	// Объединение M01 и M01.1 обратно, как mergeShots.
	registry = readScenes(t, project)
	scenes = registry["scenes"].([]any)
	merged := scenes[0].(map[string]any)
	merged["end_frame_exclusive"] = 90
	registry["scenes"] = append([]any{merged}, scenes[2:]...)
	assertKept(t, project, registry, accepted)
}

// assertKept сохраняет черновик в режиме production и проверяет, что M02 не затронут и остался принятым.
func assertKept(t *testing.T, project string, registry map[string]any, accepted string) {
	t.Helper()
	raw, err := json.Marshal(registry)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := dynvalue.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	impact, err := SaveImpact(project, dynvalue.DeepClone(draft))
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, shot := range impact.Shots {
		ids = append(ids, shot.ID)
	}
	if slices.Contains(ids, "M02") {
		t.Fatalf("M02 среди затронутых: %v", ids)
	}
	if _, err := SaveScenesWithMode(project, draft, "production"); err != nil {
		t.Fatal(err)
	}
	if got := acceptedFingerprints(project)["M02"]; got != accepted {
		t.Fatalf("приёмка M02 изменилась: %q → %q", accepted, got)
	}
	if fingerprint, _ := fingerprintsOf(project, readRegistry(project)).Value("M02").(string); fingerprint != accepted {
		t.Fatalf("отпечаток M02 %q не совпадает с принятым %q", fingerprint, accepted)
	}
}

// readScenes читает сохранённый реестр как обычные значения JSON для правки в тесте.
func readScenes(t *testing.T, project string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(project, "plan", "scenes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var registry map[string]any
	if err := json.Unmarshal(raw, &registry); err != nil {
		t.Fatal(err)
	}
	return registry
}

// cloneMap — глубокая копия плана через JSON.
func cloneMap(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

// TestReasonStateLinkOnly — объединение убрало код, на который ссылался следующий план: ссылка
// state_from перешла к объединённому плану, состояние то же, и причина называет именно это,
// а не изменённую постановку.
func TestReasonStateLinkOnly(t *testing.T) {
	var item golden.Case
	for _, candidate := range golden.Load(t, "scenario-scenes") {
		if candidate.Name == "mini-state-keep" {
			item = candidate
		}
	}
	project := item.CopyProject(t)
	parse := func(registry map[string]any) any {
		raw, err := json.Marshal(registry)
		if err != nil {
			t.Fatal(err)
		}
		value, err := dynvalue.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := readScenes(t, project)
	scenes := before["scenes"].([]any)
	first := scenes[0].(map[string]any)
	second := cloneMap(t, first)
	first["end_frame_exclusive"] = 45
	second["id"] = "M01.1"
	second["start_frame"] = 45
	second["state_from"] = "M01"
	second["state_changes"] = map[string]any{}
	scenes[1].(map[string]any)["state_from"] = "M01.1"
	before["scenes"] = append([]any{first, second}, scenes[1:]...)

	after := readScenes(t, project)
	after["scenes"].([]any)[1].(map[string]any)["state_from"] = "M01"
	reason, err := reasonOf(project, parse(before), parse(after), "M02")
	if err != nil {
		t.Fatal(err)
	}
	if reason != textImpactStateLink("M01") {
		t.Fatalf("причина %q", reason)
	}
}
