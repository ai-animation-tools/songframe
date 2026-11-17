package scenario

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
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
	return ok && dynvalue.IsSafeInteger(value) && number >= 0
}

// RegistryStatus — статус реестра сцен проекта: проверяется только общий контракт
// реестра (версия, частота кадров проекта, коды и кадровые окна планов), художественную полноту оценивает страница
// сценария. Отсутствующий файл — missing, ошибка чтения и неверная структура — invalid.
func RegistryStatus(project string) Status {
	raw, err := os.ReadFile(filepath.Join(project, "plan", "scenes.json"))
	if errors.Is(err, os.ErrNotExist) {
		return StatusMissing
	}
	if err != nil {
		return StatusInvalid
	}
	registry, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(raw)))
	if err != nil || !dynvalue.IsRecord(registry) || !dynvalue.StrictEqual(dynvalue.Get(registry, "schema_version"), 1.0) ||
		!dynvalue.StrictEqual(dynvalue.Get(registry, "fps"), ExpectedFPS(project, registry)) {
		return StatusInvalid
	}
	scenes, ok := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	if !ok {
		return StatusInvalid
	}
	ids := map[string]bool{}
	for _, scene := range scenes {
		id, isString := dynvalue.Get(scene, "id").(string)
		if !dynvalue.IsRecord(scene) || !isString || !sceneID.MatchString(id) || ids[id] {
			return StatusInvalid
		}
		start, finish := dynvalue.Get(scene, "start_frame"), dynvalue.Get(scene, "end_frame_exclusive")
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
	if read.Damaged || read.Missing || !dynvalue.Truthy(read.Value) {
		return nil
	}
	return read.Value
}

// ValidateProjectScenes — scenario.validateScenes: проверка черновика сценария с кастингом и
// длительностью трека проекта без записи.
func ValidateProjectScenes(project string, data any) ([]string, error) {
	return ValidateScenes(data, readCastValue(project), ExpectedFPS(project, data), ProjectDuration(project))
}

// SaveScenes — сохранение сценария: части нормализуются (NormalizeTreatmentDraft: порядок,
// обрезка текстов, округление границ), карта references заменяется картой из кастинга (без
// кастинга остаётся из черновика), сценарий проверяется ValidateScenes и записывается в
// plan/scenes.json. Сценарий с планами записывается только без проблем. Сценарий из одних
// частей сохраняется черновиком: содержательные проблемы частей (стык, длительность, коды) запись
// не блокируют, их показывает проверка, а построение планов недоступно, пока они есть; неверная
// структура отклоняется. Отказ — ошибка с проблемами через пробел, файл не меняется.
// Возвращает записанный сценарий.
func SaveScenes(project string, data any) (*dynvalue.Object, error) {
	castValue := readCastValue(project)
	normalized := dynvalue.Spread(data)
	if treatment, err := NormalizeTreatmentDraft(TreatmentOf(data)); err == nil {
		normalized.Set("logline", treatment.Value("logline"))
		normalized.Set("sequences", treatment.Value("sequences"))
	}
	scenes, _ := dynvalue.AsArray(normalized.Value("scenes"))
	// Карта references нужна планам; у сценария из одних частей её нет, пока планы не построены.
	if len(scenes) > 0 || normalized.Value("references") != dynvalue.Undefined {
		if castValue != nil {
			references, err := cast.References(castValue)
			if err != nil {
				return nil, err
			}
			normalized.Set("references", references)
		} else {
			normalized.Set("references", dynvalue.Get(data, "references"))
		}
	}
	problems, err := ValidateScenes(normalized, castValue, ExpectedFPS(project, normalized), ProjectDuration(project))
	if err != nil {
		return nil, err
	}
	// Черновик частей: отклоняется только структура, которую не прочитать как сценарий.
	if len(scenes) == 0 && len(problems) > 0 && !structural(problems[0], ExpectedFPS(project, normalized)) {
		problems = nil
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, " "))
	}
	if err := WriteDocument(project, "plan/scenes.json", normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

// structural — проблема ValidateScenes о форме сценария, а не о содержании частей: такой
// сценарий не сохраняется и черновиком.
func structural(problem string, fps float64) bool {
	return problem == textRegistryRequiresScenes(fps) || problem == textPartsInvalidDoc || problem == textPartsInvalidPart
}
