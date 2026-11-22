package effects

import "math"

// rain — процедурный дождь слоями глубины. Ночью капля видна только светом вокруг неё, поэтому
// её яркость берётся из размытого кадра в её точке (у горящей лампы капли окрашены её цветом) и
// из света эффектов перед дождём (Context.Lights). Положение капли — функция номера кадра; при
// каждом новом проходе сверху капля получает новое место, поэтому видимого цикла нет. Наклон
// angle — экранный, от вертикали, плюс — капли смещаются вправо; из ветра на схеме его считает
// ScreenAngle.
type rain struct {
	p      Params
	width  int
	height int
	layers [][]drop
	streak []float32
}

// drop — капля: ключ случайных чисел, начальная фаза, скорость и длина следа в пикселях за кадр,
// толщина и непрозрачность.
type drop struct {
	id            uint32
	phase         float64
	speed, length float64
	thickness     float64
	alpha         float32
}

func init() {
	register(Kind{
		ID: "rain", Title: "Дождь", Version: 1, Order: 20, WindAngle: "angle",
		Params: []ParamSpec{
			{"density", "Плотность, капель на мегапиксель", 0, 5000, 900, 10},
			{"angle", "Наклон, градусы от вертикали", -60, 60, 0, 0.5},
			{"speed", "Скорость, пиксели за кадр", 5, 200, 55, 0.5},
			{"shutter", "Длина капли, доля пути за кадр", 0.05, 3, 0.5, 0.01},
			{"thickness", "Размер капли (толщина), пиксели", 0.3, 6, 1.1, 0.1},
			{"opacity", "Непрозрачность", 0, 1, 0.35, 0.01},
			{"layers", "Слои глубины", 1, 3, 3, 1},
			{"glow", "Подсветка от кадра", 0, 40, 10, 0.5},
			{"ambient", "Своя яркость капли", 0, 0.2, 0.004, 0.001},
			{"light_gain", "Подсветка от источников света", 0, 5, 0.6, 0.1},
			{"wet_darken", "Затемнение мокрого кадра", 0, 0.6, 0.08, 0.01},
			{"wet_contrast", "Контраст мокрого кадра", 0.5, 2, 1.1, 0.01},
			{"seed", "Вариант случайной картины", 0, 1000000, 1, 1},
		},
		New: newRain,
	})
}

func newRain(p Params, size Size) Effect {
	r := &rain{p: p, width: size.Width, height: size.Height, streak: make([]float32, size.Width*size.Height*3)}
	layers := int(p["layers"])
	seed := uint32(p["seed"])
	total := p["density"] * float64(size.Width*size.Height) / 1e6
	for layer := 0; layer < layers; layer++ {
		// дальний слой: мелкие, медленные, тусклые и многочисленные капли; ближний — наоборот
		depth := 1.0
		if layers > 1 {
			depth = 0.45 + 1.1*float64(layer)/float64(layers-1)
		}
		count := int(total * (1.6 - 0.5*float64(layer)) / float64(layers))
		drops := make([]drop, count)
		for i := range drops {
			id := seed*7919 + uint32(layer)*1000003 + uint32(i)
			speed := depth * p["speed"] * (0.85 + 0.3*hash(id, 1))
			drops[i] = drop{
				id: id, phase: hash(id, 2), speed: speed,
				length:    speed * p["shutter"] * (0.8 + 0.4*hash(id, 3)),
				thickness: p["thickness"] * depth * (0.8 + 0.4*hash(id, 4)),
				alpha:     float32(p["opacity"] * (0.4 + 0.6*depth/1.55) * (0.6 + 0.4*hash(id, 5))),
			}
		}
		r.layers = append(r.layers, drops)
	}
	return r
}

func (r *rain) Apply(ctx *Context, f *Frame) {
	r.wet(f)
	glowMap := f.downsample(16)
	glowMap.blurChannels(2)
	angle := r.p["angle"] * math.Pi / 180
	dx, dy := math.Sin(angle), math.Cos(angle)
	const margin = 200.0
	spanY := float64(r.height) + 2*margin
	drift := spanY * math.Abs(dx/dy) // насколько капля смещается по горизонтали за проход
	spanX := float64(r.width) + 2*margin + drift
	glow, ambient, lightGain := float32(r.p["glow"]), float32(r.p["ambient"]), float32(r.p["light_gain"])
	clear(r.streak)
	t := float64(ctx.Frame)
	for _, layer := range r.layers {
		for _, d := range layer {
			travel := d.phase*spanY + d.speed*dy*t
			pass := math.Floor(travel / spanY)
			y := travel - pass*spanY - margin
			x := hash(d.id, uint32(int64(pass)+7))*spanX - margin - drift/2 + (y+margin)*dx/dy
			cx, cy := x+dx*d.length/2, y+dy*d.length/2
			if cx < -50 || cx > float64(r.width)+50 || cy < -50 || cy > float64(r.height)+50 {
				continue
			}
			g := glowMap.Sample(cx/16-0.5, cy/16-0.5)
			color := [3]float32{ambient + glow*g[0], ambient + glow*g[1], ambient + glow*g[2]}
			for _, source := range ctx.Lights {
				lit := source.At(cx, cy)
				for c := 0; c < 3; c++ {
					color[c] += lightGain * lit[c]
				}
			}
			r.stroke(x, y, dx, dy, d, color)
		}
	}
	for i := range f.Pix {
		f.Pix[i] += r.streak[i]
	}
}

// wet — мокрый кадр: чуть темнее и контрастнее относительно уровня тёмного фона.
func (r *rain) wet(f *Frame) {
	dark, contrast := float32(1-r.p["wet_darken"]), r.p["wet_contrast"]
	const pivot = 0.05
	parallelRows(f.Height, func(y int) {
		for i := y * f.Width * 3; i < (y+1)*f.Width*3; i++ {
			v := f.Pix[i] * dark
			if v > 0 && contrast != 1 {
				v = pivot * float32(math.Pow(float64(v/pivot), contrast))
			}
			f.Pix[i] = v
		}
	})
}

// stroke — след капли: отрезок от (x, y) вдоль (dx, dy) длиной d.length с мягкими краями.
func (r *rain) stroke(x, y, dx, dy float64, d drop, color [3]float32) {
	half := d.thickness/2 + 0.75
	x2, y2 := x+dx*d.length, y+dy*d.length
	minX, maxX := int(math.Floor(math.Min(x, x2)-half)), int(math.Ceil(math.Max(x, x2)+half))
	minY, maxY := int(math.Floor(math.Min(y, y2)-half)), int(math.Ceil(math.Max(y, y2)+half))
	for py := max(0, minY); py <= min(r.height-1, maxY); py++ {
		for px := max(0, minX); px <= min(r.width-1, maxX); px++ {
			ux, uy := float64(px)+0.5-x, float64(py)+0.5-y
			along := ux*dx + uy*dy
			if along < -half || along > d.length+half {
				continue
			}
			a := 1 - math.Abs(ux*dy-uy*dx)/half
			if a <= 0 {
				continue
			}
			// концы следа мягче: капля входит в выдержку и выходит из неё
			fade := math.Min(1, math.Min(along+half, d.length+half-along)/(2*half))
			weight := float32(a*a*fade) * d.alpha
			i := (py*r.width + px) * 3
			r.streak[i] += weight * color[0]
			r.streak[i+1] += weight * color[1]
			r.streak[i+2] += weight * color[2]
		}
	}
}

// ScreenAngle — экранный наклон дождя в градусах от вертикали (плюс — капли смещаются вправо)
// по ветру на схеме локации и направлению камеры. wind и heading — градусы против часовой
// стрелки от востока, как у точки съёмки; strength — горизонтальная скорость ветра в долях
// скорости падения (0 — дождь вертикален); tilt — наклон камеры, градусы, плюс — вверх. При
// развороте камеры на 180° наклон меняет знак, ветер вдоль взгляда наклона не даёт.
// Перспективное схождение струй к точке схода не учитывается.
func ScreenAngle(wind, strength, heading, tilt float64) float64 {
	rad := math.Pi / 180
	h, tau, w := heading*rad, tilt*rad, wind*rad
	// падение капли: горизонтальная составляющая по ветру и вертикальная вниз
	vx, vy, vz := strength*math.Cos(w), strength*math.Sin(w), -1.0
	// оси камеры: вправо и вверх на экране (X — восток, Y — север, Z — вверх)
	rx, ry := math.Sin(h), -math.Cos(h)
	ux, uy, uz := -math.Cos(h)*math.Sin(tau), -math.Sin(h)*math.Sin(tau), math.Cos(tau)
	right := vx*rx + vy*ry
	up := vx*ux + vy*uy + vz*uz
	return math.Atan2(right, -up) / rad
}
