package mediafile

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"os"

	"golang.org/x/image/draw"
)

// ShrinkJPEG — JPEG-копия изображения (PNG, JPEG, WebP), вписанная в квадрат side без увеличения.
// Так готовятся вложения агентам: оригиналы весят мегабайты, а бюджет вложений CLI агента ограничен
// (docs/agent-image-limits.md). Прозрачный фон PNG становится белым, как в интерфейсе.
func ShrinkJPEG(path string, side, quality int) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	source, _, err := image.Decode(file)
	if err != nil {
		return nil, err
	}
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil, errors.New("пустое изображение")
	}
	scale := min(1, float64(side)/float64(max(width, height)))
	target := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(width)*scale+0.5)), max(1, int(float64(height)*scale+0.5))))
	draw.Draw(target, target.Bounds(), image.White, image.Point{}, draw.Src)
	draw.CatmullRom.Scale(target, target.Bounds(), source, bounds, draw.Over, nil)
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, target, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
