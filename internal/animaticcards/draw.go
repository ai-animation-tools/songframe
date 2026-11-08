package animaticcards

import (
	"bytes"
	"image"
	"image/png"
	"strconv"
)

// Примитивы рисования карточки: заливка прямоугольника, скруглённый прямоугольник поля
// референса, полупрозрачные полосы карточки опор (альфа-композиция поверх непрозрачного холста)
// и смешивание маски текста. Арифметика целочисленная, с фиксированными округлениями, поэтому
// фон, полосы и поля карточки совпадают с эталоном побайтно.

// hexColor — цвет «#RRGGBB» констант макета как три байта RGB.
func hexColor(text string) [3]byte {
	value, _ := strconv.ParseUint(text[1:], 16, 32)
	return [3]byte{byte(value >> 16), byte(value >> 8), byte(value)}
}

// fillRect заливает прямоугольник (x0, y0)–(x1, y1): обе границы включительно, с отсечением.
func (m rgbImage) fillRect(x0, y0, x1, y1 int, fill [3]byte) {
	for y := max(y0, 0); y <= min(y1, m.height-1); y++ {
		for x := max(x0, 0); x <= min(x1, m.width-1); x++ {
			copy(m.pix[3*(y*m.width+x):], fill[:])
		}
	}
}

// roundedInsets — отступ заливки от края в строках 0..6 от верхней и нижней границы для
// скруглённого прямоугольника с радиусом 9 (углы — четверти круга диаметром 18, все четыре
// угла симметричны; значения зафиксированы эталоном). Карточка рисует только такой
// прямоугольник, поэтому общая растеризация эллипса не нужна.
var roundedInsets = [...]int{7, 5, 3, 2, 2, 1, 1}

// fillRoundedRect9 заливает скруглённый прямоугольник (x0, y0)–(x1, y1) с радиусом углов 9.
func (m rgbImage) fillRoundedRect9(x0, y0, x1, y1 int, fill [3]byte) {
	for y := y0; y <= y1; y++ {
		inset := 0
		if row := y - y0; row < len(roundedInsets) {
			inset = roundedInsets[row]
		} else if row := y1 - y; row < len(roundedInsets) {
			inset = roundedInsets[row]
		}
		m.fillRect(x0+inset, y, x1-inset, y, fill)
	}
}

// shadeBand — полоса цвета (13, 18, 22) с альфой 190, наложенная альфа-композицией на
// непрозрачную карточку (строки y0..y1 включительно): коэффициенты с 7 дробными битами и деление
// на 255 сдвигами; альфа результата всегда 255 и в RGB-холст не попадает.
func (m rgbImage) shadeBand(y0, y1 int) {
	const precision = 7
	src := [3]uint32{13, 18, 22}
	const srcA = 190
	blend := uint32(255 * (255 - srcA))
	outA255 := srcA*255 + blend
	coef1 := uint32(srcA) * 255 * 255 * (1 << precision) / outA255
	coef2 := 255*(1<<precision) - coef1
	shift := func(a uint32) uint32 { return ((a >> 8) + a) >> 8 }
	for y := max(y0, 0); y <= min(y1, m.height-1); y++ {
		for x := 0; x < m.width; x++ {
			offset := 3 * (y*m.width + x)
			for channel := 0; channel < 3; channel++ {
				value := src[channel]*coef1 + uint32(m.pix[offset+channel])*coef2
				m.pix[offset+channel] = byte(shift(value+(0x80<<precision)) >> precision)
			}
		}
	}
}

// blendMask смешивает 8-битную маску покрытия с холстом цветом ink: канал = DIV255(фон·(255−a) +
// ink·a), где DIV255(v) = ((v+128)>>8 + v+128)>>8. Части маски вне холста отсекаются.
func (m rgbImage) blendMask(mask *image.Alpha, ink [3]byte) {
	bounds := mask.Rect.Intersect(image.Rect(0, 0, m.width, m.height))
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			alpha := int(mask.Pix[mask.PixOffset(x, y)])
			if alpha == 0 {
				continue
			}
			offset := 3 * (y*m.width + x)
			for channel := 0; channel < 3; channel++ {
				value := int(m.pix[offset+channel])*(255-alpha) + int(ink[channel])*alpha + 128
				m.pix[offset+channel] = byte(((value >> 8) + value) >> 8)
			}
		}
	}
}

// encodePNG кодирует холст в PNG. Пиксели совпадают с эталоном там, где совпадает
// растеризация, но сжатие compress/flate эталоном не фиксируется, поэтому байты файла другие.
func (m rgbImage) encodePNG() ([]byte, error) {
	rgba := image.NewRGBA(image.Rect(0, 0, m.width, m.height))
	for index := 0; index < m.width*m.height; index++ {
		copy(rgba.Pix[4*index:4*index+3], m.pix[3*index:3*index+3])
		rgba.Pix[4*index+3] = 255
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, rgba); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
