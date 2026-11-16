package productionworkflow

import (
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
)

// TestReferenceEntities — каждое изображение сущности кастинга плана подписывается её ID, именем
// и видом по пути от проекта; сущность без ID и не-строковые пути пропускаются.
func TestReferenceEntities(t *testing.T) {
	value, err := dynvalue.Parse([]byte(`[
	  {"id":"world","kind":"world","name":"Мир"},
	  {"id":"masterskaya","kind":"location","name":"Мастерская","images":["locations/masterskaya.png"]},
	  {"id":"artem","kind":"character","name":"Артём","images":["heroes/artem.png","heroes/artem-2.png",7]},
	  {"kind":"prop","name":"Без ID","images":["props/x.png"]}]`))
	if err != nil {
		t.Fatal(err)
	}
	got := referenceEntities(value.(*dynvalue.Array))
	want := map[string]mediaapi.ReferenceEntity{
		"source/locations/masterskaya.png": {ID: "masterskaya", Name: "Мастерская", Kind: "location"},
		"source/heroes/artem.png":          {ID: "artem", Name: "Артём", Kind: "character"},
		"source/heroes/artem-2.png":        {ID: "artem", Name: "Артём", Kind: "character"},
	}
	if len(got) != len(want) {
		t.Fatalf("подписи %v", got)
	}
	for path, entity := range want {
		if got[path] != entity {
			t.Fatalf("%s: %+v, ожидалось %+v", path, got[path], entity)
		}
	}
	if len(referenceEntities(nil)) != 0 {
		t.Fatal("без кастинга подписей нет")
	}
}
