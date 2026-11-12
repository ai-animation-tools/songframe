package projectfile

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"slices"
)

// FrameRates — допустимые частоты кадров проекта (кадров в секунду). Частота выбирается при
// создании проекта и дальше не меняется: на ней построены кадровые границы планов, монтаж,
// приёмка и экспорт.
var FrameRates = []int{24, 25, 30}

// DefaultFrameRate — частота нового проекта, если форма её не указала.
const DefaultFrameRate = 30

// ValidFrameRate — fps входит в FrameRates.
func ValidFrameRate(fps int) bool { return slices.Contains(FrameRates, fps) }

// FrameRateInvalid — текст ошибки поля fps маркера.
const FrameRateInvalid = "plan/project.json: fps должен быть 24, 25 или 30 кадров/с."

// FrameRate — частота кадров проекта из поля fps plan/project.json. Отсутствующее, дробное или
// неподдерживаемое значение — ошибка: частоту не угадывают, иначе расчёты кадров разошлись бы
// с уже записанными границами.
func FrameRate(project string) (int, error) {
	data, err := os.ReadFile(File(project))
	if err != nil {
		return 0, fmt.Errorf("Не удалось прочитать %s: %w", relativeFile, err)
	}
	var marker struct {
		FPS any `json:"fps"`
	}
	if err := json.Unmarshal(data, &marker); err != nil {
		return 0, errors.New(FrameRateInvalid)
	}
	value, ok := marker.FPS.(float64)
	if !ok || value != math.Trunc(value) || value > 1000 || !ValidFrameRate(int(value)) {
		return 0, errors.New(FrameRateInvalid)
	}
	return int(value), nil
}

// FPS — частота кадров проекта числом для расчётов в модели dynvalue; 0, если plan/project.json
// её не задаёт: тогда сравнение с частотой реестра или монтажа не проходит.
func FPS(project string) float64 {
	fps, err := FrameRate(project)
	if err != nil {
		return 0
	}
	return float64(fps)
}

// ExpectedFPS — частота, которой обязан следовать реестр (или монтаж) проекта: частота проекта из
// plan/project.json, а в папке без действующего маркера (проверки реестра вне проекта) —
// собственная частота документа value, если она допустима. 0 — частота неизвестна.
func ExpectedFPS(project string, value any) float64 {
	if fps := FPS(project); fps != 0 {
		return fps
	}
	if number, ok := value.(float64); ok && number == float64(int(number)) && ValidFrameRate(int(number)) {
		return number
	}
	return 0
}
