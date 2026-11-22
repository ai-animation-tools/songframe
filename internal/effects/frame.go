package effects

import (
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg" // опоры бывают JPEG
	_ "image/png"
	"math"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
)

// Frame — кадр в линейном свете: три канала float32 подряд, строка за строкой. Сложение света
// и смешивание в линейном пространстве выглядят естественнее, чем в sRGB; значения выше 1
// допустимы до вывода (RGB24 их ограничивает).
type Frame struct {
	Width, Height int
	Pix           []float32
}

// NewFrame — чёрный кадр.
func NewFrame(width, height int) *Frame {
	return &Frame{Width: width, Height: height, Pix: make([]float32, width*height*3)}
}

// Clone — независимая копия.
func (f *Frame) Clone() *Frame {
	c := NewFrame(f.Width, f.Height)
	copy(c.Pix, f.Pix)
	return c
}

var (
	toLinear [256]float32
	toSRGB   [4096]uint8
)

func init() {
	for i := range toLinear {
		c := float64(i) / 255
		if c <= 0.04045 {
			toLinear[i] = float32(c / 12.92)
		} else {
			toLinear[i] = float32(math.Pow((c+0.055)/1.055, 2.4))
		}
	}
	for i := range toSRGB {
		l := float64(i) / float64(len(toSRGB)-1)
		var c float64
		if l <= 0.0031308 {
			c = l * 12.92
		} else {
			c = 1.055*math.Pow(l, 1/2.4) - 0.055
		}
		toSRGB[i] = uint8(math.Round(math.Max(0, math.Min(1, c)) * 255))
	}
}

// encode — канал линейного света в sRGB 0…255 по таблице (4096 ступеней).
func encode(v float32) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 1 {
		return 255
	}
	return toSRGB[int(v*float32(len(toSRGB)-1)+0.5)]
}

// LoadImage читает PNG или JPEG в линейный кадр.
func LoadImage(path string) (*Frame, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	src, _, err := image.Decode(file)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return FromImage(src), nil
}

// FromImage — линейный кадр из изображения.
func FromImage(src image.Image) *Frame {
	bounds := src.Bounds()
	rgba, ok := src.(*image.RGBA)
	if !ok || bounds.Min != (image.Point{}) {
		rgba = image.NewRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
		draw.Draw(rgba, rgba.Bounds(), src, bounds.Min, draw.Src)
	}
	f := NewFrame(bounds.Dx(), bounds.Dy())
	for y := 0; y < f.Height; y++ {
		row := rgba.Pix[y*rgba.Stride:]
		for x := 0; x < f.Width; x++ {
			i := (y*f.Width + x) * 3
			f.Pix[i] = toLinear[row[x*4]]
			f.Pix[i+1] = toLinear[row[x*4+1]]
			f.Pix[i+2] = toLinear[row[x*4+2]]
		}
	}
	return f
}

// RGB24 записывает кадр в sRGB по 3 байта на пиксель; out — не меньше Width*Height*3.
func (f *Frame) RGB24(out []byte) {
	parallelRows(f.Height, func(y int) {
		start, end := y*f.Width*3, (y+1)*f.Width*3
		for i := start; i < end; i++ {
			out[i] = encode(f.Pix[i])
		}
	})
}

// Sample — билинейная выборка в координатах пикселей; за краем берётся крайний пиксель.
func (f *Frame) Sample(x, y float64) [3]float32 {
	x = math.Max(0, math.Min(float64(f.Width-1), x))
	y = math.Max(0, math.Min(float64(f.Height-1), y))
	x0, y0 := int(x), int(y)
	x1, y1 := min(x0+1, f.Width-1), min(y0+1, f.Height-1)
	fx, fy := float32(x-float64(x0)), float32(y-float64(y0))
	var result [3]float32
	for c := 0; c < 3; c++ {
		a := f.Pix[(y0*f.Width+x0)*3+c]*(1-fx) + f.Pix[(y0*f.Width+x1)*3+c]*fx
		b := f.Pix[(y1*f.Width+x0)*3+c]*(1-fx) + f.Pix[(y1*f.Width+x1)*3+c]*fx
		result[c] = a*(1-fy) + b*fy
	}
	return result
}

// downsample — среднее по блокам step×step: дешёвая карта освещения кадра.
func (f *Frame) downsample(step int) *Frame {
	w, h := (f.Width+step-1)/step, (f.Height+step-1)/step
	d := NewFrame(w, h)
	counts := make([]float32, w*h)
	for y := 0; y < f.Height; y++ {
		for x := 0; x < f.Width; x++ {
			o := (y/step)*w + x/step
			i := (y*f.Width + x) * 3
			d.Pix[o*3] += f.Pix[i]
			d.Pix[o*3+1] += f.Pix[i+1]
			d.Pix[o*3+2] += f.Pix[i+2]
			counts[o]++
		}
	}
	for o, n := range counts {
		for c := 0; c < 3; c++ {
			d.Pix[o*3+c] /= n
		}
	}
	return d
}

// blurChannels — размытие каждого канала кадра (boxBlur).
func (f *Frame) blurChannels(radius int) {
	plane := make([]float32, f.Width*f.Height)
	for c := 0; c < 3; c++ {
		for i := range plane {
			plane[i] = f.Pix[i*3+c]
		}
		boxBlur(plane, f.Width, f.Height, radius)
		for i := range plane {
			f.Pix[i*3+c] = plane[i]
		}
	}
}

// parallelRows вызывает fn для каждой строки 0…n-1 на всех ядрах. Строки независимы, поэтому
// результат не зависит от числа ядер.
func parallelRows(n int, fn func(row int)) {
	workers := min(runtime.GOMAXPROCS(0), n)
	if workers <= 1 {
		for row := 0; row < n; row++ {
			fn(row)
		}
		return
	}
	var wg sync.WaitGroup
	var next atomic.Int64
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				row := int(next.Add(1) - 1)
				if row >= n {
					return
				}
				fn(row)
			}
		}()
	}
	wg.Wait()
}

// boxBlur — разделимое размытие одного канала радиусом r; три прохода приближают гауссово.
// Край продолжается крайним значением.
func boxBlur(plane []float32, w, h, r int) {
	if r <= 0 {
		return
	}
	tmp := make([]float32, len(plane))
	norm := 1 / float32(2*r+1)
	for pass := 0; pass < 3; pass++ {
		parallelRows(h, func(y int) {
			row, out := plane[y*w:(y+1)*w], tmp[y*w:(y+1)*w]
			var sum float32
			for x := -r; x <= r; x++ {
				sum += row[max(0, min(w-1, x))]
			}
			for x := 0; x < w; x++ {
				out[x] = sum * norm
				sum += row[min(w-1, x+r+1)] - row[max(0, x-r)]
			}
		})
		parallelRows(w, func(x int) {
			var sum float32
			for y := -r; y <= r; y++ {
				sum += tmp[max(0, min(h-1, y))*w+x]
			}
			for y := 0; y < h; y++ {
				plane[y*w+x] = sum * norm
				sum += tmp[min(h-1, y+r+1)*w+x] - tmp[max(0, y-r)*w+x]
			}
		})
	}
}
