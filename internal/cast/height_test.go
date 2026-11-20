package cast

import (
	"slices"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
)

// heightCast — кастинг с героем ростом 1,2 м, предметом без роста и миром сцены.
func heightCast(t *testing.T, height string) any {
	t.Helper()
	value, err := dynvalue.Parse([]byte(`{"schema_version":1,"entities":[
		{"id":"world","kind":"world","name":"Мир","short_name":"Мир","role":"","appearance":"","images":[],"initial_state":{}},
		{"id":"boy","kind":"character","name":"Мальчик","short_name":"Мальчик","role":"","appearance":"","images":[],"initial_state":{}` + height + `},
		{"id":"cup","kind":"prop","name":"Чашка","short_name":"Чашка","role":"","appearance":"","images":[],"initial_state":{}}
	],"properties":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

// TestHeight — рост сущности: необязательное число, ключ после внешности, проверка границ и типов без роста.
func TestHeight(t *testing.T) {
	normalized, err := Normalize(heightCast(t, `,"height":1.2`), LoadDefaults())
	if err != nil {
		t.Fatal(err)
	}
	boy := dynvalue.Get(normalized, "entities").(*dynvalue.Array).Items[1].(*dynvalue.Object)
	if !slices.Equal(boy.Keys(), []string{"id", "kind", "name", "short_name", "role", "appearance", "height", "images", "initial_state"}) {
		t.Fatalf("порядок ключей: %v", boy.Keys())
	}
	if boy.Value("height") != 1.2 {
		t.Fatalf("рост: %v", boy.Value("height"))
	}
	cup := dynvalue.Get(normalized, "entities").(*dynvalue.Array).Items[2].(*dynvalue.Object)
	if cup.Has("height") {
		t.Fatal("рост появился у сущности, где его не задавали")
	}
	if _, err := Normalize(heightCast(t, `,"height":"1.2"`), LoadDefaults()); err == nil || err.Error() != textEntityStructureInvalid {
		t.Fatalf("рост строкой: %v", err)
	}
	for _, height := range []string{`,"height":0`, `,"height":-1`, `,"height":501`} {
		problems, err := Validate(heightCast(t, height))
		if err != nil || !slices.Contains(problems, textHeightInvalid("Мальчик")) {
			t.Fatalf("%s: %v %v", height, problems, err)
		}
	}
	world := heightCast(t, "")
	dynvalue.Get(world, "entities").(*dynvalue.Array).Items[0].(*dynvalue.Object).Set("height", 2.0)
	if problems, _ := Validate(world); !slices.Contains(problems, textHeightNotAllowed("Мир")) {
		t.Fatalf("рост мира: %v", problems)
	}
}

// TestKeepHeights — ответ агента не меняет рост: заданный человеком остаётся, придуманный отбрасывается.
func TestKeepHeights(t *testing.T) {
	previous := heightCast(t, `,"height":1.2`)
	next := heightCast(t, `,"height":1.7`)
	dynvalue.Get(next, "entities").(*dynvalue.Array).Items[2].(*dynvalue.Object).Set("height", 0.1)
	KeepHeights(next, previous)
	normalized, err := Normalize(next, LoadDefaults())
	if err != nil {
		t.Fatal(err)
	}
	text := dynvalue.Stringify(normalized)
	if !strings.Contains(text, `"height":1.2`) || strings.Contains(text, `"height":0.1`) || strings.Contains(text, `"height":1.7`) {
		t.Fatalf("рост после ответа агента: %s", text)
	}
	// Без прежнего кастинга агенту нечего сохранять: рост не появляется.
	fresh := heightCast(t, `,"height":1.7`)
	KeepHeights(fresh, nil)
	if strings.Contains(dynvalue.Stringify(fresh), "height") {
		t.Fatal("рост без прежнего кастинга")
	}
}
