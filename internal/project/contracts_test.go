package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// projectContractFixtures описывает синтетические документы и ожидаемый снимок для двух языков.
// Карта файлов используется буквально: форматирование JSON и неизвестные поля должны пережить чтение.
type projectContractFixtures struct {
	Snapshots []struct {
		ID       string            `json:"id"`
		Files    map[string]string `json:"files"`
		Expected Snapshot          `json:"expected"`
	} `json:"snapshots"`
}

// recoveryContractFixtures фиксирует только блокировку незавершённой публикации.
// Резервы намеренно отличаются от текущих файлов, чтобы случайный rollback обнаруживался по дереву.
type recoveryContractFixtures struct {
	BaseSnapshot string `json:"baseSnapshot"`
	Cases        []struct {
		ID              string            `json:"id"`
		Files           map[string]string `json:"files"`
		Blocked         bool              `json:"blocked"`
		ProblemContains string            `json:"problemContains"`
	} `json:"cases"`
}

// readProjectContract открывает fixture только внутри songframe-go, без обращения к старому приложению.
func readProjectContract(t *testing.T, name string, target any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("../../testdata/contracts", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatal(err)
	}
}

// TestContractStoreReadAndMove проверяет все документы и отсутствие записей при повторном чтении.
// Перенос меняет только вычисленные пути; ручные секунды, UTF-8 и неизвестные данные остаются прежними.
func TestContractStoreReadAndMove(t *testing.T) {
	var fixtures projectContractFixtures
	readProjectContract(t, "api.json", &fixtures)
	for _, fixture := range fixtures.Snapshots {
		t.Run(fixture.ID, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Исходный ёж 🌿")
			for path, content := range fixture.Files {
				write(t, root, path, content)
			}
			before := tree(t, root)
			for attempt := 0; attempt < 2; attempt++ {
				got, err := (Reader{}).Read(root)
				if err != nil {
					t.Fatal(err)
				}
				want := fixture.Expected
				want.Path = root
				if want.Track != nil {
					track := *want.Track
					track.Path = filepath.Join(root, "source", "track.mp3")
					track.URL = ""
					want.Track = &track
				}
				var gotTiming, wantTiming any
				if err := json.Unmarshal(got.Timing, &gotTiming); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(want.Timing, &wantTiming); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(gotTiming, wantTiming) {
					t.Fatalf("изменены тайминги: %s", got.Timing)
				}
				got.Timing = nil
				want.Timing = nil
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("снимок: %+v; ожидалось: %+v", got, want)
				}
				if !reflect.DeepEqual(before, tree(t, root)) {
					t.Fatal("чтение изменило дерево проекта")
				}
				if attempt == 0 {
					moved := filepath.Join(filepath.Dir(root), "Перенесённый ёж 🌿")
					if err := os.Rename(root, moved); err != nil {
						t.Fatal(err)
					}
					root = moved
				}
			}
		})
	}
}

// TestContractRecoveryGateNeverRollsBack проверяет оба семейства журналов, их резервы и оригиналы.
// Повторное открытие после переноса не завершает публикацию и не выполняет полное recovery.
func TestContractRecoveryGateNeverRollsBack(t *testing.T) {
	var api projectContractFixtures
	var fixtures recoveryContractFixtures
	readProjectContract(t, "api.json", &api)
	readProjectContract(t, "recovery.json", &fixtures)
	var base map[string]string
	for _, snapshot := range api.Snapshots {
		if snapshot.ID == fixtures.BaseSnapshot {
			base = snapshot.Files
		}
	}
	if base == nil {
		t.Fatal("не найден базовый проект recovery fixture")
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.ID, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "Проект с журналом")
			for path, content := range base {
				write(t, root, path, content)
			}
			for path, content := range fixture.Files {
				write(t, root, path, content)
			}
			before := tree(t, root)
			for attempt := 0; attempt < 2; attempt++ {
				got, err := (Reader{}).Read(root)
				if err != nil {
					t.Fatal(err)
				}
				if got.Blocked != fixture.Blocked {
					t.Fatalf("blocked=%v, ожидалось %v", got.Blocked, fixture.Blocked)
				}
				if fixture.Blocked {
					if got.LyricsText != "" || got.Track != nil || string(got.Timing) != "null" || got.Duration != nil || got.TrackSha256 != nil {
						t.Fatal("утечка частично опубликованного содержимого")
					}
					if len(got.Problems) != 1 || !strings.Contains(got.Problems[0], fixture.ProblemContains) {
						t.Fatalf("причина блокировки: %v", got.Problems)
					}
				} else if len(got.Problems) != 0 || got.Track == nil {
					t.Fatalf("завершённый журнал блокирует чтение: %+v", got)
				}
				if !reflect.DeepEqual(before, tree(t, root)) {
					t.Fatal("проект, оригиналы, резервы или журнал изменены при чтении")
				}
				if attempt == 0 {
					moved := filepath.Join(filepath.Dir(root), "Перенесённый журнал 🌿")
					if err := os.Rename(root, moved); err != nil {
						t.Fatal(err)
					}
					root = moved
				}
			}
		})
	}
}
