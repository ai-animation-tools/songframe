package animaticcards

import (
	"image"
	"math"
	"strings"

	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"

	"songframe/internal/toolrt"
)

// Текстовые поля карточки: выбор кегля, перенос по словам и сокращение многоточием. Раскладка
// (кегль, строки, их координаты) совпадает с эталоном, потому что ширины строк считает
// face.length (см. shaping.go). Начертание глифов эталоном побайтно не фиксируется: контуры
// растеризуются без хинтинга растеризатором x/image/vector в целопиксельных позициях глифов,
// поэтому горизонтальные края штрихов не притянуты к сетке пикселей и выглядят чуть мягче, чем
// при TrueType-хинтинге (доли пикселя по вертикали).

// textLine — нарисованная строка: левый верхний угол (по восходящей линии шрифта) и текст.
type textLine struct {
	X, Y int
	Text string
}

// textCall — один вызов textBox для трассировки эталона (text_box): аргументы, выбранный кегль
// и строки.
type textCall struct {
	Text                      string
	X, Y, Width, Height, Size int
	Color                     string
	Bold                      bool
	Point                     int
	Lines                     []textLine
}

// splitWords делит текст на слова по любым пробельным символам toolrt.IsSpace; пустые слова
// отбрасываются.
func splitWords(text string) []string {
	return strings.FieldsFunc(text, toolrt.IsSpace)
}

// fits — помещается ли строка в ширину width: длина в 1/64 пикселя (сумма продвижений 26.6)
// сравнивается с width·64 точно, без округления.
func fits(f *face, text string, width int) bool {
	return f.length(text) <= width*64
}

// wrapped — жадный перенос по словам. Слово шире поля — AssertionError с самим словом: текст,
// который нельзя разбить, не рисуется.
func wrapped(f *face, text string, width int) ([]string, error) {
	lines := []string{""}
	for _, word := range splitWords(text) {
		candidate := toolrt.Strip(lines[len(lines)-1] + " " + word)
		if fits(f, candidate, width) {
			lines[len(lines)-1] = candidate
			continue
		}
		if !fits(f, word, width) {
			return nil, toolrt.New("AssertionError", word)
		}
		lines = append(lines, word)
	}
	return lines, nil
}

// shortened — первые count строк; последняя завершается «…», слова с конца убираются, пока
// строка с многоточием не поместится (может остаться одно «…»).
func shortened(f *face, lines []string, width, count int) []string {
	kept := append([]string(nil), lines[:count]...)
	words := splitWords(kept[len(kept)-1])
	for len(words) > 0 && !fits(f, strings.Join(words, " ")+"…", width) {
		words = words[:len(words)-1]
	}
	kept[len(kept)-1] = strings.Join(words, " ") + "…"
	return kept
}

// layoutTextBox — раскладка textBox без рисования: кегль от size вниз до 16, пока строки с
// интерлиньяжем point+7 не войдут по высоте; если не вошли и при 16 — сокращение многоточием
// до height/23 строк с округлением вниз (не меньше одной). Возвращает кегль, строки и шрифт для рисования.
func layoutTextBox(text string, width, height, size int, isBold bool) (int, []string, *face, error) {
	var (
		f       *face
		lines   []string
		leading int
		point   int
		err     error
	)
	for point = size; point > 15; point-- {
		if f, err = newFace(isBold, point); err != nil {
			return 0, nil, nil, err
		}
		if lines, err = wrapped(f, text, width); err != nil {
			return 0, nil, nil, err
		}
		leading = point + 7
		if len(lines)*leading <= height {
			return point, lines, f, nil
		}
	}
	// Если ни один кегль не подошёл, point остаётся последним значением диапазона (16).
	point++
	count := height / leading
	if count < 1 {
		count = 1
	}
	return point, shortened(f, lines, width, count), f, nil
}

// textBox рисует текстовое поле с подбором кегля и возвращает
// выбранный кегль. Нестроковый текст — AttributeError «ожидается строка» (текст зафиксирован эталоном).
func (c *card) textBox(value any, x, y, width, height, size int, color string, isBold bool) (int, error) {
	text, ok := value.(string)
	if !ok {
		return 0, toolrt.Raise(toolrt.AttributeError, "ожидается строка, получено: %s", toolrt.TypeName(value))
	}
	point, lines, f, err := layoutTextBox(text, width, height, size, isBold)
	if err != nil {
		return 0, err
	}
	call := textCall{Text: text, X: x, Y: y, Width: width, Height: height, Size: size, Color: color, Bold: isBold, Point: point}
	for index, line := range lines {
		top := y + index*(point+7)
		c.drawText(f, x, top, line, hexColor(color))
		call.Lines = append(call.Lines, textLine{X: x, Y: top, Text: line})
	}
	if c.trace != nil {
		c.trace.Texts = append(c.trace.Texts, call)
	}
	return point, nil
}

// drawText рисует строку line: базовая линия на ascent ниже y, каждый глиф — в целом пикселе
// PIXEL(pen) = (pen+32)>>6 своей позиции раскладки. Покрытия перекрывающихся глифов
// объединяются максимумом в общую маску строки, затем маска смешивается с холстом (blendMask).
func (c *card) drawText(f *face, x, y int, line string, ink [3]byte) {
	glyphs := f.shape(line)
	if len(glyphs) == 0 {
		return
	}
	baseline := float32(y + f.ascent())
	pen := 0
	type placed struct {
		segments sfnt.Segments
		ox, oy   float32
	}
	items := []placed{}
	bounds := image.Rectangle{}
	for _, glyph := range glyphs {
		if !glyph.hidden {
			segments, err := f.file.font.LoadGlyph(&f.buf, glyph.index, fixed.I(f.size), nil)
			if err == nil && len(segments) > 0 {
				ox := float32(x + (pen+32)>>6)
				box := segments.Bounds()
				rect := image.Rect(
					int(math.Floor(float64(ox)+float64(box.Min.X)/64)), int(math.Floor(float64(baseline)+float64(box.Min.Y)/64)),
					int(math.Ceil(float64(ox)+float64(box.Max.X)/64)), int(math.Ceil(float64(baseline)+float64(box.Max.Y)/64)),
				)
				bounds = bounds.Union(rect)
				items = append(items, placed{append(sfnt.Segments(nil), segments...), ox, baseline})
			}
		}
		pen += glyph.advance
	}
	if bounds.Empty() {
		return
	}
	mask := image.NewAlpha(bounds)
	rasterizer := vector.NewRasterizer(0, 0)
	for _, item := range items {
		box := item.segments.Bounds()
		left := int(math.Floor(float64(item.ox) + float64(box.Min.X)/64))
		top := int(math.Floor(float64(item.oy) + float64(box.Min.Y)/64))
		right := int(math.Ceil(float64(item.ox) + float64(box.Max.X)/64))
		bottom := int(math.Ceil(float64(item.oy) + float64(box.Max.Y)/64))
		rasterizer.Reset(right-left, bottom-top)
		dx, dy := item.ox-float32(left), item.oy-float32(top)
		point := func(p fixed.Point26_6) (float32, float32) {
			return dx + float32(p.X)/64, dy + float32(p.Y)/64
		}
		for _, segment := range item.segments {
			switch segment.Op {
			case sfnt.SegmentOpMoveTo:
				rasterizer.MoveTo(point(segment.Args[0]))
			case sfnt.SegmentOpLineTo:
				rasterizer.LineTo(point(segment.Args[0]))
			case sfnt.SegmentOpQuadTo:
				ax, ay := point(segment.Args[0])
				bx, by := point(segment.Args[1])
				rasterizer.QuadTo(ax, ay, bx, by)
			case sfnt.SegmentOpCubeTo:
				ax, ay := point(segment.Args[0])
				bx, by := point(segment.Args[1])
				cx, cy := point(segment.Args[2])
				rasterizer.CubeTo(ax, ay, bx, by, cx, cy)
			}
		}
		glyphMask := image.NewAlpha(image.Rect(0, 0, right-left, bottom-top))
		rasterizer.Draw(glyphMask, glyphMask.Bounds(), image.Opaque, image.Point{})
		for row := 0; row < glyphMask.Rect.Dy(); row++ {
			for column := 0; column < glyphMask.Rect.Dx(); column++ {
				value := glyphMask.Pix[row*glyphMask.Stride+column]
				offset := mask.PixOffset(left+column, top+row)
				if value > mask.Pix[offset] {
					mask.Pix[offset] = value
				}
			}
		}
	}
	c.img.blendMask(mask, ink)
}
