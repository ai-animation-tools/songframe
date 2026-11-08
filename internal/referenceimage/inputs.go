package referenceimage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/mediafile"
)

// InputImage — опора, явно выбранная пользователем: абсолютный путь, нейтральная подпись и, если
// renderer уже показывал номера опор, SHA-256 прочитанных тогда байтов (nil — поля нет).
type InputImage struct {
	Path   string  `json:"path"`
	Label  string  `json:"label"`
	SHA256 *string `json:"sha256,omitempty"`
}

// GenerationInput — ReferenceImageGenerationInput контракта: только явно выбранные опоры; видимый
// отредактированный промпт передаётся отдельной строкой. Images nil (поля нет или null) — неверный
// ввод.
type GenerationInput struct {
	Images []InputImage `json:"images"`
}

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Inspect — cover.inspect и referenceImages.inspect: читает
// выбранные опоры без создания сессии, сохраняя порядок и все повторы. Каждая опора — абсолютный
// путь без NUL, непустая подпись (обрезается), байты читаются, переданный SHA должен совпасть
// (иначе TextReferenceInputsChanged: видимые номера относятся к прочитанным байтам), формат
// изображения — с размерами и своим расширением. Любой другой отказ — TextReferenceInputsInvalid.
// Итог дополнительно проверяется mediafile.CheckedReferences (обычный файл, не ссылка).
func Inspect(input GenerationInput) ([]mediaapi.ReferenceImage, error) {
	if input.Images == nil {
		return nil, errors.New(mediafile.TextReferenceInputsInvalid)
	}
	images := make([]mediaapi.ReferenceImage, 0, len(input.Images))
	for _, image := range input.Images {
		if !jscompat.IsAbs(image.Path) || strings.ContainsRune(image.Path, 0) || jscompat.Trim(image.Label) == "" ||
			strings.ContainsRune(image.Label, 0) || (image.SHA256 != nil && !sha256Pattern.MatchString(*image.SHA256)) {
			return nil, errors.New(mediafile.TextReferenceInputsInvalid)
		}
		data, err := os.ReadFile(image.Path)
		if err != nil {
			return nil, errors.New(mediafile.TextReferenceInputsInvalid)
		}
		sum := sha256.Sum256(data)
		digest := hex.EncodeToString(sum[:])
		if image.SHA256 != nil && *image.SHA256 != digest {
			return nil, errors.New(mediafile.TextReferenceInputsChanged)
		}
		if !mediafile.ExtensionMatches(image.Path) || !mediafile.IsImage(image.Path) {
			return nil, errors.New(mediafile.TextReferenceInputsInvalid)
		}
		images = append(images, mediaapi.ReferenceImage{Path: image.Path, Label: jscompat.Trim(image.Label), SHA256: digest, Bytes: int64(len(data))})
	}
	return mediafile.CheckedReferences(images)
}

// Inputs — опоры сессии. Одинаковые байты отправляются один раз, а их
// нейтральные подписи объединяются через « · » без повторов; порядок — по первому появлению.
// nil — опор нет.
func Inputs(input *GenerationInput) ([]mediaapi.ReferenceImage, error) {
	if input == nil {
		input = &GenerationInput{Images: []InputImage{}}
	}
	inspected, err := Inspect(*input)
	if err != nil {
		return nil, err
	}
	result := []mediaapi.ReferenceImage{}
	positions := map[string]int{}
	for _, image := range inspected {
		if index, seen := positions[image.SHA256]; seen {
			previous := &result[index]
			if !containsLabel(strings.Split(previous.Label, " · "), image.Label) {
				previous.Label += " · " + image.Label
			}
			continue
		}
		positions[image.SHA256] = len(result)
		result = append(result, image)
	}
	return result, nil
}

// containsLabel — includes для списка подписей.
func containsLabel(labels []string, label string) bool {
	for _, item := range labels {
		if item == label {
			return true
		}
	}
	return false
}
