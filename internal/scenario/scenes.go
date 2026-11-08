package scenario

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/cast"
	"songframe-go/internal/jscompat"
)

// Status — ScenarioStatus (frontend/src/shared/scenario-status.ts): готовность реестра для
// страниц, которые работают со сценами.
type Status string

// Значения Status.
const (
	StatusMissing Status = "missing"
	StatusEmpty   Status = "empty"
	StatusInvalid Status = "invalid"
	StatusReady   Status = "ready"
)

// isFrame — неотрицательное безопасное целое (граница плана в кадрах).
func isFrame(value any) bool {
	number, ok := value.(float64)
	return ok && jscompat.IsSafeInteger(value) && number >= 0
}

// RegistryStatus — статус реестра сцен проекта: проверяется только общий контракт
// реестра (версия, fps, коды и кадровые окна планов), художественную полноту оценивает страница
// сценария. Отсутствующий файл — missing, ошибка чтения и неверная структура — invalid.
func RegistryStatus(project string) Status {
	raw, err := os.ReadFile(filepath.Join(project, "plan", "scenes.json"))
	if errors.Is(err, os.ErrNotExist) {
		return StatusMissing
	}
	if err != nil {
		return StatusInvalid
	}
	registry, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(raw)))
	if err != nil || !jscompat.IsRecord(registry) || !jscompat.StrictEqual(jscompat.Get(registry, "schema_version"), 1.0) ||
		!jscompat.StrictEqual(jscompat.Get(registry, "fps"), float64(FPS)) {
		return StatusInvalid
	}
	scenes, ok := jscompat.AsArray(jscompat.Get(registry, "scenes"))
	if !ok {
		return StatusInvalid
	}
	ids := map[string]bool{}
	for _, scene := range scenes {
		id, isString := jscompat.Get(scene, "id").(string)
		if !jscompat.IsRecord(scene) || !isString || !sceneID.MatchString(id) || ids[id] {
			return StatusInvalid
		}
		start, finish := jscompat.Get(scene, "start_frame"), jscompat.Get(scene, "end_frame_exclusive")
		if !isFrame(start) || !isFrame(finish) || finish.(float64) <= start.(float64) {
			return StatusInvalid
		}
		ids[id] = true
	}
	if len(scenes) == 0 {
		return StatusEmpty
	}
	return StatusReady
}

// readCastValue — `readCast(project) || null`: повреждённый, отсутствующий и ложный кастинг — nil.
func readCastValue(project string) any {
	read := cast.Read(project)
	if read.Damaged || read.Missing || !jscompat.Truthy(read.Value) {
		return nil
	}
	return read.Value
}

// ValidateProjectScenes — scenario.validateScenes: проверка черновика с кастингом проекта без записи.
func ValidateProjectScenes(project string, data any) ([]string, error) {
	return ValidateScenes(data, readCastValue(project))
}

// SaveScenes — сохранение реестра: карта references заменяется картой из кастинга (без кастинга остаётся
// из черновика), реестр проверяется ValidateScenes и записывается в plan/scenes.json. Отказ —
// ошибка с проблемами через пробел, файл не меняется. Возвращает записанный реестр.
func SaveScenes(project string, data any) (*jscompat.Object, error) {
	castValue := readCastValue(project)
	normalized := jscompat.Spread(data)
	if castValue != nil {
		references, err := cast.References(castValue)
		if err != nil {
			return nil, err
		}
		normalized.Set("references", references)
	} else {
		normalized.Set("references", jscompat.Get(data, "references"))
	}
	problems, err := ValidateScenes(normalized, castValue)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, " "))
	}
	if err := WriteDocument(project, "plan/scenes.json", normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}
