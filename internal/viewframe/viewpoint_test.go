package viewframe

import "testing"

// TestCameraMoves — камера «движется», если последний кадр снят с другого места, высоты, направления или наклона,
// в том числе когда без своего направления она следит за идущим героем; движение одного героя при камере со своим
// направлением — нет.
func TestCameraMoves(t *testing.T) {
	end := func(x, y float64) *Point { return &Point{x, y} }
	value := func(v float64) *float64 { return &v }
	hero := Subject{Entity: "hero", Path: Path{Start: Point{5, 0}}}
	walking := Subject{Entity: "hero", Path: Path{Start: Point{5, -2}, End: end(5, 2)}}
	still := Path{Start: Point{0, 0}}
	cases := []struct {
		name      string
		viewpoint Viewpoint
		want      bool
	}{
		{"неподвижная", Viewpoint{Side: "south", Camera: &still, Subjects: []Subject{hero}}, false},
		{"наезд", Viewpoint{Side: "south", Camera: &Path{Start: Point{0, 0}, End: end(2, 0)}, Subjects: []Subject{hero}}, true},
		{"ниже", Viewpoint{Side: "south", Camera: &still, CameraHeight: &Pair{Start: 1.6, End: value(1.2)}, Heading: &Pair{Start: 0}}, true},
		{"поворот", Viewpoint{Side: "south", Camera: &still, Heading: &Pair{Start: 0, End: value(20)}}, true},
		{"наклон", Viewpoint{Side: "south", Camera: &still, Heading: &Pair{Start: 0}, Tilt: &Pair{Start: 0, End: value(-3)}}, true},
		{"слежение за героем", Viewpoint{Side: "south", Camera: &still, Subjects: []Subject{walking}}, true},
		{"герой идёт мимо неподвижной камеры", Viewpoint{Side: "south", Camera: &still, Heading: &Pair{Start: 0}, Subjects: []Subject{walking}}, false},
		{"без места камеры", Viewpoint{Side: "south", Subjects: []Subject{walking}}, false},
		{"сверху", Viewpoint{Side: "top", Camera: &Path{Start: Point{0, 0}, End: end(2, 0)}}, false},
	}
	for _, item := range cases {
		if got := item.viewpoint.CameraMoves(Cast{}); got != item.want {
			t.Errorf("%s: CameraMoves = %v, want %v", item.name, got, item.want)
		}
	}
}
