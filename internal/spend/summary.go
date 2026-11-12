package spend

// Total — сумма известного расхода в одной единице одного источника. Кредиты разных сервисов —
// разные единицы, поэтому сумма отдельна для каждого провайдера (Provider) и для ручных генераций
// (Provider null, единицы credits, RUB, USD). Unit null — единица провайдера неизвестна.
type Total struct {
	Provider *string `json:"provider"`
	Unit     *string `json:"unit"`
	Amount   float64 `json:"amount"`
}

// Accepted — принятый результат плана: какая отправка дала видео и сколько секунд материала.
type Accepted struct {
	// GenerationID — номер генерации принятого видео; nil у ручной генерации.
	GenerationID *string
	// RequestSHA256 — SHA-256 запроса принятой попытки.
	RequestSHA256 string
	// Seconds — длина принятого материала (кадры комплекта / fps).
	Seconds float64
}

// Summary — расход плана в исходных единицах. Неизвестный расход не входит в суммы, а считается
// отдельно (Unknown, Manual): тогда суммы и стоимость секунды — нижняя граница.
type Summary struct {
	// Attempts — попытки (папки) с хотя бы одной отправкой.
	Attempts int `json:"attempts"`
	// Images, Videos — отправки запросов изображений и видео, включая ручные генерации видео.
	Images int `json:"images"`
	Videos int `json:"videos"`
	// Rejected — отправки видео, не ставшие принятым результатом; 0, пока план не принят: в работе
	// последний вариант ещё ждёт решения.
	Rejected int `json:"rejected"`
	// Unknown — отправки с неизвестным расходом: исход неизвестен, сервис не сообщил списание или
	// у ручной генерации не указана стоимость.
	Unknown int `json:"unknown"`
	// Manual — ручные генерации (видео создано вне приложения).
	Manual int `json:"manual"`
	// Totals — известный расход по единицам, в порядке первого появления.
	Totals []Total `json:"totals"`
	// AcceptedSeconds — длина принятого материала; null, пока план не принят.
	AcceptedSeconds *float64 `json:"acceptedSeconds"`
	// PerSecond — Totals на секунду принятого материала; пусто, пока план не принят.
	PerSecond []Total `json:"perSecond"`
}

// Summarize — расход плана shot по записям entries (Entries проекта). accepted nil — план не принят.
func Summarize(entries []Entry, shot string, accepted *Accepted) Summary {
	summary := Summary{Totals: []Total{}, PerSecond: []Total{}}
	attempts := map[string]bool{}
	acceptedFound := false
	for _, entry := range entries {
		if entry.Shot != shot {
			continue
		}
		attempts[entry.Attempt] = true
		if entry.Kind == "image" {
			summary.Images++
		} else {
			summary.Videos++
			if accepted != nil && !acceptedFound && isAccepted(entry, accepted) {
				acceptedFound = true
			}
		}
		var provider *string
		if entry.Status == StatusManual {
			summary.Manual++
		} else {
			provider = &entry.Provider
		}
		if entry.Amount == nil {
			summary.Unknown++
		} else {
			add(&summary.Totals, provider, entry.Unit, *entry.Amount)
		}
	}
	summary.Attempts = len(attempts)
	if accepted != nil {
		summary.Rejected = summary.Videos
		if acceptedFound {
			summary.Rejected--
		}
	}
	if accepted != nil && accepted.Seconds > 0 {
		seconds := accepted.Seconds
		summary.AcceptedSeconds = &seconds
		for _, total := range summary.Totals {
			summary.PerSecond = append(summary.PerSecond, Total{Provider: total.Provider, Unit: total.Unit, Amount: total.Amount / seconds})
		}
	}
	return summary
}

// isAccepted — отправка дала принятое видео: тот же номер генерации, а без номера — тот же запрос.
func isAccepted(entry Entry, accepted *Accepted) bool {
	if entry.GenerationID != nil && accepted.GenerationID != nil {
		return *entry.GenerationID == *accepted.GenerationID
	}
	return entry.RequestSHA256 != "" && entry.RequestSHA256 == accepted.RequestSHA256
}

// add — прибавляет amount к сумме своего источника и единицы; разные не складываются.
func add(totals *[]Total, provider, unit *string, amount float64) {
	for index := range *totals {
		total := &(*totals)[index]
		if sameText(total.Provider, provider) && sameText(total.Unit, unit) {
			total.Amount += amount
			return
		}
	}
	*totals = append(*totals, Total{Provider: provider, Unit: unit, Amount: amount})
}

// sameText — оба значения отсутствуют или равны.
func sameText(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
