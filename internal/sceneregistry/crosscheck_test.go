package sceneregistry_test

import (
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/scenario"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolrt"
)

// TestFingerprintsMatchScenario доказывает, что отпечатки sceneregistry и internal/scenario совпадают
// на всех корректных реестрах эталона, включая дробные числа и ключи вне BMP: интерфейс и
// инструменты сверяют принятие по одному SHA.
func TestFingerprintsMatchScenario(t *testing.T) {
	cases := golden.ValueFile(t, "scene-registry", "cases.json").([]any)
	compared := 0
	for _, entry := range cases {
		if golden.ValueString(t, entry, "call") != "registry" {
			continue
		}
		name := golden.ValueString(t, entry, "name")
		args := item(entry, "args").(*toolrt.Dict)
		text := golden.ValueString(t, args, "data")
		var toolInitial *toolrt.Dict
		pageInitial := dynvalue.NewObject()
		if initial, ok := args.Value("initial").(string); ok {
			toolInitial = golden.ParseDict(t, initial)
			value, err := dynvalue.Parse([]byte(initial))
			if err != nil {
				t.Fatal(err)
			}
			pageInitial = value.(*dynvalue.Object)
		}
		tools, err := sceneregistry.SceneFingerprints(golden.ParseValue(t, text), toolInitial)
		if err != nil {
			continue
		}
		data, err := dynvalue.Parse([]byte(text))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		pages, err := scenario.SceneFingerprints(data, pageInitial)
		same := err == nil && pages.Len() == tools.Len()
		if same {
			for _, sid := range tools.Keys() {
				same = same && pages.Value(sid) == tools.Value(sid)
			}
		}
		if !same {
			t.Errorf("%s: отпечатки toolrt и dynvalue расходятся (ошибка scenario: %v)", name, err)
		}
		compared++
	}
	if compared < 10 {
		t.Fatalf("сравнено только %d реестров", compared)
	}
	t.Logf("сравнено реестров: %d", compared)
}

// TestFingerprintIgnoresNumberSpelling доказывает, что запись числа в JSON (3.0 или 3) не меняет
// отпечаток постановки ни в инструментах, ни на страницах: принятый план не устаревает, если
// сценарий записан тем же числом в другой форме.
func TestFingerprintIgnoresNumberSpelling(t *testing.T) {
	registry := func(value string) string {
		return `{"schema_version": 1, "fps": 30, "audio": {"path": "source/track.mp3", "end_seconds": "10"},
"references": {"mira": {"name": "Мира", "path": "source/heroes/mira.png"}},
"sequences": [{"id": "intro", "title": "Вступление"}],
"scenes": [{"id": "M01", "original": "Инструментал", "sequence": "intro", "start_frame": 0,
"end_frame_exclusive": 300, "camera": "Общий план", "action": "Мира стоит.", "continuity": "Вечер.",
"references": ["mira"], "lipsync": false, "card": {"primary_reference": "mira"}, "state_from": null, "state_changes": {},
"viewpoint": {"location": "pier", "camera": {"start": [12.2, ` + value + `]}, "tilt": {"start": -4}}}]}`
	}
	digests := map[string]bool{}
	for _, value := range []string{"3", "3.0", "3e0"} {
		text := registry(value)
		tool, err := sceneregistry.SceneFingerprint(golden.ParseValue(t, text), "M01", nil)
		if err != nil {
			t.Fatalf("%s: %v", value, err)
		}
		data, err := dynvalue.Parse([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		pages, err := scenario.SceneFingerprints(data, dynvalue.NewObject())
		if err != nil {
			t.Fatalf("%s: %v", value, err)
		}
		if page := pages.Value("M01"); page != tool {
			t.Errorf("%s: инструмент %s, страницы %v", value, tool, page)
		}
		digests[tool] = true
	}
	if len(digests) != 1 {
		t.Errorf("запись числа меняет отпечаток: %v", digests)
	}
}
