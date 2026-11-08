package costcheck

import (
	"context"
	"testing"

	"songframe/internal/mediatest/scenario"
	"songframe/internal/toolcli"
)

// TestGolden проигрывает сценарии cost_check из эталонов testdata/golden/cost-check: каталог
// состояния — <case>/state, остаток и таблица цен по умолчанию — от тестового сервиса.
func TestGolden(t *testing.T) {
	scenario.Play(t, "cost-check", func(t *testing.T, env *scenario.Env, step scenario.Step, args []string) (toolcli.Output, bool) {
		defer env.Register()()
		return Run(context.Background(), env.Path("project"), args, env.Path("state")), false
	})
}
