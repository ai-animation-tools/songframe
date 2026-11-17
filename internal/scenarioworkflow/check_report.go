package scenarioworkflow

import (
	"errors"
	"slices"
	"strings"
	"unicode/utf16"

	"songframe/internal/dynvalue"
)

// Отчёт проверки сценария (ScenarioCheckReport): итог и проблемы, которые агент нашёл в трактовке,
// реестре и кастинге. Пределы ниже подставляются в промпт (checkPrompt) и проверяются при разборе
// ответа, поэтому агент видит ровно те правила, по которым его ответ принимается. Длины считаются в
// кодовых единицах UTF-16, как у остальных отчётов агента.

const (
	// checkSummaryMaxLength — наибольшая длина итога summary.
	checkSummaryMaxLength = 2000
	// checkIssuesMax — наибольшее число проблем; ноль допустим: хороший сценарий даёт пустой список.
	checkIssuesMax = 40
	// checkTitleMaxLength — наибольшая длина заголовка проблемы.
	checkTitleMaxLength = 160
	// checkTextMaxLength — наибольшая длина problem, why и fix.
	checkTextMaxLength = 1500
)

// Группы и важность проблемы — допустимые значения group и severity в порядке показа.
var (
	CheckGroups     = []string{"state", "story", "cast", "joins"}
	CheckSeverities = []string{"high", "medium", "low"}
)

// CheckIssue — одна проблема отчёта. Shots и Entities — ID планов реестра и сущностей кастинга,
// которых она касается; тексты написаны для человека без путей и ключей файлов.
type CheckIssue struct {
	Group    string   `json:"group"`
	Severity string   `json:"severity"`
	Shots    []string `json:"shots"`
	Entities []string `json:"entities"`
	Title    string   `json:"title"`
	Problem  string   `json:"problem"`
	Why      string   `json:"why"`
	Fix      string   `json:"fix"`
}

// CheckReport — отчёт проверки после разбора.
type CheckReport struct {
	Summary string       `json:"summary"`
	Issues  []CheckIssue `json:"issues"`
}

// checkKeys — ровно эти ключи у ответа и у проблемы.
var (
	checkReportKeys = []string{"schemaVersion", "summary", "issues"}
	checkIssueKeys  = []string{"group", "severity", "shots", "entities", "title", "problem", "why", "fix"}
)

// parseCheckReport — разбор ответа агента: JSON-объект schemaVersion 1 с полями и пределами из
// промпта, ID планов и сущностей — только из проверенного сценария (shots, entities). Любое
// нарушение отклоняет весь ответ: текст отказа называет первое нарушенное правило и номер проблемы.
func parseCheckReport(result string, shots, entities []string) (CheckReport, error) {
	value, err := dynvalue.Parse([]byte(strings.TrimSpace(result)))
	object, ok := dynvalue.AsObject(value)
	if err != nil || !ok {
		return CheckReport{}, errors.New(textCheckNotObject)
	}
	if !onlyKeys(object, checkReportKeys) || !dynvalue.StrictEqual(object.Value("schemaVersion"), 1.0) {
		return CheckReport{}, errors.New(textCheckShape)
	}
	summary, err := checkText(object.Value("summary"), checkSummaryMaxLength)
	if err != nil {
		return CheckReport{}, errors.New(textCheckSummary(err.Error()))
	}
	items, ok := dynvalue.AsArray(object.Value("issues"))
	if !ok {
		return CheckReport{}, errors.New(textCheckShape)
	}
	if len(items) > checkIssuesMax {
		return CheckReport{}, errors.New(textCheckTooMany(len(items), checkIssuesMax))
	}
	report := CheckReport{Summary: summary, Issues: []CheckIssue{}}
	for index, item := range items {
		issue, err := parseCheckIssue(item, shots, entities)
		if err != nil {
			return CheckReport{}, errors.New(textCheckIssue(index+1, err.Error()))
		}
		report.Issues = append(report.Issues, issue)
	}
	return report, nil
}

// parseCheckIssue — одна проблема ответа.
func parseCheckIssue(value any, shots, entities []string) (CheckIssue, error) {
	object, ok := dynvalue.AsObject(value)
	if !ok || !onlyKeys(object, checkIssueKeys) {
		return CheckIssue{}, errors.New(textCheckIssueShape)
	}
	issue := CheckIssue{}
	issue.Group, _ = object.Value("group").(string)
	if !slices.Contains(CheckGroups, issue.Group) {
		return CheckIssue{}, errors.New(textCheckIssueGroup)
	}
	issue.Severity, _ = object.Value("severity").(string)
	if !slices.Contains(CheckSeverities, issue.Severity) {
		return CheckIssue{}, errors.New(textCheckIssueSeverity)
	}
	var err error
	if issue.Shots, err = knownIDs(object.Value("shots"), shots, textCheckIssueShot); err != nil {
		return CheckIssue{}, err
	}
	if issue.Entities, err = knownIDs(object.Value("entities"), entities, textCheckIssueEntity); err != nil {
		return CheckIssue{}, err
	}
	fields := []struct {
		target *string
		key    string
		limit  int
	}{{&issue.Title, "title", checkTitleMaxLength}, {&issue.Problem, "problem", checkTextMaxLength}, {&issue.Why, "why", checkTextMaxLength}, {&issue.Fix, "fix", checkTextMaxLength}}
	for _, field := range fields {
		if *field.target, err = checkText(object.Value(field.key), field.limit); err != nil {
			return CheckIssue{}, errors.New(textCheckIssueField(field.key, err.Error()))
		}
	}
	return issue, nil
}

// knownIDs — массив строк без повторов, каждая из known; problem — отказ с неизвестным ID.
func knownIDs(value any, known []string, problem func(string) string) ([]string, error) {
	items, ok := dynvalue.AsArray(value)
	if !ok {
		return nil, errors.New(textCheckIssueShape)
	}
	result := []string{}
	for _, item := range items {
		id, isString := item.(string)
		if !isString || slices.Contains(result, id) {
			return nil, errors.New(textCheckIssueShape)
		}
		if !slices.Contains(known, id) {
			return nil, errors.New(problem(id))
		}
		result = append(result, id)
	}
	return result, nil
}

// checkText — непустая после trim строка не длиннее limit кодовых единиц UTF-16.
func checkText(value any, limit int) (string, error) {
	text, ok := value.(string)
	if !ok || dynvalue.Trim(text) == "" {
		return "", errors.New(textCheckEmpty)
	}
	if length := len(utf16.Encode([]rune(text))); length > limit {
		return "", errors.New(textCheckLong(length, limit))
	}
	return dynvalue.Trim(text), nil
}

// onlyKeys — у объекта есть все ключи expected и нет других.
func onlyKeys(object *dynvalue.Object, expected []string) bool {
	keys := object.Keys()
	if len(keys) != len(expected) {
		return false
	}
	for _, key := range keys {
		if !slices.Contains(expected, key) {
			return false
		}
	}
	return true
}
