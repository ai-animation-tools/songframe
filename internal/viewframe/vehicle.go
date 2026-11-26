package viewframe

import (
	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/schemes"
)

// Машина на точке съёмки — герой кастинга с kind «vehicle». Её фигура — не цилиндр человека, а коробка по типовым
// габаритам легкового автомобиля: длинная сторона вдоль направления, куда машина смотрит передом. Так же её рисует
// вид из камеры (frontend/src/shared/viewpoint-camera.ts), поэтому снимок болванки и факты кадра агента совпадают.
// Высота, длина и ширина из кастинга заменяют типовые: грузовик или автобус занимает на схеме свою длину.
const (
	// VehicleKind — вид сущности кастинга, которую фигура рисует машиной.
	VehicleKind = cast.VehicleKind
	// VehicleLength и VehicleWidth — габариты машины в плане, не заданные в кастинге, м.
	VehicleLength = 4.6
	VehicleWidth  = 1.8
	// VehicleHeight — высота машины, не заданная в кастинге, м.
	VehicleHeight = 1.5
)

// Cast — сведения кастинга для фигур героев: рост или высота (м), какие сущности — машины и габариты машин в
// плане (длина, ширина), если их задали в кастинге.
type Cast struct {
	Heights  map[string]float64
	Vehicles map[string]bool
	// Sizes — длина и ширина машины, м; машины без заданных размеров в карте нет, незаданная сторона — типовая.
	Sizes map[string]Point
}

// ReadCast читает фигуры героев из значения plan/cast.json: рост из CastHeights, машины по kind и их длину и ширину.
func ReadCast(castValue any) Cast {
	figures := Cast{Heights: CastHeights(castValue), Vehicles: map[string]bool{}, Sizes: map[string]Point{}}
	entities, _ := dynvalue.AsArray(dynvalue.Get(castValue, "entities"))
	for _, entity := range entities {
		id, ok := dynvalue.Get(entity, "id").(string)
		if !ok || !dynvalue.StrictEqual(dynvalue.Get(entity, "kind"), VehicleKind) {
			continue
		}
		figures.Vehicles[id] = true
		length, hasLength := positive(dynvalue.Get(entity, "length"))
		width, hasWidth := positive(dynvalue.Get(entity, "width"))
		if hasLength || hasWidth {
			size := Point{VehicleLength, VehicleWidth}
			if hasLength {
				size[0] = length
			}
			if hasWidth {
				size[1] = width
			}
			figures.Sizes[id] = size
		}
	}
	return figures
}

// positive — значение поля кастинга как положительное число метров; иначе поле не задано.
func positive(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && number > 0
}

// VehicleSize — длина и ширина машины entity: из кастинга, иначе типовые легкового автомобиля.
func (c Cast) VehicleSize(entity string) Point {
	if size, ok := c.Sizes[entity]; ok {
		return size
	}
	return Point{VehicleLength, VehicleWidth}
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

// vehicleFootprint — след машины размером size (длина, ширина) на земле: прямоугольник длиной вдоль facing с
// серединой в at.
func vehicleFootprint(at Point, facing float64, size Point) part {
	return part{rectCorners(schemes.Shape{Type: schemes.ShapeRect, Center: &at, Size: &size, Rotation: &facing}), true}
}
