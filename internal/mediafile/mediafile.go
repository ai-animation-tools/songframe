// Package mediafile — проверки файлов медиа, общие для слоя провайдеров (оригиналы платного
// провайдера, опоры провайдера-агента, референсы обложки) и производства:
//
//   - формат и размеры изображения по байтам, без перекодирования и переименования — перенос
//     imageDimensions, imageExtensionMatches и isImageFile из src/main/keyframe-images.ts
//     оригинала. Поддерживаются PNG, JPEG и WebP (VP8X, VP8, VP8L) с теми же заголовками и
//     маркерами; повреждённый или иной файл даёт «не изображение», а не ошибку;
//   - LocalFile — localFile из src/main/media-providers.ts: файл попытки или референс только
//     как обычный файл внутри своей папки, без символических ссылок.
package mediafile

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	_ "golang.org/x/image/webp"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaapi"
)

var pngSignature = []byte{137, 80, 78, 71, 13, 10, 26, 10}

// sofMarkers — маркеры JPEG с размерами кадра (SOF0–SOF15 без DHT, JPG и DAC).
var sofMarkers = []byte{192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207}

// read — байты обычного файла. Как existsSync+lstatSync оригинала: символическая ссылка — «не
// файл», потому что lstat по ней не следует.
func read(path string) ([]byte, bool) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, false
	}
	data, err := os.ReadFile(path)
	return data, err == nil
}

// ExtensionMatches сообщает, что расширение файла соответствует фактическому формату: .png для
// PNG, .jpg/.jpeg для JPEG, .webp для WebP. Иные форматы и отсутствующий файл — false.
func ExtensionMatches(path string) bool {
	data, ok := read(path)
	if !ok {
		return false
	}
	suffix := strings.ToLower(filepath.Ext(path))
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], pngSignature):
		return suffix == ".png"
	case len(data) >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255:
		return suffix == ".jpg" || suffix == ".jpeg"
	case len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return suffix == ".webp"
	}
	return false
}

// Dimensions — ширина и высота по заголовку фактического формата; ok=false — файл не читается
// как изображение (или размер нулевой).
func Dimensions(path string) (width, height int, ok bool) {
	data, readable := read(path)
	if !readable {
		return 0, 0, false
	}
	width, height = dimensions(data)
	return width, height, width > 0 && height > 0
}

// dimensions разбирает заголовок PNG, JPEG или WebP; 0×0 — формат не распознан.
func dimensions(data []byte) (int, int) {
	switch {
	case len(data) > 24 && bytes.Equal(data[:8], pngSignature):
		return int(binary.BigEndian.Uint32(data[16:20])), int(binary.BigEndian.Uint32(data[20:24]))
	case len(data) > 3 && data[0] == 255 && data[1] == 216:
		for offset := 2; offset+4 <= len(data); {
			if data[offset] != 255 {
				break
			}
			marker := data[offset+1]
			if marker == 217 || marker == 218 {
				break
			}
			length := int(binary.BigEndian.Uint16(data[offset+2:]))
			if length < 2 || offset+2+length > len(data) {
				break
			}
			if slices.Contains(sofMarkers, marker) && length >= 7 {
				return int(binary.BigEndian.Uint16(data[offset+7:])), int(binary.BigEndian.Uint16(data[offset+5:]))
			}
			offset += length + 2
		}
	case len(data) >= 25 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		switch string(data[12:16]) {
		case "VP8X":
			if len(data) >= 30 {
				return uint24(data[24:]) + 1, uint24(data[27:]) + 1
			}
		case "VP8 ":
			if len(data) >= 30 && bytes.Equal(data[23:26], []byte{157, 1, 42}) {
				return int(binary.LittleEndian.Uint16(data[26:]) & 0x3fff), int(binary.LittleEndian.Uint16(data[28:]) & 0x3fff)
			}
		case "VP8L":
			if data[20] == 47 {
				bits := binary.LittleEndian.Uint32(data[21:])
				return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1
			}
		}
	}
	return 0, 0
}

// uint24 — беззнаковое 24-битное число little-endian (readUIntLE(offset, 3)).
func uint24(data []byte) int { return int(data[0]) | int(data[1])<<8 | int(data[2])<<16 }

// IsImage — файл читается как изображение с ненулевыми размерами.
func IsImage(path string) bool {
	_, _, ok := Dimensions(path)
	return ok
}

// TextLocalFileRequired — mediaTexts.localFileRequired оригинала.
const TextLocalFileRequired = "Нужен локальный файл внутри рабочей папки."

// LocalFile — path.resolve(directory, path) при условии, что это обычный файл внутри directory
// (после разыменования ссылок у папки и файла), а сам путь — не символическая ссылка. Нарушение —
// ошибка TextLocalFileRequired; отсутствующий файл или папка — ошибка node:fs realpath/lstat, как
// у оригинала.
func LocalFile(directory, path string) (string, error) {
	file := jscompat.Resolve(directory, path)
	root, err := jscompat.Realpath(directory)
	if err != nil {
		return "", err
	}
	target, err := jscompat.Realpath(file)
	if err != nil {
		return "", err
	}
	inside := jscompat.Relative(root, target)
	separator := "/"
	if runtime.GOOS == "windows" {
		separator = "\\"
	}
	if jscompat.IsAbs(inside) || inside == ".." || strings.HasPrefix(inside, ".."+separator) {
		return "", errors.New(TextLocalFileRequired)
	}
	info, err := os.Lstat(file)
	if err != nil {
		return "", jscompat.FsError("lstat", file, err)
	}
	if !info.Mode().IsRegular() {
		return "", errors.New(TextLocalFileRequired)
	}
	return file, nil
}

// Тексты отказа закреплённых опор (referenceGenerationMessages оригинала).
const (
	TextReferenceInputsChanged = "Опорные изображения изменились. Подготовьте новый запрос изображения."
	TextReferenceInputsInvalid = "Не удалось прочитать опорные изображения. Проверьте файлы объекта."
)

// CheckedReferences — checkedCoverReferences оригинала: каждая закреплённая копия опоры — обычный
// файл изображения с расширением своего формата и теми же размером и SHA-256, что при
// согласовании. Изменённые байты — TextReferenceInputsChanged, иное — TextReferenceInputsInvalid.
// Возвращает копию списка; исходники не меняются.
func CheckedReferences(references []mediaapi.ReferenceImage) ([]mediaapi.ReferenceImage, error) {
	result := make([]mediaapi.ReferenceImage, 0, len(references))
	for _, image := range references {
		info, err := os.Lstat(image.Path)
		if err != nil || !info.Mode().IsRegular() || !IsImage(image.Path) || !ExtensionMatches(image.Path) {
			return nil, errors.New(TextReferenceInputsInvalid)
		}
		data, err := os.ReadFile(image.Path)
		if err != nil {
			return nil, errors.New(TextReferenceInputsInvalid)
		}
		sum := sha256.Sum256(data)
		if int64(len(data)) != image.Bytes || hex.EncodeToString(sum[:]) != image.SHA256 {
			return nil, errors.New(TextReferenceInputsChanged)
		}
		result = append(result, image)
	}
	return result, nil
}

// Decodes — изображение декодируется целиком (PNG, JPEG, WebP): замена проверки
// nativeImage.createFromPath(path).isEmpty() оригинала для оригиналов платного провайдера.
// Обрезанный файл с верным заголовком декодирование не проходит.
func Decodes(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	_, _, err = image.Decode(file)
	return err == nil
}
