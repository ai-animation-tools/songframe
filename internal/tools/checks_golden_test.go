package tools_test

import (
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/mediaadapters"
	"songframe/internal/toolrt"
	"songframe/internal/tools"
)

// TestProjectChecksGolden запускает проверки проекта через tools.Run на входах эталонов
// lint-registry, check-assets, check-workspace и shot-status (образец checks-base с разностью
// случая) и сверяет код завершения, stdout и stderr с ожидаемыми. Инструменты только читают
// проект: дерево входа после запуска должно совпасть с исходным.
func TestProjectChecksGolden(t *testing.T) {
	for _, domain := range []string{"lint-registry", "check-assets", "check-workspace", "shot-status"} {
		for _, c := range golden.Load(t, domain) {
			t.Run(domain+"/"+c.Name, func(t *testing.T) {
				spec := c.ReadValue(t, "case.json")
				// Случай с особенностью провайдера доказывает его адаптер; без адаптера в таблице
				// (провайдер удалён) общий тест не должен ломаться.
				if provider, ok := spec.Value("provider").(string); ok && !mediaadapters.Known(provider) {
					t.Skipf("нет адаптера провайдера %s", provider)
				}
				args := []string{}
				for _, arg := range spec.Value("args").([]any) {
					args = append(args, arg.(string))
				}
				root := c.BuildProject(t)
				before, beforeErr := golden.TreeDigest(root)
				result, err := tools.Run(root, c.Call, args)
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
				if beforeErr == nil {
					if after, err := golden.TreeDigest(root); err != nil || after != before {
						t.Errorf("инструмент изменил проект: %v", err)
					}
				}
			})
		}
	}
}
