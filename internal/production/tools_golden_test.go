package production_test

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/mediatest"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/tools"
)

// goldenStep — шаг домена production-tools: инструмент, аргументы с маркерами и снимаемые файлы.
type goldenStep struct {
	Label string   `json:"label"`
	Tool  string   `json:"tool"`
	Args  []string `json:"args"`
	Files []string `json:"files"`
}

// goldenOutcome — исход шага оригинала.
type goldenOutcome struct {
	Label  string             `json:"label"`
	Code   int                `json:"code"`
	Stdout string             `json:"stdout"`
	Stderr string             `json:"stderr"`
	Files  map[string]*string `json:"files"`
}

// captureFrame — байты кадра скрипта захвата (PNG 1×1, отличается от builtin_png оригинала).
var captureFrame, _ = hex.DecodeString("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082")

var goldenTime = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`)

// TestToolsGolden — regenerate_shot и accept_shot --full против CLI оригинала на тестовом
// провайдере: те же шаги подготовки пакета, повтор по пакету и по снимку комплекта, приёмка
// полного оригинала с подставными ffprobe/ffmpeg. Сравниваются код, stdout, stderr и байты файлов
// (пути — маркерами, время — <time>).
func TestToolsGolden(t *testing.T) {
	var steps []goldenStep
	var expected []goldenOutcome
	if err := json.Unmarshal(golden.ReadFile(t, "production-tools", "steps.json"), &steps); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(golden.ReadFile(t, "production-tools", "expected.json"), &expected); err != nil {
		t.Fatal(err)
	}
	var inputs struct {
		Spec, Pricing, Service, Probe json.RawMessage
		Prompt                        string
	}
	if err := json.Unmarshal(golden.ReadFile(t, "production-tools", "inputs.json"), &inputs); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	project, spec, serviceDir, state, bin := filepath.Join(root, "project"), filepath.Join(root, "spec"), filepath.Join(root, "service"), filepath.Join(root, "state"), filepath.Join(root, "bin")
	copyTree(t, filepath.Join("..", "..", "testdata", "golden", "checks-base", "project"), project)
	if err := os.RemoveAll(filepath.Join(project, "plan", "batches", "M03-attempt-01")); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(project, "plan", "project.json")
	data, _ := os.ReadFile(settings)
	write := func(path string, content []byte, mode os.FileMode) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, mode); err != nil {
			t.Fatal(err)
		}
	}
	write(settings, []byte(strings.Replace(string(data), `"provider": "test",`, `"provider": "test", "provider_selected": true,`, 1)), 0o644)
	write(filepath.Join(spec, "prompt.txt"), []byte(inputs.Prompt), 0o644)
	write(filepath.Join(spec, "frame.png"), captureFrame, 0o644)
	write(filepath.Join(spec, "pricing.json"), inputs.Pricing, 0o644)
	write(filepath.Join(spec, "spec.json"), inputs.Spec, 0o644)
	write(filepath.Join(serviceDir, "video.mp4"), []byte("\x00\x00\x00\x18ftypmp42original video bytes"), 0o644)
	write(filepath.Join(bin, "ffprobe"), []byte("#!/bin/sh\nprintf '%s' '"+string(inputs.Probe)+"'\n"), 0o755)
	write(filepath.Join(bin, "ffmpeg"), []byte("#!/bin/sh\necho 'ffmpeg version test-build'\necho 'built with test'\n"), 0o755)
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{"image", "video"}, Paid: true}))
	service, err := mediatest.New(serviceDir, pycompat.NewDict())
	if err != nil {
		t.Fatal(err)
	}
	config, err := pycompat.LoadsJSON(string(inputs.Service))
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Configure(config.(*pycompat.Dict)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Register())
	saved := tools.LocalDir
	tools.LocalDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { tools.LocalDir = saved })
	programs := mediacmd.Programs
	mediacmd.Programs = func() (string, string) { return filepath.Join(bin, "ffmpeg"), filepath.Join(bin, "ffprobe") }
	t.Cleanup(func() { mediacmd.Programs = programs })

	markers := map[string]string{"<project>": project, "<spec>": spec}
	mark := func(text string) string {
		for marker, path := range markers {
			text = strings.ReplaceAll(text, path, marker)
		}
		return goldenTime.ReplaceAllString(text, "<time>")
	}
	sha := ""
	for index, step := range steps {
		want := expected[index]
		if step.Label == "submit" {
			var attempt struct {
				RequestSHA string `json:"request_sha256"`
			}
			data, _ := os.ReadFile(filepath.Join(project, "plan", "batches", "M03-attempt-01", "request", "attempt.json"))
			_ = json.Unmarshal(data, &attempt)
			sha = attempt.RequestSHA
		}
		args := make([]string, len(step.Args))
		for position, arg := range step.Args {
			for marker, path := range markers {
				arg = strings.ReplaceAll(arg, marker, path)
			}
			args[position] = strings.ReplaceAll(arg, "<sha>", sha)
		}
		result, err := tools.Run(project, step.Tool, args)
		if err != nil {
			t.Fatalf("%s: %v", step.Label, err)
		}
		if result.Code == nil || *result.Code != want.Code {
			t.Fatalf("%s: код %v, ожидался %d; stderr %q", step.Label, result.Code, want.Code, result.Stderr)
		}
		if got := mark(result.Stdout); got != want.Stdout {
			t.Fatalf("%s: stdout\n%s\nожидался\n%s", step.Label, got, want.Stdout)
		}
		if got := mark(result.Stderr); got != want.Stderr {
			t.Fatalf("%s: stderr %q, ожидался %q", step.Label, got, want.Stderr)
		}
		for name, text := range want.Files {
			data, err := os.ReadFile(filepath.Join(project, filepath.FromSlash(name)))
			if text == nil {
				if err == nil {
					t.Fatalf("%s: лишний файл %s", step.Label, name)
				}
				continue
			}
			if err != nil {
				t.Fatalf("%s: %s: %v", step.Label, name, err)
			}
			if got := mark(string(data)); got != *text {
				t.Fatalf("%s: %s\n%s\nожидался\n%s", step.Label, name, got, *text)
			}
		}
	}
}
