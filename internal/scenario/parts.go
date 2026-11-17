package scenario

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
	"songframe/internal/sources"
)

// writeFile — запись документа сценария (scenes.json). Замена атомарная: сбой не
// оставляет обрезанный JSON. Существующий файл сохраняет свои права, новый создаётся 0666 с umask.
// Переменная — точка подмены для тестов сбоя.
var writeFile = func(path string, data []byte) error {
	perm := os.FileMode(0o666)
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	return projectfs.WriteFile(path, data, perm)
}

// Encode — байты файла: JSON с отступом в два пробела и перевод строки (формат эталонов).
func Encode(value any) []byte { return []byte(dynvalue.StringifyIndent(value, "  ") + "\n") }

// round — округление до тысячных: половина округляется к +∞.
func round(value float64) float64 {
	scaled := value * 1000
	result := math.Floor(scaled)
	if scaled-result >= 0.5 {
		result++
	}
	return result / 1000
}

// sortByStart — устойчивая сортировка частей по start (уже проверенные конечные числа); новая
// копия, вход не меняется.
func sortByStart(parts []any) []any {
	sorted := append([]any(nil), parts...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return dynvalue.ToNumber(dynvalue.Get(sorted[i], "start"))-dynvalue.ToNumber(dynvalue.Get(sorted[j], "start")) < 0
	})
	return sorted
}

// partCode — код части: строчная латиница, цифры и «_», первый знак — буква или цифра. Планы
// ссылаются на часть этим кодом (поле sequence), а проверка планов принимает и коды вида «02»,
// поэтому правило части не строже: иначе сценарий с такими кодами стал бы неверным, а
// переименование кода изменило бы постановку принятых планов.
var partCode = regexp.MustCompile(`^[a-z0-9][a-z0-9_]*$`)

// ValidateTreatment — содержательная проверка частей сценария (проекция TreatmentOf), уже
// прошедших проверку типов NormalizeTreatmentDraft: коды, названия, стык частей с допуском 0.06 с
// и конец по длительности трека. duration — ProjectDuration (число, null или иное значение как есть).
func ValidateTreatment(treatment *dynvalue.Object, duration any) ([]string, error) {
	parts, ok := dynvalue.AsArray(treatment.Value("sequences"))
	if !dynvalue.StrictEqual(treatment.Value("schema_version"), 1.0) || !ok || len(parts) == 0 {
		return []string{textPartsRequired}, nil
	}
	problems := []string{}
	ids := map[string]bool{}
	cursor := 0.0
	for _, item := range sortByStart(parts) {
		part := item.(*dynvalue.Object)
		id := part.Value("id").(string)
		title := part.Value("title").(string)
		start := part.Value("start").(float64)
		end := part.Value("end").(float64)
		if !partCode.MatchString(id) {
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
		if dynvalue.Trim(title) == "" {
			problems = append(problems, textPartTitleMissing(id))
		}
		if math.Abs(start-cursor) > 0.06 {
			problems = append(problems, textPartStartMismatch(id, start, dynvalue.ToFixed(cursor, 2)))
		}
		if end <= start {
			problems = append(problems, textPartEndsBeforeStart(id))
		}
		cursor = end
	}
	if dynvalue.Truthy(duration) && math.Abs(cursor-dynvalue.ToNumber(duration)) > 0.06 {
		seconds, isNumber := duration.(float64)
		if !isNumber {
			return nil, &dynvalue.TypeError{Message: "duration: ожидается число"}
		}
		problems = append(problems, textPartsDurationMismatch(dynvalue.ToFixed(cursor, 2), dynvalue.ToFixed(seconds, 2)))
	}
	return problems, nil
}

// finiteNumber — значение — конечное число.
func finiteNumber(value any) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

// NormalizeTreatment — строгая проверка типов (NormalizeTreatmentDraft), затем содержательная
// проверка ValidateTreatment; любая проблема отклоняет части, и её текст — сообщения через
// пробел. Используется для ответа агента первого прохода, где принимаются только части, готовые к
// построению планов. Файлы не пишутся.
func NormalizeTreatment(value any, duration any) (*dynvalue.Object, error) {
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

// NormalizeTreatmentDraft — структурная часть NormalizeTreatment: строгая проверка типов частей
// (проекция TreatmentOf или ответ агента), затем сортировка частей по началу, trim текстов,
// округление границ до миллисекунд и отбрасывание пустых кодов сущностей. Поля части сохраняются
// на своих местах; лишние поля проекции отбрасываются (она строится заново из schema_version,
// logline и sequences). Содержательные проблемы (коды, стык, длительность, пустой список частей)
// не проверяются: их даёт ValidateTreatment. Структурная проверка отделена, потому что сценарий
// без планов сохраняется черновиком (SaveScenes).
func NormalizeTreatmentDraft(value any) (*dynvalue.Object, error) {
	document, ok := dynvalue.AsObject(value)
	if !ok || !dynvalue.StrictEqual(document.Value("schema_version"), 1.0) {
		return nil, errors.New(textPartsInvalidDoc)
	}
	logline, loglineOK := document.Value("logline").(string)
	parts, partsOK := dynvalue.AsArray(document.Value("sequences"))
	if !loglineOK || !partsOK {
		return nil, errors.New(textPartsInvalidDoc)
	}
	for _, item := range parts {
		part, ok := dynvalue.AsObject(item)
		valid := ok
		if valid {
			for _, key := range []string{"id", "title", "direction"} {
				if _, isString := part.Value(key).(string); !isString {
					valid = false
				}
			}
			entities, entitiesOK := dynvalue.AsArray(part.Value("entities"))
			valid = valid && finiteNumber(part.Value("start")) && finiteNumber(part.Value("end")) && entitiesOK
			for _, entity := range entities {
				if _, isString := entity.(string); !isString {
					valid = false
				}
			}
			if lipsync := part.Value("lipsync"); lipsync != dynvalue.Undefined {
				if _, isBool := lipsync.(bool); !isBool {
					valid = false
				}
			}
			if limit := part.Value("max_shot_seconds"); limit != dynvalue.Undefined {
				if !finiteNumber(limit) || limit.(float64) <= 0 {
					valid = false
				}
			}
		}
		if !valid {
			return nil, errors.New(textPartsInvalidPart)
		}
	}
	sorted := sortByStart(parts)
	sequences := make([]any, len(sorted))
	for index, item := range sorted {
		part := dynvalue.Spread(item)
		part.Set("title", dynvalue.Trim(part.Value("title").(string)))
		part.Set("direction", dynvalue.Trim(part.Value("direction").(string)))
		part.Set("start", round(part.Value("start").(float64)))
		part.Set("end", round(part.Value("end").(float64)))
		entities, _ := dynvalue.AsArray(part.Value("entities"))
		kept := []any{}
		for _, entity := range entities {
			if entity.(string) != "" {
				kept = append(kept, entity)
			}
		}
		part.Set("entities", &dynvalue.Array{Items: kept})
		sequences[index] = part
	}
	normalized := dynvalue.NewObject()
	normalized.Set("schema_version", 1.0)
	normalized.Set("logline", dynvalue.Trim(logline))
	normalized.Set("sequences", &dynvalue.Array{Items: sequences})
	return normalized, nil
}

// ProjectDuration — длительность трека для проверки частей: duration_decoded разметки, затем
// длительность из описи, затем duration_container (как View.Duration); nil, если ничего нет.
// Значение берётся как есть: проверка частей сама отклоняет нечисловую длительность.
func ProjectDuration(project string) any {
	problems := []string{}
	timingDocument := readDocument(project, "plan/audio/timing.json", &problems)
	manifest := sources.ReadManifest(project)
	duration := dynvalue.Coalesce(dynvalue.Get(timingDocument, "duration_decoded"),
		dynvalue.Coalesce(dynvalue.GetPath(manifest, "track", "duration_seconds"),
			dynvalue.Coalesce(dynvalue.Get(timingDocument, "duration_container"), nil)))
	if duration == dynvalue.Undefined {
		return nil
	}
	return duration
}

// TreatmentOf — части сценария отдельным документом {schema_version, logline, sequences}: в таком
// виде их проверяет NormalizeTreatmentDraft, утверждает пара «кастинг и части», получает и
// возвращает агент первого прохода. nil для отсутствующего сценария. Поля берутся как есть: у
// сценария без logline проекция не пройдёт структурную проверку.
func TreatmentOf(scenes any) any {
	if scenes == nil {
		return nil
	}
	projection := dynvalue.NewObject()
	projection.Set("schema_version", dynvalue.Get(scenes, "schema_version"))
	projection.Set("logline", dynvalue.Get(scenes, "logline"))
	projection.Set("sequences", dynvalue.Get(scenes, "sequences"))
	return projection
}

// WithTreatment — сценарий с частями treatment (нормализованная проекция): logline и sequences
// заменяются, планы и общие правила остаются. Без сценария создаётся сценарий из одних частей
// с частотой проекта fps и пустым списком планов. Вход не меняется.
func WithTreatment(scenes any, treatment *dynvalue.Object, fps float64) *dynvalue.Object {
	if scenes == nil {
		result := dynvalue.NewObject()
		result.Set("schema_version", 1.0)
		result.Set("fps", fps)
		result.Set("logline", treatment.Value("logline"))
		result.Set("sequences", treatment.Value("sequences"))
		result.Set("scenes", &dynvalue.Array{Items: []any{}})
		return result
	}
	result := dynvalue.Spread(scenes)
	if result.Value("logline") == dynvalue.Undefined {
		// Логлайн стоит перед частями: так он читается в файле первым, как в новом сценарии.
		ordered := dynvalue.NewObject()
		for _, key := range result.Keys() {
			if key == "sequences" {
				ordered.Set("logline", treatment.Value("logline"))
			}
			ordered.Set(key, result.Value(key))
		}
		result = ordered
	}
	result.Set("logline", treatment.Value("logline"))
	result.Set("sequences", treatment.Value("sequences"))
	return result
}

// WriteDocument проверяет шлюз записи и заменяет документ сценария по пути внутри проекта.
func WriteDocument(project, relative string, value any) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return writeFile(filepath.Join(project, filepath.FromSlash(relative)), Encode(value))
}

// PartDirection — направление части для агентов производства и проверки видео: id, название и
// направление в этом порядке (отсутствующие ключи пропускаются). Границы части, её кастинг,
// липсинк и предел длины плана нужны построению планов; план уже несёт свои кадры и сущности,
// поэтому в контекст и отпечатки входов этих агентов они не входят.
func PartDirection(part any) *dynvalue.Object {
	result := dynvalue.NewObject()
	for _, key := range []string{"id", "title", "direction"} {
		if value := dynvalue.Get(part, key); value != dynvalue.Undefined {
			result.Set(key, value)
		}
	}
	return result
}
