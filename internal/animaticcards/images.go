package animaticcards

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/gif"
	_ "image/jpeg" // поддерживаемые форматы референсов
	_ "image/png"
	"io"
	"math"
	"os"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"songframe/internal/toolrt"
)

// rgbImage — 8-битное RGB-изображение: 3 байта на пиксель построчно без выравнивания.
// Карточка, референсы после приведения к RGB и результат ресэмплинга хранятся в этом виде, чтобы
// целочисленная арифметика смешивания и свёртки совпадала с эталоном побайтно.
type rgbImage struct {
	width, height int
	pix           []byte
}

func newRGB(width, height int, fill [3]byte) rgbImage {
	result := rgbImage{width: width, height: height, pix: make([]byte, 3*width*height)}
	for index := 0; index < len(result.pix); index += 3 {
		copy(result.pix[index:index+3], fill[:])
	}
	return result
}

// digest — SHA-256 сырых байтов пикселей RGB: им эталон сверяет вставленные изображения.
func (m rgbImage) digest() string {
	sum := sha256.Sum256(m.pix)
	return hex.EncodeToString(sum[:])
}

// unidentifiedImage — ошибка нераспознанного формата изображения. Тип записан полным именем с
// пакетом: так его печатает последняя строка трассировки инструмента (тип не встроенный); имя и
// текст зафиксированы эталоном.
func unidentifiedImage(filename string) error {
	return toolrt.New("PIL.UnidentifiedImageError", "cannot identify image file "+toolrt.Repr(filename))
}

// openRGB открывает изображение и приводит его к RGB (toRGB). Файл открывается по разрешённому
// абсолютному пути (toolrt.ResolvePath), поэтому и тексты ошибок (FileNotFoundError,
// IsADirectoryError, нераспознанный формат) содержат этот путь. Формат определяется по
// содержимому, не по расширению: PNG, JPEG, GIF, WebP, BMP и TIFF; прочие форматы (ICO, TGA,
// PPM…) дают ошибку нераспознанного формата. Повреждённые данные после распознанного заголовка —
// OSError.
func openRGB(path string) (rgbImage, error) {
	filename := toolrt.ResolvePath(path)
	data, err := os.ReadFile(filename)
	if err != nil {
		return rgbImage{}, toolrt.OSErrorFrom(err, filename)
	}
	if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
		return rgbImage{}, unidentifiedImage(filename)
	}
	decoded, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
			return rgbImage{}, toolrt.New(toolrt.OSError, "image file is truncated")
		}
		return rgbImage{}, toolrt.New(toolrt.OSError, err.Error())
	}
	switch typed := decoded.(type) {
	case *image.YCbCr:
		if format == "jpeg" {
			return jpegToRGB(typed), nil
		}
		if format == "webp" {
			return webpToRGB(typed), nil
		}
	case *image.NYCbCrA:
		if format == "webp" {
			return webpToRGB(&typed.YCbCr), nil
		}
	}
	if format == "gif" {
		decoded = gifScreen(data, decoded)
	}
	return toRGB(decoded), nil
}

// gifScreen — первый кадр GIF на логическом экране: референс имеет размер экрана, а image/gif
// отдаёт кадр в его собственных границах. Непокрытая часть заполняется цветом фона
// палитры (индекс фона вне палитры — чёрный).
func gifScreen(data []byte, frame image.Image) image.Image {
	all, err := gif.DecodeAll(bytes.NewReader(data))
	if err != nil || len(all.Image) == 0 {
		return frame
	}
	first := all.Image[0]
	screen := image.Rect(0, 0, all.Config.Width, all.Config.Height)
	if first.Bounds() == screen {
		return first
	}
	background := color.Color(color.Black)
	if palette, ok := all.Config.ColorModel.(color.Palette); ok && int(all.BackgroundIndex) < len(palette) {
		background = palette[all.BackgroundIndex]
	} else if int(all.BackgroundIndex) < len(first.Palette) {
		background = first.Palette[all.BackgroundIndex]
	}
	canvas := image.NewNRGBA(screen)
	for y := 0; y < screen.Dy(); y++ {
		for x := 0; x < screen.Dx(); x++ {
			if (image.Point{x, y}).In(first.Bounds()) {
				canvas.Set(x, y, first.At(x, y))
			} else {
				canvas.Set(x, y, background)
			}
		}
	}
	return canvas
}

// toRGB приводит изображение к 8-битному RGB: альфа отбрасывается без смешивания с фоном (у
// прозрачных пикселей остаётся их цвет), палитра раскрывается в RGB, оттенки серого повторяются
// в трёх каналах, 16-битные цветные каналы берут старший байт, а значение 16-битного серого
// насыщается на 255 (старший байт не берётся; так зафиксировано эталоном). YCbCr JPEG и WebP
// переводят jpegToRGB/webpToRGB (ycbcr.go) по правилам libjpeg-turbo и libwebp; формула
// image/color остаётся для прочих источников YCbCr.
func toRGB(source image.Image) rgbImage {
	bounds := source.Bounds()
	result := rgbImage{width: bounds.Dx(), height: bounds.Dy(), pix: make([]byte, 3*bounds.Dx()*bounds.Dy())}
	set := func(x, y int, r, g, b uint8) {
		offset := 3 * ((y-bounds.Min.Y)*result.width + (x - bounds.Min.X))
		result.pix[offset], result.pix[offset+1], result.pix[offset+2] = r, g, b
	}
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			switch typed := source.(type) {
			case *image.NRGBA:
				c := typed.NRGBAAt(x, y)
				set(x, y, c.R, c.G, c.B)
			case *image.NRGBA64:
				c := typed.NRGBA64At(x, y)
				set(x, y, uint8(c.R>>8), uint8(c.G>>8), uint8(c.B>>8))
			case *image.Gray:
				v := typed.GrayAt(x, y).Y
				set(x, y, v, v, v)
			case *image.Gray16:
				v := typed.Gray16At(x, y).Y
				if v > 255 {
					v = 255
				}
				set(x, y, uint8(v), uint8(v), uint8(v))
			case *image.Paletted:
				r, g, b := paletteRGB(typed.Palette, typed.ColorIndexAt(x, y))
				set(x, y, r, g, b)
			case *image.YCbCr:
				c := typed.YCbCrAt(x, y)
				r, g, b := color.YCbCrToRGB(c.Y, c.Cb, c.Cr)
				set(x, y, r, g, b)
			case *image.NYCbCrA:
				c := typed.NYCbCrAAt(x, y)
				r, g, b := color.YCbCrToRGB(c.Y, c.Cb, c.Cr)
				set(x, y, r, g, b)
			case *image.CMYK:
				// CMYK → RGB: nk = 255-k, канал = nk - c·nk/255 (muldiv255).
				c := typed.CMYKAt(x, y)
				nk := 255 - int(c.K)
				channel := func(v uint8) uint8 { return uint8(clamp255(nk - muldiv255(int(v), nk))) }
				set(x, y, channel(c.C), channel(c.M), channel(c.Y))
			default:
				c := color.NRGBA64Model.Convert(source.At(x, y)).(color.NRGBA64)
				set(x, y, uint8(c.R>>8), uint8(c.G>>8), uint8(c.B>>8))
			}
		}
	}
	return result
}

// paletteRGB — цвет палитры без учёта прозрачности (PNG с tRNS даёт color.NRGBA).
func paletteRGB(palette color.Palette, index uint8) (r, g, b uint8) {
	if int(index) >= len(palette) {
		return 0, 0, 0
	}
	switch c := palette[index].(type) {
	case color.NRGBA:
		return c.R, c.G, c.B
	case color.RGBA:
		if c.A == 255 || c.A == 0 {
			return c.R, c.G, c.B
		}
	}
	c := color.NRGBA64Model.Convert(palette[index]).(color.NRGBA64)
	return uint8(c.R >> 8), uint8(c.G >> 8), uint8(c.B >> 8)
}

// muldiv255 — a·b/255 с округлением через t = a·b + 128 и (t>>8 + t)>>8.
func muldiv255(a, b int) int {
	t := a*b + 128
	return ((t >> 8) + t) >> 8
}

func clamp255(v int) int {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return v
}

// containSize — размер изображения, вписанного в рамку width×height: пропорции сохраняются, по
// длинной стороне — ровно рамка, по другой — округление к чётному от float-выражения в
// показанном порядке операций (размеры зафиксированы эталоном).
func containSize(sourceWidth, sourceHeight, width, height int) (int, int) {
	imageRatio := float64(sourceWidth) / float64(sourceHeight)
	destRatio := float64(width) / float64(height)
	if imageRatio != destRatio {
		if imageRatio > destRatio {
			if newHeight := int(math.RoundToEven(float64(sourceHeight) / float64(sourceWidth) * float64(width))); newHeight != height {
				height = newHeight
			}
		} else if newWidth := int(math.RoundToEven(float64(sourceWidth) / float64(sourceHeight) * float64(height))); newWidth != width {
			width = newWidth
		}
	}
	return width, height
}

// contain вписывает RGB-изображение в рамку фильтром Ланцоша без обрезки и растяжения.
// Ширина или высота меньше 1 — ValueError.
func contain(source rgbImage, width, height int) (rgbImage, error) {
	width, height = containSize(source.width, source.height, width, height)
	return resizeLanczos(source, width, height)
}

// Ресэмплинг Ланцоша — свёртка с фильтром
// sinc(x)·sinc(x/3) с опорой 3, коэффициенты окна нормируются и переводятся в целые с 22
// дробными битами, свёртка идёт двумя проходами (горизонтальный, затем вертикальный) с
// начальным значением 1<<21 и отсечением в 0..255. Проход пропускается, если размер по его оси
// не меняется. Поэтому вписанный PNG-референс совпадает с эталоном побайтно.
const resamplePrecision = 32 - 8 - 2

func sincFilter(x float64) float64 {
	if x == 0 {
		return 1
	}
	x *= math.Pi
	return math.Sin(x) / x
}

func lanczosFilter(x float64) float64 {
	if -3 <= x && x < 3 {
		return sincFilter(x) * sincFilter(x/3)
	}
	return 0
}

// bicubicFilter — бикубический фильтр (a = -0.5, опора 2), которым масштабируются опоры и кадры
// сравнения.
func bicubicFilter(x float64) float64 {
	const a = -0.5
	if x < 0 {
		x = -x
	}
	if x < 1 {
		return ((a+2)*x-(a+3))*x*x + 1
	}
	if x < 2 {
		return (((x-5)*x+8)*x - 4) * a
	}
	return 0
}

// resampleFilter — фильтр ресэмплинга: опора (support) и функция окна.
type resampleFilter struct {
	support float64
	weight  func(float64) float64
}

var (
	lanczos = resampleFilter{3, lanczosFilter}
	bicubic = resampleFilter{2, bicubicFilter}
)

// resampleCoefficients рассчитывает и нормирует веса свёртки 8-битных каналов: для каждой выходной
// позиции первая входная позиция, число весов и целые веса (ksize на позицию).
func resampleCoefficients(inSize, outSize int, filter resampleFilter) (bounds []int, weights []int32, ksize int) {
	scale := float64(inSize) / float64(outSize)
	filterScale := scale
	if filterScale < 1 {
		filterScale = 1
	}
	support := filter.support * filterScale
	ksize = int(math.Ceil(support))*2 + 1
	bounds = make([]int, 2*outSize)
	weights = make([]int32, outSize*ksize)
	values := make([]float64, ksize)
	for out := 0; out < outSize; out++ {
		center := (float64(out) + 0.5) * scale
		inverse := 1 / filterScale
		minimum := int(center - support + 0.5)
		if minimum < 0 {
			minimum = 0
		}
		maximum := int(center + support + 0.5)
		if maximum > inSize {
			maximum = inSize
		}
		maximum -= minimum
		total := 0.0
		for x := 0; x < maximum; x++ {
			w := filter.weight((float64(x+minimum) - center + 0.5) * inverse)
			values[x] = w
			total += w
		}
		for x := 0; x < ksize; x++ {
			value := 0.0
			if x < maximum {
				value = values[x]
				if total != 0 {
					value /= total
				}
			}
			if value < 0 {
				weights[out*ksize+x] = int32(-0.5 + value*(1<<resamplePrecision))
			} else {
				weights[out*ksize+x] = int32(0.5 + value*(1<<resamplePrecision))
			}
		}
		bounds[2*out], bounds[2*out+1] = minimum, maximum
	}
	return bounds, weights, ksize
}

// clip8 — отсечение суммы свёртки: арифметический сдвиг на 22 дробных бита и предел 0..255.
func clip8(value int64) byte {
	shifted := value >> resamplePrecision
	if shifted < 0 {
		return 0
	}
	if shifted > 255 {
		return 255
	}
	return byte(shifted)
}

// resizeLanczos меняет размер RGB-изображения фильтром Ланцоша; тот же размер — копия.
func resizeLanczos(source rgbImage, width, height int) (rgbImage, error) {
	return resize(source, width, height, lanczos)
}

// resize меняет размер RGB-изображения фильтром filter за одну свёртку на ось (без
// предварительного уменьшения); тот же размер — копия.
func resize(source rgbImage, width, height int, filter resampleFilter) (rgbImage, error) {
	if width < 1 || height < 1 {
		return rgbImage{}, toolrt.New(toolrt.ValueError, "height and width must be > 0")
	}
	if width == source.width && height == source.height {
		return rgbImage{width: width, height: height, pix: append([]byte(nil), source.pix...)}, nil
	}
	current := source
	if width != source.width {
		bounds, weights, ksize := resampleCoefficients(source.width, width, filter)
		next := rgbImage{width: width, height: current.height, pix: make([]byte, 3*width*current.height)}
		for y := 0; y < current.height; y++ {
			row := current.pix[3*y*current.width:]
			for x := 0; x < width; x++ {
				start, count := bounds[2*x], bounds[2*x+1]
				k := weights[x*ksize:]
				var s0, s1, s2 int64 = 1 << (resamplePrecision - 1), 1 << (resamplePrecision - 1), 1 << (resamplePrecision - 1)
				for i := 0; i < count; i++ {
					p := 3 * (start + i)
					s0 += int64(row[p]) * int64(k[i])
					s1 += int64(row[p+1]) * int64(k[i])
					s2 += int64(row[p+2]) * int64(k[i])
				}
				o := 3 * (y*width + x)
				next.pix[o], next.pix[o+1], next.pix[o+2] = clip8(s0), clip8(s1), clip8(s2)
			}
		}
		current = next
	}
	if height != source.height {
		bounds, weights, ksize := resampleCoefficients(source.height, height, filter)
		next := rgbImage{width: current.width, height: height, pix: make([]byte, 3*current.width*height)}
		for y := 0; y < height; y++ {
			start, count := bounds[2*y], bounds[2*y+1]
			k := weights[y*ksize:]
			for x := 0; x < current.width; x++ {
				var s0, s1, s2 int64 = 1 << (resamplePrecision - 1), 1 << (resamplePrecision - 1), 1 << (resamplePrecision - 1)
				for i := 0; i < count; i++ {
					p := 3 * ((start+i)*current.width + x)
					s0 += int64(current.pix[p]) * int64(k[i])
					s1 += int64(current.pix[p+1]) * int64(k[i])
					s2 += int64(current.pix[p+2]) * int64(k[i])
				}
				o := 3 * (y*current.width + x)
				next.pix[o], next.pix[o+1], next.pix[o+2] = clip8(s0), clip8(s1), clip8(s2)
			}
		}
		current = next
	}
	return current, nil
}

// paste вставляет изображение в точку (x, y) без маски: прямоугольник копируется с отсечением по
// границам холста.
func (m rgbImage) paste(source rgbImage, x, y int) {
	for row := 0; row < source.height; row++ {
		ty := y + row
		if ty < 0 || ty >= m.height {
			continue
		}
		for column := 0; column < source.width; column++ {
			tx := x + column
			if tx < 0 || tx >= m.width {
				continue
			}
			copy(m.pix[3*(ty*m.width+tx):3*(ty*m.width+tx)+3], source.pix[3*(row*source.width+column):])
		}
	}
}
