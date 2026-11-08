package scenario

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
)

// writeFile — запись документа сценария. Оригинал писал treatment.json и scenes.json через
// writeFileSync поверх файла; здесь замена атомарная (сбой не оставляет обрезанный JSON), а права
// повторяют writeFileSync: существующий файл сохраняет свои, новый создаётся 0666 с umask.
// Переменная — точка подмены для тестов сбоя.
var writeFile = func(path string, data []byte) error {
	perm := os.FileMode(0o666)
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	return projectfs.WriteFile(path, data, perm)
}

// Encode — байты файла: JSON.stringify(value, null, 2) и перевод строки.
func Encode(value any) []byte { return []byte(jscompat.StringifyIndent(value, "  ") + "\n") }

// round — Math.round(value * 1000) / 1000: половина округляется к +∞.
func round(value float64) float64 {
	scaled := value * 1000
	result := math.Floor(scaled)
	if scaled-result >= 0.5 {
		result++
	}
	return result / 1000
}

// sortByStart — `[...parts].sort((a, b) => a.start - b.start)`: устойчивая сортировка, как
// Array.prototype.sort V8, по уже проверенным конечным числам.
func sortByStart(parts []any) []any {
	sorted := append([]any(nil), parts...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return jscompat.ToNumber(jscompat.Get(sorted[i], "start"))-jscompat.ToNumber(jscompat.Get(sorted[j], "start")) < 0
	})
	return sorted
}

// ValidateTreatment — validateTreatment для документа, уже прошедшего проверку типов
// NormalizeTreatment: коды, названия, стык частей с допуском 0.06 с и конец по длительности
// трека. duration — значение из View.Duration (число, null или иное значение как есть).
func ValidateTreatment(treatment *jscompat.Object, duration any) ([]string, error) {
	parts, ok := jscompat.AsArray(treatment.Value("sequences"))
	if !jscompat.StrictEqual(treatment.Value("schema_version"), 1.0) || !ok || len(parts) == 0 {
		return []string{textTreatmentRequiresParts}, nil
	}
	problems := []string{}
	ids := map[string]bool{}
	cursor := 0.0
	for _, item := range sortByStart(parts) {
		part := item.(*jscompat.Object)
		id := part.Value("id").(string)
		title := part.Value("title").(string)
		start := part.Value("start").(float64)
		end := part.Value("end").(float64)
		if !slug.MatchString(id) {
			label := title
			if label == "" {
				label = id
			}
			problems = append(problems, textPartCodeLatin(label))
		}
		if ids[id] {
			problems = append(problems, textDuplicatePartCode(id))
		}
		ids[id] = true
		if jscompat.Trim(title) == "" {
			problems = append(problems, textPartTitleMissing(id))
		}
		if math.Abs(start-cursor) > 0.06 {
			problems = append(problems, textPartStartMismatch(id, start, jscompat.ToFixed(cursor, 2)))
		}
		if end <= start {
			problems = append(problems, textPartEndsBeforeStart(id))
		}
		cursor = end
	}
	if jscompat.Truthy(duration) && math.Abs(cursor-jscompat.ToNumber(duration)) > 0.06 {
		seconds, isNumber := duration.(float64)
		if !isNumber {
			return nil, &jscompat.TypeError{Message: "duration.toFixed is not a function"}
		}
		problems = append(problems, textTreatmentDurationMismatch(jscompat.ToFixed(cursor, 2), jscompat.ToFixed(seconds, 2)))
	}
	return problems, nil
}

// finiteNumber — `typeof v === 'number' && Number.isFinite(v)`.
func finiteNumber(value any) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

// NormalizeTreatment — normalizeTreatment: строгая проверка типов (NormalizeTreatmentDraft), затем
// содержательная проверка ValidateTreatment; любая проблема отклоняет документ, и её текст —
// сообщения через пробел. Используется для ответа агента (этап 44), где принимается только
// готовая к построению сцен трактовка. Файлы не пишутся.
func NormalizeTreatment(value any, duration any) (*jscompat.Object, error) {
	normalized, err := NormalizeTreatmentDraft(value)
	if err != nil {
		return nil, err
	}
	problems, err := ValidateTreatment(normalized, duration)
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, errors.New(strings.Join(problems, " "))
	}
	return normalized, nil
}

// NormalizeTreatmentDraft — структурная часть normalizeTreatment: строгая проверка типов документа
// и частей, затем сортировка частей по началу, trim текстов, округление границ до миллисекунд и
// отбрасывание пустых кодов сущностей. Поля части сохраняются на своих местах; лишние поля
// документа отбрасываются (документ строится заново из schema_version, logline и sequences).
// Содержательные проблемы (коды, стык, длительность, пустой список частей) не проверяются:
// их даёт ValidateTreatment. Отличие от 634fd94: оригинал не разделял эти шаги, а редактор
// сохраняет трактовку черновиком (SaveTreatment), поэтому структурная проверка вынесена отдельно.
func NormalizeTreatmentDraft(value any) (*jscompat.Object, error) {
	document, ok := jscompat.AsObject(value)
	if !ok || !jscompat.StrictEqual(document.Value("schema_version"), 1.0) {
		return nil, errors.New(textTreatmentInvalidDoc)
	}
	logline, loglineOK := document.Value("logline").(string)
	parts, partsOK := jscompat.AsArray(document.Value("sequences"))
	if !loglineOK || !partsOK {
		return nil, errors.New(textTreatmentInvalidDoc)
	}
	for _, item := range parts {
		part, ok := jscompat.AsObject(item)
		valid := ok
		if valid {
			for _, key := range []string{"id", "title", "direction"} {
				if _, isString := part.Value(key).(string); !isString {
					valid = false
				}
			}
			entities, entitiesOK := jscompat.AsArray(part.Value("entities"))
			valid = valid && finiteNumber(part.Value("start")) && finiteNumber(part.Value("end")) && entitiesOK
			for _, entity := range entities {
				if _, isString := entity.(string); !isString {
					valid = false
				}
			}
			if lipsync := part.Value("lipsync"); lipsync != jscompat.Undefined {
				if _, isBool := lipsync.(bool); !isBool {
					valid = false
				}
			}
			if limit := part.Value("max_shot_seconds"); limit != jscompat.Undefined {
				if !finiteNumber(limit) || limit.(float64) <= 0 {
					valid = false
				}
			}
		}
		if !valid {
			return nil, errors.New(textTreatmentInvalidPart)
		}
	}
	sorted := sortByStart(parts)
	sequences := make([]any, len(sorted))
	for index, item := range sorted {
		part := jscompat.Spread(item)
		part.Set("title", jscompat.Trim(part.Value("title").(string)))
		part.Set("direction", jscompat.Trim(part.Value("direction").(string)))
		part.Set("start", round(part.Value("start").(float64)))
		part.Set("end", round(part.Value("end").(float64)))
		entities, _ := jscompat.AsArray(part.Value("entities"))
		kept := []any{}
		for _, entity := range entities {
			if entity.(string) != "" {
				kept = append(kept, entity)
			}
		}
		part.Set("entities", &jscompat.Array{Items: kept})
		sequences[index] = part
	}
	normalized := jscompat.NewObject()
	normalized.Set("schema_version", 1.0)
	normalized.Set("logline", jscompat.Trim(logline))
	normalized.Set("sequences", &jscompat.Array{Items: sequences})
	return normalized, nil
}

// projectDuration — длительность трека для проверки трактовки: View.Duration проекта (число, null
// или иное значение разметки как есть).
func projectDuration(project string) (any, error) {
	view, err := ViewProject(project)
	if err != nil {
		return nil, err
	}
	return jscompat.Parse(view.Duration)
}

// SaveTreatment — scenario.saveTreatment: структурная нормализация (NormalizeTreatmentDraft) и
// запись plan/treatment.json через шлюз записи. Отказ (неверная структура, шлюз, сбой записи) не
// меняет файл. Возвращает записанный документ.
//
// Отличие от 634fd94: оригинал отклонял сохранение при любой проблеме validateTreatment (стык,
// длительность, коды, пустой список частей). По просьбе пользователя редактор сохраняет черновик
// по частям: содержательные проблемы запись не блокируют, их показывает ValidateProjectTreatment,
// а построение каркаса сцен остаётся недоступным, пока они есть. Неверная структура по-прежнему
// отклоняется. Длительность проекта для записи не нужна, но ViewProject читается, как в
// оригинале: его исключение на документе другой формы по-прежнему отменяет сохранение.
func SaveTreatment(project string, input any) (*jscompat.Object, error) {
	if _, err := projectDuration(project); err != nil {
		return nil, err
	}
	normalized, err := NormalizeTreatmentDraft(input)
	if err != nil {
		return nil, err
	}
	if err := WriteDocument(project, "plan/treatment.json", normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

// ValidateProjectTreatment — scenario.validateTreatment: проблемы черновика трактовки по длительности
// трека проекта, без записи. Черновик сначала проходит ту же нормализацию, что и сохранение
// (сортировка, округление), поэтому список совпадает с проблемами файла после сохранения. Неверная
// структура — одна проблема с текстом отказа сохранения, а не ошибка: страница показывает её в
// том же списке. Ошибка — только исключение чтения проекта или длительность разметки другой формы.
// Отличие от 634fd94: в оригинале метода не было — проблемы приходили отказом saveTreatment.
func ValidateProjectTreatment(project string, input any) ([]string, error) {
	duration, err := projectDuration(project)
	if err != nil {
		return nil, err
	}
	normalized, err := NormalizeTreatmentDraft(input)
	if err != nil {
		return []string{err.Error()}, nil
	}
	return ValidateTreatment(normalized, duration)
}

// WriteDocument проверяет шлюз записи и заменяет документ сценария по пути внутри проекта.
func WriteDocument(project, relative string, value any) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return writeFile(filepath.Join(project, filepath.FromSlash(relative)), Encode(value))
}
