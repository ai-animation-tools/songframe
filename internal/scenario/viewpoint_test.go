package scenario

import (
	"slices"
	"testing"

	"songframe/internal/dynvalue"
)

// TestViewpointProblems — таблица проверки точки съёмки: допустимые формы и каждое нарушение.
func TestViewpointProblems(t *testing.T) {
	castValue, err := dynvalue.Parse([]byte(`{"entities": [
		{"id": "yard", "kind": "location"}, {"id": "ivan", "kind": "character"}, {"id": "world", "kind": "world"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	locations := castLocations(castValue)
	if !slices.Equal(locations, []string{"yard"}) {
		t.Fatalf("локации кастинга: %v", locations)
	}
	references := []string{"ivan", "boy"}
	cases := []struct {
		name, json string
		want       []string
	}{
		{"без точки", ``, nil},
		{"сторона и крупность", `{"location": "yard", "side": "south", "size": "wide"}`, []string{}},
		{"камера с концом, герои и угол", `{"location": "yard", "side": "west", "size": "medium", "fov": 18,
			"camera": {"start": [-3, 0], "end": [-3, 15]},
			"subjects": [{"entity": "ivan", "start": [1, 0], "end": [1, 15]}, {"entity": "boy", "start": [8, 6]}]}`, []string{}},
		{"не объект", `"south"`, []string{textViewpointShape("M01")}},
		{"лишний ключ", `{"location": "yard", "side": "south", "size": "wide", "at": [1, 2]}`, []string{textViewpointShape("M01")}},
		{"нет крупности", `{"location": "yard", "side": "south"}`, []string{textViewpointShape("M01")}},
		{"не локация", `{"location": "ivan", "side": "south", "size": "wide"}`, []string{textViewpointLocation("M01", "ivan")}},
		{"неизвестная сторона и крупность", `{"location": "yard", "side": "south-west", "size": "long"}`,
			[]string{textViewpointSide("M01", "south-west"), textViewpointSize("M01", "long")}},
		{"своё направление камеры", `{"location": "yard", "side": "south", "size": "wide", "camera": {"start": [0, 0]}, "heading": {"start": 0, "end": 359.5}}`, []string{}},
		{"направление без конца", `{"location": "yard", "side": "south", "size": "wide", "heading": {"start": 120}}`, []string{}},
		{"своя высота камеры", `{"location": "yard", "side": "south", "size": "wide", "camera": {"start": [0, 0]}, "camera_height": {"start": 0.3, "end": 12}}`, []string{}},
		{"высота числом", `{"location": "yard", "side": "south", "size": "wide", "camera_height": 2}`, []string{textViewpointCameraHeight("M01")}},
		{"нулевая высота", `{"location": "yard", "side": "south", "size": "wide", "camera_height": {"start": 0}}`, []string{textViewpointCameraHeight("M01")}},
		{"высота выше предела", `{"location": "yard", "side": "south", "size": "wide", "camera_height": {"start": 1.6, "end": 501}}`, []string{textViewpointCameraHeight("M01")}},
		{"лишний ключ высоты", `{"location": "yard", "side": "south", "size": "wide", "camera_height": {"start": 1, "speed": 2}}`, []string{textViewpointCameraHeight("M01")}},
		{"свой наклон", `{"location": "yard", "side": "south", "size": "wide", "tilt": {"start": -90, "end": 15.5}}`, []string{}},
		{"наклон числом", `{"location": "yard", "side": "south", "size": "wide", "tilt": -10}`, []string{textViewpointTilt("M01")}},
		{"наклон за пределом", `{"location": "yard", "side": "south", "size": "wide", "tilt": {"start": 0, "end": 91}}`, []string{textViewpointTilt("M01")}},
		{"лишний ключ наклона", `{"location": "yard", "side": "south", "size": "wide", "tilt": {"start": 0, "speed": 2}}`, []string{textViewpointTilt("M01")}},
		{"направление числом", `{"location": "yard", "side": "south", "size": "wide", "heading": 90}`, []string{textViewpointHeading("M01")}},
		{"направление 360", `{"location": "yard", "side": "south", "size": "wide", "heading": {"start": 360}}`, []string{textViewpointHeading("M01")}},
		{"отрицательный конец направления", `{"location": "yard", "side": "south", "size": "wide", "heading": {"start": 10, "end": -5}}`, []string{textViewpointHeading("M01")}},
		{"направление без начала", `{"location": "yard", "side": "south", "size": "wide", "heading": {"end": 10}}`, []string{textViewpointHeading("M01")}},
		{"лишний ключ направления", `{"location": "yard", "side": "south", "size": "wide", "heading": {"start": 10, "speed": 2}}`, []string{textViewpointHeading("M01")}},
		{"нулевой угол", `{"location": "yard", "side": "south", "size": "wide", "fov": 0}`, []string{textViewpointFov("M01")}},
		{"угол 180", `{"location": "yard", "side": "south", "size": "wide", "fov": 180}`, []string{textViewpointFov("M01")}},
		{"камера без начала", `{"location": "yard", "side": "south", "size": "wide", "camera": {"end": [1, 2]}}`, []string{textViewpointCamera("M01")}},
		{"камера из трёх чисел", `{"location": "yard", "side": "south", "size": "wide", "camera": {"start": [1, 2, 3]}}`, []string{textViewpointCamera("M01")}},
		{"конец камеры строкой", `{"location": "yard", "side": "south", "size": "wide", "camera": {"start": [1, 2], "end": ["1", 2]}}`, []string{textViewpointCamera("M01")}},
		{"лишний ключ камеры", `{"location": "yard", "side": "south", "size": "wide", "camera": {"start": [1, 2], "heading": 90}}`, []string{textViewpointCamera("M01")}},
		{"герои не список", `{"location": "yard", "side": "south", "size": "wide", "subjects": {"entity": "ivan"}}`, []string{textViewpointSubjects("M01")}},
		{"герой без точки", `{"location": "yard", "side": "south", "size": "wide", "subjects": [{"entity": "ivan"}]}`, []string{textViewpointSubjects("M01")}},
		{"герой не объект", `{"location": "yard", "side": "south", "size": "wide", "subjects": ["ivan"]}`, []string{textViewpointSubjects("M01")}},
		{"герой не из референсов", `{"location": "yard", "side": "south", "size": "wide", "subjects": [{"entity": "kirill", "start": [0, 0]}]}`,
			[]string{textViewpointSubjectUnknown("M01", "kirill")}},
		{"машина со своим направлением", `{"location": "yard", "side": "south", "size": "wide", "subjects": [{"entity": "ivan", "start": [0, 0], "facing": 270}]}`, []string{}},
		{"направление героя вне круга", `{"location": "yard", "side": "south", "size": "wide", "subjects": [{"entity": "ivan", "start": [0, 0], "facing": 360}]}`,
			[]string{textViewpointSubjects("M01")}},
		{"герой дважды", `{"location": "yard", "side": "south", "size": "wide", "subjects": [{"entity": "ivan", "start": [0, 0]}, {"entity": "ivan", "start": [1, 1]}]}`,
			[]string{textViewpointSubjectRepeated("M01", "ivan")}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			value := any(dynvalue.Undefined)
			if item.json != "" {
				parsed, err := dynvalue.Parse([]byte(item.json))
				if err != nil {
					t.Fatal(err)
				}
				value = parsed
			}
			got := viewpointProblems("M01", value, locations, references)
			if len(got) != len(item.want) || (len(item.want) > 0 && !slices.Equal(got, item.want)) {
				t.Fatalf("получено %q, ожидалось %q", got, item.want)
			}
		})
	}
}

// TestShotReferences — референсы плана без заглушки «—» и нестроковых значений.
func TestShotReferences(t *testing.T) {
	scene, err := dynvalue.Parse([]byte(`{"references": ["ivan", "—", "boy"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := shotReferences(scene); !slices.Equal(got, []string{"ivan", "boy"}) {
		t.Fatalf("референсы %v", got)
	}
}
