package jobs

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// jsSpaceClass — содержимое класса \s JavaScript для RE2 (в Go \s только ASCII).
const jsSpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// Шаблоны скрытия секретов: ключи API, Bearer-токены и значения полей
// с секретами заменяются служебным маркером «[скрыто]».
var (
	secretToken = regexp.MustCompile(`(?i)\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer[` + jsSpaceClass + `]+[A-Za-z0-9._~-]+)`)
	secretField = regexp.MustCompile(`(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)[` + jsSpaceClass + `]*[=:][` + jsSpaceClass + `]*["']?)[^` + jsSpaceClass + `,"'}]+`)
)

// Sanitize готовит текст для буфера обмена и отчёта: домашний каталог заменяется на «~»
// (в обоих видах разделителей), похожие на токены значения скрываются. home пустой или из
// одного символа не заменяется.
func Sanitize(text, home string) string {
	if len(home) >= 2 {
		variants := []string{home}
		if slashed := strings.ReplaceAll(home, `\`, "/"); slashed != home {
			variants = append(variants, slashed)
		}
		for _, variant := range variants {
			text = strings.ReplaceAll(text, variant, "~")
		}
	}
	text = secretToken.ReplaceAllString(text, "[скрыто]")
	return secretField.ReplaceAllString(text, "${1}[скрыто]")
}

// CopyText возвращает сведения задания и его журнал (до 1 МиБ с конца) одним текстом для
// буфера обмена. Ошибка — только ErrNotFound.
func (m *Manager) CopyText(id string) (string, error) {
	info, ok := m.Get(id)
	if !ok {
		return "", ErrNotFound
	}
	home, _ := os.UserHomeDir()
	return JobText(info, m.ReadLog(id, copyLogLimit), home), nil
}

// JobText собирает текст копирования задания; отдельно от CopyText ради отчёта разработчика.
func JobText(info Info, log, home string) string {
	trimmed := jsTrim(log)
	if trimmed == "" {
		trimmed = "Журнал пуст."
	}
	return Sanitize(Summary(info)+"\n\nЖурнал:\n"+trimmed+"\n", home)
}

// Summary — заголовок задания: ID и название, вид/проект/статус/код,
// время, шаги и причина. Используется в тексте копирования и в отчёте.
func Summary(info Info) string {
	project := "общее задание приложения"
	if info.Project != nil {
		project = *info.Project
	}
	code := "—"
	if info.Code != nil {
		code = fmt.Sprint(*info.Code)
	}
	finished := "—"
	if info.FinishedAt != nil {
		finished = *info.FinishedAt
	}
	previous := ""
	if info.PreviousSession {
		previous = "; прошлый сеанс"
	}
	lines := []string{
		fmt.Sprintf("Задание %s: %s", info.ID, info.Title),
		fmt.Sprintf("Вид: %s; проект: %s; статус: %s; код: %s", info.Kind, project, info.Status, code),
		fmt.Sprintf("Начато: %s; завершено: %s%s", info.StartedAt, finished, previous),
	}
	if len(info.Steps) > 0 {
		lines = append(lines, "Шаги:")
		for _, step := range info.Steps {
			suffix := ""
			if step.Code != nil {
				suffix = fmt.Sprintf(", код %d", *step.Code)
			}
			lines = append(lines, fmt.Sprintf("  %s (%s): %s%s", step.Label, step.Tool, step.Status, suffix))
		}
	}
	if info.Error != nil && *info.Error != "" {
		lines = append(lines, "Ошибка: "+*info.Error)
	}
	return strings.Join(lines, "\n")
}
