package videoreview

import (
	"errors"
	"math"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"songframe/internal/dynvalue"
)

// Frame — кадр-свидетельство сохранённой выборки (VideoReviewFrame). В latest.json Path
// относителен папке пакета, в представлении для renderer — абсолютный.
type Frame struct {
	ID          string  `json:"id"`
	TimeSeconds float64 `json:"timeSeconds"`
	Path        string  `json:"path"`
}

// Finding — наблюдение отчёта (VideoReviewFinding). TimeSeconds отсчитывается от начала
// проверенного оригинала, а не от начала песни.
type Finding struct {
	Verdict     string   `json:"verdict"`
	TimeSeconds float64  `json:"timeSeconds"`
	Description string   `json:"description"`
	FrameIDs    []string `json:"frameIds"`
}

// Report — отчёт агента (VideoReviewReport) после проверки формата.
type Report struct {
	SchemaVersion int       `json:"schemaVersion"`
	Summary       string    `json:"summary"`
	Findings      []Finding `json:"findings"`
	Limitations   []string  `json:"limitations"`
}

// errInvalidReport — единственный отказ проверки ответа: подробности не показываются, чтобы
// пользователь получил понятный текст, а не перечень полей.
var errInvalidReport = errors.New(textInvalidReport)

// utf16Len — длина в кодовых единицах UTF-16 (так считаются пределы полей отчёта).
func utf16Len(text string) int { return len(utf16.Encode([]rune(text))) }

// nonempty — непустая после trim строка не длиннее limit кодовых единиц UTF-16.
func nonempty(value any, limit int) bool {
	text, ok := value.(string)
	return ok && dynvalue.Trim(text) != "" && utf16Len(text) <= limit
}

// exactKeys — у объекта нет ключей вне expected (отсутствующие ключи проверяются отдельно).
func exactKeys(value *dynvalue.Object, expected ...string) bool {
	for _, key := range value.Keys() {
		found := false
		for _, name := range expected {
			found = found || key == name
		}
		if !found {
			return false
		}
	}
	return true
}

// number — конечное число JSON.
func number(value any) (float64, bool) {
	result, ok := value.(float64)
	return result, ok && !math.IsInf(result, 0) && !math.IsNaN(result)
}

// ParseReport — разбор отчёта проверки: ответ агента (строка JSON или уже разобранное
// значение) принимается, только если каждое наблюдение ссылается на реально показанные кадры, а
// его таймкод совпадает (±1 мс) со временем хотя бы одного из них. Так модель не может приписать
// вывод непросмотренному моменту. Лишние поля, пустые списки и превышение пределов — отказ.
// Результат — нормализованный объект с порядком ключей latest.json, готовый к записи.
func ParseReport(value any, frames []Frame, duration float64) (*dynvalue.Object, error) {
	if text, ok := value.(string); ok {
		parsed, err := dynvalue.Parse([]byte(text))
		if err != nil {
			return nil, errInvalidReport
		}
		value = parsed
	}
	object, ok := value.(*dynvalue.Object)
	if !ok || !exactKeys(object, "schemaVersion", "summary", "findings", "limitations") ||
		!dynvalue.StrictEqual(object.Value("schemaVersion"), 1.0) || !nonempty(object.Value("summary"), 4000) {
		return nil, errInvalidReport
	}
	findings, ok := dynvalue.AsArray(object.Value("findings"))
	if !ok || len(findings) == 0 || len(findings) > 40 {
		return nil, errInvalidReport
	}
	limitations, ok := dynvalue.AsArray(object.Value("limitations"))
	if !ok || len(limitations) == 0 || len(limitations) > 20 {
		return nil, errInvalidReport
	}
	for _, item := range limitations {
		if !nonempty(item, 1000) {
			return nil, errInvalidReport
		}
	}
	byID := map[string]Frame{}
	for _, frame := range frames {
		byID[frame.ID] = frame
	}
	normalized := &dynvalue.Array{}
	for _, raw := range findings {
		item, ok := raw.(*dynvalue.Object)
		if !ok || !exactKeys(item, "verdict", "timeSeconds", "description", "frameIds") {
			return nil, errInvalidReport
		}
		// Сравнивается строковое представление значения (dynvalue.ToString).
		switch dynvalue.ToString(item.Value("verdict")) {
		case "match", "mismatch", "uncertain":
		default:
			return nil, errInvalidReport
		}
		time, finite := number(item.Value("timeSeconds"))
		if !nonempty(item.Value("description"), 2000) || !finite || time < 0 || time >= duration {
			return nil, errInvalidReport
		}
		ids, ok := dynvalue.AsArray(item.Value("frameIds"))
		if !ok || len(ids) == 0 || len(ids) > 8 {
			return nil, errInvalidReport
		}
		seen, witnessed := map[string]bool{}, false
		for _, rawID := range ids {
			id, isString := rawID.(string)
			frame, known := byID[id]
			if !isString || !known || seen[id] {
				return nil, errInvalidReport
			}
			seen[id] = true
			witnessed = witnessed || math.Abs(frame.TimeSeconds-time) <= 0.001
		}
		if !witnessed {
			return nil, errInvalidReport
		}
		finding := dynvalue.NewObject()
		finding.Set("verdict", item.Value("verdict"))
		finding.Set("timeSeconds", time)
		finding.Set("description", item.Value("description"))
		finding.Set("frameIds", item.Value("frameIds"))
		normalized.Items = append(normalized.Items, finding)
	}
	report := dynvalue.NewObject()
	report.Set("schemaVersion", 1.0)
	report.Set("summary", object.Value("summary"))
	report.Set("findings", normalized)
	report.Set("limitations", object.Value("limitations"))
	return report, nil
}

// reportDTO переводит проверенный отчёт в структуру контракта. Значения уже проверены ParseReport,
// поэтому преобразование не теряет данных (verdict — его строковое представление).
func reportDTO(value any) *Report {
	object, ok := value.(*dynvalue.Object)
	if !ok {
		return nil
	}
	report := &Report{SchemaVersion: 1, Findings: []Finding{}, Limitations: []string{}}
	report.Summary, _ = object.Value("summary").(string)
	findings, _ := dynvalue.AsArray(object.Value("findings"))
	for _, raw := range findings {
		finding := Finding{Verdict: dynvalue.ToString(dynvalue.Get(raw, "verdict")), FrameIDs: []string{}}
		finding.TimeSeconds, _ = dynvalue.Get(raw, "timeSeconds").(float64)
		finding.Description, _ = dynvalue.Get(raw, "description").(string)
		ids, _ := dynvalue.AsArray(dynvalue.Get(raw, "frameIds"))
		for _, id := range ids {
			text, _ := id.(string)
			finding.FrameIDs = append(finding.FrameIDs, text)
		}
		report.Findings = append(report.Findings, finding)
	}
	limitations, _ := dynvalue.AsArray(object.Value("limitations"))
	for _, item := range limitations {
		text, _ := item.(string)
		report.Limitations = append(report.Limitations, text)
	}
	return report
}

// textPath — непустой после обрезки пробелов путь без NUL.
func textPath(value string) bool {
	return dynvalue.Trim(value) != "" && !strings.ContainsRune(value, 0)
}

// outside — относительный путь выходит за корень («..», «../…» или другой том).
func outside(local string) bool {
	return local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) || dynvalue.IsAbs(local)
}

// productionPath — путь value от root не выходит за root ни строкой, ни
// через символьную ссылку существующего родителя (проверяется и родитель ещё не созданного файла,
// чтобы ссылка не перенаправила запись из проекта). Возвращает resolve(root, value).
func productionPath(root, value string) (string, error) {
	if !textPath(value) {
		return "", errors.New(textPathRequired)
	}
	full := dynvalue.Resolve(root, value)
	if outside(dynvalue.Relative(root, full)) {
		return "", errors.New(textPathOutsideProject(value))
	}
	parent := full
	for !dynvalue.Exists(parent) {
		next := dynvalue.Resolve(parent, "..")
		if next == parent {
			return "", errors.New(textParentMissing)
		}
		parent = next
	}
	realRoot, err := dynvalue.Realpath(root)
	if err != nil {
		return "", err
	}
	realParent, err := dynvalue.Realpath(parent)
	if err != nil {
		return "", err
	}
	if outside(dynvalue.Relative(realRoot, realParent)) {
		return "", errors.New(textLinkOutsideProject(value))
	}
	return full, nil
}

// slash — относительный путь с разделителем «/», как он хранится в latest.json на любой ОС.
func slash(path string) string { return filepath.ToSlash(path) }
