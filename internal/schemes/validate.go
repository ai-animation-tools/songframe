package schemes

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
)

// Тексты проблем схем: их показывает страница «Схемы» и ошибка сохранения.
const (
	textFileDamaged     = "plan/schemes.json повреждён."
	textSchemaVersion   = "schemes.json: нужна schema_version 1."
	textSchemeIDMissing = "Схема без кода."
)

func textSchemeIDRepeated(id string) string {
	return "Код схемы " + id + " повторяется."
}
func textTitleMissing(id string) string { return "Схема " + id + ": нужно название." }
func textUnknownLocation(id, location string) string {
	return "Схема " + id + ": локации " + location + " нет в кастинге."
}
func textUnknownView(id, view string) string {
	return "Схема " + id + ": неизвестный вид «" + view + "»."
}
func textViewRepeated(location, view string) string {
	return "У локации " + location + " два вида «" + view + "»: у каждой стороны одна схема."
}
func textObjectIDMissing(scheme string) string {
	return "Схема " + scheme + ": объект без кода."
}
func textObjectIDRepeated(scheme, id string) string {
	return "Схема " + scheme + ": код объекта " + id + " повторяется."
}
func textObjectNameMissing(scheme, id string) string {
	return "Схема " + scheme + ": у объекта " + id + " нет названия."
}
func textObjectShape(scheme, id, problem string) string {
	return "Схема " + scheme + ", объект " + id + ": " + problem + "."
}
func textUnknownEntity(scheme, id, entity string) string {
	return "Схема " + scheme + ", объект " + id + ": сущности " + entity + " нет в кастинге."
}

// Location — локация кастинга, к которой можно привязать схемы.
type Location struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// castEntities — сущности кастинга: ID и название локаций по порядку и множество всех ID для связи
// объектов. Без кастинга или при повреждённом файле — пусто: проверка назовёт неизвестные локации.
func castEntities(project string) ([]Location, map[string]bool) {
	locations := []Location{}
	known := map[string]bool{}
	read := cast.Read(project)
	entities, _ := dynvalue.AsArray(dynvalue.Get(read.Value, "entities"))
	for _, entity := range entities {
		id, _ := dynvalue.Get(entity, "id").(string)
		if id == "" {
			continue
		}
		known[id] = true
		if dynvalue.Get(entity, "kind") == "location" {
			name, _ := dynvalue.Get(entity, "name").(string)
			locations = append(locations, Location{ID: id, Name: name})
		}
	}
	return locations, known
}

// LoadCatalog — локации и сущности кастинга проекта для проверки и выбора на странице.
func LoadCatalog(project string) Catalog {
	locations, entities := castEntities(project)
	return Catalog{Locations: locations, Entities: entities}
}

// Catalog — что из кастинга нужно проверке: локации для схем и все сущности для связи объектов.
type Catalog struct {
	Locations []Location
	Entities  map[string]bool
}

// hasLocation — локация id есть в кастинге.
func (c Catalog) hasLocation(id string) bool {
	return slices.ContainsFunc(c.Locations, func(location Location) bool { return location.ID == id })
}

// Validate — проблемы документа: версия, коды и названия схем и объектов, локации и сущности
// кастинга, по одной схеме на вид у локации, полнота и конечность геометрии. Пустой список —
// документ пригоден для записи.
func Validate(document Document, catalog Catalog) []string {
	problems := []string{}
	if document.SchemaVersion != 1 {
		problems = append(problems, textSchemaVersion)
	}
	seen := map[string]bool{}
	views := map[string]bool{}
	for _, scheme := range document.Schemes {
		id := strings.TrimSpace(scheme.ID)
		if id == "" {
			problems = append(problems, textSchemeIDMissing)
		} else if seen[id] {
			problems = append(problems, textSchemeIDRepeated(id))
		}
		seen[id] = true
		if strings.TrimSpace(scheme.Title) == "" {
			problems = append(problems, textTitleMissing(id))
		}
		if !catalog.hasLocation(scheme.Location) {
			problems = append(problems, textUnknownLocation(id, scheme.Location))
		}
		if !slices.Contains(Views, scheme.View) {
			problems = append(problems, textUnknownView(id, scheme.View))
		} else if key := scheme.Location + "\x00" + scheme.View; views[key] {
			problems = append(problems, textViewRepeated(scheme.Location, scheme.View))
		} else {
			views[key] = true
		}
		problems = append(problems, validateObjects(scheme, catalog)...)
	}
	return problems
}

// validateObjects — проблемы объектов одной схемы.
func validateObjects(scheme Scheme, catalog Catalog) []string {
	problems := []string{}
	seen := map[string]bool{}
	for _, object := range scheme.Objects {
		id := strings.TrimSpace(object.ID)
		if id == "" {
			problems = append(problems, textObjectIDMissing(scheme.ID))
			continue
		}
		if seen[id] {
			problems = append(problems, textObjectIDRepeated(scheme.ID, id))
		}
		seen[id] = true
		if strings.TrimSpace(object.Name) == "" {
			problems = append(problems, textObjectNameMissing(scheme.ID, id))
		}
		if object.Entity != "" && !catalog.Entities[object.Entity] {
			problems = append(problems, textUnknownEntity(scheme.ID, id, object.Entity))
		}
		if object.Height != nil && (!finite(*object.Height) || *object.Height < 0) {
			problems = append(problems, textObjectShape(scheme.ID, id, "высота должна быть неотрицательным числом"))
		}
		if problem := shapeProblem(object.Shape); problem != "" {
			problems = append(problems, textObjectShape(scheme.ID, id, problem))
		}
		if problem := volumeProblem(scheme.View, object); problem != "" {
			problems = append(problems, textObjectShape(scheme.ID, id, problem))
		}
	}
	return problems
}

// volumeProblem — что не так с объёмом объекта; пустая строка — объёма нет или он верный. Объём
// задаётся только на виде сверху: виды сбоку — плоские силуэты. Верх бывает у площадных фигур
// (гребень и скат — у прямоугольника, шатёр — у прямоугольника, эллипса и многоугольника), эллипсоид —
// у прямоугольника и эллипса с высотой и без верха.
func volumeProblem(view string, object Object) string {
	if object.Elevation == nil && object.Top == nil && object.Body == "" {
		return ""
	}
	if view != ViewTop {
		return "подъём над землёй, верх и тело задаются только на виде сверху"
	}
	if object.Elevation != nil && (!finite(*object.Elevation) || *object.Elevation < 0) {
		return "подъём над землёй должен быть неотрицательным числом"
	}
	kind := object.Shape.Type
	if object.Body != "" {
		switch {
		case object.Body != BodyEllipsoid:
			return "неизвестное тело «" + object.Body + "»"
		case kind != ShapeRect && kind != ShapeEllipse:
			return "эллипсоид бывает только у прямоугольника и эллипса"
		case object.Height == nil || *object.Height <= 0:
			return "эллипсоиду нужна высота"
		case object.Top != nil:
			return "у эллипсоида нет верха"
		}
	}
	top := object.Top
	if top == nil {
		return ""
	}
	if !finite(top.Rise) || top.Rise <= 0 {
		return "подъём верха должен быть положительным числом"
	}
	switch top.Form {
	case TopRidge:
		if kind != ShapeRect {
			return "гребень бывает только у прямоугольника"
		}
		if top.Axis != "x" && top.Axis != "y" || top.Down != "" {
			return "у гребня нужна ось x или y"
		}
	case TopSlope:
		if kind != ShapeRect {
			return "скат бывает только у прямоугольника"
		}
		if !slices.Contains([]string{"+x", "-x", "+y", "-y"}, top.Down) || top.Axis != "" {
			return "у ската нужна сторона, куда он опускается: +x, -x, +y или -y"
		}
	case TopTent:
		if kind != ShapeRect && kind != ShapeEllipse && kind != ShapePolygon {
			return "шатёр бывает только у прямоугольника, эллипса и многоугольника"
		}
		if top.Axis != "" || top.Down != "" {
			return "у шатра нет оси и стороны ската"
		}
	default:
		return "неизвестная форма верха «" + top.Form + "»"
	}
	return ""
}

// finite — число конечно (JSON не передаёт NaN и бесконечности, но значения приходят и из кода).
func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

// finitePoint — обе координаты конечны.
func finitePoint(point Point) bool { return finite(point[0]) && finite(point[1]) }

// shapeProblem — что не так с геометрией фигуры; пустая строка — фигура полная.
func shapeProblem(shape Shape) string {
	points := func(min int) string {
		if len(shape.Points) < min {
			return fmt.Sprintf("нужно не меньше %d точек", min)
		}
		for _, point := range shape.Points {
			if !finitePoint(point) {
				return "координаты должны быть числами"
			}
		}
		return ""
	}
	positive := func(point *Point, what string) string {
		if point == nil || !finitePoint(*point) || point[0] <= 0 || point[1] <= 0 {
			return what + " должны быть положительными числами"
		}
		return ""
	}
	center := func() string {
		if shape.Center == nil || !finitePoint(*shape.Center) {
			return "нужен центр"
		}
		if shape.Rotation != nil && !finite(*shape.Rotation) {
			return "поворот должен быть числом"
		}
		return ""
	}
	switch shape.Type {
	case ShapeRect:
		if problem := center(); problem != "" {
			return problem
		}
		return positive(shape.Size, "размеры")
	case ShapeEllipse:
		if problem := center(); problem != "" {
			return problem
		}
		return positive(shape.Radii, "радиусы")
	case ShapePolygon:
		return points(3)
	case ShapeLine:
		if shape.Width != nil && (!finite(*shape.Width) || *shape.Width <= 0) {
			return "ширина должна быть положительным числом"
		}
		if shape.Closed {
			return points(3)
		}
		return points(2)
	case ShapePoint:
		if shape.At == nil || !finitePoint(*shape.At) {
			return "нужны координаты точки"
		}
		return ""
	}
	return "неизвестная фигура «" + shape.Type + "»"
}
