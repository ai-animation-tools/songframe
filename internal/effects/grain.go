package effects

import "math"

// grain — плёночное зерно: монохромный шум, свой на каждом кадре, заметнее в светлых местах
// (корень яркости), чтобы чёрное небо не серело.
type grain struct{ amount float32 }

func init() {
	register(Kind{
		ID: "grain", Title: "Зерно", Version: 1, Order: 30,
		Hint:   "Плёночное зерно: лёгкий шум, свой на каждом кадре. Применяйте, чтобы видео выглядело снятым камерой, а планы разных генераций — одним клипом. Зерно заметнее в светлых местах; на уменьшенном превью его почти не видно — смотрите кадр на весь экран.",
		Params: []ParamSpec{{"amount", "Сила зерна", 0, 0.2, 0.025, 0.001, "Сила зерна: 0,01–0,03 — едва заметная плёнка, от 0,05 — грубое зерно старой плёнки."}},
		New: func(p Params, size Size) Effect {
			return &grain{amount: float32(p["amount"])}
		},
	})
}

func (g *grain) Apply(ctx *Context, f *Frame) {
	if g.amount == 0 {
		return
	}
	frame := uint32(ctx.Frame)
	parallelRows(f.Height, func(y int) {
		for x := 0; x < f.Width; x++ {
			pixel := uint32(y*f.Width + x)
			// сумма двух равномерных — треугольное распределение около нуля
			n := float32(hash(pixel, frame*2654435761) + hash(pixel+977, frame) - 1)
			i := (y*f.Width + x) * 3
			lum := 0.2126*f.Pix[i] + 0.7152*f.Pix[i+1] + 0.0722*f.Pix[i+2]
			k := g.amount * n * float32(math.Sqrt(float64(max(lum, 0))+0.0004))
			f.Pix[i] += k
			f.Pix[i+1] += k
			f.Pix[i+2] += k
		}
	})
}
