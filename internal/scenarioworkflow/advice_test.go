package scenarioworkflow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
)

// Факты контекста: крупность и сторона точки съёмки плана попадают к сущностям в его кадре.
func TestAdviceContextFacts(t *testing.T) {
	var item golden.Case
	for _, candidate := range golden.Load(t, "reference-advice") {
		if candidate.Name == "ready" {
			item = candidate
		}
	}
	project := item.BuildProject(t)
	path := filepath.Join(project, "plan", "scenes.json")
	var scenes map[string]any
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &scenes); err != nil {
		t.Fatal(err)
	}
	for _, raw := range scenes["scenes"].([]any) {
		scene := raw.(map[string]any)
		switch scene["id"] {
		case "M02":
			scene["viewpoint"] = map[string]any{"location": "pier", "side": "south", "size": "close"}
		case "M04":
			scene["viewpoint"] = map[string]any{"location": "pier", "side": "west", "size": "wide"}
		}
	}
	data, _ = json.Marshal(scenes)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	input, err := readInputs(project)
	if err != nil {
		t.Fatal(err)
	}
	context, entities, err := adviceContext(input, AdviceLooks{})
	if err != nil {
		t.Fatal(err)
	}
	// Модель без образов — ключа нет; с образами — модель, предел и виды.
	if strings.Contains(context, `"savedLooks"`) {
		t.Fatalf("savedLooks у модели без образов: %s", context)
	}
	withLooks, _, err := adviceContext(input, AdviceLooks{Model: "test-video", Limit: 3, Kinds: []string{"character", "prop"}})
	if err != nil {
		t.Fatal(err)
	}
	looksValue, _ := dynvalue.Parse([]byte(withLooks))
	if got := dynvalue.Stringify(dynvalue.Get(looksValue, "savedLooks")); got != `{"model":"test-video","limit":3,"kinds":["character","prop"]}` {
		t.Fatalf("savedLooks: %s", got)
	}
	if strings.Join(entities, ",") != "mira,lev,boat,pier" {
		t.Fatalf("сущности %v", entities)
	}
	parsed, _ := dynvalue.Parse([]byte(context))
	for _, fact := range arrayItems(dynvalue.Get(parsed, "facts")) {
		if dynvalue.Get(fact, "entity") != "mira" {
			continue
		}
		got := dynvalue.Stringify(dynvalue.Get(fact, "closeShots")) + " " + dynvalue.Stringify(dynvalue.Get(fact, "cameraSides"))
		if got != `["M02"] {"south":1,"west":1}` {
			t.Fatalf("факты Миры: %s", got)
		}
		return
	}
	t.Fatal("нет фактов Миры")
}

// Ответ отклоняется целиком: повтор сущности, число изображений вне предела, длинный список.
func TestParseAdviceReportRefusals(t *testing.T) {
	item := func(entity string, count any, views string) string {
		return `{"entity":"` + entity + `","name":"Мира","need":"Вид сбоку.","views":` + views + `,"count":` + dynvalue.Stringify(count) + `,"states":[],"why":"Снимают сбоку.","have":""}`
	}
	answer := func(items ...string) string {
		return `{"schemaVersion":1,"summary":"Итог","items":[` + strings.Join(items, ",") + `]}`
	}
	known := []string{"mira"}
	if _, err := parseAdviceReport(answer(item("mira", 1.0, `["сбоку"]`), item("", 2.0, `[]`)), known); err != nil {
		t.Fatalf("верный ответ: %v", err)
	}
	for name, text := range map[string]string{
		"повтор":      answer(item("mira", 1.0, `[]`), item("mira", 1.0, `[]`)),
		"ноль":        answer(item("mira", 0.0, `[]`)),
		"дробь":       answer(item("mira", 1.5, `[]`)),
		"список":      answer(item("mira", 1.0, `["1","2","3","4","5","6","7","8","9"]`)),
		"лишнее":      `{"schemaVersion":1,"summary":"Итог","items":[],"extra":1}`,
		"пустой итог": `{"schemaVersion":1,"summary":" ","items":[]}`,
	} {
		if _, err := parseAdviceReport(text, known); err == nil {
			t.Errorf("%s: ответ принят", name)
		}
	}
}
