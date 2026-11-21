// Package viewframe считает факты кадра точки съёмки плана: кто из героев и что из объектов схемы локации
// попадает в кадр, где по горизонтали, на каком расстоянии, какую часть высоты кадра занимает фигура и что её
// заслоняет. Факты получают агенты описания и видеопромпта вместо сырых координат, а человек видит их в карте
// точки съёмки до запуска. Хранится только ввод человека (scene.viewpoint, plan/schemes.json, рост в кастинге);
// всё здесь вычисляется заново и никуда не пишется.
//
// Направления и прицел повторяют карту в интерфейсе (frontend/src/shared/viewpoint.ts): общая таблица случаев
// testdata/golden/viewframe/cases.json проверяет обе стороны, поэтому карта и агент не расходятся.
package viewframe

import (
	"encoding/json"
	"math"

	"songframe/internal/schemes"
)

// Point — точка схемы в метрах: X — восток, Y — север.
type Point = schemes.Point

// Path — место на первом кадре и, если камера или герой движется, на последнем.
type Path struct {
	Start Point  `json:"start"`
	End   *Point `json:"end,omitempty"`
}

// Pair — величина на первом кадре и, если меняется за план, на последнем (направление, высота камеры).
type Pair struct {
	Start float64  `json:"start"`
	End   *float64 `json:"end,omitempty"`
}

// Subject — герой плана на схеме: сущность кастинга и её путь.
type Subject struct {
	Entity string `json:"entity"`
	Path
}

// Viewpoint — поле scene.viewpoint, как его записывает редактор; корректность проверяет internal/scenario.
type Viewpoint struct {
	Location     string    `json:"location"`
	Side         string    `json:"side"`
	Size         string    `json:"size"`
	Fov          *float64  `json:"fov,omitempty"`
	Camera       *Path     `json:"camera,omitempty"`
	Heading      *Pair     `json:"heading,omitempty"`
	CameraHeight *Pair     `json:"camera_height,omitempty"`
	Subjects     []Subject `json:"subjects,omitempty"`
}

// ParseViewpoint читает точку съёмки из значения JSON сцены (map из json.Unmarshal или сырые байты).
func ParseViewpoint(value any) (Viewpoint, error) {
	data, ok := value.([]byte)
	if !ok {
		var err error
		if data, err = json.Marshal(value); err != nil {
			return Viewpoint{}, err
		}
	}
	var viewpoint Viewpoint
	err := json.Unmarshal(data, &viewpoint)
	return viewpoint, err
}

// Фаза кадра: первый или последний.
const (
	PhaseStart = "start"
	PhaseEnd   = "end"
)

// SizeFov — угол обзора по горизонтали в градусах по крупности, если свой угол не задан.
var SizeFov = map[string]float64{"wide": 60, "medium": 40, "close": 25, "detail": 15}

const (
	// DefaultCameraHeight — высота камеры без своей, м: съёмка с рук или штатива на уровне глаз.
	DefaultCameraHeight = 1.6
	// FigureHeight — рост героя, не заданный в кастинге, м.
	FigureHeight = 1.7
	// FigureRadius — радиус условной фигуры героя, м: по нему герой заслоняет других.
	FigureRadius = 0.25
	// FrameAspect — пропорция кадра: по ней вертикальный угол обзора получается из горизонтального.
	FrameAspect = 16.0 / 9.0
	epsilon     = 1e-9
)

// FieldOfView — угол обзора по горизонтали: свой или по крупности (неизвестная крупность — как общий план).
func (v Viewpoint) FieldOfView() float64 {
	if v.Fov != nil {
		return *v.Fov
	}
	if fov, ok := SizeFov[v.Size]; ok {
		return fov
	}
	return SizeFov["wide"]
}

// pathPoint — место пути на кадре phase: конец, если задан, иначе начало; без пути — false.
func pathPoint(path *Path, phase string) (Point, bool) {
	if path == nil {
		return Point{}, false
	}
	if phase == PhaseEnd && path.End != nil {
		return *path.End, true
	}
	return path.Start, true
}

// pairValue — величина на кадре phase: конец, если задан, иначе начало.
func pairValue(pair *Pair, phase string) float64 {
	if phase == PhaseEnd && pair.End != nil {
		return *pair.End
	}
	return pair.Start
}

// EyeHeight — высота камеры на кадре phase, м.
func (v Viewpoint) EyeHeight(phase string) float64 {
	if v.CameraHeight == nil {
		return DefaultCameraHeight
	}
	return pairValue(v.CameraHeight, phase)
}

// sideHeading — направление взгляда по стороне: камера с юга смотрит на север (90°). Сверху направления нет.
func sideHeading(side string) (float64, bool) {
	heading, ok := map[string]float64{"north": 270, "east": 180, "south": 90, "west": 0}[side]
	return heading, ok
}

// headingBetween — направление от from к to в градусах [0, 360) против часовой стрелки от востока; совпавшие
// точки направления не дают.
func headingBetween(from, to Point) (float64, bool) {
	dx, dy := to[0]-from[0], to[1]-from[1]
	if math.Hypot(dx, dy) < epsilon {
		return 0, false
	}
	return normalize(math.Atan2(dy, dx) * 180 / math.Pi), true
}

// normalize приводит угол к [0, 360).
func normalize(angle float64) float64 {
	angle = math.Mod(angle, 360)
	if angle < 0 {
		angle += 360
	}
	return angle
}

// angleFrom — угол от heading до angle в (−180, 180]: положительный — против часовой стрелки, влево в кадре.
func angleFrom(heading, angle float64) float64 {
	delta := normalize(angle - heading)
	if delta > 180 {
		return delta - 360
	}
	return delta
}

// distance — расстояние между точками, м.
func distance(a, b Point) float64 {
	return math.Hypot(b[0]-a[0], b[1]-a[1])
}

// aimHeading — прицел из camera на героев points: середина их углового разброса, так все входят в кадр при
// наименьшем угле обзора. Герой в точке камеры направления не даёт; без направлений — false.
func aimHeading(camera Point, points []Point) (float64, bool) {
	var headings []float64
	for _, point := range points {
		if heading, ok := headingBetween(camera, point); ok {
			headings = append(headings, heading)
		}
	}
	if len(headings) == 0 {
		return 0, false
	}
	low, high := 0.0, 0.0
	for _, heading := range headings {
		offset := angleFrom(headings[0], heading)
		low, high = math.Min(low, offset), math.Max(high, offset)
	}
	return normalize(headings[0] + (low+high)/2), true
}

// subjectPoints — места героев на кадре phase в порядке списка.
func (v Viewpoint) subjectPoints(phase string) []Point {
	points := make([]Point, 0, len(v.Subjects))
	for index := range v.Subjects {
		point, _ := pathPoint(&v.Subjects[index].Path, phase)
		points = append(points, point)
	}
	return points
}

// LookHeading — направление взгляда на кадре phase: своё направление человека (на последнем кадре без своего
// конца — как на первом); иначе прицел на героев, если стоят камера и герой не в её точке; иначе по стороне.
// Камера сверху направления не имеет — false.
func (v Viewpoint) LookHeading(phase string) (float64, bool) {
	if v.Side == "top" {
		return 0, false
	}
	if v.Heading != nil && v.Camera != nil {
		return pairValue(v.Heading, phase), true
	}
	if camera, ok := pathPoint(v.Camera, phase); ok {
		if aim, ok := aimHeading(camera, v.subjectPoints(phase)); ok {
			return aim, true
		}
	}
	return sideHeading(v.Side)
}

// moves — есть ли у пути движение: конец задан и отличается от начала.
func moves(path *Path) bool {
	return path != nil && path.End != nil && distance(path.Start, *path.End) > epsilon
}

// Changes — меняется ли кадр за план: движется камера или герой, камера поворачивается или меняет высоту.
// Тогда факты считаются и для последнего кадра.
func (v Viewpoint) Changes() bool {
	if moves(v.Camera) || (v.Heading != nil && v.Heading.End != nil) || (v.CameraHeight != nil && v.CameraHeight.End != nil) {
		return true
	}
	for index := range v.Subjects {
		if moves(&v.Subjects[index].Path) {
			return true
		}
	}
	return false
}

// InFrame — входит ли место point в кадр на кадре phase по горизонтали: угол от направления взгляда не больше
// половины угла обзора. Без камеры или у камеры сверху судить не по чему — второе значение false.
func (v Viewpoint) InFrame(phase string, point Point) (inFrame, known bool) {
	camera, ok := pathPoint(v.Camera, phase)
	heading, hasHeading := v.LookHeading(phase)
	if !ok || !hasHeading {
		return false, false
	}
	angle, ok := headingBetween(camera, point)
	return !ok || math.Abs(angleFrom(heading, angle)) <= v.FieldOfView()/2+epsilon, true
}
