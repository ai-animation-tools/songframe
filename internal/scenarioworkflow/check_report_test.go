package scenarioworkflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/golden"
)

// TestParseCheckReport — граничные случаи разбора отчёта проверки: каждое нарушение правил
// промпта отклоняет весь ответ с текстом первого нарушенного правила.
func TestParseCheckReport(t *testing.T) {
	issue := func(extra string) string {
		return `{"schemaVersion":1,"summary":"Итог.","issues":[{"group":"state","severity":"low","shots":["M01"],"entities":["mira"],"title":"Т","problem":"П","why":"П","fix":"И","changes":[]` + extra + `}]}`
	}
	change := func(body string) string {
		return strings.Replace(issue(""), `"changes":[]`, `"changes":[`+body+`]`, 1)
	}
	cases := map[string]string{
		issue(""): "",
		change(`{"shot":"M01","phase":"before","entity":"mira","property":"facing","value":"смотрит на дверь"}`):                                                                  "",
		change(`{"shot":"M01","phase":"after","entity":"mira","property":"facing","value":null}`):                                                                                 "",
		change(`{"shot":"M02","phase":"before","entity":"mira","property":"facing","value":"к двери"}`):                                                                           "правка 1: план M02 не указан в shots проблемы",
		change(`{"shot":"M01","phase":"middle","entity":"mira","property":"facing","value":"к двери"}`):                                                                           "кадр правки",
		change(`{"shot":"M01","phase":"before","entity":"mira","property":"mood","value":"к двери"}`):                                                                             "у сущности mira нет свойства mood",
		change(`{"shot":"M01","phase":"before","entity":"mira","property":"facing","value":" "}`):                                                                                 "value: пустой текст",
		change(`{"shot":"M01","phase":"before","entity":"mira","property":"facing"}`):                                                                                             "поля правки не того вида",
		change(`{"shot":"M01","phase":"before","entity":"mira","property":"facing","value":"а"},{"shot":"M01","phase":"before","entity":"mira","property":"facing","value":"б"}`): "то же место правится дважды",
		`{"schemaVersion":1,"summary":"Итог.","issues":[]}`:                                                                                                                       "",
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
	known := checkKnown{shots: []string{"M01", "M02"}, entities: []string{"mira"}, properties: map[string][]string{"mira": {"position", "facing"}}}
	for input, want := range cases {
		_, err := parseCheckReport(input, known)
		switch {
		case want == "" && err != nil:
			t.Errorf("%s: неожиданный отказ %v", input, err)
		case want != "" && (err == nil || !strings.Contains(err.Error(), want)):
			t.Errorf("%s: отказ %v, ожидалось %q", input, err, want)
		}
	}
}

// TestCheckTooLarge — контекст больше предела задания агента не уходит менеджеру, а отказ объясняет
// причину словами, а не кодом проверки входа менеджера.
func TestCheckTooLarge(t *testing.T) {
	var ready golden.Case
	for _, item := range golden.Load(t, "scenario-check") {
		if item.Name == "ready" {
			ready = item
		}
	}
	project := ready.BuildProject(t)
	path := filepath.Join(project, "plan", "scenes.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	scenes, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := dynvalue.AsObject(arrayItems(dynvalue.Get(scenes, "scenes"))[0])
	first.Set("action", strings.Repeat("Длинное действие. ", 20000))
	if err := os.WriteFile(path, []byte(dynvalue.StringifyIndent(scenes, "  ")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	agents := &fakeAgents{}
	_, err = New(Options{LocalDir: t.TempDir(), Agents: agents}).StartCheck(project)
	if err == nil || !strings.Contains(err.Error(), "Сценарий слишком большой для одной проверки") || len(agents.inputs) > 0 {
		t.Fatalf("отказ %v, запусков %d", err, len(agents.inputs))
	}
}
