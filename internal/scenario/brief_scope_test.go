package scenario

import (
	"slices"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
)

// briefScopeCast — кастинг из мира и трёх героев с начальным состоянием: все четыре сущности
// получают состояние в каждом плане, поэтому отбор врезки виден по абзацу и чек-листу.
const briefScopeCast = `{"schema_version":1,
 "properties":{"character":[{"key":"position","label":"Положение","checklist":"Стоит: {value}?"}],"world":[{"key":"time_of_day","label":"Время суток"}]},
 "entities":[
  {"id":"world","kind":"world","name":"Мир","initial_state":{"time_of_day":"ночь"}},
  {"id":"artem","kind":"character","name":"Артём","initial_state":{"position":"у верстака"}},
  {"id":"mira","kind":"character","name":"Мира","initial_state":{"position":"у метро"}},
  {"id":"boy","kind":"character","name":"Мальчик","initial_state":{"position":"у зебры"}}]}`

func briefScopeScenes(t *testing.T, scenes string) any {
	t.Helper()
	data, err := dynvalue.Parse([]byte(`{"schema_version":1,"scenes":` + scenes + `}`))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestBuildBriefPlanScope — врезка кадра описывает только мир, references плана и сущности state_changes той же фазы;
// состояние остальных остаётся в state для блока «Вне плана», а не в тексте для агента.
func TestBuildBriefPlanScope(t *testing.T) {
	castValue, err := dynvalue.Parse([]byte(briefScopeCast))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		scenes string
		shot   string
		phase  string
		scope  []string
		absent []string
	}{
		{
			name:   "только references",
			scenes: `[{"id":"M01","action":"Мастерская.","references":["artem"],"state_from":null,"state_changes":{}}]`,
			shot:   "M01", phase: "before",
			scope: []string{"world", "artem"}, absent: []string{"Мира", "Мальчик"},
		},
		{
			name: "вход к концу плана: в итоге есть",
			scenes: `[{"id":"M01","action":"Мастерская.","references":["artem"],"state_from":null,"state_changes":{}},
			          {"id":"M02","action":"Мира входит.","references":["artem"],"state_from":"M01","state_changes":{"after":{"mira":{"position":"в дверях"}}}}]`,
			shot: "M02", phase: "after",
			scope: []string{"world", "artem", "mira"}, absent: []string{"Мальчик"},
		},
		{
			name: "вход к концу плана: на первом кадре нет",
			scenes: `[{"id":"M01","action":"Мастерская.","references":["artem"],"state_from":null,"state_changes":{}},
			          {"id":"M02","action":"Мира входит.","references":["artem"],"state_from":"M01","state_changes":{"after":{"mira":{"position":"в дверях"}}}}]`,
			shot: "M02", phase: "before",
			scope: []string{"world", "artem"}, absent: []string{"Мира", "Мальчик"},
		},
		{
			name:   "references неожиданной формы пропускаются",
			scenes: `[{"id":"M01","action":"Ночь.","references":"artem","state_from":null,"state_changes":{}}]`,
			shot:   "M01", phase: "after",
			scope: []string{"world"}, absent: []string{"Артём", "Мира", "Мальчик"},
		},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			brief, err := BuildBrief(briefScopeScenes(t, item.scenes), castValue, item.shot, item.phase)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(brief.Scope, item.scope) {
				t.Fatalf("scope %v, ожидалось %v", brief.Scope, item.scope)
			}
			// Заголовок текста повторяет действие плана, поэтому сверяются строки после него.
			_, body, _ := strings.Cut(brief.Text, "\n")
			for _, name := range item.absent {
				if strings.Contains(brief.Paragraph, name+":") || strings.Contains(body, name+":") || slices.ContainsFunc(brief.Checklist, func(q string) bool { return strings.HasPrefix(q, name+":") }) {
					t.Fatalf("%s вне плана попал во врезку:\n%s", name, brief.Text)
				}
			}
			// Состояние всех сущностей сохраняется для страницы: скрытые показываются отдельно.
			for _, id := range []string{"world", "artem", "mira", "boy"} {
				if !strings.Contains(string(brief.State), `"`+id+`"`) {
					t.Fatalf("в state нет %s: %s", id, brief.State)
				}
			}
		})
	}
}
