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

// TestKeepMeasures — ответ агента не меняет рост: заданный человеком остаётся, придуманный отбрасывается.
func TestKeepMeasures(t *testing.T) {
	previous := heightCast(t, `,"height":1.2`)
	next := heightCast(t, `,"height":1.7`)
	dynvalue.Get(next, "entities").(*dynvalue.Array).Items[2].(*dynvalue.Object).Set("height", 0.1)
	KeepMeasures(next, previous)
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
	KeepMeasures(fresh, nil)
	if strings.Contains(dynvalue.Stringify(fresh), "height") {
		t.Fatal("рост без прежнего кастинга")
	}
}

// TestVehicleSize — длина и ширина: необязательные числа после роста, только у транспорта, в тех же границах;
// ответ агента их не меняет.
func TestVehicleSize(t *testing.T) {
	truck := func(kind, size string) any {
		value, err := dynvalue.Parse([]byte(`{"schema_version":1,"entities":[
			{"id":"truck","kind":"` + kind + `","name":"Грузовик","short_name":"Грузовик","role":"","appearance":"","images":[],"initial_state":{}` + size + `}
		],"properties":{}}`))
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	normalized, err := Normalize(truck(VehicleKind, `,"width":2.5,"height":3.2,"length":7`), LoadDefaults())
	if err != nil {
		t.Fatal(err)
	}
	entity := dynvalue.Get(normalized, "entities").(*dynvalue.Array).Items[0].(*dynvalue.Object)
	if !slices.Equal(entity.Keys(), []string{"id", "kind", "name", "short_name", "role", "appearance", "height", "length", "width", "images", "initial_state"}) {
		t.Fatalf("порядок ключей: %v", entity.Keys())
	}
	if _, err := Normalize(truck(VehicleKind, `,"length":"7"`), LoadDefaults()); err == nil || err.Error() != textEntityStructureInvalid {
		t.Fatalf("длина строкой: %v", err)
	}
	for _, size := range []string{`,"length":0`, `,"width":-1`, `,"length":501`} {
		if problems, err := Validate(truck(VehicleKind, size)); err != nil || !slices.Contains(problems, textSizeInvalid("Грузовик")) {
			t.Fatalf("%s: %v %v", size, problems, err)
		}
	}
	if problems, _ := Validate(truck("prop", `,"length":7`)); !slices.Contains(problems, textSizeNotAllowed("Грузовик")) {
		t.Fatalf("длина не у транспорта: %v", problems)
	}
	if problems, _ := Validate(truck(VehicleKind, `,"length":7`)); len(problems) != 0 {
		t.Fatalf("одна длина без ширины: %v", problems)
	}
	next := truck(VehicleKind, `,"length":12`)
	KeepMeasures(next, truck(VehicleKind, `,"length":7,"width":2.5`))
	text := dynvalue.Stringify(next)
	if !strings.Contains(text, `"length":7`) || !strings.Contains(text, `"width":2.5`) || strings.Contains(text, `"length":12`) {
		t.Fatalf("размеры после ответа агента: %s", text)
	}
}
