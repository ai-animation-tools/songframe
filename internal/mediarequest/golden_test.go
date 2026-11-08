package mediarequest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/mediatest/scenario"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// interrupt — обрыв процесса посреди действия: panic из точки сбоя.
type interrupt struct{}

// TestGolden проигрывает сценарии media_request из эталонов testdata/golden/media-request.
func TestGolden(t *testing.T) {
	scenario.Play(t, "media-request", runStep)
}

// runStep — один процесс media_request сценария: часы начинаются с 1000 с, sleep продвигает их
// без паузы; сбой fault вносится через hooks или удерживаемый замок попытки.
func runStep(t *testing.T, env *scenario.Env, step scenario.Step, args []string) (output toolcli.Output, interrupted bool) {
	restore := env.Register()
	defer restore()
	savedMonotonic, savedSleep := monotonic, sleep
	clock := 1000.0
	monotonic = func() float64 { return clock }
	sleep = func(_ context.Context, seconds float64) error { clock += seconds; return nil }
	defer func() { monotonic, sleep = savedMonotonic, savedSleep }()
	kind, argument, _ := strings.Cut(step.Fault, ":")
	switch kind {
	case "":
	case "lock":
		file, err := os.OpenFile(filepath.Join(env.Real(argument), ".lock"), os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o666)
		if err != nil {
			t.Fatal(err)
		}
		if err := lockFile(file); err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		defer unlockFile(file)
	case "interrupt_on_downloads":
		hooks.journal = func(state *toolrt.Dict) {
			if toolrt.Truthy(state.Value("downloads")) {
				panic(interrupt{})
			}
		}
	case "interrupt_before_link":
		hooks.link = func(destination string) {
			if filepath.Base(destination) == argument {
				panic(interrupt{})
			}
		}
	default:
		t.Fatalf("неизвестный сбой %q", step.Fault)
	}
	defer func() {
		hooks.journal, hooks.link = nil, nil
		if recovered := recover(); recovered != nil {
			if _, ok := recovered.(interrupt); !ok {
				panic(recovered)
			}
			interrupted = true
		}
	}()
	root := ""
	if step.Project {
		root = env.Path("project")
	}
	return Run(context.Background(), root, args, nil), false
}
