package tools_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolrt"
	"songframe/internal/tools"
)

// tracebackHeader — первая строка трассировки инструмента; кадры стека инструменты не печатают,
// поэтому у таких случаев сверяются заголовок и последняя строка (тип и текст исключения).
const tracebackHeader = "Traceback (most recent call last):"

// TestSceneScaffoldGolden запускает tools.run("scene_scaffold") на копиях входов эталона
// scene-scaffold и сверяет код завершения, stdout, stderr и байты plan/scenes.json с ожидаемыми.
func TestSceneScaffoldGolden(t *testing.T) {
	for _, c := range golden.Load(t, "scene-scaffold") {
		t.Run(c.Name, func(t *testing.T) {
			spec := c.ReadValue(t, "case.json")
			args := []string{}
			for _, arg := range spec.Value("args").([]any) {
				args = append(args, arg.(string))
			}
			root := c.CopyProject(t)
			path := filepath.Join(root, "plan", "scenes.json")
			before, beforeErr := os.ReadFile(path)
			result, err := tools.Run(root, "scene_scaffold", args)
			if err != nil {
				t.Fatalf("tools.Run: %v", err)
			}
			expected := c.ReadValue(t, "expected.json")
			normalize := func(text string) string { return strings.ReplaceAll(text, root, golden.ProjectMarker) }
			if want := expected.Value("code").(toolrt.Int).String(); result.Code == nil || want != toolrt.NewInt(int64(*result.Code)).String() {
				t.Errorf("код завершения: ожидалось %s, получено %v", want, result)
			}
			if want := golden.ValueString(t, expected, "stdout"); normalize(result.Stdout) != want {
				t.Errorf("stdout:\n--- ожидалось\n%s\n--- получено\n%s", want, normalize(result.Stdout))
			}
			wantErr, gotErr := golden.ValueString(t, expected, "stderr"), normalize(result.Stderr)
			if expected.Value("traceback") == true {
				if !strings.HasPrefix(gotErr, tracebackHeader+"\n") || lastLine(gotErr) != lastLine(wantErr) {
					t.Errorf("трассировка:\n--- ожидалось (последняя строка)\n%s\n--- получено\n%s", lastLine(wantErr), gotErr)
				}
			} else if gotErr != wantErr {
				t.Errorf("stderr:\n--- ожидалось\n%s\n--- получено\n%s", wantErr, gotErr)
			}
			after, afterErr := os.ReadFile(path)
			switch state := item(expected, "files").(*toolrt.Dict).Value("plan/scenes.json"); state {
			case "absent":
				if afterErr == nil {
					t.Errorf("plan/scenes.json не должен появляться")
				}
			case "unchanged":
				if beforeErr != nil || string(after) != string(before) {
					t.Errorf("plan/scenes.json не должен меняться")
				}
			default:
				if afterErr != nil {
					t.Fatalf("plan/scenes.json (%s): %v", state, afterErr)
				}
				if want := c.Read(t, "files/plan/scenes.json"); string(after) != string(want) {
					t.Errorf("байты plan/scenes.json:\n--- ожидалось\n%s\n--- получено\n%s", want, after)
				}
			}
		})
	}
}

func item(value any, key string) any { return value.(*toolrt.Dict).Value(key) }

// lastLine — последняя непустая строка текста.
func lastLine(text string) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	return lines[len(lines)-1]
}
