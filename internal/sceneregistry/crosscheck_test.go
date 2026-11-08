package sceneregistry_test

import (
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/scenario"
	"songframe-go/internal/sceneregistry"
)

// tsDivergences — случаи cases.json, на которых отпечатки Python и TS-переноса
// (internal/scenario.SceneFingerprints, sceneFingerprints оригинального приложения) расходятся
// по природе языков. Для путей Python-инструментов действует Python (sceneregistry), для
// интерфейса — TS (scenario).
var tsDivergences = map[string]string{
	// Python печатает float как repr (1.0, 1e-07, 1e+16), JS — как Number#toString (1, 1e-7, 10000000000000000).
	"floats-in-scene": "запись чисел float",
	// sort_keys Python сортирует по кодовым точкам, сортировка JS — по кодовым единицам UTF-16:
	// символ вне BMP (суррогатная пара) встаёт перед U+FF01 только в JS.
	"astral-keys": "порядок ключей вне BMP",
}

// TestFingerprintsMatchTS доказывает, что Python- и TS-отпечатки совпадают на корректных реестрах
// эталона: интерфейс и инструменты сверяют принятие по одному SHA.
func TestFingerprintsMatchTS(t *testing.T) {
	cases := golden.PyFile(t, "scene-registry", "cases.json").([]any)
	compared := 0
	for _, entry := range cases {
		if golden.PyString(t, entry, "call") != "registry" {
			continue
		}
		name := golden.PyString(t, entry, "name")
		args := item(entry, "args").(*pycompat.Dict)
		text := golden.PyString(t, args, "data")
		var pyInitial *pycompat.Dict
		jsInitial := jscompat.NewObject()
		if initial, ok := args.Value("initial").(string); ok {
			pyInitial = golden.PyDict(t, initial)
			value, err := jscompat.Parse([]byte(initial))
			if err != nil {
				t.Fatal(err)
			}
			jsInitial = value.(*jscompat.Object)
		}
		python, err := sceneregistry.SceneFingerprints(golden.PyParse(t, text), pyInitial)
		if err != nil {
			continue
		}
		data, err := jscompat.Parse([]byte(text))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		ts, err := scenario.SceneFingerprints(data, jsInitial)
		same := err == nil && ts.Len() == python.Len()
		if same {
			for _, sid := range python.Keys() {
				same = same && ts.Value(sid) == python.Value(sid)
			}
		}
		reason, known := tsDivergences[name]
		switch {
		case same && known:
			t.Errorf("%s: отпечатки совпали, хотя записано расхождение (%s)", name, reason)
		case !same && !known:
			t.Errorf("%s: отпечатки Python и TS расходятся (TS ошибка: %v)", name, err)
		}
		compared++
	}
	if compared < 10 {
		t.Fatalf("сравнено только %d реестров", compared)
	}
	t.Logf("сравнено реестров: %d, известных расхождений: %d", compared, len(tsDivergences))
}
