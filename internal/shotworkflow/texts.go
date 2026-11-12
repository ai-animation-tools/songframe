package shotworkflow

import "strconv"

// textPromptOverLimit — отказ утвердить видеопромпт длиннее предела провайдера; тот же смысл
// показывает плашка шага «Видеопромпт» (productionTexts.promptLimit).
func textPromptOverLimit(chars, limit int) string {
	return "Промпт длиннее предела провайдера: " + strconv.Itoa(chars) + " " + plural(chars, "символ", "символа", "символов") +
		" при пределе " + strconv.Itoa(limit) + ". Верните его на доработку."
}

// plural — склонение по числу, как plural из frontend/src/shared/plural.ts: 1 символ, 2 символа, 5 символов.
func plural(count int, one, few, many string) string {
	n := count % 100
	if n < 0 {
		n = -n
	}
	last := n % 10
	switch {
	case n >= 11 && n <= 14:
		return many
	case last == 1:
		return one
	case last >= 2 && last <= 4:
		return few
	default:
		return many
	}
}
