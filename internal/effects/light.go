package effects

import "math"

// light — свет от источника за кадром или у его края (фары, фонарь). Сила меняется от кадра к
// кадру: нарастает по кривой между долями плана start и end, с лёгким дрожанием. Три
// составляющие: подсветка уже освещённых поверхностей (умножение — тёмное небо остаётся тёмным,
// металл с бликами светлеет), контур на краях, обращённых к источнику (по градиенту яркости
// кадра), и слабая дымка луча в воздухе. Эффект добавляет себя в Context.Lights: дождь после
// него подсвечивает капли в луче.
type light struct {
	p      Params
	sx, sy float64
	radius float64
	color  [3]float32
	level  float32
	lum    []float32
}

func init() {
	register(Kind{
		ID: "light", Title: "Свет", Version: 1,
		Params: []ParamSpec{
			{"source_x", "Источник по горизонтали, доля кадра", -1, 2, -0.15},
			{"source_y", "Источник по вертикали, доля кадра", -1, 2, 1.25},
			{"radius", "Дальность, доля диагонали", 0.1, 3, 1.1},
			{"color_r", "Цвет: красный", 0, 1, 1},
			{"color_g", "Цвет: зелёный", 0, 1, 0.92},
			{"color_b", "Цвет: синий", 0, 1, 0.8},
			{"intensity", "Сила", 0, 20, 4},
			{"start", "Начало нарастания, доля плана", 0, 1, 0.45},
			{"end", "Полная сила, доля плана", 0, 1, 1},
			{"curve", "Крутизна нарастания", 0.2, 5, 2},
			{"flicker", "Дрожание", 0, 0.5, 0.06},
			{"surface", "Подсветка поверхностей", 0, 10, 1.5},
			{"rim", "Контур со стороны света", 0, 10, 2},
			{"haze", "Дымка луча", 0, 1, 0.04},
		},
		New: func(p Params, size Size) Effect {
			return &light{
				p:      p,
				sx:     p["source_x"] * float64(size.Width),
				sy:     p["source_y"] * float64(size.Height),
				radius: p["radius"] * math.Hypot(float64(size.Width), float64(size.Height)),
				color:  [3]float32{float32(p["color_r"]), float32(p["color_g"]), float32(p["color_b"])},
				lum:    make([]float32, size.Width*size.Height),
			}
		},
	})
}

// levelAt — сила света на кадре ctx.Frame.
func (l *light) levelAt(ctx *Context) float32 {
	t := float64(ctx.Frame) / float64(max(1, ctx.Frames-1))
	a := math.Pow(smoothstep(l.p["start"], l.p["end"], t), l.p["curve"])
	// дрожание — сумма несоразмерных синусов: свет сквозь дождь и движение источника
	f := float64(ctx.Frame)
	n := 0.5*math.Sin(f*0.71) + 0.3*math.Sin(f*1.93+1.3) + 0.2*math.Sin(f*3.17+0.4)
	return float32(math.Max(0, a*l.p["intensity"]*(1+l.p["flicker"]*n)))
}

// falloff — доля света в точке: 1 у источника, 0 на дальности radius.
func (l *light) falloff(x, y float64) float32 {
	d := math.Hypot(x-l.sx, y-l.sy) / l.radius
	if d >= 1 {
		return 0
	}
	v := float32(1 - d)
	return v * v
}

// At — свет в точке текущего кадра (для дождя).
func (l *light) At(x, y float64) [3]float32 {
	k := l.level * l.falloff(x, y)
	return [3]float32{l.color[0] * k, l.color[1] * k, l.color[2] * k}
}

func (l *light) Apply(ctx *Context, f *Frame) {
	l.level = l.levelAt(ctx)
	ctx.Lights = append(ctx.Lights, l)
	if l.level <= 0 {
		return
	}
	// корень линейной яркости близок к воспринимаемой: край тёмного корпуса на тёмном небе
	// даёт заметный градиент
	for i := range l.lum {
		lum := 0.2126*f.Pix[i*3] + 0.7152*f.Pix[i*3+1] + 0.0722*f.Pix[i*3+2]
		l.lum[i] = float32(math.Sqrt(float64(max(0, lum))))
	}
	boxBlur(l.lum, f.Width, f.Height, 1)
	surface, rim, haze := float32(l.p["surface"]), float32(l.p["rim"]), float32(l.p["haze"])*0.05
	w := f.Width
	parallelRows(f.Height, func(y int) {
		if y == 0 || y == f.Height-1 {
			return
		}
		for x := 1; x < w-1; x++ {
			fall := l.falloff(float64(x), float64(y))
			if fall <= 0 {
				continue
			}
			k := l.level * fall
			// градиент яркости указывает внутрь предмета; край освещён, если внешняя нормаль
			// смотрит на источник
			gx := l.lum[y*w+x+1] - l.lum[y*w+x-1]
			gy := l.lum[(y+1)*w+x] - l.lum[(y-1)*w+x]
			dx, dy := float32(l.sx-float64(x)), float32(l.sy-float64(y))
			edge := float32(0)
			if length := float32(math.Hypot(float64(dx), float64(dy))); length > 0 {
				edge = max(0, -(gx*dx+gy*dy)/length)
			}
			i := (y*w + x) * 3
			for c := 0; c < 3; c++ {
				v := f.Pix[i+c]
				f.Pix[i+c] = v + k*l.color[c]*(surface*v+rim*edge+haze)
			}
		}
	})
}
