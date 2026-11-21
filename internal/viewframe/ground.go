package viewframe

import "math"

// groundFar — дальняя граница видимой земли, м, когда верхний край кадра выше горизонта: дальше любой схемы.
const groundFar = 1e4

// groundView — участок земли, который попадает в кадр: трапеция в плане между глубинами near и far вдоль взгляда
// (горизонтальное расстояние от камеры по направлению взгляда) и боковыми лучами угла обзора. Нижний край кадра
// упирается в землю на глубине near, верхний — на far, если он ниже горизонта. Плоская поверхность ближе near
// лежит под нижним краем кадра, даже если она прямо перед камерой: так низкая камера, смотрящая чуть вниз на
// героя, не «видит» дорогу у себя под ногами. ok=false — земли в кадре нет: нижний край на горизонте или выше.
type groundView struct {
	near, far float64
	corners   []Point
}

// ground — видимый участок земли кадра camera. Камера на уровне земли видит её только у горизонта: тогда
// участок — весь сектор обзора, как без учёта высоты.
func (camera view) ground() (groundView, bool) {
	low := (camera.pitch - camera.vfov/2) * math.Pi / 180
	high := (camera.pitch + camera.vfov/2) * math.Pi / 180
	near, far := 0.0, groundFar
	if camera.height > epsilon {
		if low >= 0 {
			return groundView{}, false
		}
		near = camera.height / math.Tan(-low)
		if high < 0 {
			far = math.Min(far, camera.height/math.Tan(-high))
		}
	}
	return camera.trapezoid(near, far), true
}

// trapezoid — участок сектора обзора между глубинами near и far вдоль взгляда, вершины против часовой стрелки.
func (camera view) trapezoid(near, far float64) groundView {
	theta := camera.heading * math.Pi / 180
	spread := math.Tan(camera.fov / 2 * math.Pi / 180)
	at := func(depth, side float64) Point {
		// side > 0 — влево от взгляда.
		return Point{
			camera.eye[0] + depth*math.Cos(theta) - side*math.Sin(theta),
			camera.eye[1] + depth*math.Sin(theta) + side*math.Cos(theta),
		}
	}
	return groundView{near: near, far: far, corners: []Point{
		at(near, -near*spread), at(far, -far*spread), at(far, far*spread), at(near, near*spread),
	}}
}

// clip — части следа объекта внутри участка: многоугольники обрезаются по Сазерленду — Ходжману (участок
// выпуклый), отрезки линий — по Сайрусу — Беку, точки остаются, если лежат внутри.
func (g groundView) clip(parts []part) []part {
	var result []part
	for _, piece := range parts {
		switch {
		case piece.closed && len(piece.points) > 2:
			if outline := clipPolygon(piece.points, g.corners); len(outline) > 0 {
				result = append(result, part{points: outline, closed: true})
			}
		case len(piece.edges()) > 0:
			for _, edge := range piece.edges() {
				if a, b, ok := clipSegment(edge[0], edge[1], g.corners); ok {
					result = append(result, part{points: []Point{a, b}})
				}
			}
		default:
			for _, point := range piece.points {
				if insideConvex(point, g.corners) {
					result = append(result, part{points: []Point{point}})
				}
			}
		}
	}
	return result
}

// cross — знак поворота a→b→p: больше нуля — p слева от направления a→b.
func cross(a, b, p Point) float64 {
	return (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0])
}

// insideConvex — p внутри выпуклого многоугольника convex (вершины против часовой стрелки) или на его границе.
func insideConvex(p Point, convex []Point) bool {
	for index := range convex {
		if cross(convex[index], convex[(index+1)%len(convex)], p) < -epsilon {
			return false
		}
	}
	return true
}

// clipPolygon обрезает многоугольник outline выпуклым многоугольником convex (против часовой стрелки).
func clipPolygon(outline, convex []Point) []Point {
	result := outline
	for index := range convex {
		a, b := convex[index], convex[(index+1)%len(convex)]
		input := result
		result = nil
		for position, current := range input {
			previous := input[(position+len(input)-1)%len(input)]
			currentIn, previousIn := cross(a, b, current) >= -epsilon, cross(a, b, previous) >= -epsilon
			if currentIn != previousIn {
				result = append(result, lineCrossing(previous, current, a, b))
			}
			if currentIn {
				result = append(result, current)
			}
		}
		if len(result) == 0 {
			return nil
		}
	}
	return result
}

// lineCrossing — точка пересечения отрезка pq с прямой ab.
func lineCrossing(p, q, a, b Point) Point {
	dp, dq := cross(a, b, p), cross(a, b, q)
	t := dp / (dp - dq)
	return Point{p[0] + (q[0]-p[0])*t, p[1] + (q[1]-p[1])*t}
}

// clipSegment обрезает отрезок ab выпуклым многоугольником convex (против часовой стрелки); false — снаружи.
func clipSegment(a, b Point, convex []Point) (Point, Point, bool) {
	from, to := 0.0, 1.0
	for index := range convex {
		c, d := convex[index], convex[(index+1)%len(convex)]
		start, end := cross(c, d, a), cross(c, d, b)
		switch {
		case start < -epsilon && end < -epsilon:
			return Point{}, Point{}, false
		case start < -epsilon:
			from = math.Max(from, start/(start-end))
		case end < -epsilon:
			to = math.Min(to, start/(start-end))
		}
		if from > to+epsilon {
			return Point{}, Point{}, false
		}
	}
	at := func(t float64) Point { return Point{a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t} }
	return at(from), at(to), true
}
