package scenarioworkflow

import (
	"strings"
	"testing"
)

// TestParseCheckReport — граничные случаи разбора отчёта проверки: каждое нарушение правил
// промпта отклоняет весь ответ с текстом первого нарушенного правила.
func TestParseCheckReport(t *testing.T) {
	issue := func(extra string) string {
		return `{"schemaVersion":1,"summary":"Итог.","issues":[{"group":"state","severity":"low","shots":["M01"],"entities":["mira"],"title":"Т","problem":"П","why":"П","fix":"И"` + extra + `}]}`
	}
	cases := map[string]string{
		issue(""): "",
		`{"schemaVersion":1,"summary":"Итог.","issues":[]}`: "",
		issue(`,"extra":1`): "поля не того вида",
		strings.Replace(issue(""), `"M01"`, `"M01","M01"`, 1):                                                    "поля не того вида",
		strings.Replace(issue(""), `"state"`, `"style"`, 1):                                                      "неизвестная группа",
		strings.Replace(issue(""), `"low"`, `"critical"`, 1):                                                     "неизвестная важность",
		strings.Replace(issue(""), `"mira"`, `"anna"`, 1):                                                        "неизвестная сущность anna",
		strings.Replace(issue(""), `"fix":"И"`, `"fix":"  "`, 1):                                                 "fix: пустой текст",
		strings.Replace(issue(""), `"title":"Т"`, `"title":"`+strings.Repeat("а", checkTitleMaxLength+1)+`"`, 1): "title: 161 знаков при пределе 160",
		`{"schemaVersion":2,"summary":"Итог.","issues":[]}`:                                                      "Отчёт агента не того вида",
		`{"schemaVersion":1,"summary":"","issues":[]}`:                                                           "Итог отчёта агента не принят: пустой текст",
		"```json\n{}\n```": "не в формате JSON",
	}
	for input, want := range cases {
		_, err := parseCheckReport(input, []string{"M01", "M02"}, []string{"mira"})
		switch {
		case want == "" && err != nil:
			t.Errorf("%s: неожиданный отказ %v", input, err)
		case want != "" && (err == nil || !strings.Contains(err.Error(), want)):
			t.Errorf("%s: отказ %v, ожидалось %q", input, err, want)
		}
	}
}
