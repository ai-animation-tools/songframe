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

// checkStderr сверяет stderr инструмента с эталоном: unhandled: true в эталоне — необработанная
// ошибка, её stderr должен быть выведен toolrt.Unhandled; текст сверяется целиком (compare или
// точное равенство).
func checkStderr(t *testing.T, expected *toolrt.Dict, wantErr, gotErr string, compare func(want, got string) bool) {
	t.Helper()
	if unhandled := expected.Value("unhandled") == true; toolrt.IsUnhandled(gotErr) != unhandled {
		t.Errorf("необработанная ошибка: ожидалось %v, stderr\n%s", unhandled, gotErr)
	}
	if compare == nil {
		compare = func(want, got string) bool { return want == got }
	}
	if !compare(wantErr, gotErr) {
		t.Errorf("stderr:\n--- ожидалось\n%s\n--- получено\n%s", wantErr, gotErr)
	}
}

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
			checkStderr(t, expected, wantErr, gotErr, nil)
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
