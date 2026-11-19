package schemes

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// castJSON — кастинг с двумя локациями и героем: локации получают схемы, герой — связь объекта.
const castJSON = `{
  "schema_version": 1,
  "entities": [
    {"id": "world", "kind": "world", "name": "Мир"},
    {"id": "crossing", "kind": "location", "name": "Перекрёсток"},
    {"id": "street", "kind": "location", "name": "Улица"},
    {"id": "hero", "kind": "character", "name": "Герой"}
  ],
  "properties": {}
}`

// newProject — временный проект с кастингом.
func newProject(t *testing.T) string {
	t.Helper()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, "plan"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "plan", "cast.json"), []byte(castJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	return project
}

func number(value float64) *float64 { return &value }
func point(x, y float64) *Point     { return &Point{x, y} }

// sample — вид сверху перекрёстка со всеми типами фигур и вид с запада.
func sample() Document {
	return Document{SchemaVersion: 1, Schemes: []Scheme{
		{ID: "s1", Location: "crossing", Title: "Перекрёсток сверху", View: ViewTop, Objects: []Object{
			{ID: "o1", Name: "Проезжая часть", Shape: Shape{Type: ShapeRect, Center: point(5, 40), Size: point(10, 120), Rotation: number(0)}},
			{ID: "o2", Name: "Дом", Height: number(12), Entity: "street", Shape: Shape{Type: ShapeRect, Center: point(22, 54), Size: point(16, 92)}},
			{ID: "o3", Name: "Клумба", Shape: Shape{Type: ShapeEllipse, Center: point(20, 0), Radii: point(2, 2)}},
			{ID: "o4", Name: "Сквер", Height: number(7), Color: "#4caf50", Shape: Shape{Type: ShapePolygon, Points: []Point{{14, -20}, {30, -20}, {30, 7}}}},
			{ID: "o5", Name: "Трасса", Shape: Shape{Type: ShapeLine, Points: []Point{{0, 0}, {10, 5}, {20, 0}}, Smooth: true, Closed: true, Width: number(12)}},
			{ID: "o6", Name: "Светофор", Height: number(3.5), Shape: Shape{Type: ShapePoint, At: point(10.5, 7)}},
		}},
		{ID: "s2", Location: "crossing", Title: "Сквер с запада", View: ViewWest, Objects: []Object{}},
	}}
}

func TestReadMissing(t *testing.T) {
	document, missing, err := Read(newProject(t))
	if err != nil || !missing || document.SchemaVersion != 1 || len(document.Schemes) != 0 {
		t.Fatalf("документ %+v, missing %v, ошибка %v", document, missing, err)
	}
}

func TestSaveAndReadBack(t *testing.T) {
	project := newProject(t)
	saved, err := Save(project, sample())
	if err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(Path(project))
	document, missing, err := Read(project)
	if err != nil || missing {
		t.Fatalf("чтение: %v", err)
	}
	if len(document.Schemes) != 2 || len(document.Schemes[0].Objects) != 6 || document.Schemes[0].Objects[4].Shape.Width == nil {
		t.Fatalf("прочитано не то: %+v", document)
	}
	if _, err := Save(project, document); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(Path(project))
	if string(first) != string(second) {
		t.Fatalf("повторная запись меняет байты:\n%s\n%s", first, second)
	}
	if !strings.HasSuffix(string(first), "}\n") || strings.Contains(string(first), `<`) {
		t.Fatalf("формат файла: %s", first)
	}
	if saved.Schemes[0].Objects[1].Entity != "street" {
		t.Fatal("связь с кастингом потеряна")
	}
}

func TestReadDamaged(t *testing.T) {
	project := newProject(t)
	for _, text := range []string{"{", `{"schema_version": 1, "schemes": [], "extra": 1}`} {
		if err := os.WriteFile(Path(project), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Read(project); !errors.Is(err, errDamaged) {
			t.Fatalf("%q: ожидалось повреждение, получено %v", text, err)
		}
		view, err := ViewProject(project)
		if err != nil || !view.Damaged || !slices.Contains(view.Problems, textFileDamaged) {
			t.Fatalf("вид повреждённого: %+v %v", view, err)
		}
		// Повреждённый файл не перезаписывается.
		if _, err := Save(project, sample()); !errors.Is(err, errDamaged) {
			t.Fatalf("запись поверх повреждённого: %v", err)
		}
		after, _ := os.ReadFile(Path(project))
		if string(after) != text {
			t.Fatal("повреждённый файл изменён")
		}
	}
}

func TestSaveRejectsAndKeepsFile(t *testing.T) {
	project := newProject(t)
	if _, err := Save(project, sample()); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(Path(project))
	broken := sample()
	broken.Schemes[0].Objects[0].Name = " "
	_, err := Save(project, broken)
	if err == nil || !strings.Contains(err.Error(), "нет названия") {
		t.Fatalf("ошибка %v", err)
	}
	after, _ := os.ReadFile(Path(project))
	if string(before) != string(after) {
		t.Fatal("отказ изменил файл")
	}
}

func TestSaveWriteFailureKeepsFile(t *testing.T) {
	project := newProject(t)
	if _, err := Save(project, sample()); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(Path(project))
	original := writeFile
	writeFile = func(string, []byte) error { return errors.New("диск полон") }
	t.Cleanup(func() { writeFile = original })
	if _, err := Save(project, Empty()); err == nil {
		t.Fatal("ожидалась ошибка записи")
	}
	after, _ := os.ReadFile(Path(project))
	if string(before) != string(after) {
		t.Fatal("сбой записи изменил файл")
	}
}

func TestValidate(t *testing.T) {
	catalog := Catalog{Locations: []Location{{ID: "crossing"}, {ID: "street"}}, Entities: map[string]bool{"crossing": true, "street": true, "hero": true}}
	if problems := Validate(sample(), catalog); len(problems) != 0 {
		t.Fatalf("образец с проблемами: %v", problems)
	}
	cases := []struct {
		name   string
		change func(*Document)
		want   string
	}{
		{"версия", func(d *Document) { d.SchemaVersion = 2 }, textSchemaVersion},
		{"код схемы", func(d *Document) { d.Schemes[1].ID = "" }, textSchemeIDMissing},
		{"повтор кода схемы", func(d *Document) { d.Schemes[1].ID = "s1" }, textSchemeIDRepeated("s1")},
		{"название", func(d *Document) { d.Schemes[0].Title = "" }, textTitleMissing("s1")},
		{"локация", func(d *Document) { d.Schemes[0].Location = "hero" }, textUnknownLocation("s1", "hero")},
		{"вид", func(d *Document) { d.Schemes[1].View = "up" }, textUnknownView("s2", "up")},
		{"повтор вида", func(d *Document) { d.Schemes[1].View = ViewTop }, textViewRepeated("crossing", ViewTop)},
		{"код объекта", func(d *Document) { d.Schemes[0].Objects[0].ID = "" }, textObjectIDMissing("s1")},
		{"повтор кода объекта", func(d *Document) { d.Schemes[0].Objects[1].ID = "o1" }, textObjectIDRepeated("s1", "o1")},
		{"сущность", func(d *Document) { d.Schemes[0].Objects[1].Entity = "ghost" }, textUnknownEntity("s1", "o2", "ghost")},
		{"высота", func(d *Document) { d.Schemes[0].Objects[1].Height = number(-1) }, "высота должна быть неотрицательным числом"},
		{"центр", func(d *Document) { d.Schemes[0].Objects[0].Shape.Center = nil }, "нужен центр"},
		{"размер", func(d *Document) { d.Schemes[0].Objects[0].Shape.Size = point(0, 5) }, "размеры должны быть положительными числами"},
		{"радиусы", func(d *Document) { d.Schemes[0].Objects[2].Shape.Radii = nil }, "радиусы должны быть положительными числами"},
		{"многоугольник", func(d *Document) { d.Schemes[0].Objects[3].Shape.Points = d.Schemes[0].Objects[3].Shape.Points[:2] }, "нужно не меньше 3 точек"},
		{"замкнутая линия", func(d *Document) { d.Schemes[0].Objects[4].Shape.Points = d.Schemes[0].Objects[4].Shape.Points[:2] }, "нужно не меньше 3 точек"},
		{"ширина", func(d *Document) { d.Schemes[0].Objects[4].Shape.Width = number(0) }, "ширина должна быть положительным числом"},
		{"точка", func(d *Document) { d.Schemes[0].Objects[5].Shape.At = nil }, "нужны координаты точки"},
		{"фигура", func(d *Document) { d.Schemes[0].Objects[5].Shape.Type = "star" }, "неизвестная фигура «star»"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			document := sample()
			item.change(&document)
			problems := Validate(document, catalog)
			if !slices.ContainsFunc(problems, func(problem string) bool { return strings.Contains(problem, item.want) }) {
				t.Fatalf("нет проблемы %q среди %v", item.want, problems)
			}
		})
	}
}

func TestViewProject(t *testing.T) {
	project := newProject(t)
	view, err := ViewProject(project)
	if err != nil || !view.Missing || len(view.Locations) != 2 || !slices.Equal(view.WithoutTop, []string{"crossing", "street"}) {
		t.Fatalf("вид без файла: %+v %v", view, err)
	}
	if _, err := Save(project, sample()); err != nil {
		t.Fatal(err)
	}
	view, err = ViewProject(project)
	if err != nil || view.Missing || len(view.Problems) != 0 || !slices.Equal(view.WithoutTop, []string{"street"}) {
		t.Fatalf("вид после записи: %+v %v", view, err)
	}
}
