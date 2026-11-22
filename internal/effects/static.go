package effects

import (
	"fmt"
	"math"
)

// Source — источник кадров ролика: размер вывода и кадр по номеру. Кадр t зависит только от t,
// поэтому кадры можно считать в любом порядке.
type Source interface {
	Size() Size
	Frame(t int) *Frame
}

// StaticVersion — версия сборки статичного кадра; меняется вместе с результатом.
const StaticVersion = 1

// StaticParams — параметры статичного кадра: маска различия опор, переход и наезд.
var StaticParams = []ParamSpec{
	{"threshold", "Порог различия опор", 0, 0.5, 0.012},
	{"dilate", "Расширение области смены, пиксели", 0, 64, 14},
	{"feather", "Растушёвка области смены, пиксели", 0, 64, 12},
	{"transition", "Переход при смене, кадры", 0, 30, 3},
	{"push_in", "Наезд за план, доля", 0, 0.3, 0.03},
	{"center_x", "Центр наезда по горизонтали", 0, 1, 0.5},
	{"center_y", "Центр наезда по вертикали", 0, 1, 0.5},
}

// State — опора-состояние и первый кадр плана, с которого оно видно.
type State struct {
	Image *Frame
	From  int
}

// StaticShot — план из опор-состояний. Базовая опора задаёт весь кадр; состояние берётся
// только там, где оно отличается от базовой (маска различия с расширением и растушёвкой),
// поэтому вне области смены кадр пиксель в пиксель повторяет базу и на смене фон не прыгает.
// Смена — короткий переход наложением; поверх — медленный наезд к выбранной точке.
type StaticShot struct {
	size       Size
	composites []*Frame
	starts     []int
	transition int
	pushIn     float64
	centerX    float64
	centerY    float64
}

// NewStaticShot проверяет состояния и готовит кадры смены. Первое состояние начинается с кадра
// 0, следующие — строго позже предыдущего и раньше конца плана; все опоры размера базовой.
func NewStaticShot(base *Frame, states []State, given map[string]float64, size Size) (*StaticShot, error) {
	params, err := Resolve(StaticParams, given)
	if err != nil {
		return nil, fmt.Errorf("статичный кадр: %w", err)
	}
	if size.Width <= 0 || size.Height <= 0 || size.Frames <= 0 {
		return nil, fmt.Errorf("статичный кадр: пустой размер %dx%d, кадров %d", size.Width, size.Height, size.Frames)
	}
	if len(states) == 0 {
		return nil, fmt.Errorf("статичный кадр: нет состояний")
	}
	if states[0].From != 0 {
		return nil, fmt.Errorf("статичный кадр: первое состояние начинается с кадра %d, а не с 0", states[0].From)
	}
	shot := &StaticShot{
		size: size, transition: int(params["transition"]), pushIn: params["push_in"],
		centerX: params["center_x"], centerY: params["center_y"],
	}
	for i, state := range states {
		if i > 0 && state.From <= states[i-1].From {
			return nil, fmt.Errorf("статичный кадр: состояние %d начинается не позже предыдущего", i+1)
		}
		if state.From >= size.Frames {
			return nil, fmt.Errorf("статичный кадр: состояние %d начинается с кадра %d, а в плане %d кадров", i+1, state.From, size.Frames)
		}
		if state.Image.Width != base.Width || state.Image.Height != base.Height {
			return nil, fmt.Errorf("статичный кадр: опора состояния %d размером %dx%d, а базовая — %dx%d",
				i+1, state.Image.Width, state.Image.Height, base.Width, base.Height)
		}
		mask := DiffMask(base, state.Image, float32(params["threshold"]), int(params["dilate"]), int(params["feather"]))
		shot.composites = append(shot.composites, composite(base, state.Image, mask))
		shot.starts = append(shot.starts, state.From)
	}
	return shot, nil
}

// DiffMask — маска 0…1 области, где опора b отличается от базовой a. Разница считается в sRGB:
// в линейном свете слабое свечение в темноте (ореол горящей лампы) оказывается ниже порога и
// осталось бы от прежнего состояния. Маска расширяется на dilate пикселей и растушёвывается.
func DiffMask(a, b *Frame, threshold float32, dilate, feather int) []float32 {
	mask := make([]float32, a.Width*a.Height)
	limit := threshold * 255
	for i := range mask {
		var d float32
		for c := 0; c < 3; c++ {
			v := float32(encode(a.Pix[i*3+c])) - float32(encode(b.Pix[i*3+c]))
			d = max(d, max(v, -v))
		}
		if d > limit {
			mask[i] = 1
		}
	}
	if dilate > 0 {
		boxBlur(mask, a.Width, a.Height, dilate)
		for i, v := range mask {
			if v > 0.02 {
				mask[i] = 1
			} else {
				mask[i] = 0
			}
		}
	}
	boxBlur(mask, a.Width, a.Height, feather)
	return mask
}

// composite — база вне маски и опора состояния внутри.
func composite(base, state *Frame, mask []float32) *Frame {
	result := base.Clone()
	for i, m := range mask {
		if m == 0 {
			continue
		}
		for c := 0; c < 3; c++ {
			k := i*3 + c
			result.Pix[k] = base.Pix[k]*(1-m) + state.Pix[k]*m
		}
	}
	return result
}

// Size — размер вывода.
func (s *StaticShot) Size() Size { return s.size }

// Frame — кадр t в размере вывода.
func (s *StaticShot) Frame(t int) *Frame {
	index := 0
	for i, from := range s.starts {
		if t >= from {
			index = i
		}
	}
	src := s.composites[index]
	if index > 0 && s.transition > 0 && t < s.starts[index]+s.transition {
		a := float32(t-s.starts[index]+1) / float32(s.transition+1)
		prev := s.composites[index-1]
		mixed := NewFrame(src.Width, src.Height)
		for i := range mixed.Pix {
			mixed.Pix[i] = prev.Pix[i]*(1-a) + src.Pix[i]*a
		}
		src = mixed
	}
	progress := smoothstep(0, 1, float64(t)/float64(max(1, s.size.Frames-1)))
	return resample(src, s.size.Width, s.size.Height, 1+s.pushIn*progress, s.centerX, s.centerY)
}

// resample — кадр width×height из src с заполнением (лишнее по краям обрезается) и увеличением
// zoom к точке (cx, cy) в долях src: эта точка остаётся на своём месте экрана.
func resample(src *Frame, width, height int, zoom, cx, cy float64) *Frame {
	out := NewFrame(width, height)
	scale := math.Max(float64(width)/float64(src.Width), float64(height)/float64(src.Height)) * zoom
	sw, sh := float64(src.Width), float64(src.Height)
	ox := (1 - 1/zoom) * (cx*sw - sw/2)
	oy := (1 - 1/zoom) * (cy*sh - sh/2)
	parallelRows(height, func(y int) {
		sy := sh/2 + oy + (float64(y)+0.5-float64(height)/2)/scale - 0.5
		for x := 0; x < width; x++ {
			sx := sw/2 + ox + (float64(x)+0.5-float64(width)/2)/scale - 0.5
			v := src.Sample(sx, sy)
			i := (y*width + x) * 3
			out.Pix[i], out.Pix[i+1], out.Pix[i+2] = v[0], v[1], v[2]
		}
	})
	return out
}
