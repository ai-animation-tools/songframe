package status

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/golden"
)

// expectation — expected.json статуса: либо ProjectStatus, либо {"throws": …}.
type expectation struct {
	Throws *string `json:"throws"`
}

// TestComputeMatchesGolden сверяет ComputeBase с каждым эталоном testdata/golden/status и проверяет, что
// вычисление ничего не пишет во входной проект.
func TestComputeMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "status") {
		t.Run(item.Name, func(t *testing.T) {
			path := item.ProjectPath()
			before := digestIfExists(t, path)
			result, err := ComputeBase(path)
			var want expectation
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			if want.Throws != nil {
				if err == nil {
					t.Fatalf("эталон бросает %q, Go вернул %+v", *want.Throws, result)
				}
			} else {
				if err != nil {
					t.Fatalf("ошибка: %v", err)
				}
				golden.AssertValue(t, item.Expected(t), result, path)
			}
			if after := digestIfExists(t, path); after != before {
				t.Fatal("вычисление статуса изменило файлы проекта")
			}
		})
	}
}

// TestOpenExpectations проверяет срез Projects.open, зависящий от этого пакета: ошибка открытия —
// отсутствие маркера (с абсолютным путём) либо ошибка ComputeBase; иначе статус открытия
// совпадает со статусом.
func TestOpenExpectations(t *testing.T) {
	for _, item := range golden.Load(t, "status") {
		t.Run(item.Name, func(t *testing.T) {
			var want struct {
				Error        *string `json:"error"`
				SameAsStatus *bool   `json:"sameAsStatus"`
			}
			if err := json.Unmarshal(item.Read(t, "expected-open.json"), &want); err != nil {
				t.Fatal(err)
			}
			path := item.ProjectPath()
			marker := ReadMarker(path)
			if _, statErr := os.Stat(path); statErr != nil {
				marker = nil
			}
			_, err := ComputeBase(path)
			switch {
			case marker == nil:
				if want.Error == nil || *want.Error != "В папке нет plan/project.json с названием проекта: "+golden.ProjectMarker {
					t.Fatalf("ожидалась ошибка маркера, эталон %+v", want)
				}
			case err != nil:
				if want.Error == nil {
					t.Fatalf("Go бросает %v, эталон открыл проект", err)
				}
			default:
				if want.Error != nil || want.SameAsStatus == nil || !*want.SameAsStatus {
					t.Fatalf("Go открывает проект, эталон %+v", want)
				}
			}
		})
	}
}

// TestReviewProblem проверяет постобработку projects.status: без записи сценарного процесса она не
// меняет статус существующих проектов, а несуществующий путь даёт ошибку realpath.
func TestReviewProblem(t *testing.T) {
	for _, item := range golden.Load(t, "status") {
		t.Run(item.Name, func(t *testing.T) {
			path := item.ProjectPath()
			base, baseErr := ComputeBase(path)
			full, err := Compute(path)
			if (baseErr == nil) != (err == nil) {
				t.Fatalf("ошибки различаются: %v / %v", baseErr, err)
			}
			if err != nil {
				return
			}
			if !item.HasProject() {
				want := scenarioReviewFailed("ENOENT: no such file or directory, lstat '" + path + "'")
				if len(full.Problems) != 2 || full.Problems[1] != want || full.Checks.AnimaticFresh || full.Checks.AnimaticApproved {
					t.Fatalf("проблема несуществующего пути: %+v", full.Problems)
				}
				return
			}
			left, _ := json.Marshal(base)
			right, _ := json.Marshal(full)
			if string(left) != string(right) {
				t.Fatalf("reviewProblem изменил статус:\n%s\n%s", left, right)
			}
		})
	}
}

// TestReviewInputsFailures — отказы сбора входов сценария, выполняемого вне try.
func TestReviewInputsFailures(t *testing.T) {
	project := t.TempDir()
	write := func(name, text string) {
		path := filepath.Join(project, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("plan/project.json", `{"name":"Проверка"}`)
	if problem := reviewProblem(project); problem != "" {
		t.Fatalf("здоровый проект: %q", problem)
	}
	if err := os.MkdirAll(filepath.Join(project, "source", "track.mp3"), 0o755); err != nil {
		t.Fatal(err)
	}
	if problem := reviewProblem(project); problem != scenarioReviewFailed("EISDIR: illegal operation on a directory, read") {
		t.Fatalf("каталог на месте входа: %q", problem)
	}
	if err := os.Remove(filepath.Join(project, "source", "track.mp3")); err != nil {
		t.Fatal(err)
	}
	write("assets/shots", "файл")
	if problem := reviewProblem(project); problem != scenarioReviewFailed(shotsDirectoryRequired) {
		t.Fatalf("assets/shots — файл: %q", problem)
	}
	if err := os.Remove(filepath.Join(project, "assets", "shots")); err != nil {
		t.Fatal(err)
	}
	write("assets/shots/M01", "файл")
	if problem := reviewProblem(project); !strings.HasPrefix(problem, scenarioReviewFailed("ENOTDIR: not a directory, lstat ")) {
		t.Fatalf("файл M01 в assets/shots: %q", problem)
	}
}

// digestIfExists — дайджест дерева входа или пустая строка для несуществующего пути.
func digestIfExists(t *testing.T, path string) string {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		return ""
	}
	digest, err := golden.TreeDigest(path)
	if err != nil {
		t.Fatal(err)
	}
	return digest
}
