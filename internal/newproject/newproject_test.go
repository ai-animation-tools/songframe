package newproject

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"songframe/internal/golden"
)

// TestValidateGolden — Validate на эталонах testdata/golden/project-validate-new.
func TestValidateGolden(t *testing.T) {
	var cases []struct {
		Name  string `json:"name"`
		Setup struct {
			Dirs  []string `json:"dirs"`
			Files []string `json:"files"`
		} `json:"setup"`
		Input    json.RawMessage `json:"input"`
		Expected []string        `json:"expected"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "project-validate-new", "cases.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			base := filepath.Join(t.TempDir(), "base")
			for _, dir := range append([]string{""}, item.Setup.Dirs...) {
				if err := os.MkdirAll(filepath.Join(base, dir), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for _, file := range item.Setup.Files {
				if err := os.WriteFile(filepath.Join(base, file), []byte("x\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			var input Input
			if err := json.Unmarshal([]byte(strings.ReplaceAll(string(item.Input), "<base>", base)), &input); err != nil {
				t.Fatal(err)
			}
			got := Validate(input)
			for index := range got {
				got[index] = strings.ReplaceAll(got[index], base, "<base>")
			}
			golden.AssertValue(t, mustJSON(t, item.Expected), got, "")
		})
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestDefaultAnimaticName(t *testing.T) {
	for name, want := range map[string]string{
		"Night Drive 2":  "night-drive-2-animatic.mp4",
		"Огород":         "animatic.mp4",
		"--Эхо: Live!--": "live-animatic.mp4",
		"İX":             "i-x-animatic.mp4",
		"":               "animatic.mp4",
	} {
		if got := DefaultAnimaticName(name); got != want {
			t.Errorf("%q: %q, ожидалось %q", name, got, want)
		}
	}
}

func TestRenderPlaceholders(t *testing.T) {
	values := Placeholders{"project_name": "Клип {{animatic_video}}", "animatic_video": "a.mp4"}
	got := RenderPlaceholders("{{project_name}} {{ animatic_video }} {{unknown}} {{Project_name}}", values)
	if want := "Клип {{animatic_video}} a.mp4 {{unknown}} {{Project_name}}"; got != want {
		t.Fatalf("%q", got)
	}
	if !isText(".gitignore") || !isText("README.md") || isText("cover.png") || isText("Makefile") {
		t.Fatal("выбор текстовых файлов отличается от эталона")
	}
}

// TestValidateFrameRate — частота формы: 0 означает частоту по умолчанию, допустимые проходят,
// иные дают проблему формы.
func TestValidateFrameRate(t *testing.T) {
	base := Input{Name: "Клип", Path: filepath.Join(t.TempDir(), "new")}
	for fps, ok := range map[int]bool{0: true, 24: true, 25: true, 30: true, 60: false, 12: false} {
		input := base
		input.FPS = fps
		problems := Validate(input)
		if ok != (len(problems) == 0) || (!ok && problems[0] != invalidFrameRate) {
			t.Fatalf("fps %d: %v", fps, problems)
		}
	}
}

// fakeGit кладёт в пустой PATH поддельный git (и при lfs — git-lfs), который дописывает в журнал
// «рабочая папка|аргументы»; при FAKE_GIT_FAIL=lfs команда git lfs завершается ошибкой с stderr.
func fakeGit(t *testing.T, lfs bool) (journal string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("поддельный git — shell-скрипт")
	}
	bin := t.TempDir()
	journal = filepath.Join(t.TempDir(), "git.log")
	script := "#!/bin/sh\necho \"$PWD|$*\" >> \"$FAKE_GIT_LOG\"\n" +
		"if [ \"$1\" = lfs ] && [ \"$FAKE_GIT_FAIL\" = lfs ]; then echo 'lfs: сбой хуков' >&2; exit 2; fi\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if lfs {
		if err := os.WriteFile(filepath.Join(bin, "git-lfs"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	t.Setenv("FAKE_GIT_LOG", journal)
	t.Setenv("FAKE_GIT_FAIL", "")
	return journal
}

// readJournal — строки журнала поддельного git; отсутствие файла — ни одного вызова.
func readJournal(t *testing.T, journal string) []string {
	t.Helper()
	data, err := os.ReadFile(journal)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

// TestInitGitEnablesLFS — при найденном git-lfs после git init в папке проекта выполняется
// git lfs install --local, служебная заметка не появляется.
func TestInitGitEnablesLFS(t *testing.T) {
	journal := fakeGit(t, true)
	target := t.TempDir()
	initGit(context.Background(), target)
	got := readJournal(t, journal)
	if len(got) != 2 || !strings.HasSuffix(got[0], "|init -q "+target) || got[1] != target+"|lfs install --local" {
		t.Fatalf("вызовы git %q", got)
	}
	if _, err := os.Stat(filepath.Join(target, GitFailedFile)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("заметка о сбое: %v", err)
	}
}

// TestInitGitWithoutLFS — без git-lfs выполняется только git init: Git LFS необязателен.
func TestInitGitWithoutLFS(t *testing.T) {
	journal := fakeGit(t, false)
	target := t.TempDir()
	initGit(context.Background(), target)
	if got := readJournal(t, journal); len(got) != 1 || !strings.HasSuffix(got[0], "|init -q "+target) {
		t.Fatalf("вызовы git %q", got)
	}
	if _, err := os.Stat(filepath.Join(target, GitFailedFile)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("заметка о сбое: %v", err)
	}
}

// TestInitGitLFSFailureNote — сбой git lfs install не отменяет создание: причина из stderr
// записывается в ту же служебную заметку GitFailedFile.
func TestInitGitLFSFailureNote(t *testing.T) {
	fakeGit(t, true)
	t.Setenv("FAKE_GIT_FAIL", "lfs")
	target := t.TempDir()
	initGit(context.Background(), target)
	data, err := os.ReadFile(filepath.Join(target, GitFailedFile))
	if err != nil {
		t.Fatal(err)
	}
	if want := "git lfs install --local не удался: lfs: сбой хуков\n\n"; string(data) != want {
		t.Fatalf("заметка %q", data)
	}
}
