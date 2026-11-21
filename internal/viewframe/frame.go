package viewframe

import (
	"math"
	"slices"

	"songframe/internal/schemes"
)

// Frame — факты кадра точки съёмки. Camera повторяет ввод человека, Start и End — первый и последний кадр;
// End есть, только если кадр меняется за план. Без схемы, без камеры на схеме и у камеры сверху фактов нет,
// Note объясняет почему.
type Frame struct {
	Camera CameraFacts `json:"camera"`
	Note   string      `json:"note,omitempty"`
	Start  *PhaseFacts `json:"start"`
	End    *PhaseFacts `json:"end"`
}

// CameraFacts — сторона, крупность и угол обзора по горизонтали в градусах.
type CameraFacts struct {
	Side string  `json:"side"`
	Size string  `json:"size"`
	Fov  float64 `json:"fov"`
}

// PhaseFacts — факты одного кадра: куда смотрит камера, на какой высоте, герои и объекты схемы.
type PhaseFacts struct {
	Looks        string         `json:"looks"`
	CameraHeight float64        `json:"camera_height"`
	Subjects     []SubjectFacts `json:"subjects"`
	Objects      []ObjectFacts  `json:"objects"`
}

// SubjectFacts — герой на кадре. X — место по горизонтали от −1 (левый край) до +1 (правый), только в кадре.
// FrameHeight — доля высоты кадра, которую занимает фигура; Whole — видна ли она целиком, от ног до макушки.
// Height — рост из кастинга, если задан; без него фигура считается условной (FigureHeight). HiddenBy — герои и
// объекты, которые закрывают от камеры середину фигуры.
type SubjectFacts struct {
	Entity      string   `json:"entity"`
	Lead        bool     `json:"lead,omitempty"`
	InFrame     bool     `json:"in_frame"`
	X           *float64 `json:"x,omitempty"`
	Place       string   `json:"place"`
	Distance    float64  `json:"distance"`
	Height      *float64 `json:"height,omitempty"`
	FrameHeight *float64 `json:"frame_height,omitempty"`
	Whole       *bool    `json:"whole,omitempty"`
	HiddenBy    []string `json:"hidden_by"`
}

// ObjectFacts — объект схемы на кадре. X — видимая часть по горизонтали [левый край, правый край] от −1 до +1,
// только в кадре. Distance — до ближайшего края, м. Height — верх над землёй, у плоской поверхности нет.
type ObjectFacts struct {
	Name     string      `json:"name"`
	Entity   string      `json:"entity,omitempty"`
	InFrame  bool        `json:"in_frame"`
	X        *[2]float64 `json:"x,omitempty"`
	Place    string      `json:"place"`
	Distance float64     `json:"distance"`
	Height   *float64    `json:"height,omitempty"`
}

// Compute считает факты кадра точки съёмки viewpoint по схеме локации scheme (nil — схемы нет) и росту героев
// heights из кастинга. Ничего не читает и не пишет.
func Compute(viewpoint Viewpoint, scheme *schemes.Scheme, heights map[string]float64) Frame {
	frame := Frame{Camera: CameraFacts{Side: viewpoint.Side, Size: viewpoint.Size, Fov: round(viewpoint.FieldOfView(), 1)}}
	switch {
	case viewpoint.Side == "top":
		frame.Note = noteTop
	case scheme == nil:
		frame.Note = noteNoScheme
	case viewpoint.Camera == nil:
		frame.Note = noteNoCamera
	default:
		frame.Start = computePhase(viewpoint, scheme, heights, PhaseStart)
		if viewpoint.Changes() {
			frame.End = computePhase(viewpoint, scheme, heights, PhaseEnd)
		}
	}
	return frame
}

// view — камера одного кадра: место, высота глаз, направление и наклон взгляда, углы обзора.
type view struct {
	eye     Point
	height  float64
	heading float64
	pitch   float64
	fov     float64
	vfov    float64
}

// figureHeight — рост героя из кастинга или условный.
func figureHeight(heights map[string]float64, entity string) float64 {
	if height, ok := heights[entity]; ok && height > 0 {
		return height
	}
	return FigureHeight
}

func computePhase(viewpoint Viewpoint, scheme *schemes.Scheme, heights map[string]float64, phase string) *PhaseFacts {
	eye, _ := pathPoint(viewpoint.Camera, phase)
	heading, _ := viewpoint.LookHeading(phase)
	fov := viewpoint.FieldOfView()
	camera := view{
		eye:     eye,
		height:  viewpoint.EyeHeight(phase),
		heading: heading,
		fov:     fov,
		vfov:    2 * math.Atan(math.Tan(fov/2*math.Pi/180)/FrameAspect) * 180 / math.Pi,
	}
	// Наклон взгляда — на середину роста главного героя на его расстоянии, как у вида из камеры; без героя или с
	// героем в точке камеры камера смотрит горизонтально.
	if len(viewpoint.Subjects) > 0 {
		lead, _ := pathPoint(&viewpoint.Subjects[0].Path, phase)
		if reach := distance(eye, lead); reach > epsilon {
			camera.pitch = math.Atan2(figureHeight(heights, viewpoint.Subjects[0].Entity)/2-camera.height, reach) * 180 / math.Pi
		}
	}
	facts := &PhaseFacts{Looks: compass(heading), CameraHeight: round(camera.height, 2), Subjects: []SubjectFacts{}, Objects: []ObjectFacts{}}
	points := viewpoint.subjectPoints(phase)
	for index, subject := range viewpoint.Subjects {
		facts.Subjects = append(facts.Subjects, subjectFacts(camera, viewpoint, scheme, heights, points, index, subject.Entity))
	}
	for _, object := range scheme.Objects {
		facts.Objects = append(facts.Objects, objectFacts(camera, object))
	}
	return facts
}

// screenX — место по горизонтали направления под углом angle от взгляда (положительный — влево): −1 у левого края
// кадра, +1 у правого. Перспектива плоская, как у объектива: равные метры у края кадра шире равных градусов.
func (camera view) screenX(angle float64) float64 {
	return -math.Tan(angle*math.Pi/180) / math.Tan(camera.fov/2*math.Pi/180)
}

// screenY — высота точки (x, y, z) в кадре с учётом наклона камеры: −1 у нижнего края, +1 у верхнего. Точка за
// плоскостью объектива — false.
func (camera view) screenY(at Point, z float64) (float64, bool) {
	theta, phi := camera.heading*math.Pi/180, camera.pitch*math.Pi/180
	dx, dy, dz := at[0]-camera.eye[0], at[1]-camera.eye[1], z-camera.height
	depth := dx*math.Cos(theta)*math.Cos(phi) + dy*math.Sin(theta)*math.Cos(phi) + dz*math.Sin(phi)
	if depth <= epsilon {
		return 0, false
	}
	up := -dx*math.Cos(theta)*math.Sin(phi) - dy*math.Sin(theta)*math.Sin(phi) + dz*math.Cos(phi)
	return up / depth / math.Tan(camera.vfov/2*math.Pi/180), true
}

func subjectFacts(camera view, viewpoint Viewpoint, scheme *schemes.Scheme, heights map[string]float64, points []Point, index int, entity string) SubjectFacts {
	at := points[index]
	facts := SubjectFacts{Entity: entity, Lead: index == 0, Distance: round(distance(camera.eye, at), 1), HiddenBy: []string{}}
	if height, ok := heights[entity]; ok && height > 0 {
		facts.Height = ptr(round(height, 2))
	}
	angle, ok := headingBetween(camera.eye, at)
	if !ok {
		facts.InFrame, facts.Place = true, placeAtCamera
		return facts
	}
	relative := angleFrom(camera.heading, angle)
	facts.InFrame = math.Abs(relative) <= camera.fov/2+epsilon
	if !facts.InFrame {
		facts.Place = outsidePlace(relative)
		return facts
	}
	x := camera.screenX(relative)
	facts.X, facts.Place = ptr(round(x, 2)), thirdName(x)
	height := figureHeight(heights, entity)
	bottom, okBottom := camera.screenY(at, 0)
	top, okTop := camera.screenY(at, height)
	if okBottom && okTop {
		visible := (clamp(top) - clamp(bottom)) / 2
		facts.FrameHeight = ptr(round(math.Max(visible, 0), 2))
		facts.Whole = ptr(bottom >= -1-epsilon && top <= 1+epsilon)
	}
	facts.HiddenBy = hiddenBy(camera, viewpoint, scheme, heights, points, index, height)
	return facts
}

// hiddenBy — кто и что закрывает от камеры середину фигуры героя index: линия взгляда от глаз камеры к середине его
// роста проходит сквозь другого героя или объём объекта схемы ниже его верха и выше низа. Объект, связанный с
// самим героем, его не заслоняет; плоские поверхности не заслоняют ничего.
func hiddenBy(camera view, viewpoint Viewpoint, scheme *schemes.Scheme, heights map[string]float64, points []Point, index int, height float64) []string {
	target := points[index]
	length := distance(camera.eye, target)
	result := []string{}
	if length < epsilon {
		return result
	}
	// Перекрытие ищется до фигуры самого героя: то, что стоит вплотную за ним, его не закрывает.
	limit := math.Max(0, 1-FigureRadius/length)
	sight := func(t float64) float64 { return camera.height + (height/2-camera.height)*t }
	blocks := func(spans [][2]float64, low, high float64) bool {
		for _, span := range spans {
			from, to := math.Max(span[0], 0), math.Min(span[1], limit)
			if from > to {
				continue
			}
			a, b := sight(from), sight(to)
			if math.Max(a, b) >= low-epsilon && math.Min(a, b) <= high+epsilon {
				return true
			}
		}
		return false
	}
	for other, subject := range viewpoint.Subjects {
		if other == index {
			continue
		}
		if span, ok := circleSpan(camera.eye, target, points[other], FigureRadius); ok && blocks([][2]float64{span}, 0, figureHeight(heights, subject.Entity)) {
			result = append(result, subject.Entity)
		}
	}
	entity := viewpoint.Subjects[index].Entity
	for _, object := range scheme.Objects {
		low, high := verticalRange(object)
		if high-low < epsilon || object.Entity == entity {
			continue
		}
		var spans [][2]float64
		for _, piece := range footprint(object.Shape) {
			spans = append(spans, pieceSpans(camera.eye, target, piece)...)
		}
		if blocks(spans, low, high) && !slices.Contains(result, object.Name) {
			result = append(result, object.Name)
		}
	}
	return result
}

// circleSpan — участок [t0, t1] отрезка from→to (t от 0 до 1), лежащий внутри круга center радиусом radius.
func circleSpan(from, to, center Point, radius float64) ([2]float64, bool) {
	dx, dy := to[0]-from[0], to[1]-from[1]
	fx, fy := from[0]-center[0], from[1]-center[1]
	a := dx*dx + dy*dy
	b := 2 * (fx*dx + fy*dy)
	c := fx*fx + fy*fy - radius*radius
	discriminant := b*b - 4*a*c
	if a < epsilon || discriminant < 0 {
		return [2]float64{}, false
	}
	root := math.Sqrt(discriminant)
	t0, t1 := (-b-root)/(2*a), (-b+root)/(2*a)
	if t1 < 0 || t0 > 1 {
		return [2]float64{}, false
	}
	return [2]float64{math.Max(t0, 0), math.Min(t1, 1)}, true
}

// pieceSpans — участки отрезка from→to внутри замкнутого куска или точки пересечения со стеной-ломаной.
func pieceSpans(from, to Point, piece part) [][2]float64 {
	crossings := rayCrossings(from, to, piece)
	if !piece.closed || len(piece.points) < 3 {
		spans := make([][2]float64, 0, len(crossings))
		for _, t := range crossings {
			spans = append(spans, [2]float64{t, t})
		}
		return spans
	}
	slices.Sort(crossings)
	if insideOutline(from, piece.points) {
		crossings = append([]float64{0}, crossings...)
	}
	if len(crossings)%2 == 1 {
		crossings = append(crossings, 1)
	}
	spans := make([][2]float64, 0, len(crossings)/2)
	for index := 0; index+1 < len(crossings); index += 2 {
		spans = append(spans, [2]float64{crossings[index], crossings[index+1]})
	}
	return spans
}

func objectFacts(camera view, object schemes.Object) ObjectFacts {
	parts := footprint(object.Shape)
	facts := ObjectFacts{Name: object.Name, Entity: object.Entity, Distance: round(nearest(camera.eye, parts), 1)}
	if _, high := verticalRange(object); high > epsilon {
		facts.Height = ptr(round(high, 2))
	}
	// Угловой разброс контура от камеры — смещениями от угла на первую точку: так он не рвётся на переходе через 0°.
	around := false
	var reference *float64
	low, high := 0.0, 0.0
	for _, piece := range parts {
		if piece.closed && len(piece.points) > 2 && insideOutline(camera.eye, piece.points) {
			around = true
		}
		for _, point := range piece.points {
			angle, ok := headingBetween(camera.eye, point)
			if !ok {
				around = true
				continue
			}
			if reference == nil {
				reference = ptr(angle)
			}
			offset := angleFrom(*reference, angle)
			low, high = math.Min(low, offset), math.Max(high, offset)
		}
	}
	if around {
		facts.Distance, facts.InFrame, facts.Place = 0, true, placeAround
		facts.X = &[2]float64{-1, 1}
		return facts
	}
	if reference == nil {
		facts.Place = placeAround
		return facts
	}
	center := angleFrom(camera.heading, *reference+(low+high)/2)
	spread := (high - low) / 2
	half := camera.fov / 2
	// Дуга разброса может уходить за спину камеры: сравниваем её и её сдвиги на полный оборот с углом обзора.
	left, right := math.Inf(-1), math.Inf(1)
	for _, shift := range []float64{-360, 0, 360} {
		from, to := math.Max(center+shift-spread, -half), math.Min(center+shift+spread, half)
		if from <= to+epsilon {
			right, left = math.Min(right, from), math.Max(left, to)
		}
	}
	facts.InFrame = !math.IsInf(left, -1)
	if !facts.InFrame {
		facts.Place = outsidePlace(center)
		return facts
	}
	xLeft, xRight := camera.screenX(left), camera.screenX(right)
	facts.X = &[2]float64{round(xLeft, 2), round(xRight, 2)}
	facts.Place = rangePlace(xLeft, xRight, left >= half-epsilon, right <= -half+epsilon)
	return facts
}

func clamp(value float64) float64 {
	return math.Max(-1, math.Min(1, value))
}

func round(value float64, digits int) float64 {
	scale := math.Pow(10, float64(digits))
	result := math.Round(value*scale) / scale
	if result == 0 {
		return 0
	}
	return result
}

func ptr[T any](value T) *T {
	return &value
}
