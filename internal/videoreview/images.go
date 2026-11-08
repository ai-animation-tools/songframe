package videoreview

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"

	"songframe/internal/toolrt"
)

// Подготовка копий изображений: опоры с EXIF-ориентацией и уменьшением, упаковка в бюджет.
// Пиксели обрабатывает FFmpeg (lanczos, RGB24), а JPEG кодирует стандартная библиотека Go по
// шкале качества IJG. Размеры, порядок и правила выбора качества зафиксированы эталоном
// video-review-frames; копии опор и переупакованные JPEG эталон сверяет по размерам и среднему
// цвету ячеек, байты кадров в пределах бюджета — побайтно (их пишет FFmpeg).

// reviewSide — наибольшая сторона копий (960×960 без увеличения).
const reviewSide = 960

// thumbnailSize — размер копии, вписанной в рамку boxW×boxH без увеличения: пропорции
// сохраняются, изменяемая сторона — ближайшее к исходному отношению сторон целое (floor или ceil,
// при равенстве floor, не меньше 1). ok=false — изображение уже помещается в рамку и не меняется.
func thumbnailSize(width, height, boxW, boxH int) (int, int, bool) {
	if boxW >= width && boxH >= height {
		return width, height, false
	}
	aspect := float64(width) / float64(height)
	x, y := boxW, boxH
	// roundAspect — floor или ceil value с меньшим key (при равенстве floor), не меньше 1.
	roundAspect := func(value float64, key func(n float64) float64) int {
		floor, ceil := math.Floor(value), math.Ceil(value)
		chosen := floor
		if key(ceil) < key(floor) {
			chosen = ceil
		}
		return max(int(chosen), 1)
	}
	if float64(x)/float64(y) >= aspect {
		x = roundAspect(float64(y)*aspect, func(n float64) float64 { return math.Abs(aspect - n/float64(y)) })
	} else {
		y = roundAspect(float64(x)/aspect, func(n float64) float64 {
			if n == 0 {
				return 0
			}
			return math.Abs(aspect - float64(x)/n)
		})
	}
	return x, y, true
}

// orientationFilter — фильтр FFmpeg для EXIF-ориентации: 2 — зеркало, 3 — 180°,
// 4 — вертикальное зеркало, 5 — транспонирование, 6 — 90° по часовой, 7 — поперечное
// транспонирование, 8 — 90° против часовой. swap — стороны меняются местами.
func orientationFilter(orientation int) (string, bool) {
	switch orientation {
	case 2:
		return "hflip", false
	case 3:
		return "hflip,vflip", false
	case 4:
		return "vflip", false
	case 5:
		return "transpose=cclock_flip", true
	case 6:
		return "transpose=clock", true
	case 7:
		return "transpose=clock_flip", true
	case 8:
		return "transpose=cclock", true
	}
	return "", false
}

// exifOrientation — тег Orientation (0x0112) EXIF изображения JPEG (APP1), PNG (eXIf) или WebP
// (чанк EXIF); 1, если тега нет или он неверен.
func exifOrientation(data []byte) int {
	var tiff []byte
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xd8}):
		for offset := 2; offset+4 <= len(data) && data[offset] == 0xff; {
			marker := data[offset+1]
			if marker == 0xda || marker == 0xd9 {
				break
			}
			length := int(binary.BigEndian.Uint16(data[offset+2:]))
			end := offset + 2 + length
			if length < 2 || end > len(data) {
				break
			}
			if segment := data[offset+4 : end]; marker == 0xe1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
				tiff = segment[6:]
				break
			}
			offset = end
		}
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		for offset := 8; offset+8 <= len(data); {
			length := int(binary.BigEndian.Uint32(data[offset:]))
			end := offset + 12 + length
			if length < 0 || end > len(data) {
				break
			}
			if string(data[offset+4:offset+8]) == "eXIf" {
				tiff = data[offset+8 : offset+8+length]
				break
			}
			offset = end
		}
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		for offset := 12; offset+8 <= len(data); {
			length := int(binary.LittleEndian.Uint32(data[offset+4:]))
			end := offset + 8 + length + length%2
			if offset+8+length > len(data) {
				break
			}
			if string(data[offset:offset+4]) == "EXIF" {
				tiff = bytes.TrimPrefix(data[offset+8:offset+8+length], []byte("Exif\x00\x00"))
				break
			}
			offset = end
		}
	}
	if len(tiff) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	ifd := int(order.Uint32(tiff[4:]))
	if ifd+2 > len(tiff) {
		return 1
	}
	count := int(order.Uint16(tiff[ifd:]))
	for index := 0; index < count; index++ {
		entry := ifd + 2 + index*12
		if entry+12 > len(tiff) {
			return 1
		}
		if order.Uint16(tiff[entry:]) == 0x0112 {
			value := int(order.Uint16(tiff[entry+8:]))
			if value >= 1 && value <= 8 {
				return value
			}
			return 1
		}
	}
	return 1
}

// imageSize — ширина и высота первого видеопотока изображения по ffprobe.
func (r *mediaRunner) imageSize(path string) (int, int, error) {
	output, err := r.run(r.tools.FFprobe, "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "json", path)
	if err != nil {
		return 0, 0, err
	}
	var info struct {
		Streams []map[string]any `json:"streams"`
	}
	if err := decodeJSON(output, &info); err != nil || len(info.Streams) == 0 {
		return 0, 0, fail("не удалось распознать изображение: " + toolrt.Repr(path))
	}
	width, okWidth := intOf(info.Streams[0]["width"])
	height, okHeight := intOf(info.Streams[0]["height"])
	if !okWidth || !okHeight || width <= 0 || height <= 0 {
		return 0, 0, fail("не удалось распознать изображение: " + toolrt.Repr(path))
	}
	return width, height, nil
}

// reference готовит копию опоры: EXIF-ориентация, RGB без альфы, уменьшение до 960×960 без
// увеличения, PNG. Источник только читается.
func (r *mediaRunner) reference(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return osError(err)
	}
	width, height, err := r.imageSize(source)
	if err != nil {
		if r.ctx.Err() != nil {
			return err
		}
		return fail("не удалось распознать изображение: " + toolrt.Repr(source))
	}
	filters := []string{"format=rgb24"}
	if filter, swap := orientationFilter(exifOrientation(data)); filter != "" {
		filters = append(filters, filter)
		if swap {
			width, height = height, width
		}
	}
	if w, h, resize := thumbnailSize(width, height, reviewSide, reviewSide); resize && (w != width || h != height) {
		filters = append(filters, fmt.Sprintf("scale=%d:%d:flags=lanczos+accurate_rnd+full_chroma_int", w, h))
	}
	_, err = r.run(r.tools.FFmpeg, "ffmpeg", "-v", "error", "-nostdin", "-n", "-protocol_whitelist", "file", "-noautorotate", "-i", source,
		"-map", "0:v:0", "-frames:v", "1", "-vf", strings.Join(filters, ","), "-pix_fmt", "rgb24", "-update", "1", target)
	return err
}

// resized — копия PNG path, уменьшенная FFmpeg (lanczos) до width×height, в памяти.
func (r *mediaRunner) resized(path string, width, height int) (image.Image, error) {
	output, err := r.run(r.tools.FFmpeg, "ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", path,
		"-frames:v", "1", "-vf", fmt.Sprintf("format=rgb24,scale=%d:%d:flags=lanczos+accurate_rnd+full_chroma_int", width, height),
		"-pix_fmt", "rgb24", "-f", "image2pipe", "-c:v", "png", "pipe:1")
	if err != nil {
		return nil, err
	}
	decoded, err := png.Decode(bytes.NewReader(output))
	if err != nil {
		return nil, fail(err.Error())
	}
	return decoded, nil
}

// budgetImages — упаковка в бюджет: упаковывает только приватные копии, сохраняя порядок
// и ID. Доля файла — min(perFile, total / число изображений). PNG в пределах доли не трогается
// (точные пиксели нужны для технических сверок). Крупный PNG переупаковывается в JPEG с качеством
// 85, затем 70 и 55; если не помогло, размеры уменьшаются на четверть с сохранением пропорций и
// попытки повторяются. Кадры и опоры не выбрасываются; исходный PNG удаляется только после записи
// его JPEG-копии. Возвращает фактические пути в исходном порядке.
func (r *mediaRunner) budgetImages(paths []string, total, perFile int) ([]string, error) {
	if len(paths) == 0 || total <= 0 || perFile <= 0 {
		return nil, fail(textBudgetRequired)
	}
	limit := min(perFile, total/len(paths))
	if limit <= 0 {
		return nil, fail(textBudgetTooSmall)
	}
	packed := make([]string, 0, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return nil, osError(err)
		}
		if info.Size() > 0 && info.Size() <= int64(limit) {
			packed = append(packed, path)
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, osError(err)
		}
		current, _, err := image.Decode(file)
		file.Close()
		if err != nil {
			return nil, fail("не удалось распознать изображение: " + toolrt.Repr(path))
		}
		for {
			var payload []byte
			for _, quality := range []int{85, 70, 55} {
				var buffer bytes.Buffer
				if err := jpeg.Encode(&buffer, current, &jpeg.Options{Quality: quality}); err != nil {
					return nil, fail(err.Error())
				}
				if buffer.Len() <= limit {
					payload = buffer.Bytes()
					break
				}
			}
			if payload != nil {
				target := strings.TrimSuffix(path, filepath.Ext(path)) + ".jpg"
				if err := os.WriteFile(target, payload, 0o666); err != nil {
					return nil, osError(err)
				}
				if err := os.Remove(path); err != nil {
					return nil, osError(err)
				}
				packed = append(packed, target)
				break
			}
			bounds := current.Bounds()
			width, height := bounds.Dx(), bounds.Dy()
			if width == 1 && height == 1 {
				return nil, fail(textBudgetMinimalJPEG)
			}
			w, h, resize := thumbnailSize(width, height, max(1, width*3/4), max(1, height*3/4))
			if !resize || (w == width && h == height) {
				return nil, fail(textBudgetMinimalJPEG)
			}
			if current, err = r.resized(path, w, h); err != nil {
				return nil, err
			}
		}
	}
	sum := int64(0)
	for _, path := range packed {
		info, err := os.Stat(path)
		if err != nil {
			return nil, osError(err)
		}
		if info.Size() <= 0 || info.Size() > int64(limit) {
			return nil, fail(textBudgetExceeded)
		}
		sum += info.Size()
	}
	if sum > int64(total) {
		return nil, fail(textBudgetExceeded)
	}
	return packed, nil
}
