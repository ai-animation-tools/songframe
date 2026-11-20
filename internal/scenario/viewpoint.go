package scenario

import (
	"math"
	"slices"
	"strings"

	"songframe/internal/dynvalue"
)

// Точка съёмки плана — необязательное поле scene.viewpoint: откуда снимает камера и где стоят герои
// относительно схем локации (plan/schemes.json).
//
//   - location — локация кастинга; size — крупность; fov — свой угол обзора по горизонтали в градусах
//     (без него угол следует за крупностью).
//   - side — где стоит камера: «с юга» значит камера на юге смотрит на север, как одноимённый вид схемы.
//     Без точек камеры и героя в фокусе сторона задаёт направление взгляда; с ними направление
//     считается от камеры к герою, а side редактор держит равной стороне, вычисленной из точек.
//   - camera — место камеры на виде сверху в метрах: start на первом кадре, end — на последнем, если
//     камера движется.
//   - subjects — герои плана на схеме: entity из references плана, start и необязательный end. Первый —
//     в фокусе: на него смотрит камера.
//
// Хранится только то, что ввёл человек; расстояния, стороны кадра и заслонение считаются из точек.

// ViewpointSides — стороны точки съёмки в порядке интерфейса; top — камера сверху.
var ViewpointSides = []string{"north", "east", "south", "west", "top"}

// ViewpointSizes — крупности точки съёмки: общий, средний, крупный план и деталь.
var ViewpointSizes = []string{"wide", "medium", "close", "detail"}

// viewpointKeys, pathKeys, subjectKeys — допустимые ключи; остальные запрещены, чтобы опечатка не терялась молча.
var (
	viewpointKeys = []string{"location", "side", "size", "fov", "camera", "subjects"}
	pathKeys      = []string{"start", "end"}
	subjectKeys   = []string{"entity", "start", "end"}
)

func textViewpointShape(shot string) string {
	return shot + ": точка съёмки — объект с локацией, стороной и крупностью (location, side, size), необязательными fov, camera и subjects."
}
func textViewpointLocation(shot, location string) string {
	return shot + ": точка съёмки ссылается на «" + location + "», а это не локация кастинга."
}
func textViewpointSide(shot, side string) string {
	return shot + ": сторона точки съёмки — " + strings.Join(ViewpointSides, ", ") + ", а не «" + side + "»."
}
func textViewpointSize(shot, size string) string {
	return shot + ": крупность точки съёмки — " + strings.Join(ViewpointSizes, ", ") + ", а не «" + size + "»."
}
func textViewpointFov(shot string) string {
	return shot + ": угол обзора fov — число градусов больше 0 и меньше 180."
}
func textViewpointCamera(shot string) string {
	return shot + ": место камеры camera — объект со start и необязательным end, каждый — два числа в метрах [x, y]."
}
func textViewpointSubjects(shot string) string {
	return shot + ": герои точки съёмки subjects — список объектов с entity, start и необязательным end; точки — два числа в метрах [x, y]."
}
func textViewpointSubjectUnknown(shot, entity string) string {
	return shot + ": герой точки съёмки «" + entity + "» не указан среди референсов плана."
}
func textViewpointSubjectRepeated(shot, entity string) string {
	return shot + ": герой «" + entity + "» стоит на схеме точки съёмки дважды."
}

// castLocations — ID сущностей кастинга с kind «location»; без кастинга — пусто.
func castLocations(castValue any) []string {
	entities, _ := dynvalue.AsArray(dynvalue.Get(castValue, "entities"))
	locations := []string{}
	for _, entity := range entities {
		id, ok := dynvalue.Get(entity, "id").(string)
		if ok && dynvalue.StrictEqual(dynvalue.Get(entity, "kind"), "location") {
			locations = append(locations, id)
		}
	}
	return locations
}

// finite — конечное число JSON.
func finite(value any) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

// isPoint — два конечных числа [x, y].
func isPoint(value any) bool {
	point, ok := dynvalue.AsArray(value)
	return ok && len(point) == 2 && finite(point[0]) && finite(point[1])
}

// isPath — объект {start, end?} с точками; keys — все допустимые ключи объекта.
func isPath(value any, keys []string) (*dynvalue.Object, bool) {
	record, ok := dynvalue.AsObject(value)
	if !ok || slices.ContainsFunc(record.Keys(), func(key string) bool { return !slices.Contains(keys, key) }) || !isPoint(record.Value("start")) {
		return nil, false
	}
	if end := record.Value("end"); end != dynvalue.Undefined && !isPoint(end) {
		return nil, false
	}
	return record, true
}

// viewpointProblems — нарушения точки съёмки плана shot. Отсутствующее поле — план без точки, проблем нет.
// references — референсы плана: герои на схеме берутся только из них. Наличие вида сверху у локации здесь
// не проверяется: удалённая позже схема не делает сценарий неверным — факты кадра сообщают, что схемы нет.
func viewpointProblems(shot string, value any, locations []string, references []string) []string {
	if value == dynvalue.Undefined {
		return nil
	}
	record, ok := dynvalue.AsObject(value)
	if !ok || slices.ContainsFunc(record.Keys(), func(key string) bool { return !slices.Contains(viewpointKeys, key) }) {
		return []string{textViewpointShape(shot)}
	}
	location, locationOK := record.Value("location").(string)
	side, sideOK := record.Value("side").(string)
	size, sizeOK := record.Value("size").(string)
	if !locationOK || !sideOK || !sizeOK {
		return []string{textViewpointShape(shot)}
	}
	problems := []string{}
	if !slices.Contains(locations, location) {
		problems = append(problems, textViewpointLocation(shot, location))
	}
	if !slices.Contains(ViewpointSides, side) {
		problems = append(problems, textViewpointSide(shot, side))
	}
	if !slices.Contains(ViewpointSizes, size) {
		problems = append(problems, textViewpointSize(shot, size))
	}
	if fov := record.Value("fov"); fov != dynvalue.Undefined {
		if !finite(fov) || fov.(float64) <= 0 || fov.(float64) >= 180 {
			problems = append(problems, textViewpointFov(shot))
		}
	}
	if camera := record.Value("camera"); camera != dynvalue.Undefined {
		if _, ok := isPath(camera, pathKeys); !ok {
			problems = append(problems, textViewpointCamera(shot))
		}
	}
	if subjects := record.Value("subjects"); subjects != dynvalue.Undefined {
		list, ok := dynvalue.AsArray(subjects)
		if !ok {
			return append(problems, textViewpointSubjects(shot))
		}
		seen := []string{}
		for _, item := range list {
			subject, ok := isPath(item, subjectKeys)
			entity, entityOK := "", false
			if ok {
				entity, entityOK = subject.Value("entity").(string)
			}
			if !entityOK {
				problems = append(problems, textViewpointSubjects(shot))
				continue
			}
			if !slices.Contains(references, entity) {
				problems = append(problems, textViewpointSubjectUnknown(shot, entity))
			}
			if slices.Contains(seen, entity) {
				problems = append(problems, textViewpointSubjectRepeated(shot, entity))
			}
			seen = append(seen, entity)
		}
	}
	return problems
}

// shotReferences — строковые референсы плана без заглушки «—».
func shotReferences(scene any) []string {
	list, _ := dynvalue.AsArray(dynvalue.Get(scene, "references"))
	references := []string{}
	for _, item := range list {
		if id, ok := item.(string); ok && id != "—" {
			references = append(references, id)
		}
	}
	return references
}
