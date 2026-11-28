package savedlooks

import "songframe/internal/mediaapi"

// Состояния образа замороженного запроса перед отправкой (UseCheck.Status).
const (
	// UseMissing — образа запроса нет в библиотеке аккаунта: его удалили, пересоздали (новый ID) или
	// вход выполнен в другой аккаунт. Отправка с ним невозможна.
	UseMissing = "missing"
	// UseChanged — образ в аккаунте есть, но у референса теперь другой образ или привязки нет:
	// запрос уйдёт с прежним обликом.
	UseChanged = "changed"
	// UseStale — у референса тот же образ, но снимки референса изменились после его создания.
	UseStale = "stale"
)

// UseCheck — образ замороженного запроса, требующий внимания перед отправкой: код и имя сущности,
// имя образа и состояние (Use*).
type UseCheck struct {
	Code   string `json:"code"`
	Entity string `json:"entity"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// Verify сверяет образы замороженного запроса uses с текущим отчётом аккаунта и возвращает те,
// что требуют внимания, в порядке запроса; пустой список — всё в порядке. Существование
// проверяется по ID образа в библиотеке, а не по статусу референса: запрос несёт ID, который
// был действителен при сборке. Имя образа берётся из библиотеки, если его переименовали.
func Verify(report Report, uses []mediaapi.SavedLookUse) []UseCheck {
	library := map[string]string{}
	for _, look := range report.Looks {
		library[look.ID] = look.Name
	}
	states := map[string]State{}
	for _, state := range report.States {
		states[state.Reference] = state
	}
	checks := []UseCheck{}
	for _, use := range uses {
		check := UseCheck{Code: use.Code, Entity: use.Entity, Name: use.Name}
		name, found := library[use.Look]
		state := states[use.Code]
		switch {
		case !found:
			check.Status = UseMissing
		case state.Look != use.Look:
			check.Status = UseChanged
		case state.Status == StatusStale:
			check.Status = UseStale
		default:
			continue
		}
		if found && name != "" {
			check.Name = name
		}
		checks = append(checks, check)
	}
	return checks
}

// Blocking — есть ли среди проверок образ, с которым отправка невозможна.
func Blocking(checks []UseCheck) bool {
	for _, check := range checks {
		if check.Status == UseMissing {
			return true
		}
	}
	return false
}
