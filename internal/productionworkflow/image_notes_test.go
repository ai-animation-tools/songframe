package productionworkflow

import (
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/sources"
)

// TestWithImageNotes — примечания описи к изображениям сущности попадают в imageNotes в порядке
// images, без пустых; сущность без примечаний и исходный объект кастинга не меняются.
func TestWithImageNotes(t *testing.T) {
	place, err := dynvalue.Parse([]byte(`{"id":"perekryostok","images":["locations/p.png","locations/p-2.png","locations/p-8.png"]}`))
	if err != nil {
		t.Fatal(err)
	}
	hero, err := dynvalue.Parse([]byte(`{"id":"artem","images":["heroes/artem.png"]}`))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]sources.FileInfo{
		"locations/p.png":   {Label: "Перекрёсток — пустой ракурс, красный", Note: "пустой ракурс, красный"},
		"locations/p-2.png": {Label: "Перекрёсток (2)"},
		"locations/p-8.png": {Label: "Перекрёсток — пустой ракурс, зелёный", Note: "пустой ракурс, зелёный"},
	}
	result := withImageNotes([]any{place, hero}, files)
	got := dynvalue.Stringify(dynvalue.Get(result[0], "imageNotes"))
	if want := `[{"path":"locations/p.png","note":"пустой ракурс, красный"},{"path":"locations/p-8.png","note":"пустой ракурс, зелёный"}]`; got != want {
		t.Fatalf("imageNotes %s, ожидалось %s", got, want)
	}
	if result[1] != hero || dynvalue.Get(place, "imageNotes") != dynvalue.Undefined {
		t.Fatal("сущность без примечаний или исходный кастинг изменены")
	}
}
