package viewframe

import (
	"songframe/internal/dynvalue"
	"songframe/internal/schemes"
)

// Машина на точке съёмки — герой кастинга с kind «vehicle». Её фигура — не цилиндр человека, а коробка по типовым
// габаритам легкового автомобиля: длинная сторона вдоль направления, куда машина смотрит передом. Так же её рисует
// вид из камеры (frontend/src/shared/viewpoint-camera.ts), поэтому снимок болванки и факты кадра агента совпадают.
// Высота из кастинга заменяет типовую; длина и ширина пока одни для всех машин.
const (
	// VehicleKind — вид сущности кастинга, которую фигура рисует машиной.
	VehicleKind = "vehicle"
	// VehicleLength и VehicleWidth — габариты машины в плане, м.
	VehicleLength = 4.6
	VehicleWidth  = 1.8
	// VehicleHeight — высота машины, не заданная в кастинге, м.
	VehicleHeight = 1.5
)

// Cast — сведения кастинга для фигур героев: рост или высота (м) и какие сущности — машины.
type Cast struct {
	Heights  map[string]float64
	Vehicles map[string]bool
}

// ReadCast читает фигуры героев из значения plan/cast.json: рост из CastHeights и машины по kind.
func ReadCast(castValue any) Cast {
	cast := Cast{Heights: CastHeights(castValue), Vehicles: map[string]bool{}}
	entities, _ := dynvalue.AsArray(dynvalue.Get(castValue, "entities"))
	for _, entity := range entities {
		if id, ok := dynvalue.Get(entity, "id").(string); ok && dynvalue.StrictEqual(dynvalue.Get(entity, "kind"), VehicleKind) {
			cast.Vehicles[id] = true
		}
	}
	return cast
}

// height — рост героя или высота машины: из кастинга, иначе типовая.
func (c Cast) height(entity string) float64 {
	if height, ok := c.Heights[entity]; ok && height > 0 {
		return height
	}
	if c.Vehicles[entity] {
		return VehicleHeight
	}
	return FigureHeight
}

// Facing — куда герой index смотрит передом на кадре phase, градусы против часовой стрелки от востока: своё
// направление facing; у движущегося — по ходу от start к end; иначе — к камере. Без камеры и хода — на восток.
func (v Viewpoint) Facing(index int, phase string) float64 {
	subject := v.Subjects[index]
	if subject.Facing != nil {
		return normalize(*subject.Facing)
	}
	if moves(&subject.Path) {
		heading, _ := headingBetween(subject.Start, *subject.End)
		return heading
	}
	at, _ := pathPoint(&subject.Path, phase)
	if camera, ok := pathPoint(v.Camera, phase); ok {
		if heading, ok := headingBetween(at, camera); ok {
			return heading
		}
	}
	return 0
}

// vehicleFootprint — след машины на земле: прямоугольник длиной вдоль facing с серединой в at.
func vehicleFootprint(at Point, facing float64) part {
	return part{rectCorners(schemes.Shape{Type: schemes.ShapeRect, Center: &at, Size: &Point{VehicleLength, VehicleWidth}, Rotation: &facing}), true}
}
