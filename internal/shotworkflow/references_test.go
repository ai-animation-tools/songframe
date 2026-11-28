package shotworkflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// referencesProject — копия проекта эталонов и путь пустой попытки M02 после init; окно плана M02
// — 4 с, правило длительности проекта — строго больше окна.
func referencesProject(t *testing.T) (root, directory string) {
	t.Helper()
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	root = filepath.Join(t.TempDir(), "project")
	if err := os.CopyFS(root, os.DirFS(filepath.Join(base, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	directory = filepath.Join(root, "plan", "batches", "M02-attempt-01")
	if out := Run(root, []string{"init", "M02", "--dir", directory, "--mode", "shot"}); out.Code != 0 {
		t.Fatalf("init: %s%s", out.Stdout, out.Stderr)
	}
	return root, directory
}

// Видео по референсам: plan-keyframes --no-frames оставляет план опор пустым и записывает только
// длительность запроса; правило длительности проверяется, а промежуточные опоры, одна опора и
// план из опор с этим режимом несовместимы.
func TestPlanKeyframesNoFrames(t *testing.T) {
	root, directory := referencesProject(t)
	plan := func(args ...string) toolcli.Output {
		return Run(root, append([]string{"plan-keyframes", "--dir", directory}, args...))
	}
	if out := plan("--request-seconds", "4", "--no-frames"); out.Code == 0 || !strings.Contains(out.Stderr, "строго больше") {
		t.Fatalf("длительность, равная окну: %+v", out)
	}
	for _, extra := range [][]string{{"--middle", "2:состояние"}, {"--single"}, {"--static"}} {
		out := plan(append([]string{"--request-seconds", "9", "--no-frames"}, extra...)...)
		if out.Code == 0 || !strings.Contains(out.Stderr, "без опор") {
			t.Fatalf("%v: %+v", extra, out)
		}
	}
	if out := plan("--request-seconds", "9", "--no-frames"); out.Code != 0 {
		t.Fatalf("план без опор: %+v", out)
	}
	data, err := load(directory)
	if err != nil {
		t.Fatal(err)
	}
	if items, _ := toolrt.Iter(data.Value("keyframes")); len(items) != 0 {
		t.Fatalf("опоры: %v", items)
	}
	timing, _ := data.Value("timing").(*toolrt.Dict)
	if toolrt.Str(timing.Value("request_seconds")) != "9" {
		t.Fatalf("request_seconds: %v", timing.Value("request_seconds"))
	}
}

// У попытки по референсам промпт утверждается, только когда приняты все референсы: пока список
// пуст или в нём есть непринятый, approve-prompt отказывает с перечнем.
func TestApprovePromptWaitsForReferences(t *testing.T) {
	root, directory := referencesProject(t)
	if out := Run(root, []string{"plan-keyframes", "--dir", directory, "--request-seconds", "9", "--no-frames"}); out.Code != 0 {
		t.Fatalf("plan-keyframes: %+v", out)
	}
	if err := os.WriteFile(filepath.Join(directory, "video-prompt.txt"), []byte("Герой смотрит на воду [#R01].\n"), 0o664); err != nil {
		t.Fatal(err)
	}
	setReferences := func(approved ...bool) {
		t.Helper()
		data, err := load(directory)
		if err != nil {
			t.Fatal(err)
		}
		items := []any{}
		for index, flag := range approved {
			item := toolrt.NewDict()
			item.Set("id", "R"+twoDigits(index+1))
			item.Set("approved", flag)
			items = append(items, item)
		}
		data.Set("generation_method", "references")
		data.Set("references", items)
		if _, err := save(directory, data); err != nil {
			t.Fatal(err)
		}
	}
	approve := func() toolcli.Output {
		return Run(root, []string{"approve-prompt", "--dir", directory, "--file", "video-prompt.txt"})
	}
	setReferences()
	if out := approve(); out.Code == 0 || !strings.Contains(out.Stderr, "референсов") {
		t.Fatalf("пустой список: %+v", out)
	}
	setReferences(true, false)
	if out := approve(); out.Code == 0 || !strings.Contains(out.Stderr, "Сначала примите все референсы: R02") {
		t.Fatalf("есть непринятый: %+v", out)
	}
	setReferences(true, true)
	if out := approve(); out.Code != 0 {
		t.Fatalf("все приняты: %+v", out)
	}
	data, err := load(directory)
	if err != nil {
		t.Fatal(err)
	}
	if prompt, _ := data.Value("prompt").(*toolrt.Dict); prompt == nil || prompt.Value("approved") != true {
		t.Fatalf("промпт: %v", data.Value("prompt"))
	}
}
