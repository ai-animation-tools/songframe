package productionworkflow

import (
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaadapters"
)

// limitAdapter — поддельный адаптер провайдера test с пределом видеопромпта.
type limitAdapter struct{}

func (limitAdapter) PromptWarningChars() int { return 2500 }

// Предел провайдера доходит до этапа prompt; ручной генерации и провайдеру без предела он не нужен.
func TestPromptLimitByMode(t *testing.T) {
	t.Cleanup(mediaadapters.Register("test", limitAdapter{}))
	settings := dynvalue.NewObject()
	settings.Set("provider", "test")
	if limit := (&Context{Settings: settings}).PromptLimit(); limit != 2500 {
		t.Fatalf("предел %d", limit)
	}
	if limit := (&Context{Settings: settings, Manual: true}).PromptLimit(); limit != 0 {
		t.Fatalf("ручная генерация получила предел %d", limit)
	}
	unknown := dynvalue.NewObject()
	unknown.Set("provider", "нет-такого")
	if limit := (&Context{Settings: unknown}).PromptLimit(); limit != 0 {
		t.Fatalf("неизвестный провайдер: %d", limit)
	}
}

// Ключ promptMaxChars появляется в контексте задания только с пределом.
func TestAgentContextPromptMaxChars(t *testing.T) {
	c := &Context{Settings: dynvalue.NewObject(), Scene: dynvalue.NewObject(), Cast: &dynvalue.Array{Items: []any{}}, FramePrompts: &dynvalue.Array{Items: []any{}}, References: dynvalue.NewObject()}
	with := agentContext(c, contextInput{stage: "prompt", briefs: dynvalue.NewObject(), capabilities: &dynvalue.Array{Items: []any{}}, inputFlags: []string{}, promptMaxChars: 2500})
	if !strings.Contains(with, `"promptMaxChars":2500`) {
		t.Fatalf("нет предела: %s", with)
	}
	without := agentContext(c, contextInput{stage: "prompt", briefs: dynvalue.NewObject(), capabilities: &dynvalue.Array{Items: []any{}}, inputFlags: []string{}})
	if strings.Contains(without, "promptMaxChars") {
		t.Fatalf("лишний ключ: %s", without)
	}
}
