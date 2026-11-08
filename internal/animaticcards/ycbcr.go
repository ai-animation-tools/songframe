package animaticcards

import "image"

// Перевод YCbCr в RGB так, как это делают декодеры Pillow: libjpeg-turbo для JPEG и libwebp для
// WebP с потерями. Стандартные декодеры Go отдают те же плоскости Y/Cb/Cr, но image/color
// растягивает цветоразностные каналы повтором отсчёта и считает WebP полным диапазоном JFIF,
// а libwebp — ограниченным BT.601: без этого пересчёта WebP-референс выглядел бы бледнее. Обратное
// DCT остаётся декодера Go, поэтому JPEG отличается от Pillow на единицы уровня.

// planeAt — отсчёт плоскости по её координатам.
func planeAt(plane []byte, stride, x, y int) int { return int(plane[y*stride+x]) }

// chromaSize — размер цветоразностной плоскости (downsampled_width/height libjpeg).
func chromaSize(m *image.YCbCr) (int, int, int, int) {
	width, height := m.Rect.Dx(), m.Rect.Dy()
	switch m.SubsampleRatio {
	case image.YCbCrSubsampleRatio420:
		return (width + 1) / 2, (height + 1) / 2, 2, 2
	case image.YCbCrSubsampleRatio422:
		return (width + 1) / 2, height, 2, 1
	case image.YCbCrSubsampleRatio440:
		return width, (height + 1) / 2, 1, 2
	case image.YCbCrSubsampleRatio411:
		return (width + 3) / 4, height, 4, 1
	case image.YCbCrSubsampleRatio410:
		return (width + 3) / 4, (height + 1) / 2, 4, 2
	}
	return width, height, 1, 1
}

// upsampleJPEG — цветоразностная плоскость в полном разрешении по правилам libjpeg-turbo
// (jdsample.c): h2v2 и h2v1 — «fancy» треугольная интерполяция с округлением +8/+7 и +1/+2,
// у краёв изображения соседний ряд/столбец повторяет крайний; прочие прорежения — повтор
// отсчёта (int_upsample).
func upsampleJPEG(m *image.YCbCr, plane []byte) []int {
	width, height := m.Rect.Dx(), m.Rect.Dy()
	cw, ch, hs, vs := chromaSize(m)
	out := make([]int, width*height)
	put := func(x, y, value int) {
		if x < width && y < height {
			out[y*width+x] = value
		}
	}
	at := func(x, y int) int { return planeAt(plane, m.CStride, x, y) }
	switch {
	case hs == 2 && vs == 2 && cw >= 2:
		for row := 0; row < ch; row++ {
			for v := 0; v < 2; v++ {
				other := row - 1
				if v == 1 {
					other = row + 1
				}
				other = max(0, min(ch-1, other))
				sum := func(x int) int { return at(x, row)*3 + at(x, other) }
				y := 2*row + v
				this, next := sum(0), sum(1)
				put(0, y, (this*4+8)>>4)
				put(1, y, (this*3+next+7)>>4)
				last := this
				this = next
				for column := 1; column < cw-1; column++ {
					next = sum(column + 1)
					put(2*column, y, (this*3+last+8)>>4)
					put(2*column+1, y, (this*3+next+7)>>4)
					last, this = this, next
				}
				put(2*(cw-1), y, (this*3+last+8)>>4)
				put(2*(cw-1)+1, y, (this*4+7)>>4)
			}
		}
	case hs == 2 && vs == 1 && cw >= 2:
		for y := 0; y < ch; y++ {
			first := at(0, y)
			put(0, y, first)
			put(1, y, (first*3+at(1, y)+2)>>2)
			for column := 1; column < cw-1; column++ {
				value := at(column, y) * 3
				put(2*column, y, (value+at(column-1, y)+1)>>2)
				put(2*column+1, y, (value+at(column+1, y)+2)>>2)
			}
			last := at(cw-1, y)
			put(2*(cw-1), y, (last*3+at(cw-2, y)+1)>>2)
			put(2*(cw-1)+1, y, last)
		}
	default:
		for y := 0; y < height; y++ {
			for x := 0; x < width; x++ {
				out[y*width+x] = at(min(x/hs, cw-1), min(y/vs, ch-1))
			}
		}
	}
	return out
}

// jpegRGB — ycc_rgb_convert libjpeg: таблицы с 16 дробными битами, ONE_HALF и сдвиг вправо.
func jpegRGB(y, cb, cr int) (byte, byte, byte) {
	const scale = 16
	const half = 1 << (scale - 1)
	fix := func(x float64) int64 { return int64(x*(1<<scale) + 0.5) }
	xcb, xcr := int64(cb-128), int64(cr-128)
	r := y + int((fix(1.40200)*xcr+half)>>scale)
	g := y + int(((-fix(0.34414))*xcb+half+(-fix(0.71414))*xcr)>>scale)
	b := y + int((fix(1.77200)*xcb+half)>>scale)
	return byte(clamp255(r)), byte(clamp255(g)), byte(clamp255(b))
}

// jpegToRGB — JPEG YCbCr как convert("RGB") Pillow поверх libjpeg-turbo.
func jpegToRGB(m *image.YCbCr) rgbImage {
	width, height := m.Rect.Dx(), m.Rect.Dy()
	cb, cr := upsampleJPEG(m, m.Cb), upsampleJPEG(m, m.Cr)
	result := rgbImage{width: width, height: height, pix: make([]byte, 3*width*height)}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			luma := int(m.Y[y*m.YStride+x])
			r, g, b := jpegRGB(luma, cb[y*width+x], cr[y*width+x])
			offset := 3 * (y*width + x)
			result.pix[offset], result.pix[offset+1], result.pix[offset+2] = r, g, b
		}
	}
	return result
}

// webpPixel — VP8YUVToR/G/B libwebp (yuv.h): ограниченный диапазон BT.601 с 14-битной
// арифметикой MultHi и отсечением VP8Clip8.
func webpPixel(y, u, v int) (byte, byte, byte) {
	multHi := func(value, coeff int) int { return (value * coeff) >> 8 }
	clip := func(value int) byte {
		const mask = (256 << 6) - 1
		if value&^mask == 0 {
			return byte(value >> 6)
		}
		if value < 0 {
			return 0
		}
		return 255
	}
	return clip(multHi(y, 19077) + multHi(v, 26149) - 14234),
		clip(multHi(y, 19077) - multHi(u, 6419) - multHi(v, 13320) + 8708),
		clip(multHi(y, 19077) + multHi(u, 33050) - 17685)
}

// webpToRGB — WebP с потерями (4:2:0) как WebPDecode с «fancy upsampling» (upsampling.c):
// ряд яркости 2k-1 и 2k интерполируются между рядами цветности k-1 и k по диагоналям с
// весами 9:3:3:1, первый и последний ряды — по одному ряду цветности.
func webpToRGB(m *image.YCbCr) rgbImage {
	width, height := m.Rect.Dx(), m.Rect.Dy()
	result := rgbImage{width: width, height: height, pix: make([]byte, 3*width*height)}
	uvAt := func(row, x int) uint32 {
		return uint32(m.Cb[row*m.CStride+x]) | uint32(m.Cr[row*m.CStride+x])<<16
	}
	emit := func(y, x int, uv uint32) {
		r, g, b := webpPixel(int(m.Y[y*m.YStride+x]), int(uv&0xff), int((uv>>16)&0xff))
		offset := 3 * (y*width + x)
		result.pix[offset], result.pix[offset+1], result.pix[offset+2] = r, g, b
	}
	// upsample — UPSAMPLE_FUNC для пары рядов яркости top/bottom (bottom < 0 — нет).
	upsample := func(top, bottom, topUV, curUV int) {
		lastPair := (width - 1) >> 1
		tl, l := uvAt(topUV, 0), uvAt(curUV, 0)
		emit(top, 0, (3*tl+l+0x00020002)>>2)
		if bottom >= 0 {
			emit(bottom, 0, (3*l+tl+0x00020002)>>2)
		}
		for x := 1; x <= lastPair; x++ {
			t, uv := uvAt(topUV, x), uvAt(curUV, x)
			avg := tl + t + l + uv + 0x00080008
			diag12 := (avg + 2*(t+l)) >> 3
			diag03 := (avg + 2*(tl+uv)) >> 3
			emit(top, 2*x-1, ((diag12+tl)>>1)&0x00ff00ff)
			if 2*x < width {
				emit(top, 2*x, ((diag03+t)>>1)&0x00ff00ff)
			}
			if bottom >= 0 {
				emit(bottom, 2*x-1, ((diag03+l)>>1)&0x00ff00ff)
				if 2*x < width {
					emit(bottom, 2*x, ((diag12+uv)>>1)&0x00ff00ff)
				}
			}
			tl, l = t, uv
		}
		if width&1 == 0 {
			emit(top, width-1, (3*tl+l+0x00020002)>>2)
			if bottom >= 0 {
				emit(bottom, width-1, (3*l+tl+0x00020002)>>2)
			}
		}
	}
	upsample(0, -1, 0, 0)
	for row := 1; 2*row-1 < height; row++ {
		bottom := 2 * row
		cur := row
		if bottom >= height {
			bottom = -1
			cur = row - 1
		}
		upsample(2*row-1, bottom, row-1, cur)
	}
	return result
}
