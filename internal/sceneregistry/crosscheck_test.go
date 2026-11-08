package sceneregistry_test

import (
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
	"songframe/internal/scenario"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolrt"
)

// modelDivergences — случаи cases.json, на которых отпечатки в модели toolrt (sceneregistry,
// инструменты tools.run) и в модели dynvalue (internal/scenario.SceneFingerprints, страницы
// приложения) расходятся по природе этих моделей.
var modelDivergences = map[string]string{
	// toolrt печатает дробное как 1.0, 1e-07, 1e+16, dynvalue — как 1, 1e-7, 10000000000000000.
	"floats-in-scene": "запись чисел float",
	// toolrt сортирует ключи по кодовым точкам, dynvalue — по кодовым единицам UTF-16:
	// символ вне BMP (суррогатная пара) встаёт перед U+FF01 только в dynvalue.
	"astral-keys": "порядок ключей вне BMP",
}

// TestFingerprintsMatchScenario доказывает, что отпечатки sceneregistry и internal/scenario совпадают
// на корректных реестрах эталона: интерфейс и инструменты сверяют принятие по одному SHA.
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
		reason, known := modelDivergences[name]
		switch {
		case same && known:
			t.Errorf("%s: отпечатки совпали, хотя записано расхождение (%s)", name, reason)
		case !same && !known:
			t.Errorf("%s: отпечатки toolrt и dynvalue расходятся (ошибка scenario: %v)", name, err)
		}
		compared++
	}
	if compared < 10 {
		t.Fatalf("сравнено только %d реестров", compared)
	}
	t.Logf("сравнено реестров: %d, известных расхождений: %d", compared, len(modelDivergences))
}
