package covergen

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	"image/png"
	"os"

	// Декодеры PNG, JPEG и WebP регистрирует mediafile.
	_ "songframe/internal/mediafile"
)

// textCropFailed — applicationTexts.coverCropFailed.
const textCropFailed = "Не удалось вырезать выбранную область обложки."

// decode — изображение, декодированное целиком; ошибка — файл не читается или не изображение.
func decode(path string) (image.Image, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	decoded, _, err := image.Decode(file)
	return decoded, err
}

// ReadImage — размеры изображения, которое декодируется целиком; пустое или нераспознанное
// изображение — false.
func ReadImage(path string) (width, height int, ok bool) {
	decoded, err := decode(path)
	if err != nil {
		return 0, 0, false
	}
	bounds := decoded.Bounds()
	return bounds.Dx(), bounds.Dy(), bounds.Dx() > 0 && bounds.Dy() > 0
}

// CropImage вырезает квадрат crop из input и пишет его PNG в output. Байты PNG зависят от
// кодировщика, поэтому принятая обложка проверяется по размерам, а не по SHA. Ошибка
// декодирования — coverCropFailed.
func CropImage(input, output string, crop Crop) error {
	decoded, err := decode(input)
	if err != nil {
		return errors.New(textCropFailed)
	}
	origin := decoded.Bounds().Min
	rect := image.Rect(int(crop.X), int(crop.Y), int(crop.X+crop.Size), int(crop.Y+crop.Size)).Add(origin)
	if !rect.In(decoded.Bounds()) || rect.Empty() {
		return errors.New(textCropFailed)
	}
	square := image.NewNRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(square, square.Bounds(), decoded, rect.Min, draw.Src)
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, square); err != nil {
		return errors.New(textCropFailed)
	}
	return os.WriteFile(output, buffer.Bytes(), 0o666)
}
