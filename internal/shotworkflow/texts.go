package shotworkflow

import (
	"strconv"

	"songframe/internal/plural"
)

// textPromptOverLimit — отказ утвердить видеопромпт длиннее предела провайдера; тот же смысл
// показывает плашка шага «Видеопромпт» (productionTexts.promptLimit).
func textPromptOverLimit(chars, limit int) string {
	return "Промпт длиннее предела провайдера: " + strconv.Itoa(chars) + " " + plural.Word(chars, "символ", "символа", "символов") +
		" при пределе " + strconv.Itoa(limit) + ". Верните его на доработку."
}
