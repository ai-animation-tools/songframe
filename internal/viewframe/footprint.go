package viewframe

import (
	"math"

	"songframe/internal/schemes"
)

// part — кусок следа объекта на земле: замкнутый контур или ломаная. Объект состоит из одного куска, кроме
// линии с шириной: её полоса — по прямоугольнику на каждый отрезок, так одинаково работают открытая дорога и
// замкнутая трасса.
type part struct {
	points []Point
	closed bool
}

// smoothSteps — число отрезков гладкой кривой между соседними точками, как у отрисовки схемы.
const smoothSteps = 12

// rotate поворачивает point вокруг center на angle градусов против часовой стрелки.
func rotate(point, center Point, angle float64) Point {
	radians := angle * math.Pi / 180
	x, y := point[0]-center[0], point[1]-center[1]
	return Point{center[0] + x*math.Cos(radians) - y*math.Sin(radians), center[1] + x*math.Sin(radians) + y*math.Cos(radians)}
}

func rotation(shape schemes.Shape) float64 {
	if shape.Rotation == nil {
		return 0
	}
	return *shape.Rotation
}

// rectCorners — углы прямоугольника с учётом поворота, против часовой стрелки от левого нижнего.
func rectCorners(shape schemes.Shape) []Point {
	center, size := *shape.Center, *shape.Size
	w, h := size[0]/2, size[1]/2
	corners := []Point{{center[0] - w, center[1] - h}, {center[0] + w, center[1] - h}, {center[0] + w, center[1] + h}, {center[0] - w, center[1] + h}}
	for index, corner := range corners {
		corners[index] = rotate(corner, center, rotation(shape))
	}
	return corners
}

// ellipseOutline — контур эллипса из 48 точек с учётом поворота.
func ellipseOutline(shape schemes.Shape) []Point {
	center, radii := *shape.Center, *shape.Radii
	points := make([]Point, 48)
	for index := range points {
		angle := float64(index) / 48 * math.Pi * 2
		points[index] = rotate(Point{center[0] + radii[0]*math.Cos(angle), center[1] + radii[1]*math.Sin(angle)}, center, rotation(shape))
	}
	return points
}

// smoothCurve — гладкая кривая через точки (центростремительный сплайн Катмулла — Рома) ломаной, как на холсте
// схемы: кривая проходит через все заданные точки.
func smoothCurve(points []Point, closed bool) []Point {
	if len(points) < 3 {
		return points
	}
	count := len(points)
	at := func(index int) Point {
		if closed {
			return points[((index%count)+count)%count]
		}
		return points[max(0, min(count-1, index))]
	}
	result := []Point{points[0]}
	segments := count - 1
	if closed {
		segments = count
	}
	for index := range segments {
		for step := 1; step <= smoothSteps; step++ {
			result = append(result, catmullRom(at(index-1), at(index), at(index+1), at(index+2), float64(step)/smoothSteps))
		}
	}
	return result
}

// catmullRom — точка центростремительного сплайна между p1 и p2 при параметре t ∈ [0, 1].
func catmullRom(p0, p1, p2, p3 Point, t float64) Point {
	knot := func(a, b Point) float64 { return math.Max(math.Sqrt(distance(a, b)), 1e-6) }
	t1 := knot(p0, p1)
	t2 := t1 + knot(p1, p2)
	t3 := t2 + knot(p2, p3)
	u := t1 + (t2-t1)*t
	mix := func(a, b Point, ta, tb float64) Point {
		wa, wb := (tb-u)/(tb-ta), (u-ta)/(tb-ta)
		return Point{a[0]*wa + b[0]*wb, a[1]*wa + b[1]*wb}
	}
	a1, a2, a3 := mix(p0, p1, 0, t1), mix(p1, p2, t1, t2), mix(p2, p3, t2, t3)
	b1, b2 := mix(a1, a2, 0, t2), mix(a2, a3, t1, t3)
	return mix(b1, b2, t1, t2)
}

// footprint — след фигуры на земле: углы прямоугольника, контур эллипса, многоугольник, линия (гладкая — по
// кривой; с шириной — полосой), точка.
func footprint(shape schemes.Shape) []part {
	switch shape.Type {
	case schemes.ShapeRect:
		return []part{{rectCorners(shape), true}}
	case schemes.ShapeEllipse:
		return []part{{ellipseOutline(shape), true}}
	case schemes.ShapePolygon:
		return []part{{shape.Points, true}}
	case schemes.ShapeLine:
		points := shape.Points
		if shape.Smooth {
			points = smoothCurve(points, shape.Closed)
		}
		if shape.Width != nil && *shape.Width > 0 {
			return band(points, shape.Closed, *shape.Width)
		}
		return []part{{points, shape.Closed}}
	case schemes.ShapePoint:
		return []part{{[]Point{*shape.At}, false}}
	}
	return nil
}

// band — полоса шириной width вдоль ломаной: прямоугольник на каждый отрезок.
func band(points []Point, closed bool, width float64) []part {
	segments := len(points) - 1
	if closed {
		segments = len(points)
	}
	var parts []part
	for index := range max(segments, 0) {
		a, b := points[index], points[(index+1)%len(points)]
		length := distance(a, b)
		if length < epsilon {
			continue
		}
		nx, ny := -(b[1]-a[1])/length*width/2, (b[0]-a[0])/length*width/2
		parts = append(parts, part{[]Point{{a[0] - nx, a[1] - ny}, {b[0] - nx, b[1] - ny}, {b[0] + nx, b[1] + ny}, {a[0] + nx, a[1] + ny}}, true})
	}
	if len(parts) == 0 && len(points) > 0 {
		// Линия из одной точки или совпавших точек — квадрат шириной полосы.
		half := width / 2
		at := points[0]
		parts = append(parts, part{[]Point{{at[0] - half, at[1] - half}, {at[0] + half, at[1] - half}, {at[0] + half, at[1] + half}, {at[0] - half, at[1] + half}}, true})
	}
	return parts
}

// verticalRange — низ и верх объекта над землёй, м: низ — подъём elevation, верх — плюс высота тела и подъём
// верха. Плоская поверхность (без высоты и верха) имеет нулевую толщину и обзор не заслоняет.
func verticalRange(object schemes.Object) (low, high float64) {
	if object.Elevation != nil {
		low = *object.Elevation
	}
	high = low
	if object.Height != nil {
		high += *object.Height
	}
	if object.Top != nil {
		high += object.Top.Rise
	}
	return low, high
}

// segmentDistance — расстояние от p до отрезка ab, м.
func segmentDistance(p, a, b Point) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	length := dx*dx + dy*dy
	t := 0.0
	if length > 0 {
		t = math.Min(1, math.Max(0, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length))
	}
	return math.Hypot(p[0]-(a[0]+t*dx), p[1]-(a[1]+t*dy))
}

// insideOutline — лежит ли p внутри замкнутого контура (чётность пересечений луча).
func insideOutline(p Point, points []Point) bool {
	inside := false
	for i, j := 0, len(points)-1; i < len(points); j, i = i, i+1 {
		a, b := points[i], points[j]
		if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0] {
			inside = !inside
		}
	}
	return inside
}

// edges — отрезки куска: стороны замкнутого контура или звенья ломаной.
func (p part) edges() [][2]Point {
	if len(p.points) < 2 {
		return nil
	}
	count := len(p.points) - 1
	if p.closed {
		count = len(p.points)
	}
	edges := make([][2]Point, 0, count)
	for index := range count {
		edges = append(edges, [2]Point{p.points[index], p.points[(index+1)%len(p.points)]})
	}
	return edges
}

// nearest — расстояние от p до ближайшей точки следа, м; p внутри замкнутого куска — 0.
func nearest(p Point, parts []part) float64 {
	best := math.Inf(1)
	for _, piece := range parts {
		if piece.closed && len(piece.points) > 2 && insideOutline(p, piece.points) {
			return 0
		}
		edges := piece.edges()
		if len(edges) == 0 {
			for _, point := range piece.points {
				best = math.Min(best, distance(p, point))
			}
		}
		for _, edge := range edges {
			best = math.Min(best, segmentDistance(p, edge[0], edge[1]))
		}
	}
	return best
}

// rayCrossings — параметры t ∈ [0, 1] пересечений отрезка from→to со сторонами куска.
func rayCrossings(from, to Point, piece part) []float64 {
	var result []float64
	dx, dy := to[0]-from[0], to[1]-from[1]
	for _, edge := range piece.edges() {
		ex, ey := edge[1][0]-edge[0][0], edge[1][1]-edge[0][1]
		denominator := dx*ey - dy*ex
		if math.Abs(denominator) < epsilon {
			continue
		}
		wx, wy := edge[0][0]-from[0], edge[0][1]-from[1]
		t := (wx*ey - wy*ex) / denominator
		u := (wx*dy - wy*dx) / denominator
		if t >= 0 && t <= 1 && u >= 0 && u <= 1 {
			result = append(result, t)
		}
	}
	return result
}
