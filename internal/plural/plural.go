// Package plural согласует русское существительное с числом для текстов, которые Go отдаёт
// интерфейсу и пишет в файлы проекта: 1 кадр, 2 кадра, 5 кадров.
//
// Правило совпадает с plural из frontend/src/shared/plural.ts, чтобы одно и то же число
// склонялось одинаково в сообщениях Go и в интерфейсе.
package plural

// Word возвращает форму слова для целого count: one — для 1, 21, 101; few — для 2–4, 22–24;
// many — для 0, 5–20, 11–14 в любой сотне и остальных. Знак числа не учитывается.
func Word(count int, one, few, many string) string {
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
