package productionworkflow

import (
	"testing"

	"songframe/internal/dynvalue"
)

// TestPromptProposalTranslation — ответ этапа prompt несёт русский перевод рядом с промптом:
// перевод необязателен, но если есть — непустой текст; посторонние ключи по-прежнему отклоняются.
func TestPromptProposalTranslation(t *testing.T) {
	rules := Rules{Stage: "prompt"}
	proposal, err := ParseProposal(`{"schemaVersion":1,"stage":"prompt","prompt":"图片1 starts the shot.","translation":"图片1 начинает план."}`, rules)
	if err != nil {
		t.Fatalf("промпт с переводом: %v", err)
	}
	if got := dynvalue.Get(proposal, "translation"); got != "图片1 начинает план." {
		t.Fatalf("перевод %v", got)
	}
	if _, err := ParseProposal(`{"schemaVersion":1,"stage":"prompt","prompt":"图片1 starts the shot."}`, rules); err != nil {
		t.Fatalf("промпт без перевода: %v", err)
	}
	for _, bad := range []string{`""`, `"  "`, `1`, `null`} {
		_, err := ParseProposal(`{"schemaVersion":1,"stage":"prompt","prompt":"Текст.","translation":`+bad+`}`, rules)
		if err == nil || err.Error() != textVideoPromptTranslationInvalid {
			t.Fatalf("перевод %s: %v", bad, err)
		}
	}
	if _, err := ParseProposal(`{"schemaVersion":1,"stage":"prompt","prompt":"Текст.","original":"Text."}`, rules); err == nil {
		t.Fatal("посторонний ключ принят")
	}
}
