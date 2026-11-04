package costcheck

import (
	"context"
	"testing"

	"songframe-go/internal/mediatest/scenario"
	"songframe-go/internal/pytool"
)

// TestGolden проигрывает сценарии cost_check.py оригинала (testdata/golden/cost-check): каталог
// состояния — <case>/state, остаток и таблица цен по умолчанию — от тестового сервиса.
func TestGolden(t *testing.T) {
	scenario.Play(t, "cost-check", func(t *testing.T, env *scenario.Env, step scenario.Step, args []string) (pytool.Output, bool) {
		defer env.Register()()
		return Run(context.Background(), env.Path("project"), args, env.Path("state")), false
	})
}
