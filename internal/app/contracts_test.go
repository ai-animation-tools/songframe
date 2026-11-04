package app

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// apiContractFixtures — общий с TypeScript набор ожидаемых DTO и синтетических файлов.
// Ожидания читаются как JSON, чтобы отсутствие ключа не становилось неявным нулём Go.
type apiContractFixtures struct {
	AppStates []struct {
		ID       string          `json:"id"`
		Expected json.RawMessage `json:"expected"`
	} `json:"appStates"`
}

// readAPIContracts загружает единственный эталон wire-контракта из самого checkout.
func readAPIContracts(t *testing.T) apiContractFixtures {
	t.Helper()
	data, err := os.ReadFile("../../testdata/contracts/api.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures apiContractFixtures
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}

// assertContractJSON сравнивает дерево JSON без зависимости от порядка ключей.
// Обе стороны сохраняют различие null, пустого массива и отсутствующего поля.
func assertContractJSON(t *testing.T, actual any, expected json.RawMessage) {
	t.Helper()
	data, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("JSON-контракт изменился\nполучено: %s\nожидалось: %s", data, expected)
	}
}

// TestContractAppStateMarshal закрепляет и реальный пустой State, и заполненную форму DTO.
// Второй вариант проверяет wire-формат истории, не объявляя хранение истории реализованным.
func TestContractAppStateMarshal(t *testing.T) {
	service := NewAppService(fakeProfile{path: "Профиль теста 🌿"}, nil, false, nil)
	service.platform = "linux"
	empty, err := service.State()
	if err != nil {
		t.Fatal(err)
	}
	tools, current := "Комплект теста", "Проекты/Ёж"
	states := map[string]AppState{
		"empty-nullable":    empty,
		"populated-unicode": {Packaged: true, Problems: []string{"Проверка профиля"}, ToolsRoot: &tools, LocalDir: "Профиль теста 🌿", Current: &current, History: []ProjectHistoryEntry{{Path: current, Name: "Ёж 🌿", LastOpened: "2026-11-03T12:34:56Z", Exists: true}}, Platform: "win32"},
	}
	fixtures := readAPIContracts(t)
	if len(states) != len(fixtures.AppStates) {
		t.Fatal("изменён состав fixtures AppState")
	}
	for _, fixture := range fixtures.AppStates {
		t.Run(fixture.ID, func(t *testing.T) {
			state, ok := states[fixture.ID]
			if !ok {
				t.Fatal("нет производителя DTO для fixture")
			}
			assertContractJSON(t, state, fixture.Expected)
		})
	}
}
