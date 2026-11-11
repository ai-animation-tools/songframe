package productionworkflow

import "testing"

// TestManualDescriptionSingleFrame — в ручном режиме описание принимает ровно одну опору K01 на
// начале плана, а обычный план по-прежнему требует не меньше двух.
func TestManualDescriptionSingleFrame(t *testing.T) {
	single := `{"schemaVersion":1,"stage":"description","description":"Парень поёт.","requestSeconds":5,` +
		`"keyframes":[{"id":"K01","role":"first","timeSeconds":0,"prompt":"Кадр.","referencePaths":[]}]}`
	pair := `{"schemaVersion":1,"stage":"description","description":"Парень поёт.","requestSeconds":5,` +
		`"keyframes":[{"id":"K01","role":"first","timeSeconds":0,"prompt":"Кадр.","referencePaths":[]},` +
		`{"id":"K02","role":"last","timeSeconds":5,"prompt":"Кадр.","referencePaths":[]}]}`
	late := `{"schemaVersion":1,"stage":"description","description":"Парень поёт.","requestSeconds":5,` +
		`"keyframes":[{"id":"K01","role":"first","timeSeconds":1,"prompt":"Кадр.","referencePaths":[]}]}`
	manual := Rules{Stage: "description", WindowSeconds: 4.5, DurationRule: "min_supported_strictly_greater_than_window", Manual: true}
	ordinary := manual
	ordinary.Manual = false
	if _, err := ParseProposal(single, manual); err != nil {
		t.Fatalf("одна опора в ручном режиме: %v", err)
	}
	if _, err := ParseProposal(pair, manual); err == nil || err.Error() != textManualSingleFrame {
		t.Fatalf("две опоры в ручном режиме: %v", err)
	}
	if _, err := ParseProposal(late, manual); err == nil || err.Error() != textFrameBoundariesInvalid {
		t.Fatalf("опора не на начале: %v", err)
	}
	if _, err := ParseProposal(single, ordinary); err == nil || err.Error() != textDescriptionInvalid {
		t.Fatalf("одна опора в обычном плане: %v", err)
	}
	if !RulesFromTree(manual.Tree()).Manual || RulesFromTree(ordinary.Tree()).Manual || ordinary.Tree().Has("manualGeneration") {
		t.Fatal("признак ручного режима в записи правил")
	}
}
