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

// textPromptVariantMissing — отказ утвердить вариант видеопромпта, которого у попытки нет
// (например, перевод у своего промпта).
func textPromptVariantMissing(variant string) string {
	if variant == "translation" {
		return "У видеопромпта попытки нет перевода."
	}
	return "У видеопромпта попытки нет оригинала."
}
